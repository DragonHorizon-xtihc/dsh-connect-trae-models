/**
 * 远端目录（`/api/remote/v1/models`）行解析。移植自 dsh-connect-trae
 * model-metadata.ts：只解析上游明确宣告的能力，绝不凭空补造。
 *
 * @module dsh-connect-trae-models/model-metadata
 */

import type { TraeReasoningEffort } from './reasoning.ts'

/** 一个模型宣告的两档上下文窗口（dev / Max）。 */
export interface TraeModelContextWindows {
  dev?: number
  max?: number
}

/** 远端目录宣告的推理能力（选项已被映射到标准档位）。 */
export interface TraeDiscoveredReasoning {
  supported: TraeReasoningEffort[]
  defaultEffort?: TraeReasoningEffort
}

/** 远端目录解析出的一行模型骨架。 */
export interface TraeDiscoveredModel {
  id: string
  name: string
  multimodal: boolean
  contextWindow?: number
  maxContextWindow?: number
  creditMultiplier?: number
  reasoningSupported: boolean
  reasoning?: TraeDiscoveredReasoning
}

interface RawTraeRemoteModel {
  name?: unknown
  display_name?: unknown
  multimodal?: unknown
  max_mode?: unknown
  context_window_tokens?: unknown
  reasoning_effort_config?: unknown
  features?: unknown
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** `features` 在 wire 上是内嵌 JSON 字符串。 */
function parseFeatures(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try { return record(JSON.parse(value) as unknown) } catch { return undefined }
}

const EFFORT_MAP: Readonly<Record<string, TraeReasoningEffort>> = {
  light: 'low',
  high: 'high',
  extra_high: 'xhigh',
}

/** 只解析 Trae 远端模型 API 明确宣告的能力。 */
export function parseTraeRemoteModel(value: unknown): TraeDiscoveredModel | undefined {
  const raw = record(value) as RawTraeRemoteModel | undefined
  if (raw === undefined || typeof raw.name !== 'string' || raw.name === '') return undefined
  const context = record(raw.context_window_tokens)
  const dev = finitePositive(context?.['dev'])
  const max = raw.max_mode === true ? finitePositive(context?.['max']) : undefined
  const features = parseFeatures(raw.features)
  const consumption = record(features?.['consumption_rate'])
  const consumptionData = record(consumption?.['data'])
  const creditMultiplier = consumption?.['enable'] === true ? finitePositive(consumptionData?.['rate']) : undefined
  const reasoningFeature = record(features?.['reasoning'])
  const reasoningSupported = reasoningFeature?.['enable'] === true
  const reasoningConfig = record(raw.reasoning_effort_config)
  const rawOptions = Array.isArray(reasoningConfig?.['options']) ? reasoningConfig['options'] : []
  const supported = rawOptions.flatMap(option => {
    if (typeof option !== 'string') return []
    const effort = EFFORT_MAP[option]
    return effort === undefined ? [] : [effort]
  })
  const rawDefault = reasoningConfig?.['default_level']
  const mappedDefault = typeof rawDefault === 'string' ? EFFORT_MAP[rawDefault] : undefined
  const defaultEffort = mappedDefault !== undefined && supported.includes(mappedDefault) ? mappedDefault : undefined
  return {
    id: raw.name,
    name: typeof raw.display_name === 'string' && raw.display_name !== '' ? raw.display_name : raw.name,
    multimodal: raw.multimodal === true,
    ...dev === undefined ? {} : { contextWindow: dev },
    ...max === undefined ? {} : { maxContextWindow: max },
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
    reasoningSupported,
    ...supported.length === 0 ? {} : { reasoning: { supported, ...defaultEffort === undefined ? {} : { defaultEffort } } },
  }
}
