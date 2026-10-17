/**
 * SSE → OpenAI 流转换。移植自 dsh-connect-trae sse.ts + solo-bridge.ts，
 * 语义不变：Trae 的命名 SSE 事件（output/token_usage/done/error…）转换成
 * OpenAI chat-completion chunk；200 body 内的早期拒绝（error 事件）转换成
 * 真实的 HTTP 错误，而不是让 DSH 看到一个空完成流。
 *
 * @module dsh-connect-trae-models/solo-bridge
 */

import { randomUUID } from 'node:crypto'
import { SseDecoder, decodeTraeEvent } from './sse.ts'
import type { TraeChatResult, TraeUpstreamErrorKind } from './upstream.ts'

interface OpenAIToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

/** Trae 在 200 SSE body 里报告的一次上游失败。 */
interface TraeFailure {
  code?: number
  message: string
  extra?: unknown
}

/**
 * 流内错误码语义（dsh-connect-trae 2026-10-01 实测）：
 * - `1005`：该模型需要付费计划（HTTP 200 + `event:error {"code":1005}`）；
 * - `4011`：请求使用的 function 不服务该模型（message 谎称限流，实为不在此服务）；
 * - `4001`：该 function 不接受这个 config_name。
 */
const TRAE_ERROR_HINTS: Readonly<Record<number, string>> = {
  1005: 'Trae requires a paid plan for this model; the current account\'s plan does not cover it',
  4001: 'Trae does not serve this model under the SOLO function the request used (config_name rejected)',
  4011: 'Trae refused this model under the SOLO function the request used',
}

/**
 * 排队/处理中事件 → SSE 注释帧（`: …\n\n`）。
 *
 * Trae 的热门模型（实测 Seed-2.1-Pro-0915 晚高峰 SOLO 通道排队 300+ 位、等待
 * 数分钟）在 HTTP 200 之后只持续发 `request_wait_in_queue` / `progress_notice`，
 * 正文一个字都没有。OpenAI SSE 消费方按规范忽略以 `:` 开头的注释行，所以这些
 * 帧不改变消息内容，但完成两件事：
 * * 让排队位置在网络上可见（抓包/日志可诊断，而不是看起来连接死掉）；
 * * 持续刷新下游的「流空闲超时」——pi-ai adapter 的 300s idle timeout 按字节
 *   活动计时，没有这些帧，排队超过 300s 的请求会被本地误杀（2026-10-13 实测
 *   该模型排队 6 分钟仍未排到，这正是「长时间没有响应」的直接机理）。
 */
export const TRAE_QUEUE_COMMENT = 'trae-queue'
export const TRAE_PROGRESS_COMMENT = 'trae-processing'
export const TRAE_HEARTBEAT_COMMENT = 'trae-heartbeat'

/** progress_notice 很密（成对、秒级多条）；注释帧至少间隔这么久，避免刷屏。 */
export const TRAE_PROGRESS_COMMENT_MIN_MS = 5_000
/** 上游静默时的兜底保活间隔，必须显著小于下游 300s 流空闲超时。 */
export const TRAE_KEEPALIVE_INTERVAL_MS = 20_000
/**
 * 上游完全静默（连排队位置都不发）多久判为哑连接。
 * 健康排队期 `request_wait_in_queue` 约每 1~3 秒一帧；90 秒无任何字节说明
 * 连接已事实死亡，用可读错误中止，而不是把等待放大到外层空闲超时。
 */
export const TRAE_UPSTREAM_SILENCE_MS = 90_000

/** `extra` 在 wire 上是 JSON 字符串；解包读 `plan`。 */
function traeErrorPlan(extra: unknown): number | undefined {
  let value = extra
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown } catch { return undefined }
  }
  if (typeof value !== 'object' || value === null) return undefined
  const plan = (value as Record<string, unknown>)['plan']
  return typeof plan === 'number' ? plan : undefined
}

/** 流内失败的可读消息（保留原始码）。 */
export function describeTraeFailure(failure: TraeFailure): string {
  const plan = traeErrorPlan(failure.extra)
  const parts = [
    failure.code === undefined ? 'Trae refused the request' : TRAE_ERROR_HINTS[failure.code] ?? 'Trae refused the request',
    ...plan === undefined ? [] : [`plan ${plan}`],
    ...failure.code === undefined ? [] : [`Trae code ${failure.code}`],
  ]
  const detail = failure.message.trim()
  // Trae 自己的文案经常是和码矛盾的一句道歉，所以只作为 detail 附加。
  return detail === '' ? parts.join(' · ') : `${parts.join(' · ')} · upstream: ${detail}`
}

/** 流内失败 → HTTP 状态 + 错误分类。1005 是订阅门槛：402 最真实且让客户端停止重试。 */
function classifyTraeFailure(failure: TraeFailure): { status: number; kind: TraeUpstreamErrorKind } {
  return failure.code === 1005 ? { status: 402, kind: 'hard_credit' } : { status: 400, kind: 'client' }
}

/** 识别流内失败事件；其余返回 undefined。 */
function traeFailureOf(decoded: ReturnType<typeof decodeTraeEvent>): TraeFailure | undefined {
  if (decoded.type !== 'unknown') return undefined
  const payload = decoded.data as Record<string, unknown> | undefined
  const code = typeof payload?.['code'] === 'number' ? payload['code'] : undefined
  if (decoded.event !== 'error' && !(code !== undefined && code >= 4000)) return undefined
  return {
    ...code === undefined ? {} : { code },
    message: typeof payload?.['message'] === 'string' ? payload['message'] : '',
    ...payload?.['extra'] === undefined ? {} : { extra: payload['extra'] },
  }
}

function normalizeToolCalls(value: unknown): OpenAIToolCallDelta[] {
  if (!Array.isArray(value)) return []
  const calls: OpenAIToolCallDelta[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const rawFunction = typeof record['function_call'] === 'object' && record['function_call'] !== null
      ? record['function_call'] as Record<string, unknown>
      : typeof record['function'] === 'object' && record['function'] !== null
        ? record['function'] as Record<string, unknown>
        : {}
    const fn = {
      ...typeof rawFunction['name'] === 'string' ? { name: rawFunction['name'] } : {},
      ...typeof rawFunction['arguments'] === 'string' ? { arguments: rawFunction['arguments'] } : {},
    }
    calls.push({
      index: typeof record['index'] === 'number' ? record['index'] : calls.length,
      ...typeof record['id'] === 'string' ? { id: record['id'] } : {},
      ...record['type'] === 'function' ? { type: 'function' as const } : {},
      ...Object.keys(fn).length === 0 ? {} : { function: fn },
    })
  }
  return calls
}

/** Trae 命名 SSE 事件流 → OpenAI chat-completion SSE 流（原语，恒答 200）。 */
export function bridgeTraeSoloStream(response: Response, model: string): Response {
  const source = response.body
  if (source === null) return new Response(null, { status: 502 })
  return bridgeTraeSource(source, model)
}

/** {@link bridgeTraeSoloStream} 的字节流版本。 */
function bridgeTraeSource(source: ReadableStream<Uint8Array>, model: string): Response {
  const id = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const sse = new SseDecoder()
  let sawToolCalls = false
  let emittedFinishReason = false
  let upstreamEnded = false
  let upstreamError: Error | undefined
  // OpenAI 形状的 usage 对象（prompt_tokens_details 嵌套缓存明细，值类型放宽）。
  let usage: Record<string, number | Record<string, number>> | undefined

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): Uint8Array => encoder.encode(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...usage === undefined ? {} : { usage },
  })}\n\n`)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader()
      // 流结束后置位：兜底保活定时器只能在流存活期间 enqueue，绝不能在
      // close/error 之后写控制器（否则抛 TypeError 并冒泡为未处理异常）。
      let finished = false
      let lastProgressCommentAt = 0
      let lastUpstreamReadAt = Date.now()
      const comment = (text: string): void => {
        // 下游不排干时（背压/已停读）不要再堆保活帧：desiredSize<=0 说明队列
        // 已经满，继续 enqueue 只会让分钟级排队请求的内存无限增长。
        if (!finished && controller.desiredSize !== null && controller.desiredSize > 0) {
          controller.enqueue(encoder.encode(`: ${text}\n\n`))
        }
      }
      // 单个定时器身兼两职：按固定节奏发注释帧保活；并检测上游完全静默
      // （健康排队期 1~3 秒就有一帧，90 秒无字节只可能是哑连接）。
      // 定时器在 finally 中清理；cancel 会终结 read 循环从而走到它。
      const keepalive = setInterval(() => {
        if (finished) return
        if (Date.now() - lastUpstreamReadAt > TRAE_UPSTREAM_SILENCE_MS) {
          finished = true
          clearInterval(keepalive)
          reader.cancel().catch(() => {})
          controller.error(new Error(`Trae upstream fell silent for ${Math.round(TRAE_UPSTREAM_SILENCE_MS / 1000)}s `
            + '(no queue position or content events); aborting the stalled stream'))
          return
        }
        comment(TRAE_HEARTBEAT_COMMENT)
      }, TRAE_KEEPALIVE_INTERVAL_MS)
      const consume = (event: ReturnType<SseDecoder['push']>[number]): void => {
        const decoded = decodeTraeEvent(event)
        if (decoded.type === 'unknown') {
          const failure = traeFailureOf(decoded)
          if (failure !== undefined) {
            // 覆盖「已经开流后中途失败」的情形：openTraeSourceOrFail 负责早期拒绝。
            upstreamError = new Error(describeTraeFailure(failure))
          }
          return
        }
        // 服务端排队：位置持续转发为注释帧。它不是失败（账号/function 都没错，
        // 换号实测排同一条队），唯一正确的处理就是让等待可见并保活。
        if (decoded.type === 'queue') {
          comment(decoded.position === undefined ? TRAE_QUEUE_COMMENT : `${TRAE_QUEUE_COMMENT} position=${decoded.position}`)
          return
        }
        // 「Processing…」心跳：限流转发，只保证等待期有稳定字节流。
        if (decoded.type === 'progress') {
          const now = Date.now()
          if (now - lastProgressCommentAt >= TRAE_PROGRESS_COMMENT_MIN_MS) {
            lastProgressCommentAt = now
            comment(TRAE_PROGRESS_COMMENT)
          }
          return
        }
        if (decoded.type === 'delta') {
          const delta: Record<string, unknown> = {}
          if (decoded.text !== '') delta['content'] = decoded.text
          if (decoded.reasoning !== undefined && decoded.reasoning !== '') delta['reasoning_content'] = decoded.reasoning
          const toolCalls = normalizeToolCalls(decoded.toolCalls)
          if (toolCalls.length > 0) {
            sawToolCalls = true
            delta['tool_calls'] = toolCalls
          }
          if (Object.keys(delta).length > 0) controller.enqueue(chunk(delta))
        } else if (decoded.type === 'usage') {
          // 缓存记账是 prompt_tokens 的子集（OpenAI 约定），转发为
          // prompt_tokens_details.cached_tokens / .cache_write_tokens。
          const cacheRead = decoded.cacheReadTokens
          const cacheWrite = decoded.cacheWriteTokens
          const details = {
            ...cacheRead === undefined ? {} : { cached_tokens: cacheRead },
            ...cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite },
          }
          usage = {
            ...decoded.inputTokens === undefined ? {} : { prompt_tokens: decoded.inputTokens },
            ...decoded.outputTokens === undefined ? {} : { completion_tokens: decoded.outputTokens },
            ...decoded.totalTokens === undefined ? {} : { total_tokens: decoded.totalTokens },
            // 上游两个缓存字段都没发时省略 details 对象，保持原有 wire 形状。
            ...Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details },
          }
        } else if (decoded.type === 'done') {
          upstreamEnded = true
          // Trae 可能同时发 `event: done` 和结尾 `[DONE]`；只发一个 finish chunk。
          if (!emittedFinishReason) {
            emittedFinishReason = true
            if (upstreamError !== undefined) {
              controller.error(upstreamError)
              return
            }
            controller.enqueue(chunk({}, sawToolCalls ? 'tool_calls' : decoded.finishReason || 'stop'))
          }
        }
      }
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          lastUpstreamReadAt = Date.now()
          for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event)
        }
        for (const event of sse.finish()) consume(event)
        if (upstreamError !== undefined && !upstreamEnded) {
          controller.error(upstreamError)
          return
        }
        // 干净的 EOF 是合法终止（Trae 可能不发显式 done 事件），补齐 finish chunk。
        if (!emittedFinishReason) {
          emittedFinishReason = true
          controller.enqueue(chunk({}, sawToolCalls ? 'tool_calls' : 'stop'))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        finished = true
        clearInterval(keepalive)
        controller.close()
      } catch (error) {
        finished = true
        clearInterval(keepalive)
        controller.error(error)
      } finally {
        finished = true
        clearInterval(keepalive)
        reader.releaseLock()
      }
    },
    cancel(reason) { return source.cancel(reason) },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** {@link openTraeSource} 在放弃寻找失败前最多读这么多 chunk / 字节。 */
const PEEK_MAX_CHUNKS = 64
const PEEK_MAX_BYTES = 262_144

/** 回放 peek 消耗的字节，再继续排空上游。 */
function replayTraeSource(
  buffered: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ended: boolean,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = buffered[index]
      if (chunk !== undefined) {
        index += 1
        controller.enqueue(chunk)
        return
      }
      if (ended) { controller.close(); return }
      const next = await reader.read()
      if (next.done) { controller.close(); return }
      controller.enqueue(next.value)
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}) },
  })
}

/**
 * 打开上游应答；Trae 在输出任何内容**之前**拒绝时快速失败。
 * peek 只读流头部并逐字节回放，健康应答的额外缓冲不超过第一个事件。
 */
async function openTraeSource(response: Response): Promise<
  { ok: true; source: ReadableStream<Uint8Array> } | { ok: false; status: number; kind: TraeUpstreamErrorKind; message: string }
> {
  const body = response.body
  if (body === null) return { ok: false, status: 502, kind: 'server', message: 'Trae upstream returned no response body' }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const sse = new SseDecoder()
  const buffered: Uint8Array[] = []
  let bytes = 0
  let ended = false
  try {
    while (buffered.length < PEEK_MAX_CHUNKS && bytes < PEEK_MAX_BYTES) {
      const next = await reader.read()
      if (next.done) { ended = true; break }
      buffered.push(next.value)
      bytes += next.value.byteLength
      let answered = false
      for (const event of sse.push(decoder.decode(next.value, { stream: true }))) {
        const decoded = decodeTraeEvent(event)
        const failure = traeFailureOf(decoded)
        if (failure !== undefined) {
          await reader.cancel().catch(() => {})
          return { ok: false, ...classifyTraeFailure(failure), message: describeTraeFailure(failure) }
        }
        // Trae 自己认识的任何事件类型都说明它接受了请求；停止 peek，从这里开始流。
        if (decoded.type !== 'unknown') answered = true
      }
      if (answered) break
    }
  } catch (error) {
    reader.releaseLock()
    return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
  }
  return { ok: true, source: replayTraeSource(buffered, reader, ended) }
}

/**
 * 桥接一个上游应答，把早期拒绝变成真实错误结果。
 * {@link bridgeTraeSoloStream} 是同步原语（恒 200）；这是桥接类实际使用的策略。
 */
export async function bridgeTraeSoloStreamOrFail(response: Response, model: string): Promise<TraeChatResult> {
  const opened = await openTraeSource(response)
  if (!opened.ok) return opened
  return { ok: true, response: bridgeTraeSource(opened.source, model) }
}
