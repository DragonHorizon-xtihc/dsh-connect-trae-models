/**
 * 多账号 Trae 上游客户端：chat / 目录 / 积分 / 签到 / 活动。
 *
 * 与 dsh-connect-trae 的单账号注入式客户端不同，这里每个方法都显式携带
 * `{ credential, identity }`（账号池为每次调用挑一个账号发请求）。
 *
 * @module dsh-connect-trae-models/upstream
 */

import { mergeTraeModelSources, type TraeModelInfo, type TraeWireModel } from './catalog.ts'
import { parseTraeRemoteModel, type TraeDiscoveredModel } from './model-metadata.ts'
import { buildTraeHeaders, traeEndpoint, type TraeRequestIdentity } from './protocol.ts'
import { collectWireModels, prepareSoloBody, TRAE_DIRECTORY_FUNCTIONS, TRAE_SOLO_CHAT_PATH, TRAE_SOLO_MODELS_PATH } from './solo.ts'
import { bridgeTraeSoloStreamOrFail } from './solo-bridge.ts'
import { REGION_GATEWAYS, regionOfCredential } from './region.ts'

/** 上游错误分类（shim 据此决定冷却与换号策略）。 */
export type TraeUpstreamErrorKind =
  | 'authentication'   // 401/403：凭据失效 → 刷新/冷却账号
  | 'hard_credit'      // 402（或流内 1005）：积分耗尽/订阅门槛 → 冷却账号并换号
  | 'soft_rate'        // 429：限流 → 模型级冷却并换号
  | 'not_found'
  | 'server'
  | 'client'
  | 'unconfigured'

/** chat 结果：成功给出可流式转发的 Response。 */
export type TraeChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: TraeUpstreamErrorKind; message: string }

/** 按 HTTP 状态分类上游错误（dsh-connect-trae solo.ts 同语义）。 */
export function classifyTraeError(status: number): TraeUpstreamErrorKind {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 402) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把一个上游时间戳归一化到毫秒。
 *
 * `entitlement_base_info.end_time` 是**秒级**时间戳——实测基准
 * `start_time=1790382849` 对应 2026-09-26 08:34:09（北京），十位数即秒。
 * 直接当毫秒用会让 `new Date()` 落到 1970 年，并让每个包都判定为「已过期」，
 * 于是到期提醒要么显示 1970 年、要么整体走灰显分支。
 *
 * 判定按量级而不是按字段：大于 1e12 的已经是毫秒（保护未来上游改用毫秒），
 * 其余乘以 1000。0/负数/非数字返回 0（= 上游未回报到期时间，不是「已过期」）。
 */
export function toEpochMs(value: unknown): number {
  const raw = asNumber(value)
  if (raw === undefined || raw <= 0) return 0
  return raw > 1e12 ? raw : raw * 1000
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 一个积分包的到期/额度明细（到期提醒的数据源）。 */
export interface TraeCreditPack {
  /** 来源描述（如「每月登录赠送」「签到奖励」）。 */
  displayDesc: string
  /** 包 id。 */
  entitlementId: string
  /** 该包总额度（`quota.credits_limit`）。 */
  creditsLimit?: number
  /** 该包已耗（`usage.credits_amount`）。 */
  consumed?: number
  /** 到期毫秒时间戳（`entitlement_base_info.end_time`；0 = 未回报）。 */
  endTimeMs: number
  /** 积分币种（实测 0=免费、1=通用/Work）。 */
  currency?: number
}

/** 积分快照：总量 + 分包明细 + 到期提醒字段。 */
export interface TraeCreditsSnapshot {
  total: number
  consumed: number
  available: number
  packs: TraeCreditPack[]
  /** 最近的未过期包到期毫秒时间戳（没有未过期包时 undefined）。 */
  nearestExpiryMs?: number
  /** 3 天内到期的额度合计。 */
  expiringSoon?: number
  /** 「3 天内到期」窗口的毫秒长度（测试与展示共用）。 */
  expiringSoonWindowMs: number
}

/** 签到状态（双口径字段语义不可合并——见 docs/RESEARCH.md §1.1）。 */
export interface TraeCheckinStatus {
  /** 账号级：该账号今日奖励包已存在（无论哪台设备领取的）。 */
  checkedIn: boolean
  /** 设备级：按请求携带的 `x-device-id` 判定，本机今日名额已用掉。 */
  didCheckedIn: boolean
  /** 基础奖励面额（上游回报的运行时值，绝不硬编码）。 */
  credits: number
  /** 活动开关（缺省视为开启）。 */
  enabled: boolean
  /** 当日额外奖励面额（随活动变动）。 */
  extraCredits?: number
}

/** 领取结果。业务拒绝以 `claimed:false` + code 返回，不抛异常。 */
export interface TraeCheckinClaim {
  /** 上游接受（`code === 0`）。 */
  claimed: boolean
  /** 业务码：0 成功；9004 缺 x-device-id；9095 设备今日已签。 */
  code: number
  /** 上游消息（截断，不含 token）。 */
  message: string
}

/** 一条活动规则（`ug/activity/info`）。 */
export interface TraeActivityRule {
  activityId: string
  enabled: boolean
  activityType: number
  startTimeMs: number
  endTimeMs: number
  workExtra?: Record<string, unknown>
}

export interface TraeUpstreamClientOptions {
  /** 测试/诊断用 fetch 注入。 */
  fetchImpl?: typeof fetch
  /** 请求超时毫秒。 */
  timeoutMs?: number
  /**
   * 首字节超时毫秒：请求发出后这么久还没拿到响应头就判失败。
   * 缺省 {@link TRAE_FIRST_BYTE_TIMEOUT_MS}。
   */
  firstByteTimeoutMs?: number
  /** 诊断日志。 */
  log?: (message: string, detail?: unknown) => void
  /** 显式覆盖区域（测试用）；缺省按凭据推导。 */
  region?: 'cn' | 'ai'
  /** 显式覆盖网关 base（测试用）。 */
  bases?: Partial<Record<'chat' | 'remote' | 'pay', string>>
}

/** 默认的「3 天内到期」提醒窗口。 */
export const TRAE_EXPIRING_SOON_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/** 区域的 pay base（积分/签到/活动家族）。 */
function payBaseFor(region: 'cn' | 'ai', options: TraeUpstreamClientOptions): string {
  return options.bases?.pay ?? REGION_GATEWAYS[region].pay
}

/** 解析积分快照（含到期提醒字段），纯函数便于测试。 */
export function parseCreditsSnapshot(payload: unknown, nowMs = Date.now()): TraeCreditsSnapshot {
  const doc = recordOf(payload) ?? {}
  const summary = recordOf(doc['usage_summary']) ?? {}
  const total = asNumber(summary['total_amount']) ?? 0
  const consumed = asNumber(summary['consumed_amount']) ?? 0
  const packs: TraeCreditPack[] = []
  const rawPacks = Array.isArray(doc['user_entitlement_pack_list']) ? doc['user_entitlement_pack_list'] : []
  let nearestExpiryMs: number | undefined
  let expiringSoon = 0
  for (const raw of rawPacks) {
    const pack = recordOf(raw)
    if (pack === undefined) continue
    const base = recordOf(pack['entitlement_base_info']) ?? {}
    const quota = recordOf(base['quota']) ?? {}
    const usage = recordOf(pack['usage']) ?? {}
    const creditsLimit = asNumber(quota['credits_limit'])
    const packConsumed = asNumber(usage['credits_amount'])
    // 上游 `end_time` 是秒级时间戳，必须归一化到毫秒后再参与到期判定与展示。
    const endTimeMs = toEpochMs(base['end_time'])
    packs.push({
      displayDesc: typeof pack['display_desc'] === 'string' ? pack['display_desc'] : '',
      entitlementId: typeof base['entitlement_id'] === 'string' ? base['entitlement_id'] : '',
      endTimeMs,
      currency: asNumber(base['currency']),
      ...creditsLimit === undefined ? {} : { creditsLimit },
      ...packConsumed === undefined ? {} : { consumed: packConsumed },
    })
    // 到期提醒：只统计未来到期的包；end_time 缺失/为 0 的包不参与提醒。
    if (endTimeMs > nowMs) {
      if (nearestExpiryMs === undefined || endTimeMs < nearestExpiryMs) nearestExpiryMs = endTimeMs
      if (endTimeMs <= nowMs + TRAE_EXPIRING_SOON_WINDOW_MS) {
        const remaining = creditsLimit !== undefined && packConsumed !== undefined
          ? Math.max(0, creditsLimit - packConsumed)
          : (creditsLimit ?? 0)
        expiringSoon += remaining
      }
    }
  }
  return {
    total,
    consumed,
    available: total - consumed,
    packs,
    expiringSoonWindowMs: TRAE_EXPIRING_SOON_WINDOW_MS,
    ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs },
    ...expiringSoon > 0 ? { expiringSoon } : {},
  }
}

/** 解析签到状态，纯函数便于测试。 */
export function parseCheckinStatus(payload: unknown): TraeCheckinStatus {
  const doc = recordOf(payload) ?? {}
  const extraCredits = asNumber(doc['extra_credits'])
  return {
    checkedIn: doc['checked_in'] === true,
    didCheckedIn: doc['did_checked_in'] === true,
    credits: asNumber(doc['credits']) ?? 0,
    enabled: doc['enable'] !== false,
    ...extraCredits === undefined || extraCredits <= 0 ? {} : { extraCredits },
  }
}

/** 解析领取结果，纯函数便于测试。 */
export function parseCheckinClaim(payload: unknown): TraeCheckinClaim {
  const doc = recordOf(payload) ?? {}
  const code = asNumber(doc['code']) ?? 0
  return {
    claimed: code === 0,
    code,
    message: typeof doc['message'] === 'string' ? doc['message'].slice(0, 200) : '',
  }
}

/** 解析活动规则，纯函数便于测试。 */
export function parseActivities(payload: unknown): TraeActivityRule[] {
  const doc = recordOf(payload) ?? {}
  const rawActivities = Array.isArray(doc['commercial_activities']) ? doc['commercial_activities'] : []
  const activities: TraeActivityRule[] = []
  for (const raw of rawActivities) {
    const rule = recordOf(raw)
    if (rule === undefined) continue
    activities.push({
      activityId: typeof rule['activity_id'] === 'string' ? rule['activity_id'] : '',
      enabled: rule['Enabled'] === true,
      activityType: asNumber(rule['activity_type']) ?? 0,
      startTimeMs: asNumber(rule['start_time_ms']) ?? 0,
      endTimeMs: asNumber(rule['end_time_ms']) ?? 0,
      ...rule['work_extra'] === undefined ? {} : { workExtra: rule['work_extra'] as Record<string, unknown> },
    })
  }
  return activities
}

/** 远端目录 `/models` 的回应分组解析（同 id 保留更强容量行）。 */
function preferStrongerRow(candidate: TraeDiscoveredModel, incumbent: TraeDiscoveredModel | undefined): TraeDiscoveredModel {
  if (incumbent === undefined) return candidate
  const candidateMax = candidate.maxContextWindow
  const incumbentMax = incumbent.maxContextWindow
  if (candidateMax !== undefined && incumbentMax === undefined) return candidate
  if (candidateMax === undefined && incumbentMax !== undefined) return incumbent
  if (candidateMax !== undefined && incumbentMax !== undefined && candidateMax !== incumbentMax) {
    return candidateMax > incumbentMax ? candidate : incumbent
  }
  return (candidate.contextWindow ?? 0) > (incumbent.contextWindow ?? 0) ? candidate : incumbent
}

/** 远端目录要问的 function 分组（两个区域同表，见 dsh-connect-trae solo-remote.ts）。 */
const TRAE_REMOTE_DIRECTORY_FUNCTIONS: readonly string[] = [
  'solo_agent', 'solo_agent_remote', 'solo_work_remote', 'solo_work_lite', 'chat_v3', 'solo_coder', 'builder_v3',
]

/**
 * 多账号 Trae 上游客户端。
 *
 * 网络方法都在客户端内部组合「凭据 + 本机身份」并按凭据区域路由网关；
 * 所有解析函数单独导出，测试直接覆盖 wire 契约。
 */
/**
 * 首字节超时：从发出请求起算，这么久还没拿到响应头就判失败。
 *
 * 背景：HTTP 200 之前的慢分两类——网络/网关故障，以及上游对「目录里有、实际
 * 不服务」的模型建立连接后迟迟不回响应头。对后者，旧写法用 120 秒兜底且把超时
 * 归为可重试的 `server`，shim 会换号再来一轮，白等数分钟。
 *
 * 注意（2026-10-13 取证修正）：Seed-2.1-Pro-0915「长时间无响应」的真正主因
 * **不是**不回响应头——它 2~3 秒就回 200，随后只发 `request_wait_in_queue`
 * 排队事件（实测晚高峰 300+ 位）。排队由 solo-bridge 转成 SSE 注释帧保活，
 * 不经过这里的超时。本超时只负责响应头阶段的故障收敛。
 *
 * 首字节超时把响应头阶段的挂起变成几秒内可见的失败，且归类为 `client`
 * （不可重试），让 shim 立刻给出可读错误而不是反复换号。
 */
export const TRAE_FIRST_BYTE_TIMEOUT_MS = 15_000

export class TraeUpstreamClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly firstByteTimeoutMs: number

  constructor(private readonly options: TraeUpstreamClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.firstByteTimeoutMs = options.firstByteTimeoutMs ?? TRAE_FIRST_BYTE_TIMEOUT_MS
  }

  private regionOf(request: TraeRequestIdentity): 'cn' | 'ai' {
    return this.options.region ?? regionOfCredential(request.credential)
  }

  private signalOf(signal?: AbortSignal): AbortSignal {
    return signal ?? AbortSignal.timeout(this.timeoutMs)
  }

  /**
   * `get_detail_param` union 目录：按区域依次问每个 function，首个列出某
   * config_name 的 function 拥有它（chat 必须回放该 function）。
   * 单个 function 失败不隐藏其他 function 的名册；全空才抛错。
   */
  async fetchModels(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeWireModel[]> {
    const region = this.regionOf(request)
    const base = this.options.bases?.chat ?? REGION_GATEWAYS[region].chat
    const headers = { ...buildTraeHeaders(request, { profile: 'model-detail' }), Accept: 'application/json' }
    const byId = new Map<string, TraeWireModel>()
    const failures: string[] = []
    for (const directoryFunction of TRAE_DIRECTORY_FUNCTIONS[region]) {
      let list: unknown[]
      try {
        const response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_MODELS_PATH), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            function: directoryFunction,
            config_names: null,
            need_prompt: false,
            current_config_info: null,
            poly_prompt: true,
            mode_type: null,
            agent_type: null,
          }),
          signal: this.signalOf(signal),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const document = await response.json() as Record<string, unknown>
        list = Array.isArray(document['config_info_list']) ? document['config_info_list'] : []
      } catch (error: unknown) {
        failures.push(`${directoryFunction}: ${String(error).slice(0, 80)}`)
        continue
      }
      collectWireModels(list, directoryFunction, byId)
    }
    const models = [...byId.values()]
    if (models.length === 0) {
      throw new Error(`Trae models response contained no models (${failures.join('; ') || 'empty directory'})`)
    }
    return models
  }

  /**
   * 远端目录 `/api/remote/v1/models`：union 全部 function 分组，同 id 保留
   * 更强容量行。这是模型骨架（显示 id/窗口/倍率/multimodal）的来源。
   */
  async fetchRemoteCatalog(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeDiscoveredModel[]> {
    const region = this.regionOf(request)
    const base = this.options.bases?.remote ?? REGION_GATEWAYS[region].remote
    // 区域化请求包装：CN 用中文门户形态，ai 用英文/新加坡形态（各自实测接受）。
    const dressing = region === 'ai'
      ? { referer: 'https://coresg-normal.trae.ai/', timezone: 'Asia/Singapore', language: 'en' }
      : { referer: 'https://solo.trae.cn/', timezone: 'Asia/Shanghai', language: 'zh-cn' }
    const headers = {
      'Authorization': `Cloud-IDE-JWT ${request.credential.accessToken}`,
      'Content-Type': 'application/json',
      'x-trae-client-type': 'web',
      'x-trae-user-timezone': dressing.timezone,
      'x-preferenced-language': dressing.language,
      'Referer': dressing.referer,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
    const functions = TRAE_REMOTE_DIRECTORY_FUNCTIONS.join(',')
    const response = await this.fetchImpl(`${base}/models?functions=${functions}`, {
      headers, signal: this.signalOf(signal),
    })
    if (!response.ok) throw new Error(`SOLO remote models returned HTTP ${response.status}`)
    const json = await response.json() as { code?: number; data?: { list?: { function?: string; models?: unknown[] }[] } }
    const groups = json.data?.list ?? []
    const byId = new Map<string, TraeDiscoveredModel>()
    for (const group of groups) {
      for (const raw of group.models ?? []) {
        const model = parseTraeRemoteModel(raw)
        if (model === undefined) continue
        byId.set(model.id, preferStrongerRow(model, byId.get(model.id)))
      }
    }
    const models = [...byId.values()]
    if (models.length === 0) throw new Error('SOLO remote models response contained no models')
    return models
  }

  /** 合并远端骨架与 wire 目录（照抄 mergeTraeModelSources 语义）。 */
  mergeCatalog(remote: readonly TraeDiscoveredModel[], wire: readonly TraeWireModel[]): TraeModelInfo[] {
    return mergeTraeModelSources(remote, wire)
  }

  /**
   * 发起一次 `llm_utils_chat` 流式对话。
   *
   * `bodyJson` 是已经盖好 wire 章的 Trae envelope（config_name/function 由
   * shim 侧 `stampTraeWireTarget` 按目录解析；本方法不再做默认 function 猜测）。
   * 成功后经 peek 桥接把早期拒绝转为真实错误。HTTP 失败按
   * {@link classifyTraeError} 分类。
   *
   * @param labelModel 转发给 DSH 的 SSE chunk 标签；缺省用 envelope 里的
   *   config_name。shim 传入 DSH 原本请求的显示 id——wire config_name 可能与
   *   显示 id 不同（如 Seed-Code 家族），标签必须仍是调用方点名的那一个。
   */
  async chatStream(
    request: TraeRequestIdentity,
    bodyJson: string,
    signal?: AbortSignal,
    labelModel?: string,
  ): Promise<TraeChatResult> {
    let prepared: string
    try { prepared = prepareSoloBody(bodyJson, undefined, undefined) }
    catch { return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' } }
    const region = this.regionOf(request)
    const base = this.options.bases?.chat ?? REGION_GATEWAYS[region].chat
    const headers = buildTraeHeaders(request, { profile: 'chat' })
    const sent = await this.postSoloChat(base, headers, prepared, signal)
    if (!sent.ok) {
      this.options.log?.('dsh-connect-trae-models: llm_utils_chat rejected', { status: sent.status, message: sent.message })
      return sent
    }
    // 模型 id 作为 SSE chunk 的 label——DSH 请求什么就标什么；只有调用方没给
    // 标签时才退回 envelope 内的 config_name。
    let model = typeof labelModel === 'string' && labelModel !== '' ? labelModel : 'glm-5.2'
    try {
      const input = JSON.parse(prepared) as Record<string, unknown>
      if (typeof input['model'] === 'string' && input['model'] !== '' && labelModel === undefined) model = input['model']
    } catch { /* prepared 已校验过 JSON，理论上不可达 */ }
    return await bridgeTraeSoloStreamOrFail(sent.response, model)
  }

  /** 便捷方法：调用方已持有 prepared envelope 时直接发（跳过 prepareSoloBody）。 */
  async chatPrepared(
    request: TraeRequestIdentity,
    prepared: string,
    signal?: AbortSignal,
    labelModel?: string,
  ): Promise<TraeChatResult> {
    const region = this.regionOf(request)
    const base = this.options.bases?.chat ?? REGION_GATEWAYS[region].chat
    const headers = buildTraeHeaders(request, { profile: 'chat' })
    const sent = await this.postSoloChat(base, headers, prepared, signal)
    if (!sent.ok) return sent
    let model = typeof labelModel === 'string' && labelModel !== '' ? labelModel : 'glm-5.2'
    try {
      const input = JSON.parse(prepared) as Record<string, unknown>
      if (typeof input['model'] === 'string' && input['model'] !== '' && labelModel === undefined) model = input['model']
    } catch { /* 不可达 */ }
    return await bridgeTraeSoloStreamOrFail(sent.response, model)
  }

  /**
   * 发出一次 chat 请求，带**首字节（响应头阶段）超时**。
   *
   * 只覆盖「等响应头」：连接建立但上游迟迟不回响应头时，旧写法用 120 秒兜底
   * 且把超时归为可重试的 `server`，shim 会反复换号白等数分钟。这里压到首字节
   * 超时并归为 `client`（不可重试）——响应头都没有时换账号没有意义。
   *
   * 注意 body 阶段（含热门模型的分钟级排队）不在本超时范围内：拿到响应头后
   * 定时器即解除，由 solo-bridge 的排队保活/静默保护与调用方 signal 负责。
   * 调用方 signal 与首字节超时取「先到者胜出」。
   */
  private async postSoloChat(
    base: string,
    headers: Record<string, string>,
    prepared: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; response: Response } | { ok: false; status: number; kind: TraeUpstreamErrorKind; message: string }> {
    // 首字节超时只覆盖「等响应头」阶段。必须用可解除的 AbortController +
    // setTimeout：`AbortSignal.timeout()` 的定时器无法在拿到响应头后拆除——
    // 旧写法对 signal 对象本身做 clearTimeout 是空操作，结果首字节超时在
    // 流式排队（实测 Seed 排队数分钟）期间仍然触发，把本来健康的长请求在 15 秒
    // 整拦腰 abort（2026-10-13 端到端实测）。响应头一旦 settle 就 clearTimeout，
    // 后续 body 读取只受调用方 signal 与桥接层静默保护约束。
    const firstByte = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      firstByte.abort()
    }, this.firstByteTimeoutMs)
    const combined = signal === undefined
      ? firstByte.signal
      : AbortSignal.any([signal, firstByte.signal])
    let response: Response
    try {
      response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_CHAT_PATH), {
        method: 'POST', headers, body: prepared, signal: combined,
      })
    } catch (error: unknown) {
      // 区分三种中止：首字节超时（client，不可重试）、调用方取消（server 语义由
      // 调用方决定，但这里不再是超时）、真网络故障。
      if (timedOut && !(signal?.aborted)) {
        return {
          ok: false,
          status: 0,
          kind: 'client',
          message: `Trae 模型未在 ${Math.round(this.firstByteTimeoutMs / 1000)} 秒内开始响应（已中止）；该模型可能当前不可用，请更换模型重试`,
        }
      }
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 1024)
      return { ok: false, status: response.status, kind: classifyTraeError(response.status), message: text || `Trae SOLO returned HTTP ${response.status}` }
    }
    return { ok: true, response }
  }

  /**
   * 积分快照（CN only；`/trae/api/v2/pay/web_user_ent_usage`）。
   * 只读操作，不消耗积分。返回总量/分包/到期提醒字段。
   */
  async fetchCredits(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeCreditsSnapshot> {
    const payload = await this.payPost(request, '/trae/api/v2/pay/web_user_ent_usage', { require_usage: true }, signal)
    return parseCreditsSnapshot(payload, Date.now())
  }

  /**
   * 签到状态（CN only）。读请求带 `x-device-id`（有则带）：`did_checked_in`
   * 是设备口径，缺头会让已签设备看起来和没签设备一样。
   */
  async fetchCheckinStatus(request: TraeRequestIdentity, deviceId: string, signal?: AbortSignal): Promise<TraeCheckinStatus> {
    const payload = await this.payPost(request, '/trae/api/v2/ug/checkin_credits/status', {}, signal, deviceId)
    return parseCheckinStatus(payload)
  }

  /**
   * 领取今日签到奖励（CN only；客户端中唯一的写操作）。
   * 必须携带 `x-device-id`——上游以它判定设备名额；缺失时上游答业务码 9004。
   * 业务拒绝（9004/9095）以 `claimed:false` 返回而不是抛错。
   */
  async claimCheckin(request: TraeRequestIdentity, deviceId: string, signal?: AbortSignal): Promise<TraeCheckinClaim> {
    const payload = await this.payPost(request, '/trae/api/v2/ug/checkin_credits/claim', {}, signal, deviceId)
    return parseCheckinClaim(payload)
  }

  /** 活动规则（CN only；checkin_credits/new_user_credits/send_message_reward 等）。 */
  async fetchActivities(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeActivityRule[]> {
    const payload = await this.payPost(request, '/trae/api/v2/ug/activity/info', {}, signal)
    return parseActivities(payload)
  }

  /** pay/ug 家族的 POST（HTTP 非 200 抛错；业务码由各方法自行解析）。 */
  private async payPost(
    request: TraeRequestIdentity,
    path: string,
    data: Record<string, unknown>,
    signal?: AbortSignal,
    deviceId?: string,
  ): Promise<unknown> {
    const region = this.regionOf(request)
    const base = payBaseFor(region, this.options)
    const headers = buildTraeHeaders(request, { profile: 'pay', deviceId })
    const response = await this.fetchImpl(traeEndpoint(base, path), {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
      signal: this.signalOf(signal),
    })
    if (!response.ok) throw new Error(`Trae usage endpoint ${path} returned HTTP ${response.status}`)
    return await response.json() as unknown
  }
}

/**
 * 方法级的独立包装（T4/T5 契约要求，见 index.ts 的说明）。
 *
 * 每个函数都是「建一个默认客户端，调同名方法」的薄包装，语义与实例方法完全
 * 一致——存在的理由是让调用方（shim 测试、主装配）可以在模块层单独 import 与
 * 打桩，而不必先构造 TraeUpstreamClient 实例。需要注入 fetch/super 诊断/网关
 * 覆盖时请直接用 TraeUpstreamClient。
 */
export function fetchModels(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeWireModel[]> {
  return new TraeUpstreamClient().fetchModels(request, signal)
}

/** @see TraeUpstreamClient.fetchRemoteCatalog */
export function fetchRemoteCatalog(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeDiscoveredModel[]> {
  return new TraeUpstreamClient().fetchRemoteCatalog(request, signal)
}

/** @see TraeUpstreamClient.mergeCatalog */
export function mergeCatalog(remote: readonly TraeDiscoveredModel[], wire: readonly TraeWireModel[]): TraeModelInfo[] {
  return mergeTraeModelSources(remote, wire)
}

/** @see TraeUpstreamClient.chatStream */
export function chatStream(request: TraeRequestIdentity, bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult> {
  return new TraeUpstreamClient().chatStream(request, bodyJson, signal)
}

/** @see TraeUpstreamClient.fetchCredits */
export function fetchCredits(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeCreditsSnapshot> {
  return new TraeUpstreamClient().fetchCredits(request, signal)
}

/** @see TraeUpstreamClient.fetchCheckinStatus */
export function fetchCheckinStatus(request: TraeRequestIdentity, deviceId: string, signal?: AbortSignal): Promise<TraeCheckinStatus> {
  return new TraeUpstreamClient().fetchCheckinStatus(request, deviceId, signal)
}

/** @see TraeUpstreamClient.claimCheckin */
export function claimCheckin(request: TraeRequestIdentity, deviceId: string, signal?: AbortSignal): Promise<TraeCheckinClaim> {
  return new TraeUpstreamClient().claimCheckin(request, deviceId, signal)
}

/** @see TraeUpstreamClient.fetchActivities */
export function fetchActivities(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeActivityRule[]> {
  return new TraeUpstreamClient().fetchActivities(request, signal)
}
