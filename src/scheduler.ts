/**
 * 积分自动化调度器：每日签到（Trae 自动化面的全部）。
 *
 * 蓝本 = dsh-workbuddy-xdpool scheduler.ts（tick 循环 / hour lists / firedSlots
 * per-slot 去重 / earnings ledger / 失败隔离 / 手动 runAll），但**只有一类 job**，
 * 这不是省略而是研究结论：
 *
 * Trae 的自动化面收敛为单一 `checkin_credits/claim`。docs/RESEARCH.md §5 逐项核对
 * 过其余全部积分来源：`new_user_credits` 注册时一次性发放、无领取接口；
 * `send_message_reward` 触发条件是真实发送消息（消耗大于奖励）且无 claim 端点；
 * `solo_fission` 需真实新用户注册；`express_lottery` 接口未知；网页端任务中心
 * 不存在；`monthly_bonus` 每月首次登录**自动到账**、无需任何动作。WorkBuddy 那套
 * 五类 job（report/tasks/streak/travel）依赖的成长中心体系在 Trae 完全没有对应
 * 端点族。因此这里不做 report/tasks/streak/travel —— 为一个不存在的接口写 job
 * 只会产生噪音。
 *
 * hour lists 的形状（`checkinHours: readonly number[]`）保留下来，因为
 * RESEARCH.md §5.4 建议「0 点后执行并配置错峰重试」，多时段是真实需求；
 * `extraJobHours` 是给未来新增可自动任务预留的扩展点（见 {@link AutomationOptions}）。
 *
 * 与 workbuddy scheduler 的一处**刻意不同**：账号筛选不跳过冷却账号。Trae 的
 * 账户级冷却是为对话路由设的（429 限流 / 欠费 30 分钟），签到走的是完全独立的
 * pay/ug 端点，不该被对话侧的限流连坐 —— 跳过冷却账号会让一个当天还能签到的
 * 账号白白错过。这里只跳过用户显式禁用的账号与 ai 区域账号。
 *
 * @module dsh-connect-trae-models/scheduler
 */

import type { TraeIdentity } from './identity.ts'
import type { TraeAccount, TraeAccountPool } from './pool.ts'
import type { TraeRequestIdentity } from './protocol.ts'
import type { TraeCheckinStatus, TraeUpstreamClient } from './upstream.ts'
// 默认时刻的唯一来源在 Node-free 共享层：卡片切换开关时要用同一个值回填，
// 在这里另抄一份会让两边无声漂移。
import { DEFAULT_CHECKIN_HOURS } from './status-paths.ts'

export { DEFAULT_CHECKIN_HOURS }

/** 调度循环的唤醒间隔（毫秒）。 */
export const AUTOMATION_TICK_MS = 60_000

/**
 * 签到判定的时区。
 *
 * 上游按**北京自然日**幂等（同一日重复 claim 仍回 code 0 但额度不变），所以
 * 「今天签没签」必须用北京日算，而不是跑 DSH 那台机器的本地日。用 `getHours()`
 * 会让「09:00」变成宿主本地 09:00 —— 在非东八区机器上就是一次永远不到点的签到。
 */
export const AUTOMATION_TIME_ZONE = 'Asia/Shanghai'

/** 账号之间的串行间隔，避免一个池子打成一阵突发。 */
export const AUTOMATION_ACCOUNT_DELAY_MS = 800

/** 日志面，保持结构化以便任意宿主 logger 适配。 */
export interface SchedulerLogger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
}

/** 某账号今日的设备名额占用记录（9095 与 did_checked_in 都会产生）。 */
export interface AutomationAccountEarnings {
  /** 从签到拿到的积分合计（基础 + 额外）。 */
  credit: number
  /** 其中来自签到的部分，与 `credit` 相同——保留字段名以便卡片分栏显示。 */
  checkinCredit: number
  /** 这些计数所属的北京日（`YYYY-MM-DD`）。 */
  date: string
  /**
   * 本机设备号今天被用掉了、但**不是**当前账号领到的（账号级与设备级是两个
   * 独立事实）。UI 必须区分「已领取」与「设备名额被占」，见 RESEARCH.md §5.1。
   */
  deviceSpent?: boolean
}

/**
 * 持久化的当日收益账本。
 *
 * `date` 是计数所属的北京时间日：加载时早于今天的账本被丢弃，而不是当作
 * 「今天」继续累加。
 */
export interface AutomationLedger {
  date: string
  accounts: Record<string, AutomationAccountEarnings>
}

/** 单账号在**一次运行**里的所得（runPass 的逐账号结果，也是账本的增量）。 */
export interface AutomationAccountGain {
  credit: number
  checkinCredit: number
  deviceSpent?: boolean
}

/** 一类 job 的最近一次运行记录（出现在状态文档上）。 */
export interface AutomationJobState {
  /** 最近一次完成运行的北京日 `YYYY-MM-DD`。 */
  lastRunDate?: string
  /**
   * 最近一次运行所在（或消费）的调度时段 `YYYY-MM-DDTHH`。
   *
   * 调度去重键是时段而不是日期：只按日期去重会把每个 job 压成一天一次，
   * 而 `checkinHours: [9, 21]` 这类多时段配置就是要在多个小时各跑一次。
   */
  lastRunSlot?: string
  /**
   * 今天已经消费掉的调度时段集合（`YYYY-MM-DDTHH`）。
   *
   * 真正的闸门是它、而不是单个「最后一个时段」字段：job 配 `[9, 21]` 会跑两次，
   * 一个标量只能记住其中一个——第二次运行会把第一次擦掉，于是 9 点那个候选又
   * 看起来没消费过，job 从 21 点起每小时重跑。
   *
   * 值永远是**配置的小时**，绝不是运行恰好结束的时刻。存结束时刻是原始缺陷：
   * 读取方拿它去和配置候选比对，两者几乎永远不相等，闸门就整天开着。
   *
   * 与其余 `states` 一样只在内存里：这是单进程的记录，而「补跑」设计本身
   * 就要求补上 DSH 关闭期间经过的小时。**会持久化的是 `AutomationLedger`**。
   */
  firedSlots?: readonly string[]
  /**
   * 最近一次运行**开始**所在时段（`YYYY-MM-DDTHH`）。
   *
   * 与 {@link firedSlots} 分开是刻意的：这是节流（同一个时钟小时内不重复启动），
   * 而 firedSlots 是调度账本。把两者混为一谈，正是「13:00 补跑擦掉 9 点记录」
   * 那个缺陷的来源。
   */
  lastFiredHour?: string
  /** 最近一次完成运行的 epoch ms。 */
  lastRunAtMs?: number
  /** 未抛错完成的账号数（含跳过的）。 */
  ok: number
  /** 抛错的账号数（逐个跳过，运行继续）。 */
  failed: number
  /** 本次运行真正领取成功的账号数。 */
  claimed: number
  /** 本次运行签到入账的积分合计。 */
  credit: number
  /** 本次运行因设备名额被占而跳过的账号数。 */
  deviceSpent: number
  /** 最近一次运行的说明文字。 */
  message?: string
  /** 可逐条核对的明细（每账号一行）。 */
  detail?: readonly string[]
}

/** 自动化配置。 */
export interface AutomationOptions {
  /** 总开关；缺省 false（绝不默认开启写操作）。 */
  enabled?: boolean
  /** 签到 job 的 hour list（北京时区）。缺省 `[9]`。 */
  checkinHours?: readonly number[]
  /**
   * 未来可自动任务的 hour list 扩展点。
   *
   * 现在**没有任何 job 消费它**：RESEARCH.md §5.1 已证 Trae 只有签到一个可自动
   * 的写操作（其余为一次性发放 / 需真实行为 / 接口未知 / 不存在）。保留这个字段
   * 是因为一旦上游开放新的可领取端点，加一个 job 不该需要改配置 schema 与卡片。
   */
  extraJobHours?: readonly number[]
  /** 账号之间的串行间隔；测试用 0。 */
  accountDelayMs?: number
  /** 时钟注入（测试用假时钟）。 */
  now?: () => Date
  /** 日志；缺省静默。 */
  logger?: SchedulerLogger
  /** 构造时恢复当日账本。 */
  loadEarnings?: () => AutomationLedger | undefined
  /** 账本变化时的持久化钩子。 */
  saveEarnings?: (ledger: AutomationLedger) => void | Promise<void>
}

/** 自动化快照（状态文档与卡片用）。 */
export interface AutomationStatus {
  enabled: boolean
  /** 循环是否在跑。 */
  running: boolean
  checkinHours: readonly number[]
  jobs: { checkin: AutomationJobState }
  /** 今日各账号收益；只有真正有所得的账号出现。 */
  earningsToday: Readonly<Record<string, AutomationAccountEarnings>>
  /** 当前是否有一次运行在途。 */
  runInProgress: boolean
  /** 最近一次运行的整体结果。 */
  lastPassAtMs?: number
  /** 最近一次运行的账号级结果。 */
  lastPass?: Readonly<Record<string, AutomationAccountGain>>
}

/** job 种类。目前只有一个，类型保留以便扩展。 */
export type AutomationJobKind = 'checkin'

/** 全部 job 种类（运行顺序即此顺序）。 */
export const AUTOMATION_JOB_KINDS: readonly AutomationJobKind[] = ['checkin']

/** 校准 hour list：空列表回落到默认值。 */
function hoursOrDefault(hours: readonly number[] | undefined, fallback: readonly number[]): readonly number[] {
  if (hours === undefined || hours.length === 0) return fallback
  // 只接受 0-23 的整数，去重后升序——调度比较依赖有序性。
  return [...new Set(hours.filter(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23))].sort((a, b) => a - b)
}

/** `date` 在 `timeZone` 下的日历部件（全部为补零字符串）。 */
function zonedParts(date: Date, timeZone: string = AUTOMATION_TIME_ZONE): { year: string; month: string; day: string; hour: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type: string): string => parts.find(part => part.type === type)?.value ?? '00'
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour') }
}

/**
 * `date` 所属的自然日，`YYYY-MM-DD`（默认北京时区）。
 *
 * 上游按北京自然日判幂等，账本的日界必须与它一致；跨日重置也靠这个键。
 */
export function dayKey(date: Date, timeZone: string = AUTOMATION_TIME_ZONE): string {
  const { year, month, day } = zonedParts(date, timeZone)
  return `${year}-${month}-${day}`
}

/**
 * `date` 所在的调度时段，`YYYY-MM-DDTHH`。
 *
 * 逐 job 的运行闸门以它为键，因此配了多个小时的 job 在每个小时各跑一次，而
 * 同一个小时内的第二次 tick 仍被拒。
 */
export function slotKey(date: Date, timeZone: string = AUTOMATION_TIME_ZONE): string {
  const { hour } = zonedParts(date, timeZone)
  return `${dayKey(date, timeZone)}T${hour}`
}

/** `now` 所在小时是否属于 `hours`。 */
export function isFireHour(now: Date, hours: readonly number[], timeZone: string = AUTOMATION_TIME_ZONE): boolean {
  return hours.includes(Number(zonedParts(now, timeZone).hour))
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** 账号短标签（明细行用）。 */
function accountWord(account: TraeAccount): string {
  return account.label === '' ? account.id.slice(0, 8) : account.label
}

/** 签到所得金额：基础 + 额外。面额永远取运行时值，绝不硬编码（一年内已四次变动）。 */
function claimCredit(status: TraeCheckinStatus): number {
  return status.credits + (status.extraCredits ?? 0)
}

/**
 * 积分自动化调度器。
 *
 * 循环每分钟醒一次，某 job 的某个配置小时**已经过去且该时段尚未消费**时触发。
 * 「已消费」按 job 记为 `YYYY-MM-DDTHH` 集合，跨日自动作废。
 *
 * 一切串行且失败隔离：一个账号抛错只跳过该账号并继续下一个，一次 job 抛错绝不
 * 停止循环。ai 区域账号整类跳过 —— 国际版没有 `/ug/*` 端点族（实测 404）。
 */
export class TraeScheduler {
  private enabled: boolean
  private checkinHours: readonly number[]
  private extraJobHours: readonly number[]
  private readonly delayMs: number
  private readonly now: () => Date
  private readonly logger: SchedulerLogger
  private readonly pool: TraeAccountPool
  private readonly client: TraeUpstreamClient

  /** 逐 job 的运行记录。 */
  private readonly states: Record<AutomationJobKind, AutomationJobState> = {
    checkin: { ok: 0, failed: 0, claimed: 0, credit: 0, deviceSpent: 0 },
  }

  /** 今日各账号收益。 */
  private earnings = new Map<string, AutomationAccountEarnings>()
  /** 当前 earnings 所属的北京日。 */
  private earningsDate: string
  /** 最近一次运行的整体结果（状态文档用）。 */
  private lastPass: Record<string, AutomationAccountGain> | undefined
  private lastPassAtMs: number | undefined

  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private stopped = false
  /** 一次运行在途（tick 与手动触发共用一个闸门）。 */
  private busy = false
  /** 整轮在途（startRunAll 的返回依据）。 */
  private runInFlight = false
  private saveEarningsFn: ((ledger: AutomationLedger) => void | Promise<void>) | undefined

  /**
   * @param pool 多账号池（T2）。签约只遍历 `pool.list('cn')`。
   * @param client 上游客户端（T3）。
   * @param options 配置；`enabled` 缺省 false。
   */
  constructor(pool: TraeAccountPool, client: TraeUpstreamClient, options: AutomationOptions = {}) {
    this.pool = pool
    this.client = client
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? {}
    this.delayMs = options.accountDelayMs ?? AUTOMATION_ACCOUNT_DELAY_MS
    this.checkinHours = hoursOrDefault(options.checkinHours, DEFAULT_CHECKIN_HOURS)
    this.extraJobHours = [...options.extraJobHours ?? []]
    this.earningsDate = dayKey(this.now())
    // 恢复当日账本，丢弃更早的：计数回答的是「自动化**今天**拿到了什么」，
    // 昨天的合计绝不能当作今天展示。
    const restored = options.loadEarnings?.()
    if (restored !== undefined && restored.date === this.earningsDate) {
      for (const [id, entry] of Object.entries(restored.accounts)) this.earnings.set(id, entry)
    }
    if (options.saveEarnings !== undefined) this.saveEarningsFn = options.saveEarnings
    this.enabled = options.enabled ?? false
  }

  /** 安装持久化钩子（宿主 settings 服务就绪后调用）。 */
  setEarningsPersistence(save: (ledger: AutomationLedger) => void | Promise<void>): void {
    this.saveEarningsFn = save
  }

  /**
   * 折入一份此前持久化的账本（当它属于今天时）。
   *
   * 设置文档可读发生在构造之后，所以要有这个后置入口；更早日期的账本被忽略，
   * 计数因此永远不会把昨天说成今天。
   */
  applyEarningsLedger(ledger: AutomationLedger): void {
    const today = dayKey(this.now())
    if (ledger.date !== today) return
    for (const [id, entry] of Object.entries(ledger.accounts)) this.earnings.set(id, entry)
    this.earningsDate = today
  }

  /** 应用新配置；运行中调用是安全的。 */
  applyConfig(options: AutomationOptions): void {
    if (options.enabled !== undefined) this.enabled = options.enabled
    // hour list 在**空**时回落到默认值，与构造函数同理：设置 schema 会把缺失的
    // 列表物化成 `[]`，用 `!== undefined` 判断会采纳空数组，于是「已开启但一个
    // 可运行时点都没有」——这正是 workbuddy 那边踩过的坑。
    if (options.checkinHours !== undefined) {
      this.checkinHours = hoursOrDefault(options.checkinHours, DEFAULT_CHECKIN_HOURS)
    }
    if (options.extraJobHours !== undefined) this.extraJobHours = [...options.extraJobHours]
  }

  /** 启动循环。幂等。 */
  start(): void {
    if (this.timer !== undefined) return
    this.stopped = false
    this.running = true
    // unref：插件绝不靠自己把宿主进程吊住。
    this.timer = setInterval(() => { void this.tick() }, AUTOMATION_TICK_MS)
    this.timer.unref?.()
  }

  /** 停止循环。幂等，且可在 `start` 之前调用。 */
  stop(): void {
    this.stopped = true
    this.running = false
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 状态快照。 */
  status(): AutomationStatus {
    return {
      enabled: this.enabled,
      running: this.running,
      checkinHours: [...this.checkinHours],
      jobs: { checkin: { ...this.states.checkin } },
      earningsToday: this.earningsSnapshot(),
      runInProgress: this.runInFlight,
      ...this.lastPassAtMs === undefined ? {} : { lastPassAtMs: this.lastPassAtMs },
      ...this.lastPass === undefined ? {} : { lastPass: this.lastPass },
    }
  }

  /** 手动触发（卡片按钮）：后台推进整轮并立刻返回是否启动。 */
  startRunAll(job?: AutomationJobKind, force = false): boolean {
    if (this.runInFlight) return false
    this.runInFlight = true
    void this.runAll(job, force)
      .catch((error: unknown) => {
        this.logger.warn?.('dsh-connect-trae-models automation run failed:', error)
      })
      .finally(() => { this.runInFlight = false })
    return true
  }

  /**
   * 运行一轮（可指定单个 job）。
   *
   * `force` 绕过「今天已跑过」闸门，也就是「再按一次按钮」的含义。手动运行
   * **不消费调度时段**：10:35 按一次「立即运行」绝不能取消 21:00 那个时段。
   */
  async runAll(job?: AutomationJobKind, force = false): Promise<Record<string, AutomationAccountGain>> {
    const jobs = job === undefined ? AUTOMATION_JOB_KINDS : [job]
    // 日界在任何运行之前滚（理由同 tick）：手动触发发生在午夜之后时，必须先清掉
    // 昨天的账本与时段闸门，否则本轮的记录会被收尾处的滚动再次抹掉。
    this.rollEarnings(dayKey(this.now()))
    const merged: Record<string, AutomationAccountGain> = {}
    for (const kind of jobs) {
      const gained = await this.runJob(kind, force)
      for (const [id, gain] of Object.entries(gained)) {
        const existing = merged[id]
        merged[id] = {
          credit: (existing?.credit ?? 0) + gain.credit,
          checkinCredit: (existing?.checkinCredit ?? 0) + gain.checkinCredit,
          ...existing?.deviceSpent === true || gain.deviceSpent === true ? { deviceSpent: true } : {},
        }
      }
    }
    this.lastPass = merged
    this.lastPassAtMs = this.now().getTime()
    return merged
  }

  /**
   * 运行单个 job 的全部账号。
   *
   * 串行遍历，账号级 try/catch 隔离：一个账号的 token 失效、429 或畸形载荷
   * 绝不能花掉其他账号当天的签到。
   */
  async runJob(kind: AutomationJobKind, force = false): Promise<Record<string, AutomationAccountGain>> {
    const now = this.now()
    const today = dayKey(now)
    const state = this.states[kind]
    const slot = slotKey(now)
    // 节流：同一个时钟小时内不重复启动。手动 force 才是「我知道，还是跑」。
    if (!force && state.lastFiredHour === slot) return {}
    if (this.busy) return {}
    this.busy = true
    const ctx = { today, detail: [] as string[], gained: {} as Record<string, AutomationAccountGain> }
    try {
      const accounts = this.eligibleAccounts()
      for (let index = 0; index < accounts.length; index += 1) {
        if (this.stopped) break
        const account = accounts[index]!
        try {
          await this.runCheckin(account, ctx)
        } catch (error: unknown) {
          // 一个账号失败绝不停下整轮。
          state.failed += 1
          this.logger.warn?.(`automation checkin ${accountWord(account)} failed:`, error)
          ctx.detail.push(`${accountWord(account)}: 失败（${describeError(error)}）`)
        }
        // 串行间隔，但绝不在最后一个账号之后空等。
        if (index < accounts.length - 1 && this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
      }
    } finally {
      this.busy = false
    }
    // 三个独立事实，三个字段——任意两个混用都会产生「每小时重跑」那类缺陷：
    //
    //   firedSlots    调度消费了什么（配置的小时，集合）
    //   lastFiredHour 运行何时开始（仅节流）
    //   lastRunAtMs   运行何时结束（卡片展示）
    state.lastFiredHour = slot
    state.lastRunDate = today
    state.lastRunSlot = slot
    state.lastRunAtMs = this.now().getTime()
    state.message = this.summarise(kind, state)
    state.detail = ctx.detail
    this.logger.info?.(`automation ${kind}: ${state.message}`)
    return ctx.gained
  }

  /**
   * 参与自动化的账号：CN 区域、未禁用。
   *
   * **不跳过冷却账号**（与 workbuddy scheduler 的刻意差异）：Trae 的账户级冷却
   * 是对话路由的闸门（429 限流 / 欠费 30 分钟），签到走独立的 pay/ug 端点，
   * 不该被对话侧限流连坐——跳过它只会让当天还能签到的账号白错过。
   */
  private eligibleAccounts(): TraeAccount[] {
    return this.pool.list('cn').filter(account => !this.pool.isDisabled(account.id))
  }

  /** 单账号签到：status → enable/checked_in/did_checked_in 判定 → claim → 读回刷新。 */
  private async runCheckin(
    account: TraeAccount,
    ctx: { today: string; detail: string[]; gained: Record<string, AutomationAccountGain> },
  ): Promise<void> {
    const state = this.states.checkin
    const label = accountWord(account)
    const request = { credential: account.credential, identity: this.requestIdentity() }
    // 设备号是本机安装身份的一部分，不是「当前账号」的属性；读一次即可。
    const deviceId = this.deviceId()

    const status = await this.client.fetchCheckinStatus(request, deviceId)
    // 活动没开：不是错误，跳过。
    if (!status.enabled) {
      state.ok += 1
      ctx.detail.push(`${label}: 签到活动未开启`)
      return
    }
    // 账号级：该账号今日奖励包已存在（无论哪台设备领的）。跳过且**不发 claim**。
    if (status.checkedIn) {
      state.ok += 1
      ctx.detail.push(`${label}: 今日已签到（${status.credits} 积分已到账）`)
      this.recordEarnings(account.id, ctx.today, { credit: 0, checkinCredit: 0 })
      return
    }
    // 设备级已用但账号级没有：本机名额被同机**其他账号**占了。这是多账号池的
    // 上游活动规则（RESEARCH.md §1.2），不是失败，如实呈现且不发 claim。
    if (status.didCheckedIn) {
      state.ok += 1
      state.deviceSpent += 1
      ctx.detail.push(`${label}: 本机今日签到名额已被其他账号占用（该账号未获得）`)
      this.recordEarnings(account.id, ctx.today, { credit: 0, checkinCredit: 0, deviceSpent: true })
      ctx.gained[account.id] = { credit: 0, checkinCredit: 0, deviceSpent: true }
      return
    }
    // 没有设备号就不能 claim：上游会答 9004（缺 x-device-id）。status 读得出来
    // 但领取一定失败，所以直接跳过并说明原因，而不是发一次注定失败的写请求。
    if (deviceId === '') {
      state.ok += 1
      ctx.detail.push(`${label}: 读不到本机设备号，跳过领取（上游会回 9004）`)
      return
    }

    const claim = await this.client.claimCheckin(request, deviceId)
    if (claim.claimed) {
      // 读回 status 刷新明细：面额永远取运行时值，绝不硬编码。
      const refreshed = await this.client.fetchCheckinStatus(request, deviceId).catch(() => status)
      const credit = claimCredit(refreshed)
      state.ok += 1
      state.claimed += 1
      state.credit += credit
      ctx.detail.push(`${label}: 签到成功 +${credit} 积分`)
      this.recordEarnings(account.id, ctx.today, { credit, checkinCredit: credit })
      ctx.gained[account.id] = { credit, checkinCredit: credit }
      return
    }
    // 9095 = 该设备今日已签：状态读完之后名额才被占用（并发窗口），或者上游
    // 把本机记在了别的账号上。按「设备已签」展示，**不当失败**。
    if (claim.code === 9095) {
      state.ok += 1
      state.deviceSpent += 1
      ctx.detail.push(`${label}: 本机今日已签到（上游 9095），未发放`)
      this.recordEarnings(account.id, ctx.today, { credit: 0, checkinCredit: 0, deviceSpent: true })
      ctx.gained[account.id] = { credit: 0, checkinCredit: 0, deviceSpent: true }
      return
    }
    // 9004 = 缺 x-device-id。走到这里说明我们带了设备号，所以这是配置缺陷：
    // 计为失败，把上游原话带给用户（不要吞掉）。
    if (claim.code === 9004) {
      state.failed += 1
      ctx.detail.push(`${label}: 上游拒绝（9004 设备头未被接受）：${claim.message}`)
      return
    }
    // 其余业务码：同样是上游拒绝，计为失败并保留原话。
    state.failed += 1
    ctx.detail.push(`${label}: 领取被拒（code ${claim.code}）：${claim.message}`)
  }

  /** 本机身份（缓存）。 */
  private identity: TraeIdentity | undefined

  /** 注入本机身份（池扫描或宿主启动时解析一次）。 */
  setIdentity(identity: TraeIdentity): void {
    this.identity = identity
  }

  /** 当前注入的身份（诊断用；永不回显 token 材料）。 */
  currentIdentity(): { deviceId: string; machineId: string } {
    return { deviceId: this.deviceId(), machineId: this.identity?.machineId ?? '' }
  }

  /**
   * 本次请求携带的本机身份。
   *
   * 未注入身份时给一个最小占位：签到路由只需要 `x-device-id` 的值判定设备口径，
   * 缺身份时 {@link deviceId} 返回空串、claim 会被跳过，因此这里不需要伪造任何
   * 真实身份字段（RESEARCH.md §1.2 明确排除设备号伪造）。
   */
  private requestIdentity(): TraeRequestIdentity['identity'] {
    const identity = this.identity
    if (identity === undefined) return { machineId: '', deviceId: '', platform: process.platform }
    return identity
  }

  /** 本机设备号；读不到时是空串（`x-device-id` 的判定量）。 */
  private deviceId(): string {
    return this.identity?.deviceId ?? ''
  }

  /** 一行总结。 */
  private summarise(kind: AutomationJobKind, state: AutomationJobState): string {
    const parts = [`${state.ok} 个账号已处理`]
    if (state.claimed > 0) parts.push(`${state.claimed} 个领取成功 +${state.credit} 积分`)
    if (state.deviceSpent > 0) parts.push(`${state.deviceSpent} 个本机名额受限`)
    if (state.failed > 0) parts.push(`${state.failed} 个失败`)
    return `签到：${parts.join('，')}`
  }

  /** 某个 job 今天已消费的时段集合。 */
  private firedSlotsOf(kind: AutomationJobKind): Set<string> {
    const stored = this.states[kind].firedSlots
    if (stored === undefined) return new Set<string>()
    const today = dayKey(this.now())
    // 读取时顺手丢掉更早的日期：这个集合只回答「**今天**的候选跑过没有」。
    return new Set(stored.filter(entry => entry.startsWith(`${today}T`)))
  }

  /** 记录一个已消费的调度时段。 */
  private consumeSlot(kind: AutomationJobKind, slot: string): void {
    const today = dayKey(this.now())
    const next = new Set([...this.firedSlotsOf(kind), slot])
    // 稳定排序，状态文档因此不会在读之间抖动。
    this.states[kind].firedSlots = [...next].filter(entry => entry.startsWith(`${today}T`)).sort()
  }

  /**
   * 此刻该 job 的到期时段，没有则 undefined。
   *
   * **最早**的未消费候选胜出，这样多时段配置才完整：消费掉最早的那个，把更晚
   * 的留给它自己的小时。
   */
  private dueSlot(kind: AutomationJobKind, now: Date): string | undefined {
    const hours = this.hoursOf(kind)
    if (hours.length === 0) return undefined
    const current = Number(zonedParts(now).hour)
    const today = dayKey(now)
    const fired = this.firedSlotsOf(kind)
    for (const candidate of [...hours].sort((a, b) => a - b)) {
      if (candidate > current) break
      const slot = `${today}T${String(candidate).padStart(2, '0')}`
      if (!fired.has(slot)) return slot
    }
    return undefined
  }

  /** 一个 job 配置的小时。 */
  private hoursOf(kind: AutomationJobKind): readonly number[] {
    switch (kind) {
      case 'checkin': return this.checkinHours
    }
  }

  /**
   * 循环体：到点就跑。
   *
   * 状态筛选（enabled / stopped / busy）与异常隔离都在这里，保证循环本身绝不
   * 被一次失败拖死。
   */
  private async tick(): Promise<void> {
    if (!this.enabled || this.stopped || this.busy) return
    try {
      const now = this.now()
      const slot = slotKey(now)
      // 先在**任何消费之前**滚动日界。`rollEarnings` 会清空 firedSlots，如果让它
      // 在消费之后跑（它由 recordEarnings / runJob 触发），本日刚消费掉的时段会被
      // 立刻擦掉——闸门重新打开，同一小时可以无限重跑，账本也丢掉「今天跑过」。
      this.rollEarnings(dayKey(now))
      for (const kind of AUTOMATION_JOB_KINDS) {
        if (this.stopped) return
        // 调度账本先判：配置的小时已经过去、且那个时段还没消费 → 跑它并消费掉。
        // 「已经过去」而不是「正好等于」，是为了让 DSH 关闭期间错过的时段自愈
        // （09:00 的签到在 10:00 启动时补上），这正是笔记本合盖场景需要的。
        const consumed = this.dueSlot(kind, now)
        if (consumed === undefined) continue
        // 节流：同一个时钟小时内不重复启动。
        if (this.states[kind].lastFiredHour === slot) continue
        this.consumeSlot(kind, consumed)
        await this.runJob(kind, true)
      }
    } catch (error: unknown) {
      // 循环自身的缺陷绝不能杀死定时器。
      this.logger.warn?.('dsh-connect-trae-models automation tick failed:', error)
    }
  }

  /** 今日各账号收益（先跨日重置，避免午夜后读到昨天的合计）。 */
  private earningsSnapshot(): Record<string, AutomationAccountEarnings> {
    this.rollEarnings(dayKey(this.now()))
    const out: Record<string, AutomationAccountEarnings> = {}
    for (const [id, entry] of this.earnings) out[id] = { ...entry }
    return out
  }

  /** 把一次所得累加进当日账本；0 所得且无设备占用的记录不落账。 */
  private recordEarnings(
    accountId: string,
    today: string,
    delta: { credit: number; checkinCredit: number; deviceSpent?: boolean },
  ): void {
    this.rollEarnings(today)
    const existing = this.earnings.get(accountId)
    const credit = (existing?.credit ?? 0) + delta.credit
    const checkinCredit = (existing?.checkinCredit ?? 0) + delta.checkinCredit
    const deviceSpent = existing?.deviceSpent === true || delta.deviceSpent === true
    if (credit === 0 && checkinCredit === 0 && !deviceSpent) return
    this.earnings.set(accountId, {
      credit,
      checkinCredit,
      date: today,
      ...deviceSpent ? { deviceSpent: true } : {},
    })
    // 每次写入都持久化：重启不能抹掉当天已经拿到的收益。
    this.persistEarnings()
  }

  /** 北京日翻转时清空逐账号计数。 */
  private rollEarnings(today: string): void {
    if (this.earningsDate === today) return
    this.earnings.clear()
    this.earningsDate = today
    for (const kind of AUTOMATION_JOB_KINDS) {
      const state = this.states[kind]
      state.firedSlots = []
      state.lastFiredHour = undefined
      state.lastRunSlot = undefined
      state.lastRunDate = undefined
    }
    this.lastPass = undefined
    this.persistEarnings()
  }

  /** 账本快照落盘（无钩子时静默）。 */
  private persistEarnings(): void {
    if (this.saveEarningsFn === undefined) return
    const ledger: AutomationLedger = { date: this.earningsDate, accounts: this.earningsSnapshot() }
    try {
      const outcome = this.saveEarningsFn(ledger)
      if (outcome instanceof Promise) void outcome.catch(() => {})
    } catch (error: unknown) {
      this.logger.warn?.('dsh-connect-trae-models automation ledger save failed:', error)
    }
  }

  /** 暴露给状态文档的时段闸门（测试与诊断用）。 */
  firedSlots(kind: AutomationJobKind): readonly string[] {
    return [...this.firedSlotsOf(kind)]
  }

  /** 当前配置的扩展 job 时段（暂无 job 消费，见 AutomationOptions.extraJobHours）。 */
  extensionHours(): readonly number[] {
    return [...this.extraJobHours]
  }

  /** 单次 tick 的显式入口（测试用；生产由定时器驱动）。 */
  async runDueNow(): Promise<void> {
    await this.tick()
  }
}

/** 错误的一句话描述（明细行用，绝不回显 token）。 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 120 ? `${message.slice(0, 117)}...` : message
}
