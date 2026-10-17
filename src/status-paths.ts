/**
 * 宿主与浏览器两半共享的常量与类型（**Node-free**）。
 *
 * 卡片在浏览器包里，不能 import 任何沾 `node:*` 的模块；而路由路径与文档形状
 * 又必须两半完全一致，所以它们单独住在这里。本文件**不得**引入任何 Node 内置
 * 或宿主实现（只允许 `import type`，编译后不留运行时依赖）。
 *
 * @module dsh-connect-trae-models/status-paths
 */

/** 插件自有路由前缀。全部路由挂宿主同源 web server。 */
export const TRAE_POOL_ROUTE_PREFIX = '/plugins/dsh-connect-trae-models'

/** 只读池状态（账号行 + 模型 + shim + 自动化）。 */
export const TRAE_POOL_STATUS_PATH = `${TRAE_POOL_ROUTE_PREFIX}/status`
/** 重新扫描本机 Trae 凭据（重读桌面快照）。 */
export const TRAE_POOL_RESCAN_PATH = `${TRAE_POOL_ROUTE_PREFIX}/accounts/rescan`
/** 清除全部限流冷却。 */
export const TRAE_POOL_RESET_COOLDOWN_PATH = `${TRAE_POOL_ROUTE_PREFIX}/cooldowns/reset`
/**
 * 手动签到（本插件**唯一**会改上游账号状态的用户触发路由）。
 *
 * 守卫比其它路由严得多：仅 POST、仅回环 origin、且读写顺序强制「先读状态、
 * 再决定是否 claim」，见 `web-status.ts` 的 JSDoc。
 */
export const TRAE_POOL_CHECKIN_PATH = `${TRAE_POOL_ROUTE_PREFIX}/checkin`
/** 保存某区域的模型选择（写 settings 分区）。 */
export const TRAE_POOL_MODELS_SAVE_PATH = `${TRAE_POOL_ROUTE_PREFIX}/models/save`
/** 开关一个账号是否参与轮转。 */
export const TRAE_POOL_ACCOUNT_TOGGLE_PATH = `${TRAE_POOL_ROUTE_PREFIX}/accounts/disabled`
/** 立即运行一次自动化 job（卡片「立即运行」按钮）。 */
export const TRAE_POOL_AUTOMATION_RUN_PATH = `${TRAE_POOL_ROUTE_PREFIX}/automation/run`
/**
 * 钉选优先账号：被钉住的账号只要合格就绝对优先派活（对话栏「切换用户」用它）。
 *
 * 只影响本机的派活顺序，不改上游账号状态、也不写凭据——与「停用账号」是两件
 * 不同的事：停用是不让它参与轮转，钉选是在参与者里指定首选。
 */
export const TRAE_POOL_ACCOUNT_SELECT_PATH = `${TRAE_POOL_ROUTE_PREFIX}/accounts/select`

/**
 * 区域查询参数。
 *
 * 卡片一次只问一个区域：两个网关在不同主机上，名册几乎不重叠，把两边混进一个
 * 文档会让「这个模型到底调得动吗」无法回答。
 */
export type TraePoolRegion = 'cn' | 'ai'

/** 默认区域（参数缺失时）。 */
export const TRAE_POOL_DEFAULT_REGION: TraePoolRegion = 'cn'

/** 一个积分包的展示信息（到期提醒的数据源）。 */
export interface TraePoolWebCreditPack {
  /** 来源描述（如「每月登录赠送」「签到奖励」）。 */
  displayDesc: string
  /** 该包额度上限（`quota.credits_limit`）。 */
  creditsLimit?: number
  /** 该包已耗（`usage.credits_amount`）。 */
  consumed?: number
  /** 到期毫秒时间戳（`entitlement_base_info.end_time`；0 = 未回报）。 */
  endTimeMs: number
}

/** 一个账号的积分总览。 */
export interface TraePoolWebCredits {
  total: number
  consumed: number
  available: number
  packs: readonly TraePoolWebCreditPack[]
  /** 最近的未过期包到期毫秒时间戳。 */
  nearestExpiryMs?: number
  /** 3 天内到期的额度合计。 */
  expiringSoon?: number
}

/**
 * 一个账号的签到状态（**双口径**，语义不可合并）。
 *
 * `checkedIn` 是账号级：该账号今天的奖励包已经存在，无论哪台设备领的。
 * `didCheckedIn` 是设备级：按请求携带的 `x-device-id` 判定，本机今天的名额
 * 已用掉——**可能是为另一个账号用掉的**。
 *
 * 把后者当成「今天签过了」是一个已发生过的缺陷：切换账号后卡片显示「今日已
 * 签到」并禁用按钮，判断结论对但理由错，掩盖了新账号其实一分未得。
 */
export interface TraePoolWebCheckin {
  /** 活动开关；仅 true 时卡片才展示领取按钮。 */
  enabled: boolean
  /** 账号级：今日奖励已到账。 */
  checkedIn: boolean
  /** 设备级：本机今日名额已用掉。 */
  didCheckedIn: boolean
  /** 基础奖励面额（上游运行时值，绝不硬编码）。 */
  credits: number
  /** 当日额外奖励面额。 */
  extraCredits?: number
}

/** 一个账号的行（不含任何 token 材料）。 */
export interface TraePoolWebAccount {
  id: string
  label: string
  region: TraePoolRegion
  /** 凭据过期 ISO 时间戳。 */
  expiresAt?: string
  /** 整账号冷却中（每个模型都被挡）。 */
  cooling: boolean
  /** 整账号冷却解除的 ISO 时间戳；仅 cooling 时给出。 */
  cooldownUntil?: string
  /**
   * 上游**拒绝过**该账号的登录（401/403）。
   *
   * 与 `cooling` 不同：等待修不好它，只有重新登录才行——凭据文件在被吊销时
   * 不会改写过期时间，所以死账号看起来永远新鲜。
   */
  credentialDead?: boolean
  /** 死凭据标记解除的 ISO 时间戳；仅 credentialDead 时给出。 */
  credentialDeadUntil?: string
  /** 当前生效的按模型冷却（账号整体不算 cooling，其它模型仍可服务）。 */
  modelCooldowns?: ReadonlyArray<{ modelId: string; until: string }>
  /** 用户是否关闭了该账号（关闭后不派活，但仍在列出以便重开）。 */
  disabled: boolean
  /** 连续限流命中数。 */
  rateLimitHits: number
  /** 用户为该账号保留的积分下限。 */
  creditReserve: number
  /** 是否**仅**因保留线而被挡下（账号本身健康）。 */
  reserved: boolean
  /** 本进程最近一次实际派活时刻，ISO。 */
  lastUsedAt?: string
  /** 积分总览（只读，best-effort）。 */
  credits?: TraePoolWebCredits
  /** 积分读取失败的原因（脱敏、截断）。 */
  creditsError?: string
  /** 今日签到状态（只读，best-effort）。 */
  checkin?: TraePoolWebCheckin
  /** 签到状态读取失败的原因（脱敏、截断）。 */
  checkinError?: string
  /**
   * 本机设备名额已被占用、但**不是**该账号领到的。
   *
   * 多账号池的核心约束：同一台机器一天只能为一个账号签到，其余账号必然
   * 9095。卡片必须如实呈现「设备受限」而不是「已领取」。
   */
  deviceSpent?: boolean
}

/** 一个模型行（交给卡片）。 */
export interface TraePoolWebModel {
  id: string
  name: string
  /** 折后积分倍率（如 0.08 → 「x0.08」）。 */
  multiplier?: number
  /** 该模型当前是否在选择器里启用。 */
  enabled: boolean
  /** 生效的图片输入支持（已叠加用户 opt-in 与上游 multimodal）。 */
  supportsImages: boolean
  /** 生效上下文窗口（已叠加用户预算）。 */
  contextWindow: number
  /** 上游宣告的窗口，未叠加预算。 */
  nativeContextWindow: number
  /** 上游宣告的单次输出上限。 */
  maxOutputTokens?: number
  /** 上游宣告的推理档位。 */
  supportedEfforts?: readonly string[]
}

/** 保存的模型选择（回显给卡片做草稿 diff）。 */
export interface TraePoolWebModelSelection {
  /** 缺失 = 全部启用。 */
  enabledModelIds?: readonly string[]
  /** 缺失 = 跟随上游图片能力。 */
  imageModelIds?: readonly string[]
  /** 按模型 id 的上下文预算。 */
  contextBudgets?: Readonly<Record<string, number | undefined>>
}

/** 一次手动签到的结果。 */
export interface TraePoolWebCheckinClaim {
  /** 上游接受了领取。 */
  claimed: boolean
  /** 账号级：今日奖励本来就在（未发 claim）。 */
  alreadyCheckedIn?: boolean
  /** 设备级：本机名额已用掉（未发 claim，或上游答 9095）。 */
  deviceCheckedIn?: boolean
  /** 上游业务码：0 成功、9095 设备今日已签。 */
  code?: number
  /** 上游原话（脱敏、截断）。 */
  message?: string
  /** 领取后的最新签到状态。 */
  checkin?: TraePoolWebCheckin
}

/** 手动运行一次自动化的结果（异步启动的回执）。 */
export interface TraePoolWebAutomationRunResult {
  ok: true
  /** 是否真的启动了（在途时第二次是 false）。 */
  started: boolean
  job?: string
}

/** 一个自动化 job 的最近一次运行（卡片展示用）。 */
export interface TraePoolWebAutomationJob {
  /** 最近一次完成的北京日 `YYYY-MM-DD`。 */
  lastRunDate?: string
  /** 最近一次完成时刻 epoch ms（只给日期无法区分「跑了一次」和「跑了八次」）。 */
  lastRunAtMs?: number
  /** 今天已消费的调度时段 `YYYY-MM-DDTHH`。 */
  firedSlots?: readonly string[]
  ok: number
  failed: number
  /** 本次运行真正领取成功的账号数。 */
  claimed: number
  /** 本次运行入账的积分。 */
  credit: number
  /** 本次因设备名额受限而跳过的账号数。 */
  deviceSpent: number
  message?: string
  detail?: readonly string[]
}

/** 今日某账号的自动化所得。 */
export interface TraePoolWebAutomationEarnings {
  credit: number
  checkinCredit: number
  date: string
  deviceSpent?: boolean
}

/**
 * 签到 job 的默认执行时刻（本地小时，Asia/Shanghai）。
 *
 * 放在这个 Node-free 共享层而不是 `scheduler.ts`，因为浏览器半端也要用它：
 * 卡片切换自动化开关时必须把小时列表一并写回，而列表为空时要回落到宿主的
 * 同一默认值，否则卡片写一份「跑不起来的日程」而宿主再也读不回来。两份手抄
 * 的常量必然漂移，且漂移是无声的。
 */
export const DEFAULT_CHECKIN_HOURS: readonly number[] = [9]

/** 自动化街区块。 */
export interface TraePoolWebAutomation {
  enabled: boolean
  running: boolean
  /** 签到 job 的配置小时列表（北京时区）。 */
  checkinHours: readonly number[]
  jobs: { checkin: TraePoolWebAutomationJob }
  /** 今日各账号收益；无所得的账号不出现。 */
  earningsToday: Readonly<Record<string, TraePoolWebAutomationEarnings>>
  /** 是否有一次运行在途（卡片轮询它决定何时停止显示进度）。 */
  runInProgress: boolean
  lastPassAtMs?: number
}

/** 选号路由的请求体：一次一个账号。 */
export interface TraePoolWebAccountSelect {
  /** 目标账号 id；空串 = 取消钉选，回到普通轮转。 */
  accountId: string
  region: TraePoolRegion
}

/**
 * 给一个状态路由加上区域参数。
 *
 * 两个区域是两套独立 provider 栈，每条卡片请求都必须说明自己问的是哪一侧，
 * 否则后端无从判断该读哪个账号列表。缺省按国内侧处理，与
 * {@link parseRegionParam} 的缺省一致。
 */
export function withTraeRegion(path: string, region: TraePoolRegion): string {
  return `${path}?region=${region}`
}

/**
 * 池把请求分配到各账号的方式（= 卡片的「账号使用方式」）。
 *
 * 声明在这个 Node-free 层而不是 `pool.ts`：卡片要在浏览器里列出这五种并写回
 * 设置，而 `pool.ts` 带 node 依赖，浏览器端不能 import。两处各写一份必然漂移。
 *
 * - `priority`：先用完一个再换下一个（默认，攒自己的号就该这么用）
 * - `round-robin`：按顺序轮换，花销均摊
 * - `balanced`：按闲置时长加权随机，一个不健康的号无法把池子钉死在自己身上
 * - `sticky`：一个对话只用一个账号（上游提示缓存按租户隔离，中途换号等于作废缓存）
 * - `expiry`：优先花「最快到期」的积分包，过期不花等于白扔
 */
export type TraeDistribution = 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry'

/** 卡片渲染的 JSON 文档。 */
export interface TraePoolWebStatus {
  ok: boolean
  region: TraePoolRegion
  accounts: readonly TraePoolWebAccount[]
  /** 池接下来会用的账号（轮转游标）。 */
  activeAccountId?: string
  /**
   * 用户**钉选**的优先账号；缺失表示没有钉选、走普通轮转。
   *
   * 与 `activeAccountId` 是两件事：后者是「最近实际服务的那个」，由轮转游标
   * 决定、会自己变；前者是用户的显式选择，只有他切账号时才变。两者都放进文档
   * 是为了让「切换用户」看得见结果——否则钉选生效了界面却毫无变化。
   */
  preferredAccountId?: string
  /** 冷却中的账号数。 */
  cooling: number
  models: readonly TraePoolWebModel[]
  /** 保存的选择，卡片据此 diff 草稿。 */
  selection: TraePoolWebModelSelection
  /** 请求如何在池内分布。 */
  distribution: string
  shim: { running: boolean; baseUrl?: string }
  automation: TraePoolWebAutomation
  /** 当前生效的按账号积分保留线。 */
  creditReserves: Readonly<Record<string, number>>
  /** 该区域的模型列表来自哪里（live = 网关，fallback = 静态表）。 */
  catalogSource?: 'live' | 'fallback'
  catalogUpdatedAt?: string
  catalogError?: string
}

/** 账号开关路由的请求体：一次一个账号。 */
export interface TraePoolWebAccountToggle {
  accountId: string
  /** true = 关闭；false = 放回轮转。 */
  disabled: boolean
}

/** 手动运行路由的请求体。 */
export interface TraePoolWebAutomationRun {
  /** job 名；省略 = 跑完整一轮。 */
  job?: string
  /** 绕过「今天已跑过」闸门（再按一次按钮的含义）。 */
  force?: boolean
}

/** 签到路由的请求体：一次一个账号。 */
export interface TraePoolWebCheckinRequest {
  accountId: string
  region?: TraePoolRegion
}

/**
 * 剥掉一层 volatile 活引用。
 *
 * 0.1.7 把一个 volatile 字段以 `{ get(): T }` 交回而不是裸值，因此每次读标记
 * 字段都要解包：把引用往下一层传会拿对象去和字符串比较，字段被当成未设置。
 * 0.1.5 上字段已是裸值，这里是恒等。
 */
export function unwrapVolatile<T>(value: T): T {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as unknown as { get(): T }).get()
  }
  return value
}

/**
 * 深拷贝一个配置值，把里面每一个活 `{get(): T}` 引用换它解析出的值。
 *
 * {@link unwrapVolatile} 只剥普通读取需要的那一层。settings 服务不同：它要校验
 * 并 `structuredClone` **整个**对象，任何残留引用都会让校验失败。
 */
export function unwrapVolatileDeep<T>(value: T): T {
  const peeled = unwrapVolatile(value)
  if (Array.isArray(peeled)) return peeled.map(entry => unwrapVolatileDeep(entry)) as T
  if (peeled !== null && typeof peeled === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(peeled)) out[key] = unwrapVolatileDeep(entry)
    return out as T
  }
  return peeled
}

/**
 * 解析区域查询参数。
 *
 * 返回 `undefined` 表示**非法**（调用方答 400），而不是悄悄回落：卡片 tab 与
 * 文档必须指向同一个区域，静默回落会让用户看着 ai 的标签页读 cn 的数据。缺省
 * （参数不存在）才取 {@link TRAE_POOL_DEFAULT_REGION}。
 */
export function parseRegionParam(value: string | null | undefined): TraePoolRegion | undefined {
  if (value === null || value === undefined || value === '') return TRAE_POOL_DEFAULT_REGION
  if (value === 'cn' || value === 'ai') return value
  return undefined
}
