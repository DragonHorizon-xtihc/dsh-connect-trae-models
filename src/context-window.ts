/**
 * 上下文窗口档位算术（宿主与卡片共用）。
 *
 * 为什么单独一个模块：本文件**不 import 任何 Node 专有 API**，所以宿主侧
 * （catalog/adapter）与浏览器半端（卡片渲染档位建议）可以共用同一份算术。
 * 两边各自手抄一份必然漂移，而漂移的表现是「卡片给你一个窗口，宿主却拒绝
 * 应用」——一个静默失效的控件。
 *
 * 背景（见 `docs/CONTEXT_OVERFLOW_ROOTCAUSE.md`）：本插件曾把申报给 DSH 的
 * `contextWindow` 永久钉在 200000，而 `deepseek-v4.1-flash` 的真实窗口是
 * 1,000,000。pi-ai 在模型**正常返回**之后用 `usage.input > contextWindow` 做
 * 事后判定（silent overflow），于是 24~34 万 token 的成功响应被当成溢出丢弃。
 * 让窗口如实反映上游宣告的档位，是这条误判链的唯一正解。
 *
 * @module dsh-connect-trae-models/context-window
 */

/**
 * 两个档位之间的中间档（token 数）。
 *
 * 存在的理由：Trae 给每个模型宣告两档——dev（通常 200K/256K/272K）与 Max
 * （通常 1M）。dev→Max 是 5 倍跳跃，对只想「多一点余量」的用户来说代价过高
 * （Max 档按倍率计费）。500K 是折中点，且**只在该模型的 Max 档不窄于 500K 时
 * 才提供**——绝不给一个上游没宣告过的窄模型伪造 500K。
 *
 * 为什么是常量而不是按模型算：这是**本地**偏好（只影响 DSH 何时压缩），不是
 * Trae 宣告的窗口。真正的护栏是 {@link resolveContextBudget}：任何比该模型
 * Max 更宽、或非正整数的预算一律作废，回退默认策略。
 */
export const TRAE_CONTEXT_BUDGET_MID = 500_000

/**
 * 两个来源（远端目录 / `get_detail_param`）都没报窗口时的兜底值。
 *
 * 没有窗口的模型会让 DSH 以 `INVALID_MODEL_CONTEXT` 拒绝**整条** provider
 * 路由，比一个不精确的窗口严重得多。放在这个 node-free 模块里，是因为
 * {@link defaultContextWindow} 需要它，而 catalog.ts 反过来 import 本模块。
 */
export const TRAE_DEFAULT_CONTEXT_WINDOW = 200_000

/** {@link contextBudgetOptions} / {@link defaultContextWindow} 读的字段。 */
export interface TraeContextWindows {
  /** 目录当前生效窗口（未叠加预算时等于 dev 档）。 */
  contextWindow?: number
  /** 上游宣告的 dev 档窗口；缺省 = `contextWindow` 就是 dev 档。 */
  devContextWindow?: number
  /** 上游宣告的 Max 档窗口；缺失 = 该模型没有更宽的档位。 */
  maxContextWindow?: number
}

/** 正整数判定（窗口/预算都必须是正整数 token 数）。 */
function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * dev 档窗口：优先用显式记录的 `devContextWindow`，否则 `contextWindow` 就是
 * dev 档（未叠加预算时的常态）。
 *
 * 分开读的理由：`contextWindow` 是**生效值**，会被用户预算改写。若档位列表
 * 直接拿它当 dev 档，用户把 1M 压到 128K 之后列表就退化成 `[128K, 500K, 1M]`，
 * 「回到 dev 档」这个选项凭空消失——一个只能单向远离原状的控件。
 */
function devWindow(model: TraeContextWindows): number | undefined {
  return positive(model.devContextWindow) ?? positive(model.contextWindow)
}

/**
 * 一个模型可选的全部窗口档位，升序：dev → 500K（仅当构成真正的中间档）→ Max。
 * 重复值会被去掉，所以 dev 恰好等于 500K 的模型只出现一次。
 *
 * 没有 Max 档的模型只返回一个档位（它自己的 dev）。档位是**建议值**而非白名单：
 * 卡片把它们渲染成输入框的 `datalist`，用户仍可填任意合法预算；只有一档时没有
 * 可建议的内容，卡片就不渲染建议列表。
 */
export function contextBudgetOptions(model: TraeContextWindows): number[] {
  const dev = devWindow(model)
  const max = positive(model.maxContextWindow)
  const options: number[] = []
  const push = (value: number | undefined): void => {
    if (value === undefined || options.includes(value)) return
    options.push(value)
  }
  push(dev)
  // 仅当它是两个档位之间**真正的一步**：比 dev 宽（相等就是重复项），且不宽于
  // Max（相等就是重复项）。
  if (max !== undefined && max >= TRAE_CONTEXT_BUDGET_MID && (dev === undefined || TRAE_CONTEXT_BUDGET_MID > dev)) {
    push(TRAE_CONTEXT_BUDGET_MID)
  }
  push(max)
  return options.sort((left, right) => left - right)
}

/**
 * 该模型允许的最宽窗口 —— `contextBudgetOptions` 的最大值。
 *
 * 单独暴露是因为「上限」和「档位列表」是两个不同的问题：预算校验只关心上限，
 * 而卡片渲染关心列表。上限永远不会超过上游宣告的 Max（无 Max 时就是 dev），
 * 所以任何被接受的预算都不可能虚构出一个上游没承诺过的窗口。
 */
export function budgetCeiling(model: TraeContextWindows): number {
  const options = contextBudgetOptions(model)
  const widest = options[options.length - 1]
  return widest ?? positive(model.contextWindow) ?? TRAE_DEFAULT_CONTEXT_WINDOW
}

/**
 * 校验并归一一个用户保存的预算。
 *
 * 规则（两条同时成立才算合法）：
 * 1. 有限数 → 向下取整后仍是正整数（`step(1)` 的 schema 拦不住老设置文件）；
 * 2. 结果**夹到** {@link budgetCeiling} 以内（绝不越过 Max）。
 *
 * 为什么超限值是「夹到 Max」而不是「作废回默认」：作废会把窗口收窄到默认档
 * （500K），而**收窄正是 silent overflow 的危险方向**——pi-ai 用
 * `usage.input > contextWindow` 事后判定，申报得越窄越容易被误杀。夹到 Max
 * 既尊重「我要尽可能宽」的原意，又保证结果仍是 {@link contextBudgetOptions}
 * 里的某一档。只有非正数 / 非有限数（0、负数、NaN、Infinity）才作废，回退
 * 默认策略。
 *
 * 非法值返回 `undefined`（调用方回退默认策略），**绝不抛错**：这个入口在配置
 * 页面的保存/渲染路径上，抛一次就会让整张卡片消失。
 */
export function resolveContextBudget(model: TraeContextWindows, budget: number | undefined): number | undefined {
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return undefined
  const window = Math.floor(budget)
  if (window < 1) return undefined
  return Math.min(window, budgetCeiling(model))
}

/**
 * 未设置预算时的默认申报窗口。
 *
 * 三种情形（这是本次事故的核心策略，改动前请先读 docs/CONTEXT_OVERFLOW_ROOTCAUSE.md）：
 * - **没有 Max 档**：dev。上游只宣告了一档，照抄它，不虚构。
 * - **Max 档不宽于 500K**（如 272K）：直接用 Max。这种档位本身就保守，再用 dev
 *   只会重演「明明能装下却报溢出」。
 * - **Max 档宽于 500K**（如 1M）：默认取 500K 而不是直接冲到 Max。这是**保守
 *   默认**——1M 是上游对模型能力的宣告，但把申报值一次拉到 1M 意味着压缩要到
 *   很晚才动手，一旦上游对某个账号/通道的实际上限更窄，就会从「可读的本地
 *   报错」变成「上游 400」。500K 已经能把本次事故里的 24~34 万 token 全部
 *   装下（约为其 1.5 倍），而想要完整 1M 的用户可以在卡片上显式选 Max 档。
 *
 * 结果永远落在 {@link contextBudgetOptions} 里（它就是其中一个档位），所以
 * 「默认策略」与「用户可选档位」不会互相矛盾。
 */
export function defaultContextWindow(model: TraeContextWindows): number {
  const dev = devWindow(model) ?? TRAE_DEFAULT_CONTEXT_WINDOW
  const max = positive(model.maxContextWindow)
  if (max === undefined) return dev
  return max <= TRAE_CONTEXT_BUDGET_MID ? Math.max(dev, max) : TRAE_CONTEXT_BUDGET_MID
}

/**
 * 一行模型**最终**应申报给 DSH 的窗口：合法预算优先，否则默认策略。
 *
 * 这是 `catalog.visible()` 与 adapter 申报共用的唯一算术入口——「预算」与
 * 「默认」两套规则若各写一遍，迟早出现「目录显示 500K、adapter 报 200K」的
 * 分叉，而那正是 silent overflow 的温床。
 */
export function effectiveContextWindow(model: TraeContextWindows, budget?: number | undefined): number {
  return resolveContextBudget(model, budget) ?? defaultContextWindow(model)
}
