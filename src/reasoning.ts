/** Trae 推理档位：与上游 `reasoning_effort` wire 值一一对应。 */
export const TRAE_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type TraeReasoningEffort = typeof TRAE_REASONING_EFFORTS[number]

/** 一个模型宣告的推理能力。 */
export interface TraeReasoningCapability {
  supported: readonly TraeReasoningEffort[]
  defaultEffort?: TraeReasoningEffort
}

/** 解析 `get_detail_param` 行的 `reasoning_effort_config`（不在选项列表时返回 undefined）。 */
export function parseReasoningCapability(value: unknown): TraeReasoningCapability | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const rawOptions = Array.isArray(record['reasoning_effort_options']) ? record['reasoning_effort_options'] : []
  const supported = rawOptions.filter((item): item is TraeReasoningEffort =>
    typeof item === 'string' && (TRAE_REASONING_EFFORTS as readonly string[]).includes(item))
  const rawDefault = record['default_reasoning_effort']
  const defaultEffort = typeof rawDefault === 'string' && supported.includes(rawDefault as TraeReasoningEffort)
    ? rawDefault as TraeReasoningEffort
    : undefined
  if (supported.length === 0 && defaultEffort === undefined) return undefined
  return { supported, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

/**
 * 把选中的档位写入 body——仅当模型确实宣告了该值。
 * 未宣告时抛错而不是静默降级：DSH 侧应先把请求修剪到模型真实支持的范围。
 */
export function applyReasoningEffort<T extends Record<string, unknown>>(
  body: T,
  effort: TraeReasoningEffort | undefined,
  capability: TraeReasoningCapability | undefined,
): T & { reasoning_effort?: TraeReasoningEffort } {
  if (effort === undefined) return body
  if (capability === undefined || !capability.supported.includes(effort)) {
    throw new Error(`Trae model does not advertise reasoning effort ${effort}`)
  }
  return { ...body, reasoning_effort: effort }
}
