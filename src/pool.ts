/**
 * Trae 多账号账号池（蓝本 = dsh-workbuddy-xdpool 的 WorkBuddyAccountPool）。
 *
 * 池发现本机全部 Trae 账号（经 TraeCredentialStore），按区域（cn | ai）分桶，
 * 每请求派发一个健康账号，并从被上游限流/欠费/凭据失效的账号上轮换开。
 * 发现只读：桌面端文件绝不被写入；刷新结果写进插件自有副本并回流进池。
 *
 * @module dsh-connect-trae-models/pool
 */

import { TraeCredentialStore, traeAccountId, type TraeCandidateFailure, type TraeCredential, type TraeRefreshOutcome } from './auth.ts'
import type { TraeStorageCandidate } from './paths.ts'
import { regionOfCredential, type TraeRegion } from './region.ts'

/** 池刷新 token 所需的最小上游面（避免循环 import）。 */
export interface TraeTokenRefresher {
  refresh(credential: TraeCredential): Promise<TraeRefreshOutcome>
}

/** 池内的一个 Trae 账号：凭据 + 池簿记。 */
export interface TraeAccount {
  /** 稳定池键：sha256(edition+userId) 前 24 位（与凭据存储的 traeAccountId 一致）。 */
  id: string
  /** 人类可读短标签：账号名，缺失时 `userId 前 8 位#`。 */
  label: string
  credential: TraeCredential
  /** 路由桶（cn | ai），由凭据的 userRegion > host 后缀 > edition 判定。 */
  region: TraeRegion
  /**
   * 本账号对全部模型跳过的截止时刻（epoch ms）。只由整账号冷却设置
   * （欠费 hard_credit 30 分钟等）。常规 429 是按模型的，记在
   * {@link modelCooldowns}，绝不封整账号。
   */
  cooldownUntilMs: number
  /** 按上游模型 id → 该模型在本账号被跳过的截止时刻（epoch ms）。 */
  modelCooldowns: Record<string, number>
  /** 连续限流命中数，诊断用。 */
  rateLimitHits: number
  /**
   * 本账号因上游拒绝其登录（401/403）而跳过的截止时刻。
   * 被吊销的会话在凭据文件里不可见：上游不会在杀掉 refresh token 时改写
   * expiresAtMs，所以死账号看起来永远新鲜。0/undefined 表示「未知已死」。
   */
  credentialDeadUntilMs?: number
  /** 最近一次实际派活的时刻（epoch ms），balanced 的 idle 权重来源。 */
  lastUsedAt?: number
}

/** 池如何选择哪个账号服务下一个请求。 */
export type TraeDistribution = 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry'

/** sticky 模式记住的对话→账号绑定上限（内存约束，LRU 淘汰）。 */
const STICKY_AFFINITY_LIMIT = 200

/** balanced 模式：每空闲 1 小时的权重增量。 */
const IDLE_WEIGHT_PER_HOUR = 0.5
/** balanced 模式：空闲加成的上限，防止长期闲置的账号永久统治。 */
const IDLE_WEIGHT_MAX = 5

/** 欠费（hard_credit）整账号冷却默认值：30 分钟（积分包按自身周期重置）。 */
const EXHAUST_COOLDOWN_MS = 30 * 60 * 1000

/** 凭据失效（401/403）整账号冷却默认值：30 分钟。 */
const CREDENTIAL_DEAD_COOLDOWN_MS = 30 * 60 * 1000

export interface TraeAccountPoolOptions {
  /** 发现/轮换事件的日志。 */
  logger?: { info?(...args: unknown[]): void; warn(...args: unknown[]): void; error?(...args: unknown[]): void }
  /** 测试注入：只探测这些候选路径。 */
  candidates?: readonly TraeStorageCandidate[]
  /** 测试注入：插件自有副本路径列表。 */
  ownPaths?: readonly string[]
  /** 限流账号退出轮转的时长。 */
  cooldownMs?: number
  /** 欠费账号休息时长（默认 30 分钟）。 */
  exhaustCooldownMs?: number
  /** 登录被拒的账号休息时长（默认 30 分钟）。 */
  credentialDeadCooldownMs?: number
  /** 用于临近过期刷新 token 的上游客户端。 */
  client?: TraeTokenRefresher
  /** 距实际过期多久开始刷新；默认 5 分钟。 */
  refreshMarginMs?: number
  /** 请求如何在池内分布。 */
  distribution?: TraeDistribution
}

/**
 * 空闲权重：`1 + min(idleHours * 0.5, 5)`。基数 1 让每个合格账号都在局内
 * （刚服务过的账号仍有一点机会），权重和永不为零。
 * `lastUsedAt === undefined`（本进程从未使用）拿满加成：新启动时全体平权，
 * 首批请求被摊开而不是永远落在第一条。
 */
function idleWeight(lastUsedAt: number | undefined, now: number): number {
  if (lastUsedAt === undefined) return 1 + IDLE_WEIGHT_MAX
  const hours = (now - lastUsedAt) / 3_600_000
  // 时钟回跳会产生负空闲项；钳到 0。
  const idle = Math.min(Math.max(hours, 0) * IDLE_WEIGHT_PER_HOUR, IDLE_WEIGHT_MAX)
  return 1 + idle
}

/**
 * 这次刷新失败是否证明凭据本身已死？
 *
 * ExchangeToken 对被吊销的 refresh token 的回答是明确的拒绝语义；网络失败、
 * DNS 错误与 5xx 不证明任何事，绝不能把凭据标记为死 —— 否则一次抖动就让一个
 * 健康账号退出轮转半小时。
 */
function isCredentialDeadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('invalid_grant')
    || message.includes('Offline user session not found')
    || message.includes('session_dead')
    || message.includes('refresh token is missing')
    || /http (401|403)\b/.test(message)
}

/**
 * 只读的 Trae 多账号池：发现、去重、区域分桶、限流/欠费/凭据失效冷却、
 * 5 种分布、积分保留、临近过期刷新（in-flight 去重）。
 */
export class TraeAccountPool {
  private readonly logger: TraeAccountPoolOptions['logger']
  private readonly candidatesOverride: readonly TraeStorageCandidate[] | undefined
  private readonly ownPaths: readonly string[]
  private cooldownMs: number
  private exhaustCooldownMs: number
  private credentialDeadCooldownMs: number
  private readonly client: TraeTokenRefresher | undefined
  private readonly refreshMarginMs: number
  private accounts: TraeAccount[] = []
  private distribution: TraeDistribution
  /** round-robin 游标；priority 分布下不使用。 */
  private cursor = 0
  /** sticky：对话键 → 账号 id。插入顺序即 LRU 顺序：重绑先删后插。 */
  private readonly affinity = new Map<string, string>()
  private lastScanAtMs = 0
  private preferredId: string | undefined
  /** 用户在卡片上关掉的账号 id（仍列出，不派活）。 */
  private disabledIds = new Set<string>()
  /** 每账号积分保留线，键为账号 id。0（或缺失）表示「花光即可」。 */
  private creditReserves = new Map<string, number>()
  /** 每账号最近一次已知的积分余额。无读数视为可用。 */
  private creditBalances = new Map<string, number>()
  /** 每账号最近的积分包到期时刻（epoch ms）。缺失 = 未探测或不紧急。 */
  private creditExpiry = new Map<string, number>()
  /** 每账号 refresh 的 in-flight 去重。 */
  private refreshInflight = new Map<string, Promise<boolean>>()
  private readonly store: TraeCredentialStore

  constructor(options: TraeAccountPoolOptions = {}) {
    this.logger = options.logger
    this.candidatesOverride = options.candidates
    this.ownPaths = options.ownPaths ?? []
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.exhaustCooldownMs = options.exhaustCooldownMs ?? EXHAUST_COOLDOWN_MS
    this.credentialDeadCooldownMs = options.credentialDeadCooldownMs ?? CREDENTIAL_DEAD_COOLDOWN_MS
    this.client = options.client
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    // priority 是默认：用户聚合自己的账号是为了花完一个再碰下一个，
    // 而不是把每个请求平摊。
    this.distribution = options.distribution ?? 'priority'
    this.store = new TraeCredentialStore({
      candidates: options.candidates,
      ownPaths: options.ownPaths,
      refreshMarginMs: options.refreshMarginMs,
      refresh: async credential => {
        const refresher = options.client
        if (refresher === undefined) throw new Error('connect-trae-models: no token refresher configured')
        return refresher.refresh(credential)
      },
    })
  }

  /** 重新应用只影响发现与冷却策略的配置，不重建池。 */
  applyConfig(options: {
    cooldownMs?: number
    exhaustCooldownMs?: number
    distribution?: TraeDistribution
    disabledAccountIds?: readonly string[]
    creditReserves?: Readonly<Record<string, number>>
  }): void {
    if (options.cooldownMs !== undefined && options.cooldownMs >= 1000) this.cooldownMs = options.cooldownMs
    if (options.exhaustCooldownMs !== undefined && options.exhaustCooldownMs >= 1000) this.exhaustCooldownMs = options.exhaustCooldownMs
    if (options.distribution !== undefined) this.distribution = options.distribution
    if (options.disabledAccountIds !== undefined) this.disabledIds = new Set(options.disabledAccountIds)
    if (options.creditReserves !== undefined) this.setCreditReserves(options.creditReserves)
  }

  /** 当前分布模式（卡片展示）。 */
  currentDistribution(): TraeDistribution {
    return this.distribution
  }

  /** 钉住优先使用的账号（卡片偏好选择）。 */
  prefer(accountId: string | undefined): void {
    this.preferredId = accountId
  }

  /**
   * 当前被钉住的账号 id；undefined 表示没有钉选、走普通轮转。
   *
   * 暴露它是因为「钉选」必须可被看见：状态文档与对话栏都要标出哪一个账号
   * 被钉住，否则用户点完「切换用户」看到的是毫无变化的界面，无从判断是否生效。
   */
  preferredAccountId(): string | undefined {
    return this.preferredId
  }

  /** 用户是否关闭了该账号。 */
  isDisabled(accountId: string): boolean {
    return this.disabledIds.has(accountId)
  }

  /** 用户关闭的全部账号 id（发现顺序）。 */
  disabledIdsInOrder(): string[] {
    return this.accounts.filter(account => this.disabledIds.has(account.id)).map(account => account.id)
  }

  /** 重新扫描凭据来源并合并新发现的账号（保留既有冷却状态）。 */
  async scan(): Promise<TraeAccount[]> {
    const found = await this.store.readAll()
    const byId = new Map<string, TraeAccount>()
    // 以既有账号做种子，让冷却状态在重扫后存活。
    for (const account of this.accounts) byId.set(account.id, account)

    for (const credential of found) {
      const id = traeAccountId(credential)
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, {
          id,
          label: accountLabel(credential),
          credential,
          region: regionOfCredential(credential),
          cooldownUntilMs: 0,
          modelCooldowns: {},
          rateLimitHits: 0,
        })
        continue
      }
      // 同一账号取更新的凭据副本（与存储层 readAll 的合并语义一致：多保留
      // 一次刷新的结果）。凭据内容变化视为重新登录 —— 这是唯一能复活被上游
      // 拒绝账号的动作，清掉 dead 标记。
      if (credential.expiresAtMs > existing.credential.expiresAtMs || credential.accessToken !== existing.credential.accessToken) {
        const signedInAgain = credential.accessToken !== existing.credential.accessToken
          || credential.refreshToken !== existing.credential.refreshToken
        byId.set(id, {
          ...existing,
          credential,
          label: accountLabel(credential),
          region: regionOfCredential(credential),
          ...signedInAgain ? { credentialDeadUntilMs: 0 } : {},
        })
      }
    }

    // 稳定可预测的顺序让「优先队首」有意义：按 token 有效期倒序（过期时间
    // 更晚的在前）。byId 保留了账号首次发现的顺序，重扫不会打乱队列。
    const ordered = [...byId.values()]
    ordered.sort((a, b) => b.credential.expiresAtMs - a.credential.expiresAtMs)
    this.accounts = ordered
    this.lastScanAtMs = Date.now()
    return this.accounts
  }

  /** 全部账号（含冷却状态）；带 region 时按区域过滤（CN/国际网关不互通）。 */
  list(region?: TraeRegion): readonly TraeAccount[] {
    if (region === undefined) return this.accounts
    return this.accounts.filter(account => account.region === region)
  }

  /**
   * 当前可派活的账号。
   *
   * 带 modelId 时：账号合格 = 未整账号冷却 且 该模型未冷却 —— hy4 上的 429
   * 只挡 hy4，同账号的 hy3 继续服务。积分低于保留线的账号不派活；
   * 无读数的账号留在局内（未探测的池不能被搁浅）。
   */
  private available(now: number, modelId?: string, region?: TraeRegion): TraeAccount[] {
    return this.accounts.filter(account => {
      if (this.disabledIds.has(account.id)) return false
      // 积分保留线：余额 ≤ 保留线时不派活，给用户留缓冲。
      const reserve = this.creditReserves.get(account.id)
      if (reserve !== undefined && reserve > 0) {
        const balance = this.creditBalances.get(account.id)
        if (balance !== undefined && balance <= reserve) return false
      }
      if (account.cooldownUntilMs > now) return false
      // 登录被上游拒绝：凭据文件看起来仍然新鲜，这里是唯一拦住死账号
      // 吞掉整个重试预算的闸门。
      if ((account.credentialDeadUntilMs ?? 0) > now) return false
      if (modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now) return false
      // 区域维度的调用方（两个 provider 之一）绝不能拿到对话在另一个
      // 区域网关上的账号。
      if (region !== undefined && account.region !== region) return false
      return true
    })
  }

  /**
   * 现在为什么没有账号可用 —— 供准确的报错。
   *
   * 池可以为需要相反补救措施的原因变空：没登录（用户要登录）、全部限流
   * （用户等待后重试即可）、全部被关闭（用户要重新启用）、凭据被拒
   * （重新登录而非等待）。计数在该区域的账号上进行。
   */
  unavailableReason(modelId?: string, region?: TraeRegion): {
    total: number
    cooling: number
    disabled: number
    /** 因上游拒绝登录而被跳过的账号数。 */
    dead: number
    reason: 'empty' | 'cooling' | 'disabled' | 'dead' | 'reserve' | 'none'
  } {
    const now = Date.now()
    const inRegion = this.accounts.filter(account => region === undefined || account.region === region)
    if (inRegion.length === 0) return { total: 0, cooling: 0, disabled: 0, dead: 0, reason: 'empty' }

    let cooling = 0
    let disabled = 0
    let dead = 0
    for (const account of inRegion) {
      if (this.disabledIds.has(account.id)) { disabled += 1; continue }
      // 登录被拒：与「冷却」分开计数，因为补救措施相反（重新登录，不是等待）。
      if ((account.credentialDeadUntilMs ?? 0) > now) { dead += 1; continue }
      const modelCooling = modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now
      if (account.cooldownUntilMs > now || modelCooling) { cooling += 1; continue }
      const reserve = this.creditReserves.get(account.id)
      if (reserve !== undefined && reserve > 0) {
        const balance = this.creditBalances.get(account.id)
        if (balance !== undefined && balance <= reserve) {
          return { total: inRegion.length, cooling, disabled, dead, reason: 'reserve' }
        }
      }
    }
    // 被拒登录压过冷却：等待修不好被吊销的 token。
    if (dead > 0) return { total: inRegion.length, cooling, disabled, dead, reason: 'dead' }
    if (cooling > 0) return { total: inRegion.length, cooling, disabled, dead, reason: 'cooling' }
    if (disabled > 0) return { total: inRegion.length, cooling, disabled, dead, reason: 'disabled' }
    return { total: inRegion.length, cooling, disabled, dead, reason: 'none' }
  }

  /** round-robin：游标轮转。 */
  private pickRoundRobin(pool: readonly TraeAccount[]): TraeAccount | undefined {
    const index = this.cursor % pool.length
    const account = pool[index]
    if (account === undefined) return undefined
    this.cursor = (index + 1) % pool.length
    return account
  }

  /** 记住对话绑定的账号，维持 LRU 顺序。 */
  private bindAffinity(conversationKey: string, accountId: string): void {
    this.affinity.delete(conversationKey)
    this.affinity.set(conversationKey, accountId)
    while (this.affinity.size > STICKY_AFFINITY_LIMIT) {
      const oldest = this.affinity.keys().next().value
      if (oldest === undefined) break
      this.affinity.delete(oldest)
    }
  }

  /**
   * sticky：该对话已绑定的账号（当它仍能为被请求的模型服务时）。
   * 无绑定或绑定不再合格时返回 undefined —— 调用方随后重绑，这正是限流对话
   * 跳到新账号而不是失败的机制。
   */
  private affinityAccount(pool: readonly TraeAccount[], conversationKey: string | undefined): TraeAccount | undefined {
    if (conversationKey === undefined || conversationKey === '') return undefined
    const boundId = this.affinity.get(conversationKey)
    if (boundId === undefined) return undefined
    const bound = pool.find(account => account.id === boundId)
    if (bound === undefined) {
      // 绑定已过期：账号消失、被关闭或对该模型冷却。删掉让下一轮不再复查。
      this.affinity.delete(conversationKey)
      return undefined
    }
    // 重新插入标记为最近使用。
    this.bindAffinity(conversationKey, boundId)
    return bound
  }

  /** 当前记住的绑定数（测试/诊断）。 */
  affinitySize(): number {
    return this.affinity.size
  }

  /** 忘掉全部对话绑定（测试与设置变更）。 */
  clearAffinity(): void {
    this.affinity.clear()
  }

  /**
   * balanced：对合格账号按空闲权重随机抽取。
   * 权重 = 1 + min(idleHours * 0.5, 5)。刚服务过的账号输给闲置久的账号，
   * 小池不会锤死单个账号。无空闲历史的池权重全等，首批请求被摊开。
   */
  private pickByWeight(pool: readonly TraeAccount[]): TraeAccount | undefined {
    if (pool.length === 1) return pool[0]
    const now = Date.now()
    const weights = pool.map(account => idleWeight(account.lastUsedAt, now))
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    if (!Number.isFinite(total) || total <= 0) return pool[0]
    let roll = Math.random() * total
    for (let index = 0; index < pool.length; index += 1) {
      roll -= weights[index] ?? 0
      if (roll < 0) return pool[index]
    }
    return pool[pool.length - 1]
  }

  /**
   * expiry：积分包最近到期的账号先服务。
   *
   * 积分包是 use-it-or-lose-it，先花将死的比摊开花严格更优。无已知到期的
   * 账号排在最后 —— 「还没看」绝不能压过真实截止时间。没有任何到期读数的池
   * 表现得与 priority 一致（诚实的退化）。
   */
  private pickByExpiry(pool: readonly TraeAccount[]): TraeAccount | undefined {
    let best: TraeAccount | undefined
    let bestAt = Number.POSITIVE_INFINITY
    for (const account of pool) {
      const at = this.creditExpiry.get(account.id)
      if (at === undefined) continue
      if (at < bestAt) { best = account; bestAt = at }
    }
    return best ?? pool[0]
  }

  /**
   * 派发一个账号。
   *
   * - priority（默认）：队首账号服务一切直到被限流，然后下一个顶上；冷却结束
   *   即回到队首（它从未被消耗）。
   * - round-robin：连续请求轮转，花费摊匀。
   * - balanced：空闲加权随机，安静的池摊开而不是抽干第一个。
   * - sticky：每对话一账号（LRU 上限 200）；新对话按轮转顺序取下一个。
   * - expiry：积分包最近到期的先花，use-it-or-lose-it。
   *
   * 每种模式下显式 prefer 的账号在其合格时绝对优先；冷却按模型粒度跳过；
   * 未识别的 distribution 回退 priority。
   *
   * region 必须过滤：CN 与国际是不同网关，不可互通。
   */
  async acquire(modelId?: string, region?: TraeRegion, conversationKey?: string): Promise<TraeAccount | undefined> {
    if (this.accounts.length === 0) await this.scan()
    // 每账号一次尝试：token 刷新可能证明凭据被吊销（见 ensureFresh），那会把
    // 该账号标记为死并从下一次 available() 移除；循环让请求在本轮仍落在健康
    // 账号上而不是死在坏账号上。
    const maxTries = this.accounts.length + 1
    for (let attempt = 0; attempt < maxTries; attempt += 1) {
      let pool = this.available(Date.now(), modelId, region)
      if (pool.length === 0 && attempt === 0) {
        await this.scan()
        pool = this.available(Date.now(), modelId, region)
      }
      if (pool.length === 0) return undefined

      // 显式选择合格时绝对优先（不参与加权抽签）。
      if (this.preferredId !== undefined) {
        const preferred = pool.find(account => account.id === this.preferredId)
        if (preferred !== undefined && await this.ensureFresh(preferred)) return preferred
      }

      if (this.distribution === 'sticky') {
        const bound = this.affinityAccount(pool, conversationKey)
        if (bound !== undefined && await this.ensureFresh(bound)) return bound
      }

      const account = this.distribution === 'round-robin' || this.distribution === 'sticky'
        ? this.pickRoundRobin(pool)
        : this.distribution === 'balanced'
          ? this.pickByWeight(pool)
          : this.distribution === 'expiry'
            ? this.pickByExpiry(pool)
            : pool[0]
      if (account === undefined) return undefined
      const healthy = await this.ensureFresh(account)
      if (!healthy) continue
      if (this.distribution === 'sticky' && conversationKey !== undefined && conversationKey !== '') {
        this.bindAffinity(conversationKey, account.id)
      }
      return account
    }
    return undefined
  }

  /** 记录一个账号实际服务了请求（上游 200 后由调用方调用；balanced 权重读同一表）。 */
  noteServed(accountId: string): void {
    if (!this.accounts.some(account => account.id === accountId)) return
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return
    account.lastUsedAt = Date.now()
  }

  /**
   * 记录一个账号最近的积分余额与最近积分包到期时刻。
   *
   * 到期时间直写不合并：已花掉或已过期的包从下一次读数消失，保留陈旧截止
   * 时间会把池钉在一个积分已经没了的账号上 —— 与 expiry 模式的意图相反。
   */
  noteCredits(accountId: string, balance: number, nearestExpiryMs?: number): void {
    if (!Number.isFinite(balance)) return
    if (!this.accounts.some(account => account.id === accountId)) return
    this.creditBalances.set(accountId, balance)
    if (nearestExpiryMs === undefined || !Number.isFinite(nearestExpiryMs)) {
      this.creditExpiry.delete(accountId)
      return
    }
    this.creditExpiry.set(accountId, nearestExpiryMs)
  }

  /** 某账号最近的积分包到期时刻；未知为 undefined。 */
  creditExpiryOf(accountId: string): number | undefined {
    return this.creditExpiry.get(accountId)
  }

  /** 某账号最近已知余额；从未读过为 undefined。 */
  creditsOf(accountId: string): number | undefined {
    return this.creditBalances.get(accountId)
  }

  /** 某账号的积分保留线；未设置为 0。 */
  creditReserveOf(accountId: string): number {
    return this.creditReserves.get(accountId) ?? 0
  }

  /** 整体替换全部保留线（设置页每次 apply 调用，镜像保存的文档）。 */
  setCreditReserves(reserves: Readonly<Record<string, number>>): void {
    const next = new Map<string, number>()
    for (const [id, value] of Object.entries(reserves)) {
      if (Number.isFinite(value) && value > 0) next.set(id, Math.floor(value))
    }
    this.creditReserves = next
  }

  /** 当前生效的全部保留线，键为账号 id。 */
  creditReservesInOrder(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const account of this.accounts) {
      const reserve = this.creditReserves.get(account.id)
      if (reserve !== undefined && reserve > 0) out[account.id] = reserve
    }
    return out
  }

  /** 账号是否仅因保留线被扣住（卡片区分「保分」与其他不可用原因）。 */
  isReserved(accountId: string): boolean {
    const reserve = this.creditReserves.get(accountId)
    if (reserve === undefined || reserve <= 0) return false
    const balance = this.creditBalances.get(accountId)
    return balance !== undefined && balance <= reserve
  }

  /** 最近实际服务的账号 id（卡片回答「我现在在用哪个账号」）。 */
  lastServedId(): string | undefined {
    let newest: { id: string; at: number } | undefined
    for (const account of this.accounts) {
      if (account.lastUsedAt === undefined) continue
      if (newest === undefined || account.lastUsedAt > newest.at) newest = { id: account.id, at: account.lastUsedAt }
    }
    return newest?.id
  }

  /** 会话失效后对单个账号的尽力刷新（卡片手动刷新按钮）。 */
  async refreshAccount(accountId: string, options?: { force?: boolean }): Promise<boolean> {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return false
    return await this.ensureFresh(account, options?.force === true)
  }

  /**
   * 因上游拒绝登录（401/403）冷却整个账号。
   * 有直接证据时调用（请求刚返回 session_dead），不用猜：没有它，同一请求的
   * 下一次重试还会选中同一账号 —— 其凭据文件仍然声称有效 —— 8 次尝试全花在
   * 一个死账号上，健康账号永远轮不上。
   */
  penalizeCredentialDead(accountId: string): void {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return
    const until = Date.now() + this.credentialDeadCooldownMs
    account.credentialDeadUntilMs = Math.max(account.credentialDeadUntilMs ?? 0, until)
    this.logger?.warn(
      `dsh-connect-trae-models: ${account.label} 登录被上游拒绝；${new Date(until).toISOString()} 前不参与轮转（重新登录可恢复）`,
    )
  }

  /** 凭据被证明重新有效后把账号放回轮转。 */
  clearCredentialDead(accountId: string): void {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return
    account.credentialDeadUntilMs = 0
  }

  /** 当前因登录被拒而退出轮转的账号。 */
  deadCredentials(): readonly TraeAccount[] {
    const now = Date.now()
    return this.accounts.filter(account => (account.credentialDeadUntilMs ?? 0) > now)
  }

  /**
   * 在过期余量内（或已过期）时刷新账号的 access token，按账号 in-flight 去重。
   * 刷新失败但 token 尚未过期时保留现有 token：刷新端点不可达绝不能掀翻一个
   * 还能用的会话。刷新成功是登录仍然活着的最强证明 —— 清掉任何先前的死标记。
   */
  private async ensureFresh(account: TraeAccount, force = false): Promise<boolean> {
    // 异步闭包内 TS 不保留 `this.client` 的窄化，这里用局部常量捕获一次。
    const client = this.client
    if (client === undefined) return true
    const credential = account.credential
    const expiring = credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + this.refreshMarginMs
    if (!expiring && !force) return true
    const existing = this.refreshInflight.get(account.id)
    if (existing !== undefined) {
      await existing
      return (account.credentialDeadUntilMs ?? 0) <= Date.now()
    }
    const run = (async (): Promise<boolean> => {
      if (credential.refreshToken === undefined || credential.refreshToken === '') {
        // 无可刷新材料；只有已过期才值得失败。
        if (credential.expiresAtMs > Date.now() + 30_000) return true
        this.logger?.warn(`dsh-connect-trae-models: ${account.label} token 已过期且无 refresh token，请在 Trae 重新登录`)
        this.penalizeCredentialDead(account.id)
        return false
      }
      try {
        const outcome = await client.refresh(credential)
        account.credential = {
          ...credential,
          accessToken: outcome.accessToken,
          ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
          expiresAtMs: outcome.expiresAtMs,
          ...outcome.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: outcome.refreshExpiresAtMs },
          ...outcome.host === undefined || outcome.host === '' ? {} : { host: outcome.host },
          source: 'dsh',
        }
        // 一次成功的刷新是登录复活的最强证明 —— 撤销任何先前的死标记。
        this.clearCredentialDead(account.id)
        this.logger?.info?.(`dsh-connect-trae-models: 已刷新 ${account.label} 的 token`)
        return true
      } catch (error: unknown) {
        if (isCredentialDeadError(error)) {
          // 上游明确说 refresh token 没了。存储的过期时间在这里没有意义 ——
          // 被吊销的 token 过期时间仍指向未来 —— 标记死亡而不是无限重试。
          this.penalizeCredentialDead(account.id)
          this.logger?.warn?.(
            `dsh-connect-trae-models: ${account.label} 的 refresh token 已被上游吊销；请重新登录恢复`,
            error,
          )
          return false
        }
        if (credential.expiresAtMs > Date.now() + 30_000) {
          this.logger?.warn?.(`dsh-connect-trae-models: token 刷新失败但 ${account.label} 的 token 仍有效`, error)
        } else {
          this.logger?.error?.(`dsh-connect-trae-models: token 刷新失败且 ${account.label} 的 token 已过期`, error)
        }
        return true
      }
    })()
    this.refreshInflight.set(account.id, run)
    try {
      return await run
    } finally {
      this.refreshInflight.delete(account.id)
    }
  }

  /**
   * 上游报告积分耗尽（hard_credit）后冷却整账号。
   * 欠费是账号级条件（与按模型的限流相反）：该账号的全部模型在配额重置前
   * 都不可用，因此整账号冷却（不带 modelId）30 分钟。
   */
  penalizeExhausted(accountId: string): void {
    const until = Date.now() + this.exhaustCooldownMs
    this.penalize(accountId, until)
    this.logger?.warn(
      `dsh-connect-trae-models: 账号积分耗尽；整账号冷却至 ${new Date(until).toISOString()}`,
    )
  }

  /**
   * 标记账号（或其某模型）被限流。
   *
   * 带 modelId：只冷却该账号上的该模型 —— 上游的限流按模型计
   * （「可切换其他模型继续使用」），同账号其他模型留在轮转里。
   * 不带 modelId：冷却整账号，调用方应只对真正横跨全部模型的限制这么用。
   */
  penalize(accountId: string, resetAtMs?: number, modelId?: string): void {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return
    account.rateLimitHits += 1
    const until = resetAtMs ?? Date.now() + this.cooldownMs
    if (modelId !== undefined && modelId !== '') {
      account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until)
      this.logger?.warn(
        `dsh-connect-trae-models: ${account.label} 的模型 ${modelId} 被限流；冷却至 ${new Date(until).toISOString()}`,
      )
      return
    }
    account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until)
    this.logger?.warn(
      `dsh-connect-trae-models: 账号 ${account.label} 被限流；冷却至 ${new Date(until).toISOString()}`,
    )
  }

  /** 清除全部冷却（整账号与按模型），如设置页的重置按钮。 */
  resetCooldowns(): void {
    for (const account of this.accounts) {
      account.cooldownUntilMs = 0
      account.modelCooldowns = {}
      account.rateLimitHits = 0
      // 被拒登录也是冷却的一种，「清除全部冷却」就是用户说「全部再试一遍」。
      // 凭据真死了，下一个请求会重新标记，代价只是一次失败尝试；
      // 好处是有效账号绝不被陈旧标记藏住。
      account.credentialDeadUntilMs = 0
    }
  }

  /** 诊断快照。整账号冷却计数（按模型冷却不计：只限一个模型时账号整体仍可用）。 */
  status(): { count: number; cooling: number; dead: number; lastScanAtMs: number } {
    const now = Date.now()
    return {
      count: this.accounts.length,
      cooling: this.accounts.filter(account => account.cooldownUntilMs > now).length,
      dead: this.accounts.filter(account => (account.credentialDeadUntilMs ?? 0) > now).length,
      lastScanAtMs: this.lastScanAtMs,
    }
  }

  /** 每个候选路径为何没有得到账号（卡片诊断）。 */
  async diagnose(): Promise<{ tried: TraeStorageCandidate[]; failures: TraeCandidateFailure[] }> {
    return this.store.diagnose()
  }
}

/** 人类可读标签：账号名优先，缺失时 `userId 前 8 位#`。 */
function accountLabel(credential: TraeCredential): string {
  const name = credential.accountName
  const discriminator = credential.userId.slice(0, 8)
  if (name !== undefined && name !== '') return discriminator === '' ? name : `${name}#${discriminator}`
  return discriminator === '' ? 'Trae' : `${discriminator}#`
}

/** 便捷组合：凭据 → 池账号 id（与 traeAccountId 一致，供外部对账）。 */
export function traePoolAccountId(credential: TraeCredential): string {
  return traeAccountId(credential)
}
