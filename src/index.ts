// dsh-connect-trae-models 宿主入口。
//
// cordis 插件 id：llm-connect-trae-models。这里装配五件套：
//   pool（多账号池）→ shim（回环 OpenAI 端点 + 容错换号）→ adapter（pi-ai 路由）
//   + catalog（模型目录） + scheduler（签到自动化）
//
// 同时保留上游客户端与目录层的公共 API 再导出（T4 契约要求的方法级导出）。
//
// @module dsh-connect-trae-models/index

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { createTraeAdapter, POOL_NAME_BY_REGION, POOL_PROVIDER_BY_REGION } from './adapter.ts'
import type { TraeAdapter } from './adapter.ts'
import { TraeCatalog } from './catalog.ts'
import type { ModelSelection } from './catalog.ts'
import { resolveTraeIdentity } from './identity.ts'
import type { TraeIdentity } from './identity.ts'
import { traeStorageCandidates, type TraeStorageCandidate } from './paths.ts'
import { refreshTraeCredential } from './refresh.ts'
import { TraeAccountPool } from './pool.ts'
import type { TraeDistribution } from './pool.ts'
import { regionOfCredential } from './region.ts'
import type { TraeRegion } from './region.ts'
import { TraeScheduler } from './scheduler.ts'
import type { AutomationLedger, AutomationOptions } from './scheduler.ts'
import { createTraePoolShim } from './shim.ts'
import type { TraePoolShim } from './shim.ts'
import { TraeUpstreamClient } from './upstream.ts'
import { configReader, registerTraePoolStatusRoute } from './web-status.ts'

/** settings 分区命名空间（卡片与两个 provider 共用）。 */
export const TRAE_POOL_SETTINGS_NS = 'connect-trae-models'

/** 依赖注入：LLM seam（注册 provider/adapter）与 settings（挂卡片）。 */
export const inject = ['llm', 'settings']

/**
 * 把一个 schema 字段标记为 volatile。
 *
 * 0.1.7 线**要求**一个 entry 至少有一个 volatile 字段，否则 settings 写入闸门
 * 直接拒绝（"Plugin entry ... has no volatile fields"）且 `describe()` 跳过它 ——
 * 卡片既渲染不出也存不下。0.1.5 线上这个标记退化为恒等操作。
 */
function asVolatile<S>(schema: S): S {
  const candidate = schema as unknown as { volatile?: () => S }
  return typeof candidate.volatile === 'function' ? candidate.volatile() : schema
}

/**
 * 剥掉一层 volatile 活引用。
 *
 * 0.1.7 把一个 volatile 字段以 `{ get(): T }` 交回而不是裸值，好让运行中的实例
 * 无需重挂载就能观察设置改动。因此每次读标记字段都要解包：把引用往下一层传会
 * 拿对象去和字符串比较，字段被当成未设置。0.1.5 上字段已是裸值，这里是恒等。
 */
function unwrapVolatile<T>(value: T): T {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as unknown as { get(): T }).get()
  }
  return value
}

/**
 * 深拷贝一个配置值，把里面每一个活 `{get(): T}` 引用换它解析出的值。
 *
 * {@link unwrapVolatile} 只剥普通读取需要的那一层。settings 服务不同：它要校验
 * 并 `structuredClone` **整个**对象，所以任何残留引用都会让 schema 校验以
 * 「点名字段但不点原因」的消息失败，于是命名空间注册不上、卡片静默消失 ——
 * 这正是交给 `installSection` 的对象必须先过这里的原因。
 */
function unwrapVolatileDeep<T>(value: T): T {
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
 * 一个区域的模型选择 schema。
 *
 * 每个字段都刻意可选：缺失字段保留其文档语义（「全部启用」/「跟随上游图片
 * 标记」/「不设上限」），而从没保存过的区域保持缺失，让 applyConfigFromSource
 * 能回退到 legacy 平键。
 */
const modelSelectionSchema = z.object({
  enabledModelIds: z.array(z.string()).description('该区域选择器中启用的模型 id（缺失 = 全部）'),
  imageModelIds: z.array(z.string()).description('该区域接受图片输入的模型 id（缺失 = 跟随上游）'),
  contextBudgets: z.dict(z.number().step(1).min(1)).description('该区域按模型的上下文窗口覆盖值'),
})

/**
 * 自动化 schema。
 *
 * `enabled` 带真实默认值 false：调度器每个 tick 都读它，字段缺失必须意味着
 * 「关闭」而不是 undefined。小时列表本身在调度器里有兜底，所以这里保持可选。
 *
 * 目前 job 只有签到（RESEARCH.md §5 结论：Trae 唯一可自动的写操作就是签到
 * claim）；`extraJobHours` 是上游将来开放新领取端点时的预留扩展点。
 */
const automationSchema = z.object({
  enabled: z.boolean().default(false).description('运行每日积分自动化（签到）'),
  checkinHours: z.array(z.number().step(1).min(0).max(23)).description('每日签到的本地小时列表'),
  extraJobHours: z.array(z.number().step(1).min(0).max(23)).description('预留：未来可自动任务的本地小时列表'),
})

/**
 * 插件配置 schema。字段形状与卡片保存的文档一一对应。
 *
 * 显式标注为 `z<TraePoolConfig>`：不标注时 tsdown 的 dts 生成器会因推导出的
 * 类型引用了 peer 依赖内部的 cosmokit 路径而报 TS2742（"cannot be named without
 * a reference to ... cosmokit"）—— 类型不可移植，声明文件生成失败，整个 build
 * 挂掉。显式标注让导出的类型只指向本文件自己的接口。
 */
export const Config: z<TraePoolConfig> = z.object({
  authFile: asVolatile(z.string().description('Trae 桌面存储文件（缺省走应用自有位置）')),
  cooldownMs: asVolatile(z.number().step(1).min(1000).default(60000).description('每账号限流冷却毫秒数')),
  distribution: asVolatile(
    z.union(['priority', 'round-robin', 'balanced', 'sticky', 'expiry']).default('priority')
      .description('请求如何分布：priority（抽干一个）、round-robin（依次）、balanced（空闲加权随机）、sticky（每对话一账号）、expiry（先花将到期的积分包）'),
  ),
  disabledAccountIds: asVolatile(z.array(z.string()).default([]).description('被排除出池的账号 id（空 = 全部发现的账号都参与）')),
  creditReserves: asVolatile(z.dict(z.number().step(1).min(0)).default({}).description('按账号的积分保留线：余额降到该值后停用该账号')),
  enabledModelIds: asVolatile(z.array(z.string()).default([]).description('legacy 共享模型 id 列表；用于尚无分区选择的区域')),
  imageModelIds: asVolatile(z.array(z.string()).default([]).description('legacy 共享图片 id 列表；用于尚无分区选择的区域')),
  contextBudgets: asVolatile(z.dict(z.number().step(1).min(1)).default({}).description('legacy 共享上下文预算；用于尚无分区选择的区域')),
  modelSelectionCn: asVolatile(modelSelectionSchema.description('国内网关的模型选择')),
  modelSelectionGlobal: asVolatile(modelSelectionSchema.description('国际网关的模型选择')),
  automation: asVolatile(automationSchema.description('每日积分自动化（签到）')),
  automationEarnings: asVolatile(z.any().description('自动化收益账本（由调度器写入）')),
})

/**
 * 插件配置值的静态类型。
 *
 * 手写而不是从 schema 推导：schemastery 的默认导出在类型位置只是一个类型，
 * 没有可用的 infer 命名空间；而手写这个接口正好让「schema 与类型同步」成为
 * 一件需要显式核对的事，而不是被推导悄悄掩盖。
 */
export interface TraePoolConfig {
  authFile?: string
  cooldownMs?: number
  distribution?: 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry'
  disabledAccountIds?: string[]
  creditReserves?: Record<string, number>
  enabledModelIds?: string[]
  imageModelIds?: string[]
  contextBudgets?: Record<string, number>
  modelSelectionCn?: ModelSelectionConfig
  modelSelectionGlobal?: ModelSelectionConfig
  automation?: AutomationConfig
  automationEarnings?: AutomationLedger
}

/**
 * 一个区域保存下来的模型选择。
 *
 * 刻意在本地声明而不是复用 catalog 的 `ModelSelection`：schemastery 推导出的
 * 形状用的是可变数组，而那个接口用 `readonly` 数组，两者在 `z<Config>` 标注下
 * 不兼容。形状保持一致即可，语义在同一处测试里对齐。
 */
export interface ModelSelectionConfig {
  enabledModelIds?: string[]
  imageModelIds?: string[]
  contextBudgets?: Record<string, number>
}

/**
 * 每日积分自动化配置。
 *
 * 同样是本地声明（理由见上）；字段名与调度器的 {@link AutomationOptions} 一一
 * 对应，装配时直接透传。
 */
export interface AutomationConfig {
  enabled?: boolean
  checkinHours?: number[]
  extraJobHours?: number[]
}

/** 卡片与 CLI 读到的实时快照。 */
export interface TraePoolApi {
  pool: TraeAccountPool
  /** 每区域一个目录，与注册的两个 provider 对应。 */
  catalogs: Readonly<Record<TraeRegion, TraeCatalog>>
  client: TraeUpstreamClient
  /** 每区域一个 shim。 */
  shims: Readonly<Record<TraeRegion, TraePoolShim>>
  adapter: TraeAdapter | undefined
  /** 签到自动化；与 core 一同装配，`start()` 前保持惰性。 */
  scheduler: TraeScheduler
}

/** 实时 API，供 CLI 使用。 */
let api: TraePoolApi | undefined

/** 实时 API；插件尚未 apply 时为 undefined。 */
export function currentApi(): TraePoolApi | undefined {
  return api
}

/** 测试缝：不启动 cordis 也能装入一个 API 实例。 */
export function setApi(next: TraePoolApi | undefined): void {
  api = next
}

/**
 * 不注册任何东西地装配运行时对象。
 *
 * 每区域一个目录、一个 shim：CN 与国际网关的名册不同，共享目录会让选择器显示
 * 「碰巧先抓到的那份」列表。
 */
export function createCore(logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void }) {
  const client = new TraeUpstreamClient()
  // 池要的是「给我一个凭据，返回续期结果」这一个小接口；上游客户端本身不带
  // 刷新（刷新是 refresh.ts 的纯函数，打 ExchangeToken 端点），所以在这里适配
  // 一次，而不是把刷新逻辑塞进上游客户端。
  const pool = new TraeAccountPool({
    ...logger === undefined ? {} : { logger },
    client: { refresh: credential => refreshTraeCredential(credential) },
  })
  const catalogs = {
    cn: new TraeCatalog('cn'),
    ai: new TraeCatalog('ai'),
  } as const
  // 调度器在这里装配但 `start()` 前保持惰性：CLI 与测试都要能建 core 而不引发
  // 后台流量。
  const scheduler = new TraeScheduler(pool, client, { ...logger === undefined ? {} : { logger } })
  return { client, pool, catalogs, scheduler }
}

/** provider id → 区域（注册与发现共用一份映射）。 */
function regionOfProvider(provider: string | undefined): TraeRegion | undefined {
  if (provider === POOL_PROVIDER_BY_REGION.cn) return 'cn'
  if (provider === POOL_PROVIDER_BY_REGION.ai) return 'ai'
  return undefined
}

/**
 * 装配并注册。
 *
 * 时序：装配 core → 注册两个 provider/adapter → 挂 settings 卡片 → 应用一次已
 * 保存的配置 → 后台播种目录 → 注入身份 → 起调度器。任何一步失败都只影响它
 * 自己，绝不阻断其余部分：模型路由必须在离线上游下也能立起来。
 */
export function apply(ctx: Context, config: TraePoolConfig = {} as TraePoolConfig): void {
  const core = createCore(ctx.logger)

  /** 本机身份；签到 claim 依赖它的 deviceId，未解析出来时调度器会主动跳过。 */
  let identity: TraeIdentity | undefined

  let stopped = false
  let adapter: TraeAdapter | undefined
  let releaseProviders: (() => void) | undefined

  /** 目录变化后重建 picker；注册完成前是空操作。 */
  let invalidateCatalog: () => void = () => {}

  const shims = {} as Record<TraeRegion, TraePoolShim>
  for (const region of ['cn', 'ai'] as const) {
    shims[region] = createTraePoolShim({
      pool: core.pool,
      client: core.client,
      catalog: core.catalogs[region],
      region,
      logger: ctx.logger,
      // 每请求现取身份：启动时 Trae 可能尚未登录而解析不出来，但签到与
      // x-device-id 都必须用到它，所以在真正要发请求的时刻再读一次。
      identityOf: () => Promise.resolve(identity),
    })
  }

  /**
   * 施加一个区域的模型选择。
   *
   * 分区字段缺失时回退到 legacy 平键：老设置文件只有平键，而「缺失 = 全部启用」
   * 若直接照做，会让升级用户的模型列表突然全部展开。两者都为空时才真的留空
   * （= 全部启用）。
   */
  const applySelection = (region: TraeRegion, selection: ModelSelection | undefined): void => {
    const live = unwrapVolatileDeep(config) as TraePoolConfig
    const legacyEnabled = live.enabledModelIds
    const legacyImages = live.imageModelIds
    const legacyBudgets = live.contextBudgets
    // 区域槽位里出现的**空列表**与「缺失」同义，一律折成缺省（不过滤）。
    // 设置 schema 会把「从未配置」materialize 成 `[]`，卡片保存也会写回当前
    // 勾选集；把 `[]` 原样传下去会让 visible() 过滤掉全部模型——那正是配置
    // 界面看不到任何可选模型的成因。丢失选择必须退化为「不筛选」，绝不能
    // 退化为「一个都不要」。
    core.catalogs[region].applySelection({
      ...selection?.enabledModelIds === undefined || selection.enabledModelIds.length === 0
        ? legacyEnabled === undefined || legacyEnabled.length === 0 ? {} : { enabledModelIds: legacyEnabled }
        : { enabledModelIds: selection.enabledModelIds },
      ...selection?.imageModelIds === undefined || selection.imageModelIds.length === 0
        ? legacyImages === undefined || legacyImages.length === 0 ? {} : { imageModelIds: legacyImages }
        : { imageModelIds: selection.imageModelIds },
      ...selection?.contextBudgets === undefined
        ? legacyBudgets === undefined || Object.keys(legacyBudgets).length === 0 ? {} : { contextBudgets: legacyBudgets }
        : { contextBudgets: selection.contextBudgets },
    })
    invalidateCatalog()
  }

  /**
   * 读回已保存的配置并施加到运行时。
   *
   * 0.1.7 上 `configure({auto})` 只注册呈现策略，既不读也不应用值，而编辑是通过
   * `loader/volatile-update` 事件广播的（监听器，启动时不触发）。0.1.5 则把初始
   * 文档经 `installSection` → `hooks.onChange` 推过来。没有启动时这一次应用，
   * 池、两个目录、调度器都会停在构造默认值上 —— 每次重启都静默回退掉分布、
   * 自动化开关与模型选择，尽管设置文件里还留着它们。
   */
  const applyConfigFromSource = (): void => {
    const live = unwrapVolatileDeep(config) as TraePoolConfig

    core.pool.applyConfig({
      ...live.cooldownMs === undefined ? {} : { cooldownMs: live.cooldownMs },
      ...live.distribution === undefined ? {} : { distribution: live.distribution as TraeDistribution },
      ...live.disabledAccountIds === undefined ? {} : { disabledAccountIds: live.disabledAccountIds },
      ...live.creditReserves === undefined ? {} : { creditReserves: live.creditReserves },
    })

    applySelection('cn', live.modelSelectionCn as ModelSelection | undefined)
    applySelection('ai', live.modelSelectionGlobal as ModelSelection | undefined)

    core.scheduler.applyConfig((live.automation ?? {}) as AutomationOptions)
  }

  // ── settings 卡片：双线路兼容 ─────────────────────────────────────────
  //
  // 0.1.5  SettingsProvider.installSection(owner, ns, schema, entry, hooks)
  // 0.1.7  SettingsForms.configure({auto}, owner) 注册呈现策略，编辑以
  //        `loader/volatile-update` 事件广播（0.1.7 上调 installSection 会以
  //        "is not a function" 抛出）。
  // 两条都探测调用：只认一条会让另一个版本线上卡片静默消失。
  const settingsService = (ctx as unknown as {
    settings?: {
      installSection?: (
        owner: unknown,
        ns: string,
        schema: unknown,
        entry: unknown,
        hooks?: { onChange?(): void },
      ) => void
      configure?: (presentation: { auto?: boolean }, owner?: unknown) => () => void
    }
  }).settings

  /**
   * `settings.update` 在运行线上期望的命名空间（见下）。
   *
   * 0.1.5 按插件经 `installSection` 注册的**命名空间**解析写入器；0.1.7 起改为
   * 按**宿主插件条目 id** 解析（`configEditor.entries().find(row =>
   * row.options.id === ns)`），而 profile patch 选的就是那个 id —— 桌面宿主
   * 把本插件挂成 `llm-connect-trae-models`，但市场安装可能包一层（`mkt-...`）或经
   * `include` 行挂载。唯一正确答案是问 fiber 要它自己的 entry id；硬猜自己的
   * namespace 会让每次保存都抛「No configurable plugin entry」——这正是
   * 「模型管理保存无效」的根因。此判断与 dsh-workbuddy-xdpool index.ts:836 一致。
   */
  const settingsWriteNs: string = typeof settingsService?.installSection === 'function'
    ? TRAE_POOL_SETTINGS_NS
    : (() => {
        try {
          const entryId = (ctx.fiber as unknown as { entry?: { options?: { id?: string } } })?.entry?.options?.id
          return entryId === undefined || entryId === '' ? TRAE_POOL_SETTINGS_NS : entryId
        } catch {
          return TRAE_POOL_SETTINGS_NS
        }
      })()

  if (settingsService !== undefined) {
    if (typeof settingsService.installSection === 'function') {
      // 0.1.5：交出命名空间，让 provider 拥有该文档。
      //
      // 配置先过 `unwrapVolatileDeep`：volatile 字段是活 `{get(): T}` 引用，而
      // provider 会校验并 structuredClone 整个对象 —— 残留引用会让校验失败、
      // 命名空间注册不上、卡片静默消失。
      settingsService.installSection(
        ctx,
        TRAE_POOL_SETTINGS_NS,
        Config,
        unwrapVolatileDeep(config),
        // 0.1.5 的保存回调是同步的，从这里重应用。
        { onChange() { applyConfigFromSource() } },
      )
    }
    if (typeof settingsService.configure === 'function') {
      // 0.1.7：宿主从这个 entry 推导表单，并把编辑持久化进 profile patch。
      // 经 `ctx.effect` 注册让 disposer 绑在本插件生命周期上。
      ctx.effect(() => settingsService.configure?.({ auto: true }, ctx.fiber) ?? (() => {}))
    }
    if (typeof settingsService.installSection !== 'function' && typeof settingsService.configure !== 'function') {
      ctx.logger.warn?.('dsh-connect-trae-models: settings 服务既没有 installSection 也没有 configure；卡片不会挂载')
    }
  }

  // 0.1.7 上保存的编辑落在 profile patch 里并以 `loader/volatile-update` 广播。
  // 在这里重应用，才让卡片上的保存无需重启宿主就生效。该事件在 0.1.5 上不存在，
  // 那条线走上面的 hooks.onChange，所以这里只是永不触发。
  ;(ctx as unknown as { on(name: string, listener: () => void): unknown })
    .on('loader/volatile-update', () => { applyConfigFromSource() })

  // 启动即应用一次已保存配置（理由见 applyConfigFromSource 的 JSDoc）。
  applyConfigFromSource()

  const stopAll = (): void => {
    stopped = true
    core.scheduler.stop()
    releaseProviders?.()
    void shims.cn.close()
    void shims.ai.close()
  }
  ctx.effect(() => stopAll)

  /** 解析本机身份；显式 `authFile` 优先，否则走真实四形态探测。 */
  const readIdentity = async (): Promise<TraeIdentity> => {
    const authFile = (unwrapVolatileDeep(config) as TraePoolConfig).authFile
    const candidates: readonly TraeStorageCandidate[] = authFile === undefined || authFile === ''
      ? traeStorageCandidates()
      : [{ edition: 'cn', path: authFile, source: 'desktop' }]
    return await resolveTraeIdentity(candidates, 'cn')
  }

  /**
   * 播种某一区域的实时模型目录。
   *
   * 两个区域互相隔离且各自独立重试：它们是不同主机上的不同网关，一个不可达
   * 绝不能拖累另一个。静态回退名册保证上游离线时 provider 永不为空。
   */
  const seedRegion = async (
    region: TraeRegion,
    accounts: readonly { credential: { edition: string; userId: string; host?: string } }[],
  ): Promise<void> => {
    if (identity === undefined) {
      ctx.logger.warn?.(`dsh-connect-trae-models: 本机身份不可用，跳过 ${region} 目录播种（保持静态回退）`)
      return
    }
    const account = accounts.find(candidate => regionOfCredential(candidate.credential as never) === region)
    if (account === undefined) {
      ctx.logger.info?.(`dsh-connect-trae-models: 尚无 ${region} 账号；保留静态 ${region} 目录`)
      return
    }
    const request = { credential: account.credential as never, identity }
    try {
      const wire = await core.client.fetchModels(request)
      const remote = await core.client.fetchRemoteCatalog(request)
      const merged = core.client.mergeCatalog(remote, wire)
      core.catalogs[region].updateFromUpstream(merged)
      ctx.logger.info?.(`dsh-connect-trae-models: ${region} 目录已播种 ${merged.length} 个模型`)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      core.catalogs[region].noteFetchFailure(message)
      ctx.logger.warn(`dsh-connect-trae-models: ${region} 模型目录不可用；使用静态回退`, error)
    }
    // 施加选择放在播种之后：目录刚换成实时数据，之前的选择要重新贴合。
    applyConfigFromSource()
  }

  // ── 注册两个 provider ────────────────────────────────────────────────
  void (async () => {
    try {
      await Promise.all([shims.cn.ready, shims.ai.ready])
    } catch (error: unknown) {
      ctx.logger.error('dsh-connect-trae-models: shim 启动失败', error)
      return
    }
    if (stopped) return

    const adapterCn = createTraeAdapter({
      shim: shims.cn,
      catalog: core.catalogs.cn,
      ctx,
      providerId: POOL_PROVIDER_BY_REGION.cn,
      displayName: POOL_NAME_BY_REGION.cn,
    })
    const adapterAi = createTraeAdapter({
      shim: shims.ai,
      catalog: core.catalogs.ai,
      ctx,
      providerId: POOL_PROVIDER_BY_REGION.ai,
      displayName: POOL_NAME_BY_REGION.ai,
    })
    adapter = adapterCn

    try {
      const releaseAdapterCn = ctx.llm.registerAdapter([POOL_PROVIDER_BY_REGION.cn], adapterCn.adapter)
      const releaseAdapterAi = ctx.llm.registerAdapter([POOL_PROVIDER_BY_REGION.ai], adapterAi.adapter)
      const releaseDirectory = ctx.llm.registerConfigurableProviders([
        {
          provider: POOL_PROVIDER_BY_REGION.cn,
          displayName: POOL_NAME_BY_REGION.cn,
          settingsNs: TRAE_POOL_SETTINGS_NS,
          settingsPath: [],
          declared: false,
        },
        {
          provider: POOL_PROVIDER_BY_REGION.ai,
          displayName: POOL_NAME_BY_REGION.ai,
          settingsNs: TRAE_POOL_SETTINGS_NS,
          settingsPath: [],
          declared: false,
        },
      ])
      releaseProviders = () => {
        releaseAdapterCn?.()
        releaseAdapterAi?.()
        releaseDirectory?.()
      }
    } catch (error: unknown) {
      // 中途抛出会留下已注册的部分；撤掉它们，免得启动失败留下半个 provider。
      releaseProviders?.()
      releaseProviders = undefined
      ctx.logger.error('dsh-connect-trae-models: provider 注册失败', error)
      return
    }

    // 从这里开始设置变更可以重建 picker。在这行之前 invalidateCatalog 是空操作。
    invalidateCatalog = () => {
      adapterCn.invalidate()
      adapterAi.invalidate()
    }

    ctx.llm.registerModelDiscovery(TRAE_POOL_SETTINGS_NS, async (request: { provider?: string }) => {
      const region = regionOfProvider(request.provider)
      if (region === undefined) return []
      return core.catalogs[region].visible().map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxOutputTokens,
        inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
      }))
    })

    ctx.logger.info?.(
      `dsh-connect-trae-models: provider 已注册 cn=${shims.cn.baseUrl()} ai=${shims.ai.baseUrl()}`,
    )

    if (stopped) return

    // 解析本机身份并注入调度器：deviceId 是签到 claim 的设备口径判定量，未注入
    // 时调度器会主动跳过 claim（避免注定 9004 的写请求）。
    try {
      identity = await readIdentity()
      core.scheduler.setIdentity(identity)
      ctx.logger.info?.('dsh-connect-trae-models: 本机身份已注入调度器（签到 x-device-id 可用）')
    } catch (error: unknown) {
      ctx.logger.warn(
        'dsh-connect-trae-models: 本机身份解析失败；签到 claim 会被跳过（对话路由不受影响）',
        error,
      )
    }

    // 发现账号；此时静态回退目录已在服务模型。
    let accounts: Awaited<ReturnType<typeof core.pool.scan>> = []
    try {
      accounts = await core.pool.scan()
      ctx.logger.info?.(`dsh-connect-trae-models: ${accounts.length} 个 Trae 账号进入轮转`)
    } catch (error: unknown) {
      ctx.logger.warn('dsh-connect-trae-models: 账号发现失败', error)
    }
    if (stopped) return

    // 播种实时目录。每个区域独立，一个失败不影响另一个。
    await Promise.all((['cn', 'ai'] as const).map(region => seedRegion(region, accounts)))

    if (stopped) return

    // 账本持久化：调度器把当天账本写回 settings，启动时读回旧账本（更早日期的
    // 会被丢弃）。写失败绝不能打断调度器本身。
    core.scheduler.setEarningsPersistence(ledger => {
      const writer = settingsService === undefined
        ? undefined
        : (settingsService as unknown as {
          update?: (ns: string, patch: Record<string, unknown>) => Promise<void> | void
        }).update
      if (typeof writer !== 'function') return
      void Promise.resolve(writer(settingsWriteNs, { automationEarnings: ledger })).catch(
        (error: unknown) => { ctx.logger.warn('dsh-connect-trae-models: 自动化账本写入失败', error) },
      )
    })
    const stored = (unwrapVolatileDeep(config) as TraePoolConfig).automationEarnings
    if (stored !== undefined && stored !== null) core.scheduler.applyEarningsLedger(stored as never)

    // 调度器放装配末尾：核心对象就绪、身份已注入、配置已应用。
    core.scheduler.start()
    ctx.logger.info?.('dsh-connect-trae-models: 签到调度器已启动（automation.enabled=false 时保持惰性）')
  })()

  // ── 卡片路由（T7）─────────────────────────────────────────────────────
  //
  // 挂宿主同源 web server。`webServer` 是可选服务，所以用 `ctx.inject` 而不是直接
  // 取：无头 profile 上这些路由根本不挂，卡片退化成离线横幅，provider 照常服务。
  const settingsWriter = settingsService === undefined
    ? undefined
    : (settingsService as unknown as {
      update?: (ns: string, patch: Record<string, unknown>) => Promise<void> | void
    }).update

  /**
   * 把一次卡片写入落到 settings。
   *
   * 每个写入都走「读当前文档 → 合并 → 整体 update」：`update` 是浅合并补丁，
   * 而这里要改的字段（`disabledAccountIds` 列表、某区域的选择分区）都是整体
   * 替换语义，先读后写才不会被上一次写入的残留覆盖。
   */
  const writeSettings = async (patch: Record<string, unknown>): Promise<void> => {
    if (typeof settingsWriter !== 'function') {
      throw new Error('settings service is not available; the change was not saved')
    }
    await settingsWriter(settingsWriteNs, patch)
    // 写入后立即重应用：0.1.7 的编辑通常经 loader/volatile-update 广播回来，但
    // 那条路对卡片自身的写入不保证触发顺序，主动重应用才能让开关立刻生效。
    applyConfigFromSource()
  }

  // 卡片路由背后的同源端点。`webServer` 是**可选**服务：无头 profile（CLI、测试）
  // 上没有它，此时这些路由根本不挂、卡片退化成离线横幅 —— 而 provider 照常服务
  // 模型。因此必须用 `ctx.inject(['webServer'], ...)` 而不是直接调
  // `ctx.webServer.register`：后者在没有该服务时会以
  // 「Cannot read properties of undefined (reading 'register')」抛出，
  // 把**整个插件**的 apply 弄崩（不只是卡片），连 provider 都注册不上。
  // 此处与 dsh-workbuddy-xdpool index.ts:894、dsh-connect-trae index.ts:757 的
  // 接线形状保持一致。
  ctx.inject(['webServer'], webCtx => registerTraePoolStatusRoute(webCtx, {
    pool: core.pool,
    catalogs: core.catalogs,
    client: core.client,
    shim: region => {
      try {
        return { running: true, baseUrl: shims[region].baseUrl() }
      } catch {
        // 还没绑端口：running=false 而不是抛错（卡片问的是状态，不是要一个端点）。
        return { running: false }
      }
    },
    scheduler: () => core.scheduler.status(),
    runAutomation: (job, force) => core.scheduler.startRunAll(job as never, force),
    config: configReader(() => config),
    deviceId: () => identity?.deviceId ?? '',
    logger: ctx.logger,
    saveSelection: async (region, selection) => {
      const key = region === 'cn' ? 'modelSelectionCn' : 'modelSelectionGlobal'
      await writeSettings({ [key]: selection })
    },
    setAccountDisabled: async (accountId, disabled) => {
      const live = unwrapVolatileDeep(config) as TraePoolConfig
      const current = new Set(live.disabledAccountIds ?? [])
      if (disabled) current.add(accountId)
      else current.delete(accountId)
      await writeSettings({ disabledAccountIds: [...current] })
    },
    rescan: async () => { await core.pool.scan() },
    resetCooldowns: () => { core.pool.resetCooldowns() },
  }))

  // 让 `logger` 不再被 TS 判定为「仅此一处使用」而留下未用告警：上面已经用到了
  // ctx.logger，这里显式记录一次挂载结果，同时也让无头 profile 的降级可见。
  ctx.logger.info?.('dsh-connect-trae-models: 卡片路由已挂载（webServer 可用时）')

  api = { pool: core.pool, catalogs: core.catalogs, client: core.client, shims, adapter, scheduler: core.scheduler }
}

// ── 公共 API 再导出（T4 契约：shim 与主装配可直接 import 并打桩）─────────
export { classifyTraeError, TraeUpstreamClient } from './upstream.ts'
export type {
  TraeActivityRule,
  TraeChatResult,
  TraeCheckinClaim,
  TraeCheckinStatus,
  TraeCreditsSnapshot,
  TraeCreditPack,
  TraeUpstreamClientOptions,
  TraeUpstreamErrorKind,
} from './upstream.ts'
export { parseActivities, parseCheckinClaim, parseCheckinStatus, parseCreditsSnapshot } from './upstream.ts'
export {
  chatStream,
  claimCheckin,
  fetchActivities,
  fetchCheckinStatus,
  fetchCredits,
  fetchModels,
  fetchRemoteCatalog,
  mergeCatalog,
} from './upstream.ts'
export {
  applyModelBudget,
  fallbackModelsFor,
  FALLBACK_TRAE_MODELS,
  FALLBACK_TRAE_MODELS_AI,
  mergeTraeModelSources,
  TRAE_DEFAULT_CONTEXT_WINDOW,
  TraeCatalog,
  traeModelDisplayName,
} from './catalog.ts'
export type { ModelSelection, TraeContextBudget, TraeInputModality, TraeModelInfo, TraeWireModel } from './catalog.ts'
export {
  bridgeTraeSoloStream,
  bridgeTraeSoloStreamOrFail,
  describeTraeFailure,
  TRAE_HEARTBEAT_COMMENT,
  TRAE_KEEPALIVE_INTERVAL_MS,
  TRAE_PROGRESS_COMMENT,
  TRAE_QUEUE_COMMENT,
  TRAE_UPSTREAM_SILENCE_MS,
} from './solo-bridge.ts'
export {
  collectWireModels,
  prepareSoloBody,
  TRAE_DIRECTORY_FUNCTIONS,
  TRAE_SOLO_CHAT_PATH,
  TRAE_SOLO_FUNCTION,
  TRAE_SOLO_MODELS_PATH,
  wireCreditMultiplier,
} from './solo.ts'
export {
  decodeTraeEvent,
  SseDecoder,
} from './sse.ts'
export { parseReasoningCapability, TRAE_REASONING_EFFORTS } from './reasoning.ts'
export { parseTraeRemoteModel } from './model-metadata.ts'
export {
  buildTraeHeaders,
  normalizeTraeVersionCode,
  traeEndpoint,
} from './protocol.ts'
export {
  REGION_GATEWAYS,
  regionOfCredential,
  regionOfEdition,
  regionOfHost,
  regionOfUserRegion,
} from './region.ts'
// 凭据发现层与多账号账号池（T2）。
export {
  TraeCredentialStore,
  normalizeTraeCredential,
  traeAccountId,
  traeAccountRegion,
  TRAE_AUTH_FILENAME,
} from './auth.ts'
export type {
  TraeCandidateFailure,
  TraeCredential,
  TraeCredentialStoreOptions,
  TraeRefreshOutcome,
} from './auth.ts'
export {
  TraeAccountPool,
  traePoolAccountId,
} from './pool.ts'
export type { TraeAccount, TraeAccountPoolOptions, TraeDistribution, TraeTokenRefresher } from './pool.ts'
export {
  traeCliCandidates,
  traeStorageCandidates,
  traeWindowsAppNames,
  TRAE_CLI_TOKEN_FILENAME,
} from './paths.ts'
export type { TraeCredentialSource, TraeEdition, TraeStorageCandidate } from './paths.ts'
export {
  decryptTraeStorageValue,
  parseTraeAuthValue,
  parseTraeCliToken,
  parseTraeStorageDocument,
  TRAE_AUTH_STORAGE_KEY,
} from './decrypt.ts'
export type { TraeCliTokenClaims } from './decrypt.ts'
export {
  identityHeaders,
  pickTraeStorageIdentity,
  readTraeCliIdentity,
  readTraeIdentity,
  resolveTraeIdentity,
} from './identity.ts'
export type { TraeIdentity, TraeIdentityReadOptions } from './identity.ts'
export { refreshTraeCredential } from './refresh.ts'
export type { TraeRefreshDevice } from './refresh.ts'
// shim（T5）：多账号容错换号的回环端点。
export {
  contextOverflowMessage,
  conversationKeyOf,
  createTraePoolShim,
  parseRateLimitReset,
  stampTraeWireTarget,
  TRAE_DEFAULT_COOLDOWN_MS,
} from './shim.ts'
export type { ShimLogger, TraePoolShim, TraePoolShimOptions } from './shim.ts'
// adapter（T5）：pi-ai 路由装配。
export {
  createTraeAdapter,
  POOL_NAME_BY_REGION,
  POOL_PROVIDER_BY_REGION,
  TRAE_GLOBAL_POOL_PROVIDER,
  TRAE_POOL_PROVIDER,
  TRAE_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.ts'
export type { TraeAdapter, TraeAdapterOptions } from './adapter.ts'
// 调度器（T6）：签到自动化。
export {
  AUTOMATION_JOB_KINDS,
  AUTOMATION_TICK_MS,
  AUTOMATION_TIME_ZONE,
  DEFAULT_CHECKIN_HOURS,
  TraeScheduler,
  dayKey,
  isFireHour,
  slotKey,
} from './scheduler.ts'
export type {
  AutomationAccountEarnings,
  AutomationAccountGain,
  AutomationJobKind,
  AutomationJobState,
  AutomationLedger,
  AutomationOptions,
  AutomationStatus,
  SchedulerLogger,
} from './scheduler.ts'
// 上下文预算（shim 的滑窗压缩）。
export {
  compactMessages,
  compactWithSummary,
  estimateMessagesTokens,
  estimateTextTokens,
  hardTruncate,
} from './context-budget.ts'
export type { ChatMessage, CompactOptions, CompactResult } from './context-budget.ts'
// 卡片路由与共享类型（T7）：路径常量与类型必须 Node-free，浏览器端也要 import。
export {
  EXPIRING_SOON_WINDOW_MS,
  CHECKIN_DEVICE_ALREADY_CLAIMED,
  buildTraePoolWebStatus,
  configReader,
  parseSelection,
  registerTraePoolStatusRoute,
  safeMessage,
} from './web-status.ts'
export type { TraePoolStatusRouteOptions } from './web-status.ts'
export {
  parseRegionParam,
  TRAE_POOL_ACCOUNT_TOGGLE_PATH,
  TRAE_POOL_AUTOMATION_RUN_PATH,
  TRAE_POOL_CHECKIN_PATH,
  TRAE_POOL_DEFAULT_REGION,
  TRAE_POOL_MODELS_SAVE_PATH,
  TRAE_POOL_RESET_COOLDOWN_PATH,
  TRAE_POOL_RESCAN_PATH,
  TRAE_POOL_ROUTE_PREFIX,
  TRAE_POOL_STATUS_PATH,
  unwrapVolatile,
  unwrapVolatileDeep,
} from './status-paths.ts'
export type {
  TraePoolRegion,
  TraePoolWebAccount,
  TraePoolWebAccountToggle,
  TraePoolWebAutomation,
  TraePoolWebAutomationEarnings,
  TraePoolWebAutomationJob,
  TraePoolWebAutomationRun,
  TraePoolWebAutomationRunResult,
  TraePoolWebCheckin,
  TraePoolWebCheckinClaim,
  TraePoolWebCheckinRequest,
  TraePoolWebCreditPack,
  TraePoolWebCredits,
  TraePoolWebModel,
  TraePoolWebModelSelection,
  TraePoolWebStatus,
} from './status-paths.ts'

export const name = 'llm-connect-trae-models'
