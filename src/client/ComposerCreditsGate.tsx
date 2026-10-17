/**
 * 决定本会话的对话栏要不要显示积分读数。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 该项目的 `client/ComposerCreditsGate.tsx`：读宿主自己的 `modelSelection`
 *   投影判断「本会话当前用哪个 provider」，只在属于本插件时渲染。
 *
 * 为什么用投影而不是插件自己的状态：投影是模型选择器写入、也是下一次请求真正
 * 要用的，读数因此不可能与实际生效的模型不一致。`next` 优先于 `lastUsed`，因为
 * 一个已选定但还没发出去的选择，仍应是 composer 展示给用户的——这与外壳自身
 * 的优先级一致。
 *
 * 与 ComposerCredits 分开（也与浏览器入口分开），是为了让这个「归属判定」可以
 * 在没有宿主的测试环境里单测：入口 import 的是浏览器专属 DSH 包，测试环境
 * 加载不了，而本模块只依赖 React 和一个窄投影形状。
 */
import { ComposerCredits, COMPOSER_PROVIDERS } from './ComposerCredits.tsx'
import type { ComposerCreditsInjected } from './ComposerCredits.tsx'
import type { TraePoolRegion } from '../status-paths.ts'

/** 这个判定需要的 `modelSelection` 投影切片。 */
export interface ModelSelectionProjectionLike {
  lastUsed?: { provider?: unknown } | null
  next?: { provider?: unknown } | null
}

/**
 * 本会话当前指向的 provider 路由。
 *
 * `next` 优先于 `lastUsed`：一次已落地但还没发出的切换，仍是 composer 要展示
 * 的选择。
 */
export function selectedProviderOf(projection: ModelSelectionProjectionLike | undefined): string | undefined {
  const candidate = projection?.next ?? projection?.lastUsed
  const provider = candidate?.provider
  return typeof provider === 'string' && provider !== '' ? provider : undefined
}

/**
 * 本会话该显示哪个区域的读数；不属于本插件返回 undefined。
 *
 * 归属测试与区域选择是**同一次查找**，这样就没有第二份会漂移的规则副本。
 */
export function composerRegionOf(
  projection: ModelSelectionProjectionLike | undefined,
): TraePoolRegion | undefined {
  const provider = selectedProviderOf(projection)
  return provider === undefined ? undefined : COMPOSER_PROVIDERS[provider]
}

export interface ComposerCreditsGateProps {
  t: ComposerCreditsInjected['t']
  /** 标准插槽钩子：读宿主为本会话计算的投影；由插槽注入，直接渲染时缺失。 */
  useProjection?: (key: 'modelSelection') => unknown
  settingsScope?: ComposerCreditsInjected['settingsScope']
}

export function ComposerCreditsGate(props: ComposerCreditsGateProps) {
  const { t, useProjection, settingsScope } = props
  // 投影钩子可选：直接渲染本组件（测试）时没有宿主，由结果而非调用次数兜底。
  const projection = useProjection === undefined
    ? undefined
    : useProjection('modelSelection') as ModelSelectionProjectionLike | undefined

  // 一次判定：只有本插件拥有这个 provider 才渲染。否则什么都不画，共享的
  // composer 行保持原样，也不启动拉取循环。
  const region = composerRegionOf(projection)
  if (region === undefined) return null

  // 到这里 region 非 undefined，而它由 provider 派生，故 provider 必在；
  // 断言这一点，而不是把组件 prop 放宽成接受一个它永远见不到的缺失 provider。
  const provider = selectedProviderOf(projection) as string
  // settingsScope 为 undefined 时绝不能把 `settingsScope: undefined` 显式传进去：
  // exactOptionalPropertyTypes 下「属性缺席」与「显式 undefined」不是一回事，
  // 显式传 undefined 反而过不了类型。
  return settingsScope === undefined
    ? <ComposerCredits t={t} provider={provider} />
    : <ComposerCredits t={t} provider={provider} settingsScope={settingsScope} />
}