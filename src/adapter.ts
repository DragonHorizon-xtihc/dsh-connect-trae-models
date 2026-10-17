/**
 * `connect-trae-models` 的 pi-ai provider：注册进 Harness LLM seam 的回环适配器，
 * 由 `dsh-llm-pi-ai` 的公开扩展点装配。每个模型都指向 shim；账号轮换留在
 * shim 内部。
 *
 * 装配方式（createProvider + openAICompletionsApi + 惰性 auth 面 + 以 shim
 * 的进程内 secret 作 apiKey）沿用 dsh-workbuddy-xdpool / dsh-connect-trae 的
 * 已验证设计（血统为 corrinehu/dsh-workbuddy-connect，MIT）。
 *
 * @module dsh-connect-trae-models/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import { TRAE_DEFAULT_CONTEXT_WINDOW, type TraeCatalog, type TraeModelInfo } from './catalog.ts'
import type { TraePoolShim } from './shim.ts'

/** 国内（CN）网关的 provider 路由。 */
export const TRAE_POOL_PROVIDER = 'connect-trae-models'
/** 国际网关的 provider 路由。 */
export const TRAE_GLOBAL_POOL_PROVIDER = 'connect-trae-models-global'

/** 每个区域注册的 provider id。 */
export const POOL_PROVIDER_BY_REGION = {
  cn: TRAE_POOL_PROVIDER,
  ai: TRAE_GLOBAL_POOL_PROVIDER,
} as const

/** 每个区域注册的显示名，让选择器能把它们分组。 */
export const POOL_NAME_BY_REGION = {
  cn: 'Trae Connect Models（国内版）',
  ai: 'Trae Connect Models（国际版）',
} as const

/**
 * 单次流读取挂起期间的 provider 空闲上限。
 *
 * 取 15 分钟（而不是常见的 5 分钟）是有证据的：2026-10-13 实测热门模型
 * Seed-2.1-Pro-0915 在 SOLO 通道晚高峰排队 300+ 位，`request_wait_in_queue`
 * 位置事件持续 6~10 分钟才排到（对照模型 glm-5.2 同期 1.1 秒首字）。5 分钟
 * 会在请求即将排到前被本地误杀。排队期间 solo-bridge 持续发 SSE 注释帧让
 * 代理层/日志可见，桥接层另有 90s「上游完全静默」保护，哑连接不会被放大到
 * 15 分钟——这个值只兜底「队列确实很长但仍在消化」。
 */
export const TRAE_STREAM_IDLE_TIMEOUT_MS = 900_000

/** dsh-llm-pi-ai 默认值下的图片请求预算。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * 惰性 pi-ai auth 面。该路由只通过每请求解析的 shim 共享 secret 认证，
 * 所以 pi-ai 自己的凭据生命周期绝不能为它制造凭据。
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-connect-trae-models: this route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** 订阅制额度没有可推断的按 token 定价；报零。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

export interface TraeAdapterOptions {
  shim: TraePoolShim
  catalog: TraeCatalog
  /** 插件上下文；pi-ai adapter 从它取 `attachments`/`fs`。 */
  ctx: Context
  providerId?: string
  displayName?: string
}

/** {@link createTraeAdapter} 交回的东西。 */
export interface TraeAdapter {
  providerId: string
  displayName: string
  adapter: PiAiAdapter
  /** 从当前目录重建 pi-ai 模型列表。 */
  buildModels: () => Model<Api>[]
  /** 重建 adapter 的 provider 快照；目录更新后调用。 */
  invalidate: () => void
}

/** pi-ai 输入模态：只有目录宣告图片时才允许图片。 */
function modelInput(info: TraeModelInfo): ('text' | 'image')[] {
  return info.supportsImages ? ['text', 'image'] : ['text']
}

/** 只映射目录宣告的档位；DSH 未宣告的档位保持关闭。 */
function thinkingLevelMap(info: TraeModelInfo): Record<string, string | null> | undefined {
  const efforts = info.supportedEfforts
  if (efforts === undefined || efforts.length === 0) return undefined
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const map: Record<string, string | null> = {}
  for (const level of levels) map[level] = (efforts as readonly string[]).includes(level) ? level : null
  map['off'] = null
  return map
}

/** 中点分隔符：在模型自带的连字符与倍率/徽标后缀之间不会歧义。 */
const DISPLAY_SEPARATOR = ' · '

/**
 * 上游标签码 → 模型选择器里紧挨倍率显示的本地化促销标签。
 * `free` 与 `limited-free` 折叠成同一个短标签，让下拉行保持可扫读。
 */
const TAG_LABEL: Readonly<Record<string, string>> = {
  'free': '限时免费',
  'limited-free': '限时免费',
  'night-discount': '夜间折扣',
}

/**
 * 解析一行目录的显示后缀（`xN.NN`、促销徽标）。
 * 没有可展示内容时返回 `undefined` —— 名字保持原样，免得在一个朴素模型后面
 * 挂一个游离的分隔符。
 */
function displaySuffix(info: TraeModelInfo): string | undefined {
  const parts: string[] = []
  // `multiplier: 0` 是网关自己表达「免费」的写法，所以打印成免费徽标而不是
  // `x0.00` —— 后者读起来是零费率，而且完全没带促销标签。
  if (info.multiplier === 0) {
    parts.push('免费')
  } else if (typeof info.multiplier === 'number' && Number.isFinite(info.multiplier)) {
    parts.push(`x${info.multiplier.toFixed(2)}`)
  }
  for (const tag of info.tags ?? []) {
    const label = TAG_LABEL[tag]
    if (label !== undefined && !parts.includes(label)) parts.push(label)
  }
  return parts.length === 0 ? undefined : parts.join(DISPLAY_SEPARATOR)
}

/**
 * 把目录的倍率 + 促销徽标应用到模型显示名上。
 *
 * 仅影响显示：wire 请求由 `model.id` 构造，所以这里的改名不可能影响路由、
 * token 或上游计费。DSH 的 composer（ModelSelect）只渲染 `model.name`，这
 * 正是倍率与徽标搭在名字上而非单独描述列的原因。
 */
function withCatalogDisplay(name: string, info: TraeModelInfo): string {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${DISPLAY_SEPARATOR}${suffix}`
}

/**
 * 构造一个指向回环 shim 的 pi-ai 模型描述符。
 *
 * `contextWindow` 必须有值：DSH 对无窗口模型会以 `INVALID_MODEL_CONTEXT`
 * 失败，而那会拖垮**整条** provider 路由 —— 比一个不精确的窗口严重得多。
 * 目录保证每行都有正整数窗口，这里仍兜底一次。
 */
function toPiModel(info: TraeModelInfo, baseUrl: string, providerId: string): Model<Api> {
  const map = thinkingLevelMap(info)
  const contextWindow = Number.isFinite(info.contextWindow) && info.contextWindow > 0
    ? info.contextWindow
    : TRAE_DEFAULT_CONTEXT_WINDOW
  return {
    id: info.id,
    name: withCatalogDisplay(info.name, info),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: modelInput(info),
    cost: NO_COST,
    contextWindow,
    maxTokens: info.maxOutputTokens,
    reasoning: map !== undefined,
    ...map === undefined ? {} : { thinkingLevelMap: map },
    compat: { supportsReasoningEffort: map !== undefined },
  } as unknown as Model<Api>
}

/**
 * 装配 adapter。`getModels` 重读实时目录，且每个模型的 `baseUrl` 每次读取都
 * 重新解析，使 shim 的临时端口从启动后的第一份快照起就生效。
 * 只在 `shim.ready` 之后调用。
 */
export function createTraeAdapter(options: TraeAdapterOptions): TraeAdapter {
  const { shim, catalog } = options
  const providerId = options.providerId ?? TRAE_POOL_PROVIDER
  const displayName = options.displayName ?? 'Trae Connect Models'

  const buildModels = (): Model<Api>[] => {
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.visible().map(info => toPiModel(info, baseUrl, providerId))
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'Trae Connect Models loopback secret',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'Trae Connect Models' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: TRAE_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-trae-models retryPolicy'),
    configuredMaxTokens: new Map(),
    // dsh-llm-pi-ai 要求：宿主 adapter 在每次模型解析时读
    // profile.modelErrors.get(model)。目录来自实时上游，所以没有预知的失败
    // —— 空 map 表示「没有模型被预先拒绝」。
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // shim 的进程内 secret 就是 OpenAI apiKey；shim 校验它，并自己在每请求
    // 从池里解析真实的 Trae token。
    resolveApiKey: async () => shim.token(),
    // 图片输入由宿主持久化附件存储提供。宿主 PiAiAdapter 在缺失该钩子时拒绝
    // 任何携带图片的请求，所以宣告图片输入的路由必须把两个钩子都接上。
    resolveAttachments: () => options.ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, hostPath => options.ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
  })

  return {
    providerId,
    displayName,
    adapter,
    buildModels,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}
