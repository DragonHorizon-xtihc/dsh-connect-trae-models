/**
 * Trae SOLO chat 协议（`llm_utils_chat`）与目录函数。
 * 移植自 dsh-connect-trae solo.ts，契约已真机验证，语义禁止改动。
 *
 * @module dsh-connect-trae-models/solo
 */

import type { TraeWireModel } from './catalog.ts'
import type { TraeReasoningCapability } from './reasoning.ts'
import { parseReasoningCapability } from './reasoning.ts'

/** `llm_utils_chat` 的缺省 function（无目录信息时的兜底）。 */
export const TRAE_SOLO_FUNCTION = 'solo_work_lite'

/**
 * 各区域依次 union 的目录 function（按优先序）。
 *
 * Trae 把可调用名册拆在多个 SOLO function 上，模型只能通过列出它的那个
 * function 调用（glm-5.3 只在 `solo_work_remote` 下可用，`solo_work_lite`
 * 答 `4001 param is invalid`——dsh-connect-trae 2026-09-15 实测）。目录把
 * 它们 union；首个列出某 config_name 的 function 拥有它，chat 调用回放该 function。
 *
 * `solo_agent` 故意缺席：它是 Remote-agent 名册 function，不是 chat function
 * （实测同一模型用它必答流内 `event:error {"code":4011}`）。`chat_v3` 名册最宽，
 * 排最后只补空隙，不扰动先到 function 的归属。CN 额外接 `solo_coder`
 * （2026-10-02 逐模型验证可调）。任何 chat function 都没列出的模型交给合并层
 * 保留（无 wire 目标时调用给可读报错而不是隐藏）。
 */
export const TRAE_DIRECTORY_FUNCTIONS: Readonly<Record<'cn' | 'ai', readonly string[]>> = {
  cn: ['solo_work_remote', TRAE_SOLO_FUNCTION, 'solo_agent_remote', 'chat_v3', 'solo_coder'],
  ai: ['solo_work_remote', TRAE_SOLO_FUNCTION, 'solo_agent_remote', 'chat_v3'],
}

/** chat 端点路径。 */
export const TRAE_SOLO_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
/** 目录端点路径（`get_detail_param`）。 */
export const TRAE_SOLO_MODELS_PATH = '/api/ide/v1/get_detail_param'

/**
 * 从 `get_detail_param` 行读折后积分倍率。
 *
 * Trae IDE 渲染的倍率在 `display_contact_config`——一个**字符串**里嵌的又一份
 * JSON——其 `consumption_rate.data.rate` 已是折后价（dsh-connect-trae 2026-09-13
 * 实测：Remote 目录报未折扣值 0.8，IDE 与该字段报 0.08，限时 1 折活动下最多差
 * 10 倍）。合并时该值优先于 Remote 目录的 `consumption_rate`。
 * ai 网关到处都没有 `consumption_rate`，没有该字段的行保持裸值——解析过但缺失，
 * 绝不虚构。
 */
export function wireCreditMultiplier(config: Record<string, unknown>): number | undefined {
  const raw = config['display_contact_config']
  if (typeof raw !== 'string' || raw === '') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const consumption = (parsed as Record<string, unknown>)['consumption_rate']
  if (typeof consumption !== 'object' || consumption === null) return undefined
  const entry = consumption as Record<string, unknown>
  if (entry['enable'] !== true) return undefined
  const data = entry['data']
  if (typeof data !== 'object' || data === null) return undefined
  const rate = (data as Record<string, unknown>)['rate']
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : undefined
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 把 OpenAI 形状的请求改写为 `llm_utils_chat` 的证据化 envelope。
 * 该端点不是 OpenAI 兼容端点：显式构造 envelope，让 Pi/OpenAI 的可选字段
 * （temperature、max_tokens、tool_choice、response_format 等）不会让每个模型
 * 都撞上参数校验失败。
 *
 * 规则（照抄 dsh-connect-trae，全部实测）：
 * - `config_name` = model；`function` 优先用请求里已盖章的（目录解析产物），
 *   缺省用 functionName，再缺省 `solo_work_lite`；`stream` 恒 true；
 * - `developer` 角色 → `system`（上游只认 system/assistant/user/tool/function）；
 * - content 字符串 → `[{type:'text', text}]`；工具参数 JSON.stringify；
 * - assistant 的 `tool_calls[].function` → `function_call`；tool 消息必须有
 *   `tool_call_id`；`reasoning_effort` 字符串透传。
 */
export function prepareSoloBody(source: string, defaultModel = 'glm-5.2', functionName?: string): string {
  const input = JSON.parse(source) as Record<string, unknown>
  const requestedModel = typeof input['model'] === 'string' && input['model'].trim() !== '' ? input['model'].trim() : defaultModel
  const model = requestedModel
  const body: Record<string, unknown> = {
    ...Array.isArray(input['messages']) ? { messages: input['messages'] } : {},
    model,
    config_name: model,
    // 目录 function（见 TRAE_DIRECTORY_FUNCTIONS）。桥接层可能已经盖了从目录
    // 学到的精确 function，它优先于缺省值。
    function: typeof input['function'] === 'string' && input['function'] !== ''
      ? input['function']
      : (functionName ?? TRAE_SOLO_FUNCTION),
    stream: true,
    ...Array.isArray(input['tools']) ? { tools: input['tools'] } : {},
    ...typeof input['reasoning_effort'] === 'string' ? { reasoning_effort: input['reasoning_effort'] } : {},
  }
  if (Array.isArray(body['messages'])) {
    for (const raw of body['messages']) {
      if (typeof raw !== 'object' || raw === null) continue
      const message = raw as Record<string, unknown>
      // DSH 把 system 提示词作为 OpenAI `developer` 角色发送，`llm_utils_chat`
      // 会用 400 拒绝它；这里归一化。
      if (message['role'] === 'developer') message['role'] = 'system'
      if (typeof message['content'] === 'string') message['content'] = [{ type: 'text', text: message['content'] }]
      if (message['role'] === 'assistant' && Array.isArray(message['tool_calls'])) {
        for (const rawCall of message['tool_calls']) {
          if (typeof rawCall !== 'object' || rawCall === null) continue
          const call = rawCall as Record<string, unknown>
          if (typeof call['function'] === 'object' && call['function'] !== null) {
            call['function_call'] = call['function']
            delete call['function']
          }
        }
      }
      if (message['role'] === 'tool') {
        if (typeof message['tool_call_id'] !== 'string' || message['tool_call_id'] === '') {
          throw new Error('Trae SOLO tool message requires tool_call_id')
        }
      }
    }
  }
  if (Array.isArray(body['tools'])) {
    for (const raw of body['tools']) {
      if (typeof raw !== 'object' || raw === null) continue
      const fn = (raw as Record<string, unknown>)['function']
      if (typeof fn !== 'object' || fn === null) continue
      const record = fn as Record<string, unknown>
      if (typeof record['parameters'] === 'object' && record['parameters'] !== null) record['parameters'] = JSON.stringify(record['parameters'])
    }
  }
  return JSON.stringify(body)
}

/** 一行 `get_detail_param` 的解析结果（wire 侧权威行）。 */
export type { TraeWireModel }

/** 把一个 function 返回的 config_info_list 合并进共享目录（首个命中者拥有该 id）。 */
export function collectWireModels(
  list: readonly unknown[],
  directoryFunction: string,
  byId: Map<string, TraeWireModel>,
): void {
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const config = raw as Record<string, unknown>
    const id = typeof config['config_name'] === 'string' ? config['config_name'] : ''
    if (id === '') continue
    if (byId.has(id)) continue
    const display = typeof config['display_config'] === 'object' && config['display_config'] !== null ? config['display_config'] as Record<string, unknown> : {}
    const details = Array.isArray(config['model_detail_list']) ? config['model_detail_list'] : []
    const detail = typeof details[0] === 'object' && details[0] !== null ? details[0] as Record<string, unknown> : {}
    // get_detail_param 的真实字段名（dsh-connect-trae 2026-08-30 实测）：窗口是
    // `model_detail_list[].prompt_max_tokens`（或顶层 `context_window_tokens.dev`），
    // 输出上限是 `model_detail_list[].max_tokens`。wire 的 config_name 就是
    // `config_name` 本身——不是 `model_name`（那只是底层 checkpoint 的变体名）。
    const contextTokens = typeof config['context_window_tokens'] === 'object' && config['context_window_tokens'] !== null ? config['context_window_tokens'] as Record<string, unknown> : {}
    const promptMaxTokens = finitePositive(detail['prompt_max_tokens'])
    const devTokens = finitePositive(contextTokens['dev'])
    const contextWindow = promptMaxTokens ?? devTokens
    const maxTokens = finitePositive(detail['max_tokens'])
    const reasoning: TraeReasoningCapability | undefined = parseReasoningCapability({ ...config, ...detail })
    byId.set(id, {
      id,
      name: typeof display['display_name'] === 'string' && display['display_name'] !== '' ? display['display_name'] : id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...reasoning === undefined ? {} : { reasoning },
      ...wireCreditMultiplier(config) === undefined ? {} : { creditMultiplier: wireCreditMultiplier(config) },
      function: directoryFunction,
    })
  }
}
