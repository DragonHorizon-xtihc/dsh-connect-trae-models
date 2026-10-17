/**
 * 插件卡片背后的同源路由（/plugins/dsh-connect-trae-models/*）。
 *
 * 这些路由**只服务回环浏览器请求**，且响应里绝不携带 token 材料（访问/刷新
 * token、账号 id 之外的身份都不出去）。默认只读：状态是 GET，卡片的重扫与
 * 冷却重置是显式 POST。**唯一**会改上游账号状态的是每日签到 claim，它由显式的
 * per-account `accountId` 加一次前置状态复核守住。
 *
 * 挂载在宿主的 `webServer` 上（与 DSH 设置界面同源），由 `apply` 中的
 * `ctx.inject(['webServer'], ...)` 接线。`webServer` 是可选的，无头 profile
 * 上这些路由根本不挂，卡片退化成离线横幅——provider 照常服务模型。
 *
 * @module dsh-connect-trae-models/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { TraeAccount, TraeAccountPool } from './pool.ts'
import type { TraeCatalog, TraeModelInfo } from './catalog.ts'
import type { TraeCreditsSnapshot, TraeUpstreamClient } from './upstream.ts'
import type { AutomationStatus, AutomationJobState, AutomationAccountEarnings } from './scheduler.ts'
import {
  parseRegionParam,
  TRAE_POOL_ACCOUNT_SELECT_PATH,
  TRAE_POOL_ACCOUNT_TOGGLE_PATH,
  TRAE_POOL_AUTOMATION_RUN_PATH,
  TRAE_POOL_CHECKIN_PATH,
  TRAE_POOL_MODELS_SAVE_PATH,
  TRAE_POOL_RESET_COOLDOWN_PATH,
  TRAE_POOL_RESCAN_PATH,
  TRAE_POOL_STATUS_PATH,
  unwrapVolatileDeep,
  type TraePoolRegion,
  type TraePoolWebAccount,
  type TraePoolWebAccountToggle,
  type TraePoolWebAutomation,
  type TraePoolWebAutomationJob,
  type TraePoolWebAutomationRun,
  type TraePoolWebCheckin,
  type TraePoolWebCheckinClaim,
  type TraePoolWebModel,
  type TraePoolWebModelSelection,
  type TraePoolWebStatus,
} from './status-paths.ts'

export {
  TRAE_POOL_ACCOUNT_SELECT_PATH,
  TRAE_POOL_ACCOUNT_TOGGLE_PATH,
  TRAE_POOL_AUTOMATION_RUN_PATH,
  TRAE_POOL_CHECKIN_PATH,
  TRAE_POOL_MODELS_SAVE_PATH,
  TRAE_POOL_RESET_COOLDOWN_PATH,
  TRAE_POOL_RESCAN_PATH,
  TRAE_POOL_STATUS_PATH,
}
export type { TraePoolWebStatus }

/** 上游对「本设备今日已签到」的业务码。 */
export const CHECKIN_DEVICE_ALREADY_CLAIMED = 9095

/**
 * 「3 天内到期」提醒窗口。
 *
 * 与 `upstream.ts` 的 `TRAE_EXPIRING_SOON_WINDOW_MS` 同值；这里重新声明是为了
 * 让本模块的类型面自洽（值语义必须一致，测试钉住）。
 */
export const EXPIRING_SOON_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/** 每账号探测的上游调用超时（长于它视为不可达，降级为错误文案）。 */
const ACCOUNT_PROBE_TIMEOUT_MS = 15_000

/** 构造依赖——池运行时的一个窄切片。 */
export interface TraePoolStatusRouteOptions {
  pool: TraeAccountPool
  /** 每个区域一个目录；卡片读当前 tab 对应的那个。 */
  catalogs: Readonly<Record<TraePoolRegion, TraeCatalog>>
  client: TraeUpstreamClient
  /** 惰性解析正在运行的 shim（尚未绑端口时 running=false）。 */
  shim?: (region: TraePoolRegion) => { running: boolean; baseUrl?: string }
  /**
   * 签到自动化的状态读取器。
   *
   * 可选：无调度器的 profile（测试、CLI）也要能挂这些路由，卡片会把自动化显示
   * 为关闭，而不是显示一个坏掉的面板。
   */
  scheduler?: () => AutomationStatus
  /**
   * 启动一次手动运行，返回「是否真的启动」而不是结果。
   *
   * 一整轮要几十秒（每账号一次上游往返），所以它在后台跑，卡片轮询状态看进度。
   */
  runAutomation?: (job: string | undefined, force: boolean) => boolean
  /**
   * 当前配置文档（已解包 volatile）。
   *
   * 卡片要回显保存过的选择与保留线，而这些都住在 settings 里。以 thunk 而不是
   * 快照给出，文档才能反映此刻的值（包括 CLI 刚改过的）。
   */
  config?: () => Record<string, unknown>
  /**
   * 持久化某区域的模型选择。
   *
   * 由宿主提供（settings 分区归它所有）；缺省时保存路由答 503 而不是假装成功。
   */
  saveSelection?: (region: TraePoolRegion, selection: TraePoolWebModelSelection) => Promise<void> | void
  /**
   * 持久化某账号的开关。
   *
   * 宿主负责读改写整个 `disabledAccountIds` 列表——路由层不该知道 settings 的
   * 存储细节，否则它会变成第二个所有者。
   */
  setAccountDisabled?: (accountId: string, disabled: boolean) => Promise<void> | void
  /** 重扫本机凭据。 */
  rescan?: () => Promise<void> | void
  /** 清除全部冷却。 */
  resetCooldowns?: () => Promise<void> | void
  /** 本机设备号（签到的设备口径判定量）；读不到时返回空串。 */
  deviceId?: () => string
  /** 诊断日志。 */
  logger?: { warn?(...args: unknown[]): void; info?(...args: unknown[]): void }
}

/**
 * 读出池里被钉选的账号，访问器缺失时按「没有钉选」处理。
 *
 * 状态文档是**只读**组装路径：某个可选访问器不在（测试替身、老宿主、后续精简）
 * 时，最坏的结果应该是「看不到钉选标记」，而不是整份文档 500——那会让账号列表、
 * 积分与签到一起消失，把一个装饰性字段的缺失升级成功能故障。
 */
function readPreferredAccountId(pool: unknown): string | undefined {
  const reader = (pool as { preferredAccountId?: () => string | undefined }).preferredAccountId
  if (typeof reader !== 'function') return undefined
  try {
    const value = reader.call(pool)
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/** 把 token 类内容抹掉再送回浏览器。 */
export function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** 只接受回环浏览器来源；其它设备一律拒绝。 */
function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/** 最小 POST body 读取器，带上限，防止挂起或超大 body 钉住宿主机内存。 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const LIMIT = 64 * 1024
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(text)
        resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 解析状态/签到路由的区域。
 *
 * 合法值之外一律 400（而不是静默回落）：卡片 tab 与文档必须指向同一个区域，
 * 静默回落会让 ai 的标签页读到 cn 的数据。返回值 `undefined` 时响应已写完。
 */
function requestRegion(req: IncomingMessage, res: ServerResponse, allowBody?: Record<string, unknown>): TraePoolRegion | undefined {
  const fromBody = allowBody?.['region']
  const raw = typeof fromBody === 'string'
    ? fromBody
    : new URL(req.url ?? '/', 'http://localhost').searchParams.get('region')
  const region = parseRegionParam(raw)
  if (region === undefined) {
    json(res, 400, { error: `unknown region: ${String(raw).slice(0, 32)}` })
    return undefined
  }
  return region
}

/** 一个账号行的组装输入（把 pool 的簿记摊平）。 */
function toWebAccount(account: TraeAccount, now: number, deps: {
  disabled: boolean
  reserve: number
  reserved: boolean
  credits?: TraeCreditsSnapshot
  creditsError?: string
  checkin?: TraePoolWebCheckin
  checkinError?: string
  deviceSpent?: boolean
}): TraePoolWebAccount {
  const cooling = account.cooldownUntilMs > now
  const deadUntil = account.credentialDeadUntilMs ?? 0
  const credentialDead = deadUntil > now
  const modelCooldowns = Object.entries(account.modelCooldowns)
    .filter(([, until]) => until > now)
    .map(([modelId, until]) => ({ modelId, until: new Date(until).toISOString() }))
  const credits = deps.credits
  return {
    id: account.id,
    label: account.label,
    region: account.region,
    ...account.credential.expiresAtMs > 0 ? { expiresAt: new Date(account.credential.expiresAtMs).toISOString() } : {},
    cooling,
    ...cooling ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
    ...credentialDead ? { credentialDead: true, credentialDeadUntil: new Date(deadUntil).toISOString() } : {},
    ...modelCooldowns.length === 0 ? {} : { modelCooldowns },
    disabled: deps.disabled,
    rateLimitHits: account.rateLimitHits,
    creditReserve: deps.reserve,
    reserved: deps.reserved,
    ...account.lastUsedAt === undefined ? {} : { lastUsedAt: new Date(account.lastUsedAt).toISOString() },
    // 积分总览：到期提醒字段必须产出（nearestExpiryMs/expiringSoon 是本插件的
    // 核心卖点之一，缺了它卡片就没有倒计时可显示）。
    ...credits === undefined ? {} : {
      credits: {
        total: credits.total,
        consumed: credits.consumed,
        available: credits.available,
        packs: credits.packs.map(pack => ({
          displayDesc: pack.displayDesc,
          endTimeMs: pack.endTimeMs,
          ...pack.creditsLimit === undefined ? {} : { creditsLimit: pack.creditsLimit },
          ...pack.consumed === undefined ? {} : { consumed: pack.consumed },
        })),
        ...credits.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: credits.nearestExpiryMs },
        ...credits.expiringSoon === undefined ? {} : { expiringSoon: credits.expiringSoon },
      },
    },
    ...deps.creditsError === undefined ? {} : { creditsError: deps.creditsError },
    ...deps.checkin === undefined ? {} : { checkin: deps.checkin },
    ...deps.checkinError === undefined ? {} : { checkinError: deps.checkinError },
    ...deps.deviceSpent === true ? { deviceSpent: true } : {},
  }
}

/** 签到状态 → 卡片形状。 */
function toCheckin(status: {
  enabled: boolean
  checkedIn: boolean
  didCheckedIn: boolean
  credits: number
  extraCredits?: number
}): TraePoolWebCheckin {
  return {
    enabled: status.enabled,
    checkedIn: status.checkedIn,
    didCheckedIn: status.didCheckedIn,
    credits: status.credits,
    ...status.extraCredits === undefined ? {} : { extraCredits: status.extraCredits },
  }
}

/** 模型行 → 卡片形状。 */
function toWebModel(model: TraeModelInfo, enabled: boolean): TraePoolWebModel {
  return {
    id: model.id,
    name: model.name,
    ...model.multiplier === undefined ? {} : { multiplier: model.multiplier },
    enabled,
    supportsImages: model.supportsImages,
    contextWindow: model.contextWindow,
    // 上游宣告的窗口（未叠加预算）：卡片要能显示「你把它从 1M 压到了 128K」。
    nativeContextWindow: model.maxContextWindow ?? model.contextWindow,
    ...model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens },
    ...model.supportedEfforts === undefined ? {} : { supportedEfforts: model.supportedEfforts },
  }
}

/** 自动化 job 状态 → 卡片形状。 */
function toWebJob(state: AutomationJobState): TraePoolWebAutomationJob {
  return {
    ...state.lastRunDate === undefined ? {} : { lastRunDate: state.lastRunDate },
    ...state.lastRunAtMs === undefined ? {} : { lastRunAtMs: state.lastRunAtMs },
    ...state.firedSlots === undefined ? {} : { firedSlots: [...state.firedSlots] },
    ok: state.ok,
    failed: state.failed,
    claimed: state.claimed,
    credit: state.credit,
    deviceSpent: state.deviceSpent,
    ...state.message === undefined ? {} : { message: state.message },
    ...state.detail === undefined ? {} : { detail: [...state.detail] },
  }
}

/** 无调度器时的空自动化块（卡片渲染同一个形状，而不是缺一块）。 */
function emptyAutomation(): TraePoolWebAutomation {
  return {
    enabled: false,
    running: false,
    checkinHours: [],
    jobs: { checkin: { ok: 0, failed: 0, claimed: 0, credit: 0, deviceSpent: 0 } },
    earningsToday: {},
    runInProgress: false,
  }
}

/** 读取保存的模型选择（分区键优先，legacy 平键兜底）。 */
function savedSelection(config: Record<string, unknown>, region: TraePoolRegion): TraePoolWebModelSelection {
  const sectionKey = region === 'cn' ? 'modelSelectionCn' : 'modelSelectionGlobal'
  const section = config[sectionKey]
  const source = typeof section === 'object' && section !== null && !Array.isArray(section)
    ? section as Record<string, unknown>
    : {}
  const pick = <T>(key: string, legacy: unknown): T[] | undefined => {
    const value = source[key]
    if (Array.isArray(value)) return value as T[]
    if (Array.isArray(legacy)) return legacy as T[]
    return undefined
  }
  const enabled = pick<string>('enabledModelIds', config['enabledModelIds'])
  const images = pick<string>('imageModelIds', config['imageModelIds'])
  const rawBudgets = source['contextBudgets'] ?? config['contextBudgets']
  const budgets = typeof rawBudgets === 'object' && rawBudgets !== null && !Array.isArray(rawBudgets)
    ? rawBudgets as Record<string, number>
    : undefined
  return {
    ...enabled === undefined ? {} : { enabledModelIds: enabled },
    ...images === undefined ? {} : { imageModelIds: images },
    ...budgets === undefined ? {} : { contextBudgets: budgets },
  }
}

/**
 * 组装卡片状态文档。
 *
 * 逐账号组账：`credits` 与 `checkin` 都是异步 best-effort —— 一个账号积分读失败
 * 只降级成该行的 `creditsError`，绝不让整份文档 500。这个取舍是刻意的：卡片最
 * 需要的「谁在冷却、谁被关掉、模型倍率多少」都来自本地簿记，不能因为一个账号的
 * 上游调用超时而一起消失。
 */
export async function buildTraePoolWebStatus(
  deps: TraePoolStatusRouteOptions,
  region: TraePoolRegion,
  options: { probe?: boolean } = {},
): Promise<TraePoolWebStatus> {
  const probe = options.probe ?? true
  const now = Date.now()
  const config = deps.config?.() ?? {}
  const accounts = deps.pool.list(region)
  const rows: TraePoolWebAccount[] = []
  const deviceId = deps.deviceId?.() ?? ''

  for (const account of accounts) {
    const disabled = deps.pool.isDisabled(account.id)
    const reserve = deps.pool.creditReserveOf(account.id)
    const request = { credential: account.credential, identity: undefined as never }
    let credits: TraeCreditsSnapshot | undefined
    let creditsError: string | undefined
    let checkin: TraePoolWebCheckin | undefined
    let checkinError: string | undefined
    if (probe) {
      // 积分只在 CN 区域有端点族（ai 区 404）：不去问就不会把「不支持」渲染成
      // 一个红色的读取失败。
      if (region === 'cn') {
        credits = await deps.client.fetchCredits(request, AbortSignal.timeout(ACCOUNT_PROBE_TIMEOUT_MS))
          .catch((error: unknown) => { creditsError = safeMessage(error); return undefined })
        checkin = await deps.client.fetchCheckinStatus(request, deviceId, AbortSignal.timeout(ACCOUNT_PROBE_TIMEOUT_MS))
          .then(status => toCheckin(status))
          .catch((error: unknown) => { checkinError = safeMessage(error); return undefined })
      }
    }
    // 设备名额受限的判定取**实时**签到状态：did_checked_in 为真而账号级未到账，
    // 就是这个账号被同机另一账号挤掉了。
    const deviceSpent = checkin !== undefined && checkin.didCheckedIn && !checkin.checkedIn
    rows.push(toWebAccount(account, now, {
      disabled,
      reserve,
      reserved: deps.pool.isReserved(account.id) && reserve > 0,
      ...credits === undefined ? {} : { credits },
      ...creditsError === undefined ? {} : { creditsError },
      ...checkin === undefined ? {} : { checkin },
      ...checkinError === undefined ? {} : { checkinError },
      deviceSpent,
    }))
  }

  const catalog = deps.catalogs[region]
  const selection = savedSelection(config, region)
  const enabled = new Set(selection.enabledModelIds ?? [])

  const schedulerStatus = deps.scheduler?.()
  const automation: TraePoolWebAutomation = schedulerStatus === undefined
    ? emptyAutomation()
    : {
        enabled: schedulerStatus.enabled,
        running: schedulerStatus.running,
        checkinHours: [...schedulerStatus.checkinHours],
        jobs: { checkin: toWebJob(schedulerStatus.jobs.checkin) },
        earningsToday: Object.fromEntries(
          Object.entries(schedulerStatus.earningsToday).map(([id, entry]) => [id, toEarnings(entry)]),
        ),
        runInProgress: schedulerStatus.runInProgress,
        ...schedulerStatus.lastPassAtMs === undefined ? {} : { lastPassAtMs: schedulerStatus.lastPassAtMs },
      }

  return {
    ok: true,
    region,
    accounts: rows,
    ...deps.pool.lastServedId() === undefined ? {} : { activeAccountId: deps.pool.lastServedId() },
    // 用户钉选的账号必须出现在文档里：否则「切换用户」点了之后界面毫无变化，
    // 用户无从判断到底生效没有。
    //
    // 读取刻意是防御式的：这是**只读**文档组装路径，不该因为某个可选访问器缺失
    // 就整份失败（那会让账号、积分、签到一起消失）。钉选缺失只是看不到标记，
    // 不会让状态读不出来。
    ...readPreferredAccountId(deps.pool) === undefined
      ? {}
      : { preferredAccountId: readPreferredAccountId(deps.pool) },
    cooling: rows.filter(row => row.cooling).length,
    models: catalog.visible().map(model => toWebModel(model, enabled.size === 0 || enabled.has(model.id))),
    selection,
    distribution: deps.pool.currentDistribution(),
    shim: deps.shim?.(region) ?? { running: false },
    automation,
    creditReserves: deps.pool.creditReservesInOrder(),
    catalogSource: catalog.currentSource(),
    ...catalog.catalogUpdatedAt() === undefined ? {} : { catalogUpdatedAt: catalog.catalogUpdatedAt() },
    ...catalog.lastFetchError() === undefined ? {} : { catalogError: safeMessage(catalog.lastFetchError()) },
  }
}

/** 今日自动化所得 → 卡片形状。 */
function toEarnings(entry: AutomationAccountEarnings): { credit: number; checkinCredit: number; date: string; deviceSpent?: boolean } {
  return {
    credit: entry.credit,
    checkinCredit: entry.checkinCredit,
    date: entry.date,
    ...entry.deviceSpent === true ? { deviceSpent: true } : {},
  }
}

/** 校验模型选择载荷；任何畸形都返回 undefined 让路由答 400，而不是写半个选择。 */
export function parseSelection(body: Record<string, unknown>): TraePoolWebModelSelection | undefined {
  const out: { enabledModelIds?: string[]; imageModelIds?: string[]; contextBudgets?: Record<string, number> } = {}
  for (const key of ['enabledModelIds', 'imageModelIds'] as const) {
    const value = body[key]
    if (value === undefined) continue
    if (!Array.isArray(value)) return undefined
    const ids: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string' || entry === '') return undefined
      ids.push(entry)
    }
    // 空数组合法且有意义（`enabledModelIds: []` = 全部停用），原样保留。
    out[key] = ids
  }
  const budgets = body['contextBudgets']
  if (budgets !== undefined) {
    if (typeof budgets !== 'object' || budgets === null || Array.isArray(budgets)) return undefined
    const map: Record<string, number> = {}
    for (const [id, raw] of Object.entries(budgets as Record<string, unknown>)) {
      if (id === '') return undefined
      // 太小或非整数的预算没有意义（DSH 会按 INVALID_MODEL_CONTEXT 拒绝）。
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1000) return undefined
      map[id] = raw
    }
    out.contextBudgets = map
  }
  return out
}

/** 校验账号开关载荷。 */
function parseAccountToggle(body: Record<string, unknown>, known: (id: string) => boolean): TraePoolWebAccountToggle | undefined {
  const accountId = typeof body['accountId'] === 'string' ? body['accountId'].trim() : ''
  const disabled = body['disabled']
  if (accountId === '' || typeof disabled !== 'boolean') return undefined
  // 只接受当前已知的账号：任意字符串会把孤儿 id 留在设置文件里，卡片再也无法
  // 把它关回去（过期标签页或改过名的凭据都会造成这个）。
  if (!known(accountId)) return undefined
  return { accountId, disabled }
}

/** 校验手动运行载荷。未知 job 名答 400，而不是静默什么都不做。 */
function parseAutomationRun(body: Record<string, unknown>, knownJob: (job: string) => boolean): TraePoolWebAutomationRun | undefined {
  const raw = body['job']
  const force = body['force']
  if (force !== undefined && typeof force !== 'boolean') return undefined
  if (raw === undefined || raw === null || raw === '') return { ...force === undefined ? {} : { force } }
  if (typeof raw !== 'string') return undefined
  const job = raw.trim()
  if (!knownJob(job)) return undefined
  return { job, ...force === undefined ? {} : { force } }
}

/**
 * 在 `webServer` 可用的 context 上挂载路由。
 *
 * 调用方用 `ctx.inject(['webServer'], ...)`，让桌面端启动顺序无法让这次注册
 * 凭空消失。
 */
export function registerTraePoolStatusRoute(ctx: Context, deps: TraePoolStatusRouteOptions): void {
  ctx.effect(() => {
    const disposers: Array<() => void> = []

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: TRAE_POOL_STATUS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        const region = requestRegion(req, res)
        if (region === undefined) return
        try {
          json(res, 200, await buildTraePoolWebStatus(deps, region))
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))

    /**
     * 每日签到领取——本插件**唯一**会改上游账号状态的路由，因此守得比兄弟路由
     * 严得多：仅 POST、仅回环 origin，且状态读取**先跑**，让「该账号今天已经拿到
     * 奖励」的日子永远到不了上游的 claim。
     *
     * `alreadyCheckedIn` 与 `deviceCheckedIn` 刻意是两个独立答案，因为两个标志
     * 含义不同：`checkedIn` 是该账号今天的奖励已存在，`didCheckedIn` 是**这台
     * 机器**用掉了它的签到名额——很可能是为另一个账号用掉的。把后者当成「今天
     * 签过了」是一个已发布过的缺陷：切换账号后卡片显示「今日已签到」并禁用按钮，
     * 结论对但理由错，掩盖了新账号其实一分未得。
     *
     * 上游按北京自然日幂等（重复 claim 回 code 0 但额度不变），但把正确性建立在
     * 上游的宽容上，等于把闸门交到别人手里。
     */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: TRAE_POOL_CHECKIN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error: unknown) {
          return json(res, 400, { error: safeMessage(error) })
        }
        const region = requestRegion(req, res, body)
        if (region === undefined) return
        if (region !== 'cn') {
          // `/trae/api/v2/ug/*` 整个族在国际网关上不存在（实测 404）。这里直接
          // 答 404 是把这件事说清楚，而不是把上游的 HTML 404 当成网络故障抛给用户。
          return json(res, 404, { error: 'check-in is not available for the international region' })
        }
        const accountId = typeof body['accountId'] === 'string' ? body['accountId'].trim() : ''
        if (accountId === '') return json(res, 400, { error: 'accountId is required' })
        const account = deps.pool.list('cn').find(entry => entry.id === accountId)
        if (account === undefined) return json(res, 404, { error: 'unknown account' })
        try {
          const request = { credential: account.credential, identity: undefined as never }
          const deviceId = deps.deviceId?.() ?? ''
          const current = await deps.client.fetchCheckinStatus(request, deviceId)
          if (!current.enabled) {
            return json(res, 409, { error: 'check-in is not enabled for this account' })
          }
          // 只有**账号级**标志能拦住 claim：该账号今天的奖励已存在，确实无事可做，
          // 也没有任何请求值得发出。
          if (current.checkedIn) {
            const claim: TraePoolWebCheckinClaim = {
              claimed: false,
              alreadyCheckedIn: true,
              deviceCheckedIn: current.didCheckedIn,
              checkin: toCheckin(current),
            }
            return json(res, 200, claim)
          }
          // 设备名额已用但账号没有：claim 只会被 9095 拒。不发，如实回报。
          if (current.didCheckedIn) {
            const claim: TraePoolWebCheckinClaim = {
              claimed: false,
              alreadyCheckedIn: false,
              deviceCheckedIn: true,
              code: CHECKIN_DEVICE_ALREADY_CLAIMED,
              message: 'this device already used today\'s check-in',
              checkin: toCheckin(current),
            }
            return json(res, 200, claim)
          }
          // 没有设备号就不能 claim：上游会答 9004（缺 x-device-id）。读得出状态
          // 但领取一定失败，所以不发这一次注定失败的写请求。
          if (deviceId === '') {
            return json(res, 409, { error: 'this installation has no device id; check-in cannot be claimed' })
          }
          const claim = await deps.client.claimCheckin(request, deviceId)
          const checkin = await deps.client.fetchCheckinStatus(request, deviceId).catch(() => current)
          // 9095 是上游自己的「该设备今日已参与签到」：设备名额被别人抢了（另一个
          // 窗口，或者 Trae 客户端本身）。它是拒绝，但是良性的——报成硬错误会让
          // 用户以为坏了，而其实只是今天用完了。
          const deviceClaimed = claim.code === CHECKIN_DEVICE_ALREADY_CLAIMED
          const result: TraePoolWebCheckinClaim = {
            claimed: claim.claimed,
            alreadyCheckedIn: false,
            ...deviceClaimed ? { deviceCheckedIn: true } : {},
            code: claim.code,
            message: claim.message,
            checkin: toCheckin(checkin),
          }
          json(res, 200, result)
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))

    /**
     * 立即运行一次自动化。
     *
     * 后台启动并立即返回：一整轮要几十秒，把卡片请求挂那么久会让浏览器或宿主
     * web server 超时，用户看到一个卡住的按钮，而那一轮其实在正常跑。卡片随后
     * 轮询 status 的 `automation.runInProgress`。
     */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: TRAE_POOL_AUTOMATION_RUN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (deps.runAutomation === undefined) return json(res, 503, { error: 'automation is not available' })
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error: unknown) {
          return json(res, 400, { error: safeMessage(error) })
        }
        const schedule = deps.scheduler?.()
        const known = (job: string): boolean => schedule !== undefined
          && Object.prototype.hasOwnProperty.call(schedule.jobs, job)
        const parsed = parseAutomationRun(body, known)
        if (parsed === undefined) return json(res, 400, { error: 'invalid automation run request' })
        try {
          const started = deps.runAutomation(parsed.job, parsed.force ?? false)
          json(res, 200, { ok: true, started, ...parsed.job === undefined ? {} : { job: parsed.job } })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))

    /** 重扫本机凭据。 */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: TRAE_POOL_RESCAN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (deps.rescan === undefined) return json(res, 503, { error: 'rescan is not available' })
        try {
          await deps.rescan()
          json(res, 200, { ok: true })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))

    /** 清除全部冷却（429 自我修复的手动出口）。 */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: TRAE_POOL_RESET_COOLDOWN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        try {
          if (deps.resetCooldowns !== undefined) await deps.resetCooldowns()
          else deps.pool.resetCooldowns()
          json(res, 200, { ok: true })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))

    /** 开关一个账号。 */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: TRAE_POOL_ACCOUNT_TOGGLE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (deps.setAccountDisabled === undefined) return json(res, 503, { error: 'account switching is not available' })
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error: unknown) {
          return json(res, 400, { error: safeMessage(error) })
        }
        const toggle = parseAccountToggle(body, id => deps.pool.list().some(account => account.id === id))
        if (toggle === undefined) return json(res, 400, { error: 'invalid account toggle' })
        try {
          await deps.setAccountDisabled(toggle.accountId, toggle.disabled)
          json(res, 200, { ok: true, accountId: toggle.accountId, disabled: toggle.disabled })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))

    /**
     * 钉选优先账号（对话栏「切换用户」）。
     *
     * 只改本机的派活顺序，不改上游状态、不写凭据。传空 accountId 表示取消钉选、
     * 回到普通轮转。账号必须存在于当前池里，否则拒绝——钉到一个不存在的账号会
     * 让请求无限等待一个永远不会被派活的号。
     */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: TRAE_POOL_ACCOUNT_SELECT_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error: unknown) {
          return json(res, 400, { error: safeMessage(error) })
        }
        const region = requestRegion(req, res, body)
        if (region === undefined) return
        const raw = body['accountId']
        const accountId = typeof raw === 'string' ? raw.trim() : ''
        // 空串 = 取消钉选，合法且不需要存在性校验。
        if (accountId !== '') {
          const known = deps.pool.list(region).some(account => account.id === accountId)
          if (!known) return json(res, 404, { error: 'account is not in the pool' })
        }
        try {
          deps.pool.prefer(accountId === '' ? undefined : accountId)
          json(res, 200, { ok: true, region, accountId })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))

    /** 保存某区域的模型选择。 */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: TRAE_POOL_MODELS_SAVE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (deps.saveSelection === undefined) return json(res, 503, { error: 'model selection cannot be saved' })
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error: unknown) {
          return json(res, 400, { error: safeMessage(error) })
        }
        const region = requestRegion(req, res, body)
        if (region === undefined) return
        const selection = parseSelection(body)
        if (selection === undefined) return json(res, 400, { error: 'invalid model selection' })
        try {
          await deps.saveSelection(region, selection)
          json(res, 200, { ok: true, region })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))

    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}

/** 供宿主组装的便捷导出：解包 volatile 后的配置读取器工厂。 */
export function configReader(read: () => unknown): () => Record<string, unknown> {
  return () => {
    const live = unwrapVolatileDeep(read())
    return typeof live === 'object' && live !== null && !Array.isArray(live)
      ? live as Record<string, unknown>
      : {}
  }
}
