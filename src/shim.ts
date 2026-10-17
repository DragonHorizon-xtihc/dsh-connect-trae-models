/**
 * 回环 OpenAI 兼容端点 + 多账号自动容错换号。
 *
 * pi-ai provider 指向这里。每个 chat 请求从账号池取一个账号；上游回答限流时，
 * shim 冷却该账号、换下一个、在同一请求内重试 —— 所以 `429 soft_rate` 永远
 * 不会以「一轮对话失败」的形式到达用户面前。
 *
 * 安全模型（Host/Origin 回环校验、常量时间 bearer 比较、随机端口、进程内
 * secret、请求体上限、错误→状态码映射）沿用 dsh-workbuddy-xdpool 的已验证设计
 * （其血统为 corrinehu/dsh-workbuddy-connect，MIT）。
 *
 * @module dsh-connect-trae-models/shim
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { TraeAccount, TraeAccountPool } from './pool.ts'
import type { TraeCatalog, TraeModelInfo } from './catalog.ts'
import {
  TraeUpstreamClient,
  type TraeChatResult,
  type TraeUpstreamErrorKind,
} from './upstream.ts'
import type { TraeRequestIdentity } from './protocol.ts'
import type { TraeIdentity } from './identity.ts'
import type { TraeRegion } from './region.ts'
import { compactWithSummary, estimateMessagesTokens, hardTruncate, type ChatMessage } from './context-budget.ts'

/** 池与 shim 共用的最小日志面。 */
export interface ShimLogger {
  info?(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** 一个已监听的回环端点。 */
export interface TraePoolShim {
  ready: Promise<void>
  baseUrl(): string
  /** 进程内 secret（adapter 把它当 OpenAI apiKey 用）。 */
  token(): string
  close(): Promise<void>
}

export interface TraePoolShimOptions {
  pool: TraeAccountPool
  client: TraeUpstreamClient
  catalog: TraeCatalog
  logger?: ShimLogger
  /**
   * 把本 shim 限制在一个网关上。两个 shim 并排运行 —— 每区域一个 —— 每个都
   * 只能取属于自己网关的账号。缺省 = 全部账号（单区域部署）。
   */
  region?: TraeRegion
  /** 每请求最多尝试几个账号。 */
  maxAttempts?: number
  /**
   * 本机稳定身份（machineId/deviceId）。`deviceId` 是签到 `x-device-id` 的
   * 判定量，所以每个上游请求都要带上它。缺省时由 {@link TraePoolShimOptions.identityOf}
   * 或调用方在请求前解析；测试可注入。
   */
  identityOf?: (account: TraeAccount) => Promise<TraeIdentity | undefined>
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** 压缩摘要文本的上限，防止一次异常上游把内存吃光。 */
const COMPLETION_TEXT_LIMIT = 256 * 1024

/** 各上游失败类映射到的 HTTP 状态码。 */
const KIND_STATUS: Readonly<Record<TraeUpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  authentication: 401,
  not_found: 502,
  server: 502,
  client: 400,
  unconfigured: 503,
}

/** 上游未给 reset 时间时的限流冷却兜底（毫秒）。 */
export const TRAE_DEFAULT_COOLDOWN_MS = 60_000

/**
 * 从 429 响应体解析冷却截止时刻。
 *
 * 上游有时给出 `resetAt`/`reset_time`（13 位 epoch 毫秒）或本地化的
 * 「将在 2026-10-11 12:00:00」；两者都拿不到时返回 undefined，由
 * {@link TRAE_DEFAULT_COOLDOWN_MS} 兜底 —— 一个识别不出的限流窗口绝不能让
 * 账号被无限期冷却，也绝不能完全不冷却。
 */
export function parseRateLimitReset(body: string): number | undefined {
  const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body)
  if (epochMs !== null) return Number(epochMs[1])

  const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body)
  if (localized !== null) {
    const parsed = Date.parse(localized[1]!.replace(' ', 'T'))
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/** Host 必须指向回环；在路由前就挡掉 DNS rebinding。 */
function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/** 带 Origin 时必须是回环；非浏览器客户端不发 Origin，直接放行。 */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** chat POST 必须带 JSON body 类型（挡掉简单请求 CSRF）。 */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/**
 * 上游失败体是否表示请求超出了模型上下文窗口。
 *
 * Trae 的表述与 WorkBuddy 不同：除通用的 `context_length_exceeded` 外，还会
 * 出现「input length too long」与 `"code":1005` 家族之外的窗口类文案，
 * 所以这里同时接受正则化的通用说法。
 */
export function isContextTooLong(body: string): boolean {
  if (body.includes('context_length_exceeded')) return true
  if (body.includes('input length too long')) return true
  if (body.includes('context window exceeded')) return true
  if (body.includes('maximum context length')) return true
  if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true
  return false
}

/**
 * 请求的无内容形态描述，供上游拒绝时记日志。
 *
 * `client` 类失败（HTTP 400）通常带空的 `param`，错误本身说不出是哪个参数被
 * 拒 —— 用户只看到「请求参数不满足当前模型要求」而无从下手。记录形态
 * （顶层键、按角色的消息数、工具数、近似 prompt 大小）让这类拒绝能从日志里
 * 诊断出来。
 *
 * 刻意只记形态：无消息内容、无工具 schema、无 token。它会落进日志文件，而它
 * 描述的那个对话属于用户。
 */
function requestShape(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const keys = Object.keys(parsed).sort()
    const messages = Array.isArray(parsed['messages']) ? parsed['messages'] as unknown[] : []
    const byRole = new Map<string, number>()
    let chars = 0
    for (const entry of messages) {
      if (typeof entry !== 'object' || entry === null) continue
      const message = entry as Record<string, unknown>
      const role = typeof message['role'] === 'string' ? message['role'] : '?'
      byRole.set(role, (byRole.get(role) ?? 0) + 1)
      // 仅近似；要点是数量级。
      chars += JSON.stringify(message['content'] ?? '').length
    }
    const roles = [...byRole.entries()].map(([role, n]) => `${role}:${n}`).join(' ')
    const tools = Array.isArray(parsed['tools']) ? parsed['tools'].length : 0
    return `keys=[${keys.join(' ')}] messages=${messages.length}${roles === '' ? '' : ` (${roles})`} `
      + `tools=${tools} contentChars=${chars}`
  } catch {
    return 'body was not parseable JSON'
  }
}

/**
 * 请求所属对话的稳定身份，供 `sticky` 使用。
 *
 * 用**第一条 user 消息**做键：它是 body 里唯一不随历史增长而改变的部分，所以
 * 一个对话的每一轮都哈希到同一个值，而新对话（开头消息不同）哈希到别的值。
 * 哈希而非存原文，让对话内容不进入池的内存。
 *
 * 两条开头完全相同的对话会共享账号 —— 罕见且无害：只意味着它们共用同一个
 * 账号的 prompt 缓存。
 */
export function conversationKeyOf(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { messages?: unknown }
    if (!Array.isArray(parsed.messages)) return undefined
    for (const entry of parsed.messages) {
      if (typeof entry !== 'object' || entry === null) continue
      const message = entry as Record<string, unknown>
      if (message['role'] !== 'user') continue
      const content = typeof message['content'] === 'string'
        ? message['content']
        : JSON.stringify(message['content'] ?? '')
      return createHash('sha256').update(content).digest('hex').slice(0, 32)
    }
    return undefined
  } catch {
    return undefined
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 取请求里的 model 字段（限流按模型计，所以冷却要带 modelId）。 */
function modelIdOf(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { model?: unknown }
    return typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : undefined
  } catch {
    return undefined
  }
}

/**
 * 按实时目录把 OpenAI 形状请求盖成真正的 Trae wire 目标。
 *
 * `llm_utils_chat` 只接受「列出该 config_name 的那个 function」与真实
 * config_name（glm-5.3 只在 `solo_work_remote` 下服务，`solo_work_lite`
 * 答 4001；部分模型的显示 id 与 wire config_name 不同）。目录合并层
 * （catalog.mergeTraeModelSources）已经把这两半算好放在 `wireFunction` /
 * `wireConfigName` 上，但早期移植漏掉了在请求路径上消费它们——所有请求都以
 * 缺省 `solo_work_lite`、显示 id 直发上游。这里补齐这一层（与 dsh-connect-trae
 * 的 TraeSoloBridge wire 解析同义）：
 *
 * - `model` 改写为 wire config_name（仅当目录行宣告了不同值）；
 * - `function` 盖为目录归属 function（请求体已显式带 function 时尊重显式值）；
 * - `reasoning_effort` 若未被该模型目录宣告支持则删除——上游对不支持的档位
 *   会 400，而 DSH 可能带着上一个模型的档位选择切模型。
 *
 * 纯函数：解析失败或没有目录行时原样返回，绝不因目录问题拦住请求。
 */
export function stampTraeWireTarget(raw: string, catalog: Pick<TraeCatalog, 'find'>): string {
  let parsed: Record<string, unknown>
  try {
    const candidate = JSON.parse(raw)
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return raw
    parsed = candidate as Record<string, unknown>
  } catch {
    return raw
  }
  const requestedModel = typeof parsed['model'] === 'string' && parsed['model'] !== '' ? parsed['model'] : undefined
  if (requestedModel === undefined) return raw
  const entry = catalog.find(requestedModel)
  if (entry === undefined) return raw

  let changed = false
  if (entry.wireConfigName !== undefined && entry.wireConfigName !== '' && entry.wireConfigName !== requestedModel) {
    parsed['model'] = entry.wireConfigName
    changed = true
  }
  if (entry.wireFunction !== undefined && entry.wireFunction !== '') {
    const explicit = parsed['function']
    if (typeof explicit !== 'string' || explicit === '') {
      parsed['function'] = entry.wireFunction
      changed = true
    }
  }
  if (typeof parsed['reasoning_effort'] === 'string') {
    const supported = entry.supportedEfforts
    if (supported === undefined || !supported.includes(parsed['reasoning_effort'])) {
      delete parsed['reasoning_effort']
      changed = true
    }
  }
  return changed ? JSON.stringify(parsed) : raw
}

export function createTraePoolShim(options: TraePoolShimOptions): TraePoolShim {
  const { pool, client, catalog } = options
  const region = options.region
  const logger = options.logger
  const maxAttempts = options.maxAttempts ?? 8

  // 进程内 secret。adapter 把它解析为 OpenAI apiKey；shim 从不转发它，
  // 因为真实 token 来自账号池。
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const a = Buffer.from(match[1] as string)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('trae shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  /**
   * 每账号最近一次余额刷新时刻，避免繁忙账号被每次请求探测。
   * 十分钟远在普通使用可能跨过保留线的窗口之内。
   */
  const lastBalanceAt = new Map<string, number>()
  const BALANCE_REFRESH_MS = 10 * 60 * 1000

  /**
   * 尽力刷新一个账号已知的积分余额。
   *
   * 在成功请求后于后台运行。失败被刻意吞掉：保留线是安全特性，一次抖动的余额
   * 查询绝不能变成失败的用户请求或噪声日志。
   */
  async function refreshBalance(account: TraeAccount): Promise<void> {
    const now = Date.now()
    const last = lastBalanceAt.get(account.id) ?? 0
    if (now - last < BALANCE_REFRESH_MS) return
    lastBalanceAt.set(account.id, now)
    try {
      const request = await identityOf(account)
      if (request === undefined) return
      const credits = await client.fetchCredits(request)
      // 到期时间与余额同行：expiry 模式按它排序，而余额读取是我们唯一能
      // 学到它的地方。
      pool.noteCredits(account.id, credits.total, credits.nearestExpiryMs)
    } catch {
      // 保留上一次读数；下一个请求再试。
    }
  }

  /**
   * 把一个池账号包装成上游请求身份包。
   *
   * Trae 的每个上游方法都要 `{ credential, identity }`：identity 提供
   * `x-machine-id`/`x-device-id`，而 `deviceId` 还是签到名额的判定量。所以
   * 这里必须解析本机身份，而不是只传凭据。
   */
  async function identityOf(account: TraeAccount): Promise<TraeRequestIdentity | undefined> {
    const identity = options.identityOf === undefined
      ? undefined
      : await options.identityOf(account)
    if (identity === undefined) {
      logger?.warn?.('dsh-connect-trae-models: 本机身份不可用，跳过该请求（签到与 x-device-id 依赖它）')
      return undefined
    }
    return {
      credential: {
        accessToken: account.credential.accessToken,
        userId: account.credential.userId,
        edition: account.credential.edition,
      },
      identity: {
        machineId: identity.machineId,
        deviceId: identity.deviceId,
        platform: identity.platform,
        ...identity.appVersion === undefined ? {} : { appVersion: identity.appVersion },
        ...identity.buildVersion === undefined ? {} : { buildVersion: identity.buildVersion },
        ...identity.deviceBrand === undefined ? {} : { deviceBrand: identity.deviceBrand },
        ...identity.deviceCpu === undefined ? {} : { deviceCpu: identity.deviceCpu },
        ...identity.osVersion === undefined ? {} : { osVersion: identity.osVersion },
      },
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true, pool: pool.status() })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'connect-trae-models',
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) writeOpenAIError(res, 500, 'internal', String(error))
      else res.end()
    }
  }

  /**
   * 服务一次 chat 补全，在限流时轮换账号。
   *
   * 被限流的账号按上游报告的窗口冷却（可解析时），并立刻尝试下一个账号 ——
   * 所以池里只要有健康成员，就永远不向调用方暴露 429。
   */
  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const controller = new AbortController()
    req.on('close', () => controller.abort())

    // `sticky` 把每个对话绑到一个账号；其他分布下池会忽略它。
    const conversationKey = conversationKeyOf(raw)

    // 请求的目标模型。上游限流按模型计（「可切换其他模型继续使用」），所以冷却
    // 以 (账号, 模型) 为键：hy4-preview 上的 429 只冷却该账号的那个模型，绝不
    // 封整账号。
    const modelId = modelIdOf(raw)

    // 按实时目录盖 wire 章（真实 config_name + 归属 function + 档位修剪）。
    // 盖章在换号循环之前只做一次：wire 目标是模型属性，与用哪个账号无关。
    const stamped = stampTraeWireTarget(raw, catalog)

    const tried: string[] = []
    let last: { kind: TraeUpstreamErrorKind; status: number; message: string } | undefined

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (controller.signal.aborted) return

      const account = await pool.acquire(modelId, region, conversationKey)
      if (account === undefined) {
        // 直接问池「为什么」，而不是从本次请求单独推断。
        //
        // 旧写法用了一个只在本次循环中置位的标志，它看不见更早请求建立的冷却。
        // 一次 429 之后，下一个请求在第一次尝试就找不到账号、标志仍为 false，
        // shim 于是回答 401「无凭据，请登录」—— DSH 把它渲染成「API key 无效」，
        // 把一个临时限流变成让用户重新登录。
        const why = pool.unavailableReason(modelId, region)

        if (why.reason === 'cooling') {
          // 限流是**临时**的：调用方应当等待，而不是重新认证。
          const subject = modelId === undefined
            ? 'every Trae account is rate-limited'
            : `every account is rate-limited for model ${modelId}`
          const upstream = last === undefined ? '' : ` — ${last.message.slice(0, 200)}`
          writeOpenAIError(
            res,
            429,
            'soft_rate',
            `${subject} (${why.cooling}/${why.total} cooling, tried ${tried.length})`
              + `${tried.length === 0 ? '' : `: ${tried.join(' → ')}`}${upstream}`,
          )
          return
        }

        if (why.reason === 'disabled') {
          writeOpenAIError(
            res,
            403,
            'no_enabled_account',
            `all ${why.total} Trae account(s) for this gateway are switched off; `
              + 're-enable one on the pool card',
          )
          return
        }

        if (why.reason === 'reserve') {
          writeOpenAIError(
            res,
            402,
            'reserve_floor',
            `every Trae account is at or below its credit reserve (${why.total} account(s)); `
              + 'lower the reserve on the pool card or top up credits',
          )
          return
        }

        if (why.reason === 'dead') {
          // 与「从未登录」不同：这些账号**有**凭据，只是上游现在拒绝它们。
          // 等待没用，而说「找不到凭据」会让用户去找一个并不缺失的文件。
          writeOpenAIError(
            res,
            401,
            'session_dead',
            `${why.dead}/${why.total} Trae account(s) for this gateway were rejected by the upstream `
              + '(their sign-in was revoked); sign in again in the Trae desktop app to restore them',
          )
          return
        }

        writeOpenAIError(
          res,
          401,
          'not_signed_in',
          why.total === 0
            ? 'no Trae credential found for this gateway; sign in on the Trae desktop app'
            : `no usable Trae credential among ${why.total} account(s) for this gateway; sign in again on the desktop app`,
        )
        return
      }
      tried.push(account.label)

      const request = await identityOf(account)
      if (request === undefined) {
        // 身份解析失败是本机状态问题，不是账号问题：换号不会有帮助。
        writeOpenAIError(res, 500, 'identity_unavailable', 'Trae machine identity could not be resolved')
        return
      }

      const result = await client.chatStream(request, stamped, controller.signal, modelId)

      if (result.ok) {
        await serveSuccessfulStream(res, account, result, logger, refreshBalance, pool)
        return
      }

      last = { kind: result.kind, status: result.status, message: result.message }

      // 死会话只在 refresh token 仍可用时可恢复。`refreshAccount` 问上游并回报：
      // true 表示 token 已续期（重试请求），false 表示上游确认凭据被吊销。后者
      // 冷却账号，让下一次尝试轮换而不是又落在它身上 —— 没有这一步，
      // maxAttempts 次都会打在同一个死账号上，健康的账号永远不会被尝试。
      if (result.kind === 'authentication') {
        logger?.warn(`dsh-connect-trae-models: ${account.label} 会话失效；刷新 token 后重试`)
        const before = account.credential.accessToken
        const recovered = await pool.refreshAccount(account.id, { force: true })
        // 上游仍发放刷新凭据的 401 只是「也许过期」。一旦刷新回来的还是同一个
        // token（或干脆失败），就没有可试的了：标记为死，让重试预算花在别的
        // 账号上。
        if (!recovered || account.credential.accessToken === before) {
          pool.penalizeCredentialDead(account.id)
          logger?.warn(
            `dsh-connect-trae-models: ${account.label} 登录已失效 `
              + `(attempt ${attempt + 1}/${maxAttempts})；轮换`,
          )
        }
        continue
      }

      // 积分耗尽是**账号**条件而非模型条件：该账号上的每个模型在配额重置前都
      // 不可用，所以冷却整账号并轮换。在这里直接失败会浪费其他健康账号。
      if (result.kind === 'hard_credit') {
        pool.penalizeExhausted(account.id)
        logger?.warn(
          `dsh-connect-trae-models: ${account.label} 积分已耗尽 `
            + `(attempt ${attempt + 1}/${maxAttempts})；轮换`,
        )
        continue
      }

      // `client` 类失败（HTTP 400）在上游留空 `extError.param` 时不点名任何
      // 参数，而这是常态 —— 用户于是只得到「请求参数不满足当前模型要求」。
      // 记录我们发出的**形态**（只有键与计数，绝无消息内容），让下次出现时
      // 能从日志诊断，而不必复现。
      if (result.kind === 'client') {
        logger?.warn(
          `dsh-connect-trae-models: ${account.label} 判定请求无效 `
          + `(model ${modelId ?? '(none)'}) — ${requestShape(raw)}；上游：${result.message.slice(0, 300)}`,
        )
      }

      // 其他失败对本次请求是终态。
      if (result.kind !== 'soft_rate') break

      // 只冷却该账号的这个模型；账号的其他模型保持可用（上游明确允许切换模型）。
      const resetAt = parseRateLimitReset(result.message)
        ?? Date.now() + TRAE_DEFAULT_COOLDOWN_MS
      pool.penalize(account.id, resetAt, modelId)
      logger?.warn(
        `dsh-connect-trae-models: ${account.label} 在 ${modelId ?? '(no model)'} 上被限流 `
          + `(attempt ${attempt + 1}/${maxAttempts})；轮换`,
      )
    }

    if (last === undefined) {
      writeOpenAIError(res, 500, 'internal', 'chat request exhausted without a result')
      return
    }
    // 上下文窗口超限有两层防线，这是内层。Harness 在派发**之前**跑自己的
    // compaction-basic，依据是模型宣告的窗口 —— 但对一个经 shim 路由的上游而言
    // 那个窗口只是猜测，所以 prompt 仍可能过大。真发生时，就地压缩并重试一次；
    // 若连那样都放不下，就发出 Harness 能识别的溢出消息（见
    // `contextOverflowMessage`），让它的**外层**恢复路径有机会在 agent 层
    // 缩减历史并重试。
    //
    // 两层互补而非冗余：内层让单轮对话在不惊动 Harness 的情况下活下去，外层
    // 兜住「shim 侧压缩仍放不下」的情况。
    if (isContextTooLong(last.message)) {
      const recovered = await recoverFromContextOverrun({
        raw: stamped,
        modelId,
        controller,
        region,
        logger,
        client,
        pool,
        maxAttempts,
        identityOf,
        contextWindow: modelId === undefined
          ? undefined
          : catalog.current().find(m => m.id === modelId)?.contextWindow,
      })
      if (recovered.ok) {
        await serveSuccessfulStream(res, recovered.account, recovered.result, logger, refreshBalance, pool)
        return
      }
      // 措辞是与 Harness 的契约；见 `contextOverflowMessage`。
      writeOpenAIError(res, 400, 'context_length_exceeded', contextOverflowMessage(modelId, recovered.detail))
      return
    }
    writeOpenAIError(
      res,
      KIND_STATUS[last.kind],
      last.kind,
      `trae upstream ${last.kind} (http ${last.status}) after ${tried.length} account(s) [${tried.join(' → ')}]: ${last.message.slice(0, 400)}`,
    )
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(() => resolve())
        server.closeAllConnections()
        server.once('error', reject)
      }),
  }
}

/**
 * 把一次流式补全的 SSE 帧重组成单个字符串。
 *
 * 只用于内部压缩（总结被丢弃的轮次）：chat 端点本身总是流式，所以这里把帧
 * 收集起来。任何失败都会抛出，让压缩器回退到纯截断，而不是让用户的这一轮
 * 失败。
 */
async function readCompletionText(response: Response): Promise<string> {
  if (response.body === null) throw new Error('compaction upstream returned no body')
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ''
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 帧之间以空行分隔；保留末尾不完整的部分。
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        text += contentOfFrame(buffer.slice(0, split))
        buffer = buffer.slice(split + 2)
        if (text.length > COMPLETION_TEXT_LIMIT) return text.slice(0, COMPLETION_TEXT_LIMIT)
        split = buffer.indexOf('\n\n')
      }
    }
    if (buffer.trim() !== '') text += contentOfFrame(buffer)
  } finally {
    reader.releaseLock?.()
  }
  return text
}

/** 从一帧 SSE 里取出 `choices[0].delta.content`（或非流式的 `message.content`）。 */
function contentOfFrame(frame: string): string {
  let out = ''
  for (const rawLine of frame.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const choices = (parsed as { choices?: unknown }).choices
    if (!Array.isArray(choices)) continue
    const first = choices[0]
    if (typeof first !== 'object' || first === null) continue
    const choice = first as Record<string, unknown>
    const delta = choice['delta']
    if (typeof delta === 'object' && delta !== null) {
      const content = (delta as Record<string, unknown>)['content']
      if (typeof content === 'string') out += content
    }
    const message = choice['message']
    if (typeof message === 'object' && message !== null) {
      const content = (message as Record<string, unknown>)['content']
      if (typeof content === 'string') out += content
    }
  }
  return out
}

/**
 * 构造 Harness 必须能识别的溢出消息。
 *
 * 这刻意**不是**自由散文。`dsh-compaction-basic` 通过把到达它的文本送进
 * `isContextWindowExceededError()`（`@deepseek-ai/dsh-llm`）来决定是否
 * 压缩并重试，而那个匹配器只接受特定措辞：
 *
 *   - `context_length_exceeded` / `context window exceeded`
 *   - `maximum context length`
 *   - `<input|prompt|request|messages> too large|long for ... context`
 *   - `<input|prompt|request> exceeds the ... context window`
 *
 * 那句友善的「对话超出该模型的上下文窗口」一个都不匹配，Trae 上游自己的
 * 「input length too long」也不匹配。发出任何一个都意味着 Harness 看到一个
 * 无法分类的 400、跳过恢复路径、并留下一轮死掉的对话 —— 这正是本函数存在的
 * 原因。
 *
 * 前导从句承载机器匹配措辞；尾随从句是人读的。两者都要与
 * `tests/context-overflow-contract.test.ts` 保持同步。
 */
export function contextOverflowMessage(modelId: string | undefined, detail = ''): string {
  const subject = modelId === undefined ? 'the model' : `model ${modelId}`
  const note = detail === '' ? '' : ` (${detail})`
  return `This model's maximum context length was exceeded: the prompt is too large for `
    + `${subject}, and the conversation could not be compacted in place${note}. `
    + `Compact the conversation, or start a new chat.`
}

/**
 * 把一个已经成功的上游流转发为 SSE 响应。
 *
 * 抽出来是为了让上下文超限恢复路径复用与首次命中**完全相同**的簿记
 * （noteServed + 后台余额刷新）。
 */
async function serveSuccessfulStream(
  res: ServerResponse,
  account: TraeAccount,
  result: Extract<TraeChatResult, { ok: true }>,
  logger: ShimLogger | undefined,
  refreshBalance: (account: TraeAccount) => Promise<void>,
  pool: TraeAccountPool,
): Promise<void> {
  logger?.info?.(`dsh-connect-trae-models: 由 ${account.label} 服务`)
  // 到这一刻这个账号才真正在服务用户：一个失败换号到别处的请求绝不能把
  // 试过的账号标记为已使用。
  pool.noteServed(account.id)
  // 后台刷新余额，让保留线有新鲜读数。刻意**不** await：响应已经就绪，
  // 一次余额查询绝不能拖延用户的流。
  void refreshBalance(account)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  let sawDone = false
  let queueLogged = false
  const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    if (chunk.includes('[DONE]')) sawDone = true
    // 排队帧由 solo-bridge 生成（`: trae-queue position=N`）；只记首末位置各一次，
    // 让「为什么等了这么久」在日志里有据可查，而不是每个位置一行刷爆日志。
    if (!queueLogged && chunk.includes('trae-queue')) {
      queueLogged = true
      const match = /trae-queue(?: position=(\d+))?/.exec(chunk.toString('utf8'))
      logger?.info?.(`dsh-connect-trae-models: 上游排队中（位置 ${match?.[1] ?? '未知'}），已发送保活帧等待`)
    }
  })
  body.on('error', (error: unknown) => {
    logger?.warn('dsh-connect-trae-models: 上游流中途失败', error)
    if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
  })
  body.pipe(res)
}

export interface RecoverOptions {
  raw: string
  modelId: string | undefined
  controller: AbortController
  region: TraeRegion | undefined
  logger: ShimLogger | undefined
  client: TraeUpstreamClient
  pool: TraeAccountPool
  maxAttempts: number
  identityOf: (account: TraeAccount) => Promise<TraeRequestIdentity | undefined>
  /** 模型真实上下文窗口，让预算贴合真实上限。 */
  contextWindow?: number
}

export type RecoverResult =
  | { ok: true; account: TraeAccount; result: Extract<TraeChatResult, { ok: true }> }
  | { ok: false; detail: string }

/**
 * 压缩一个过长的对话并重试一次。
 *
 * 策略依次为：
 *  1. 丢弃最老的轮次，保留 system 消息与最新一轮问答；
 *  2. 让模型总结被丢弃的轮次并把这句摘要拼接回去；
 *  3. 最后手段：硬截断。
 *
 * 只有连截断后的 prompt 仍超限才返回 `ok: false` —— 调用方随后把原始可操作的
 * 400 交给用户。
 */
async function recoverFromContextOverrun(options: RecoverOptions): Promise<RecoverResult> {
  const { raw, modelId, controller, region, logger, client, pool, maxAttempts, identityOf } = options
  let parsed: Record<string, unknown>
  try {
    const candidate = JSON.parse(raw) as unknown
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      return { ok: false, detail: 'request body was not a JSON object' }
    }
    parsed = candidate as Record<string, unknown>
  } catch {
    return { ok: false, detail: 'request body was not parseable JSON' }
  }
  const rawMessages = parsed['messages']
  if (!Array.isArray(rawMessages)) return { ok: false, detail: 'request carried no messages array' }
  const messages = rawMessages.filter(
    (value): value is ChatMessage => typeof value === 'object' && value !== null && !Array.isArray(value),
  )
  if (messages.length === 0) return { ok: false, detail: 'request carried no usable messages' }

  // 上游报告了超限但没给窗口大小，所以预算必须从证据推导，而不能只看目录。
  const overrunTokens = estimateMessagesTokens(messages)
  // 已知模型**真实**窗口（来自目录）时用它；未知时才回退到 prompt 的一半。
  //
  // ……但绝不把它当上界，这正是要修的 bug：目录若宣告 1M 而目录保证的窗口更
  // 小，预算会算出一个比已被拒绝的 prompt 还大的目标，压缩「到」更大的值等于
  // 什么都没改，重试再次超限，而日志看起来像恢复跑过了。
  //
  // 手上的 prompt 刚刚超限，所以它是一个硬的、基于证据的天花板：无论目录怎么
  // 宣称，预算都必须明显低于它。
  const realWindow = options.contextWindow
  const fromWindow = realWindow !== undefined && realWindow > 0
    ? Math.max(512, Math.floor(realWindow * 0.8) - 2048)
    : Number.POSITIVE_INFINITY
  // 失败 prompt 的一半：它的大小已知过大，所以减半既保证真实收缩，又给答案
  // 留出余量。
  const fromOverrun = Math.max(512, Math.floor(overrunTokens / 2))
  const budget = Math.min(fromWindow, fromOverrun)

  logger?.warn(
    `dsh-connect-trae-models: ${modelId ?? '(no model)'} 上下文超限 `
      + `(~${overrunTokens} tokens, catalog window ${realWindow ?? 'unknown'})；`
      + `压缩到 ~${budget} 后重试一次`,
  )

  let summary: string | undefined
  let compacted: ChatMessage[] = messages
  let compactionDetail = ''
  try {
    const summariser = await pool.acquire(modelId, region)
    const summariserRequest = summariser === undefined ? undefined : await identityOf(summariser)
    if (summariser === undefined || summariserRequest === undefined) {
      compactionDetail = 'no account available to summarise with'
    } else {
      const outcome = await compactWithSummary(
        messages,
        { budget, keepRecent: 6 },
        {
          complete: async (request, signal) => {
            const body = JSON.stringify({
              ...parsed,
              stream: true,
              max_tokens: Math.max(256, Math.floor(budget / 2)),
              messages: request,
            })
            const result = await client.chatStream(summariserRequest, body, signal ?? controller.signal, modelId)
            if (!result.ok) {
              throw new Error(`compaction upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 300)}`)
            }
            return await readCompletionText(result.response)
          },
        },
        controller.signal,
      )
      compacted = outcome.messages
      summary = outcome.summary
      if (outcome.skipped !== undefined) compactionDetail = outcome.skipped
    }
  } catch (error: unknown) {
    // 总结是尽力而为；失败就落到截断。
    compactionDetail = `summarisation failed: ${String(error)}`
  }

  // 无论总结器做到什么程度，都要保证 prompt 现在放得下。
  if (estimateMessagesTokens(compacted) > budget) {
    compacted = hardTruncate(compacted, budget).messages
  }
  if (summary === undefined && estimateMessagesTokens(compacted) >= overrunTokens) {
    return { ok: false, detail: compactionDetail === '' ? 'compaction could not reduce the prompt' : compactionDetail }
  }

  const retryBody = JSON.stringify({ ...parsed, messages: compacted })
  const tried: string[] = []
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (controller.signal.aborted) return { ok: false, detail: 'client disconnected' }
    const account = await pool.acquire(modelId, region)
    if (account === undefined) return { ok: false, detail: 'no account available after compaction' }
    const request = await identityOf(account)
    if (request === undefined) return { ok: false, detail: 'machine identity unavailable after compaction' }
    tried.push(account.label)
    const result = await client.chatStream(request, retryBody, controller.signal, modelId)
    if (result.ok) {
      logger?.info?.(
        `dsh-connect-trae-models: ${modelId ?? '(no model)'} 已从上下文超限恢复 `
          + `(summarised: ${summary === undefined ? 'no' : 'yes'})`,
      )
      return { ok: true, account, result }
    }
    if (isContextTooLong(result.message)) {
      // 压缩后仍然太长：放弃而不是打转。
      return { ok: false, detail: 'prompt still exceeded the window after compaction' }
    }
    if (result.kind === 'authentication') {
      // 与主循环同一规则：试一次刷新，若凭据被证明已死就冷却它，免得这段
      // 重试预算又花在它身上。
      const before = account.credential.accessToken
      const recovered = await pool.refreshAccount(account.id, { force: true })
      if (!recovered || account.credential.accessToken === before) pool.penalizeCredentialDead(account.id)
      continue
    }
    if (result.kind === 'hard_credit') {
      pool.penalizeExhausted(account.id)
      continue
    }
    if (result.kind === 'soft_rate') {
      const resetAt = parseRateLimitReset(result.message) ?? Date.now() + TRAE_DEFAULT_COOLDOWN_MS
      pool.penalize(account.id, resetAt, modelId)
      continue
    }
    return { ok: false, detail: `upstream ${result.kind} after compaction` }
  }
  return { ok: false, detail: `no account served the compacted request (tried ${tried.length})` }
}

/** 模型行的只读映射（卡片与 shim 的 /v1/models 共用同一份数据）。 */
export type { TraeModelInfo }
