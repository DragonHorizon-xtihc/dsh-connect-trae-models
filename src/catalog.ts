/**
 * 模型目录：回退名册 + 合并 + 选择过滤。
 *
 * 结构蓝本 = dsh-workbuddy-xdpool catalog.ts（models + selection + source
 * live/fallback + notify listeners + visible()）；回退名册与合并算法照抄
 * dsh-connect-trae catalog.ts（契约已验证，禁止改动语义）。
 *
 * @module dsh-connect-trae-models/catalog
 */

import type { TraeDiscoveredModel } from './model-metadata.ts'
import type { TraeRegion } from './region.ts'

/** 模型的一种输入模态。 */
export type TraeInputModality = 'text' | 'image'

/**
 * 目录中的一行模型。`contextWindow` 是目录保证的窗口（用户预算可调整）；
 * `maxContextWindow` 是上游宣告的 Max 窗口（只用于预算上限，不产生第二个模型行）。
 */
export interface TraeModelInfo {
  id: string
  /** Trae 自身的显示名（不含倍率后缀；倍率后缀只加在给 DSH 的名字上）。 */
  name: string
  /** 生效上下文窗口。目录保证必有正值：DSH 拒绝无窗口模型会拖垮整条 provider 路由。 */
  contextWindow: number
  /** 单次输出的 token 上限；上游目录偶有缺省。 */
  maxOutputTokens?: number
  /** 积分倍率（折后价，如 0.08 → 「 · x0.08」）。 */
  multiplier?: number
  /** 上游宣告的推理档位（低配模型缺省）。 */
  supportedEfforts?: readonly string[]
  /** 当前是否对 DSH 暴露图片输入。 */
  supportsImages: boolean
  /** 上游自己的 multimodal 宣告（图像能力的来源事实，可被显式 opt-in 叠加）。 */
  multimodal?: boolean
  /** 上游宣告的 Max 档窗口（预算只能抬到这个值，绝不虚构）。 */
  maxContextWindow?: number
  /** 上游标签（保留给卡片扩展，如 free）。 */
  tags?: readonly string[]
  /** `llm_utils_chat` 真正接受的 config_name；缺省 = id 本身就是 wire id。 */
  wireConfigName?: string
  /** 目录中列出该模型的 function（chat 调用必须回放它）。 */
  wireFunction?: string
}

/**
 * 目录保证的默认窗口。两个来源（远端目录/get_detail_param）都没报窗口的
 * 罕见模型用它兜底：没有窗口的模型会让 DSH 整条 provider 路由
 * `INVALID_MODEL_CONTEXT` 失败，比一个不精确的窗口严重得多。
 */
export const TRAE_DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * CN 回退名册（照抄 dsh-connect-trae catalog.ts，字段已实测核对）：
 * - id 必须是 `llm_utils_chat` 真正接受的 config_name（CN 的 DeepSeek 行带
 *   `-Official` 后缀；没有 `auto` 这种伪 id）；
 * - 每行必须带正整数 contextWindow（原因同上）；
 * - 图像输入缺省关闭，由用户的显式 opt-in 打开。
 */
export const FALLBACK_TRAE_MODELS: readonly TraeModelInfo[] = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash', contextWindow: 200_000, supportsImages: false, multimodal: false },
  { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro', contextWindow: 200_000, supportsImages: false, multimodal: false },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000, supportsImages: false, multimodal: false },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 200_000, supportsImages: false, multimodal: false },
]

/**
 * 国际（ai）回退名册（照抄 dsh-connect-trae，来自 2026-09-15 对
 * `coresg-normal.trae.ai/api/remote/v1/models` 的实测抓取）。两个区域名册几乎
 * 不重叠（CN 没有 Gemini/GPT/MiniMax 行），所以 ai 账号绝不能用 CN 名册播种。
 */
export const FALLBACK_TRAE_MODELS_AI: readonly TraeModelInfo[] = [
  { id: 'gemini-3.1-pro', name: 'Gemini-3.1-Pro-Preview', contextWindow: 200_000, supportsImages: false, multimodal: false },
  { id: 'gemini-3-flash-solo', name: 'Gemini-3-Flash-Preview', contextWindow: 200_000, supportsImages: false, multimodal: false },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 200_000, supportsImages: false, multimodal: false },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: 200_000, supportsImages: false, multimodal: false },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', contextWindow: 200_000, supportsImages: false, multimodal: false },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, supportsImages: false, multimodal: false },
  { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 272_000, supportsImages: false, multimodal: false },
]

/** 区域 → 回退名册。每个区域的 provider 只服务自己区域的名册。 */
export function fallbackModelsFor(region: TraeRegion): readonly TraeModelInfo[] {
  return region === 'ai' ? FALLBACK_TRAE_MODELS_AI : FALLBACK_TRAE_MODELS
}

/**
 * 给 DSH 的显示名：照 Trae 自己模型选择器的拼法，把倍率画进名字
 * （`Name · x0.08`）。行上的 `name` 保持纯净名——wire 解析等所有 join 都必须
 * 匹配不带后缀的名字；只有交给 DSH 的行用这个装饰名。
 */
export function traeModelDisplayName(model: Pick<TraeModelInfo, 'name' | 'multiplier'>): string {
  return model.multiplier === undefined
    ? model.name
    : `${model.name} · x${model.multiplier.toFixed(2)}`
}

/** 目录行 ↔ `get_detail_param` 行（wire 侧），来自上游目录的权威 wire id。 */
export interface TraeWireModel {
  /** 上游接受的 config_name（`llm_utils_chat` 的 wire id）。 */
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: { supported: readonly string[]; defaultEffort?: string }
  /**
   * 折后积分倍率，来自该行 `display_contact_config`（Trae IDE 渲染的数值）。
   * 优先于远端目录自己的 `consumption_rate`（后者可能是未折扣值，最高差 10 倍）。
   */
  creditMultiplier?: number
  /** 列出该 config_name 的目录 function（chat 调用回放它，否则 4001/4011）。 */
  function?: string
}

/** 显示名归一化，用于跨源 join（大小写与首尾空白不敏感）。 */
function displayKey(name: string): string {
  return name.trim().toLowerCase()
}

/** 目录行的推理档位列表（reasoning 支持时才有）。 */
function effortsOf(reasoning: TraeWireModel['reasoning']): readonly string[] | undefined {
  return reasoning?.supported.length === 0 ? undefined : reasoning?.supported
}

/**
 * 合并两个 Trae 模型来源为一个权威目录。
 *
 * - `remote`（`/api/remote/v1/models`）是模型骨架：显示 id、显示名、上下文窗口、
 *   倍率、推理与 multimodal 标志；
 * - `wire`（`get_detail_param`）提供真正的 `llm_utils_chat` config_name——chat
 *   端点唯一接受的 id——以及 `display_contact_config` 里的折后倍率（优先）。
 *
 * 合并规则（照抄 dsh-connect-trae mergeTraeModelSources，语义不变）：
 * 1. wire 按 id（config_name）或显示名 join 到 remote 行；
 * 2. **没有 wire 匹配的 remote 行也保留**——wire 名册是账号范围的，"免费账号没列"
 *    不能证明付费账号调不了；行保留后调用失败会给可读报错而不是静默消失；
 * 3. 倍率：wire 的折后值优先，remote 的 `consumption_rate` 兜底；
 * 4. wire 的 config_name 与 remote id 不同时记为 `wireConfigName`。
 */
export function mergeTraeModelSources(
  remote: readonly TraeDiscoveredModel[],
  wire: readonly TraeWireModel[],
): TraeModelInfo[] {
  const wireByName = new Map<string, TraeWireModel>()
  const wireById = new Map<string, TraeWireModel>()
  for (const model of wire) {
    wireByName.set(displayKey(model.name), model)
    wireById.set(displayKey(model.id), model)
  }
  const result: TraeModelInfo[] = []
  for (const model of remote) {
    const wireModel = wireById.get(displayKey(model.id)) ?? wireByName.get(displayKey(model.name))
    const creditMultiplier = wireModel?.creditMultiplier ?? model.creditMultiplier
    const window = model.contextWindow ?? wireModel?.contextWindow
    result.push({
      id: model.id,
      name: model.name,
      // 目录保证每个窗口有值：两个来源都没报的行用兜底窗口，避免 DSH 把整条
      // provider 路由按 INVALID_MODEL_CONTEXT 拒掉。
      contextWindow: window ?? TRAE_DEFAULT_CONTEXT_WINDOW,
      ...model.maxContextWindow === undefined ? {} : { maxContextWindow: model.maxContextWindow },
      ...wireModel?.maxTokens === undefined ? {} : { maxOutputTokens: wireModel.maxTokens },
      ...creditMultiplier === undefined ? {} : { multiplier: creditMultiplier },
      // 图像输入不在这里放行：`supportsImages` 保持 false，由 visible() 的
      // 单次决策统一（上游 multimodal 标志 + 用户显式 opt-in）。
      supportsImages: false,
      ...model.multimodal === undefined ? {} : { multimodal: model.multimodal },
      ...effortsOf(model.reasoning) === undefined ? {} : { supportedEfforts: effortsOf(model.reasoning) },
      ...wireModel !== undefined && wireModel.id !== '' && wireModel.id !== model.id ? { wireConfigName: wireModel.id } : {},
      ...wireModel?.function === undefined ? {} : { wireFunction: wireModel.function },
    })
  }
  return result
}

/** 用户的模型选择（settings 分区存储）。 */
export interface ModelSelection {
  /** 缺省 = 目录里所有模型都提供（新安装绝不能给空选择器）。 */
  enabledModelIds?: readonly string[]
  /** 缺省 = 跟随上游 multimodal 能力。 */
  imageModelIds?: readonly string[]
  /** 按模型 id 的上下文预算。 */
  contextBudgets?: Readonly<Record<string, number | undefined>>
}

/** 用户选择的上下文预算数值类型（token 数）。 */
export type TraeContextBudget = number

/**
 * 应用单个模型的上下文预算。
 * 规则：预算必须落在 (0, 广告窗口上限] 内——上限 = maxContextWindow（若有）
 * 否则当前窗口。可以下调，也可以上调到上游真实宣告的 Max 档，但绝不虚构数值。
 */
export function applyModelBudget(model: TraeModelInfo, budget: number | undefined): TraeModelInfo {
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return model
  const ceiling = model.maxContextWindow ?? model.contextWindow
  const window = Math.max(1, Math.min(Math.floor(budget), ceiling))
  if (window === model.contextWindow) return model
  return { ...model, contextWindow: window }
}

/** 模型目录：live 数据 + 静态回退 + 用户选择。 */
export class TraeCatalog {
  private models: readonly TraeModelInfo[]
  private listeners = new Set<() => void>()
  /** 用户的模型选择。空对象 = 跟随目录不过滤。 */
  private selection: ModelSelection = {}
  /** 当前 models 来自网关（live）还是静态表（fallback）。 */
  private source: 'live' | 'fallback' = 'fallback'
  /** live 列表最近一次落地的 ISO 时间。 */
  private lastUpdatedAt: string | undefined
  /** 最近一次抓取失败的原因（展示用）。 */
  private lastError: string | undefined
  /** 区域用于 reset() 时选对回退名册。 */
  private readonly region: TraeRegion

  /**
   * @param region 播种该区域的静态回退：每个区域的 provider 在第一次 live
   * 刷新落地前绝不能服务另一个区域的名册。
   */
  constructor(region: TraeRegion = 'cn') {
    this.region = region
    this.models = fallbackModelsFor(region)
  }

  /** 当前完整目录（未套用 selection）。 */
  current(): readonly TraeModelInfo[] {
    return this.models
  }

  /**
   * DSH 实际应提供的模型：套用用户选择——停用的模型剔除，显式图片列表与上游
   * multimodal 标志并集决定图片输入，逐模型预算调整窗口。
   *
   * 与蓝本 dsh-workbuddy-xdpool 的语义一致：`enabledModelIds` **缺失** = 全部
   * 可见；空数组则是「用户撤回了每一个模型」这一显式选择，必须照办——所以这里
   * 不能把空数组也放宽成不筛选。
   *
   * 真正要防的是空数组被**无意写入**：schema 会把「从未配置」materialize 成
   * `[]`，那会让模型选择器整个空掉。防它的是写入侧的兜底（见 index.ts 的
   * applySelection 与卡片保存），不是在这里放宽过滤。
   */
  visible(): readonly TraeModelInfo[] {
    const enabled = this.selection.enabledModelIds
    const allow = enabled === undefined ? undefined : new Set(enabled)
    const images = this.selection.imageModelIds
    const imageSet = images === undefined ? undefined : new Set(images)
    const budgets = this.selection.contextBudgets
    return this.models
      .filter(model => allow === undefined || allow.has(model.id))
      .map(model => {
        let next = { ...model }
        if (imageSet !== undefined) next.supportsImages = next.supportsImages || imageSet.has(model.id)
        // 上游自己宣告 multimodal 的模型即使没有 opt-in 也接受图片：
        // Trae IDE 的附件按钮就只看这个标志。
        if (model.multimodal === true) next.supportsImages = true
        next = applyModelBudget(next, budgets?.[model.id])
        return next
      })
  }

  /** 替换目录并通知 adapter 重建模型列表。空列表忽略（绝不接受空目录）。 */
  update(models: readonly TraeModelInfo[]): void {
    if (models.length === 0) return
    this.models = models
    this.notify()
  }

  /** 恢复本区域的静态回退（例如上游长时间不可用后手动重置）。 */
  reset(): void {
    this.models = fallbackModelsFor(this.region)
    this.source = 'fallback'
    this.notify()
  }

  /** 本目录服务的区域。 */
  currentRegion(): TraeRegion {
    return this.region
  }

  /** 替换用户选择；adapter 从 visible() 重建。 */
  applySelection(selection: ModelSelection): void {
    this.selection = selection
    this.notify()
  }

  /** 当前生效的选择（卡片的保存回环用）。 */
  currentSelection(): ModelSelection {
    return this.selection
  }

  /** 当前目录来源（fallback 是降级但不是错误状态）。 */
  currentSource(): 'live' | 'fallback' {
    return this.source
  }

  /** live 列表最近一次落地时间（从未成功过则 undefined）。 */
  catalogUpdatedAt(): string | undefined {
    return this.lastUpdatedAt
  }

  /** 最近一次抓取失败原因（未失败则 undefined）。 */
  lastFetchError(): string | undefined {
    return this.lastError
  }

  /** 订阅目录变化；返回退订函数。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 按 id 找行（含 wire 信息，供 shim 解析 config_name）。 */
  find(id: string): TraeModelInfo | undefined {
    return this.models.find(model => model.id === id)
  }

  /** 从 live 合并结果替换目录；空列表时保留现状并记录失败。 */
  updateFromUpstream(models: readonly TraeModelInfo[]): void {
    if (models.length === 0) {
      this.noteFetchFailure('live catalog fetch returned no models')
      return
    }
    this.update(models)
    this.source = 'live'
    this.lastUpdatedAt = new Date().toISOString()
    this.lastError = undefined
  }

  /**
   * 记录一次抓取失败，但不重置当前列表：一次刷新失败不应把健康的会话降级到
   * 静态表——保留在跑的目录比“闪回旧名册”更安全。
   */
  noteFetchFailure(message: string): void {
    this.lastError = message
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
