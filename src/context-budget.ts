/**
 * shim 的上下文窗口预算。
 *
 * 请求超出模型窗口时上游会回答 `context_length_exceeded`。与其把这一轮对话
 * 直接摔回给用户，shim 就地压缩它：
 *
 *  1. 本地估算 prompt 成本（廉价、无往返）；
 *  2. 丢弃最老的轮次，保留 `system` 与最新一轮问答；
 *  3. 若仍超限，请模型自己总结对话中段，并把摘要作为 system 消息拼回去。
 *
 * 除 `compactWithSummary` 之外，这里全是纯函数；那一处由调用方通过注入的
 * chat 函数驱动，使本模块无需网络即可测试。
 *
 * @module dsh-connect-trae-models/context-budget
 */
/** One OpenAI chat message, narrowed to the fields we must preserve. */
export interface ChatMessage {
  role: string
  content: unknown
  [key: string]: unknown
}

/** Rough character-per-token ratio. CJK is ~1 token/char, latin ~1/4. */
const CHARS_PER_TOKEN_LATIN = 4
const CHARS_PER_TOKEN_CJK = 1

/** Fixed per-message overhead the chat template adds (role markers etc.). */
const PER_MESSAGE_TOKEN_OVERHEAD = 4

/** Every image/tool part costs at least this much once decoded. */
const PER_PART_TOKEN_FLOOR = 16

/**
 * 估算一条消息 `content` 的 token 成本。
 *
 * 刻意保守（宁可高估），让我们稍微提前压缩，而不是到上游才发现超限。
 */
export function estimateContentTokens(content: unknown): number {
  if (content === null || content === undefined) return 0
  if (typeof content === 'string') return estimateTextTokens(content)
  if (typeof content === 'number' || typeof content === 'boolean') return PER_PART_TOKEN_FLOOR
  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) total += estimateContentTokens(part)
    return total
  }
  if (typeof content === 'object') {
    const record = content as Record<string, unknown>
    // Multimodal parts carry their payload under `text` / `image_url` / `input`.
    let total = PER_PART_TOKEN_FLOOR
    for (const key of ['text', 'image_url', 'input', 'content']) {
      if (key in record) total += estimateContentTokens(record[key])
    }
    // Tool calls and arbitrary JSON payloads still cost their serialised size.
    if (total === PER_PART_TOKEN_FLOOR) total += estimateTextTokens(safeStringify(record))
    return total
  }
  return 0
}

/** Estimate tokens for a plain string, accounting for CJK density. */
export function estimateTextTokens(text: string): number {
  if (text === '') return 0
  let cjk = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (isCjk(code)) cjk += 1
  }
  const latin = text.length - cjk
  return Math.ceil(cjk / CHARS_PER_TOKEN_CJK + latin / CHARS_PER_TOKEN_LATIN)
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) // CJK punctuation
    || (code >= 0x3040 && code <= 0x30ff) // kana
    || (code >= 0x3400 && code <= 0x4dbf) // extension A
    || (code >= 0x4e00 && code <= 0x9fff) // unified ideographs
    || (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
    || (code >= 0xff00 && code <= 0xffef) // fullwidth forms
    || (code >= 0x20000 && code <= 0x2ebef) // extensions B–F
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** Estimate the prompt cost of a whole message array. */
export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += PER_MESSAGE_TOKEN_OVERHEAD
    total += estimateContentTokens(message.content)
    // Tool-call metadata rides alongside `content` and is billed too.
    if (message['tool_calls'] !== undefined) total += estimateContentTokens(message['tool_calls'])
    if (message['name'] !== undefined) total += estimateTextTokens(String(message['name']))
  }
  return total
}

/** True when `role` carries instructions that must survive compaction. */
function isPinnedRole(role: string): boolean {
  return role === 'system' || role === 'developer'
}

export interface CompactOptions {
  /**
   * prompt 的 token 预算。为模型自身输出预留的部分已由调用方扣除，
   * 所以这就是 prompt 的上限。
   */
  budget: number
  /** Keep at least this many trailing non-pinned messages verbatim. */
  keepRecent?: number
}

export interface CompactResult {
  /** The compacted message array. */
  messages: ChatMessage[]
  /** Messages removed (oldest first) — the summarisation input. */
  dropped: ChatMessage[]
  /** Estimated tokens after compaction. */
  tokens: number
  /** Whether anything was actually removed. */
  changed: boolean
}

/**
 * 丢弃最老的非钉住消息，直到估算值放得进 `budget`。
 *
 * 钉住（system/developer）的消息与最新 `keepRecent` 条消息被保留
 * —— 这里绝不动它们；若仅它们就超预算，调用方必须回退到总结或放弃。
 */
export function compactMessages(
  messages: readonly ChatMessage[],
  options: CompactOptions,
): CompactResult {
  const keepRecent = Math.max(1, options.keepRecent ?? 4)
  const estimate = estimateMessagesTokens(messages)
  if (estimate <= options.budget) {
    return { messages: [...messages], dropped: [], tokens: estimate, changed: false }
  }

  const pinned: ChatMessage[] = []
  const body: ChatMessage[] = []
  for (const message of messages) {
    if (isPinnedRole(message.role)) pinned.push(message)
    else body.push(message)
  }

  // Always keep the tail; everything older is a drop candidate.
  const keep = Math.min(keepRecent, body.length)
  const tail = body.slice(body.length - keep)
  // `head` is the SURVIVING prefix; `dropCount` walks it down from the front, so
  // the dropped set grows while the survivor shrinks. Tracking the dropped set as
  // the survivor list was the original bug: once the prefix emptied, this function
  // reported `changed: false` even though most of the conversation had been cut.
  const head = body.slice(0, body.length - keep)
  let dropCount = 0
  let candidate = [...pinned, ...head, ...tail]
  let total = estimateMessagesTokens(candidate)

  while (total > options.budget && dropCount < head.length) {
    dropCount += 1
    candidate = [...pinned, ...head.slice(dropCount), ...tail]
    total = estimateMessagesTokens(candidate)
  }

  // Summarisation input is exactly the prefix trimmed away.
  const dropped = head.slice(0, dropCount)

  return {
    messages: candidate,
    dropped,
    tokens: total,
    changed: dropCount > 0,
  }
}

/**
 * 最后手段：丢弃最老的消息，**包括**钉住的那些。
 *
 * 用在连摘要都无法把 prompt 压进预算时（例如粘贴了一整个巨大文档）。
 * 最新的一条消息永远保留。
 */
export function hardTruncate(
  messages: readonly ChatMessage[],
  budget: number,
): CompactResult {
  if (messages.length === 0) return { messages: [], dropped: [], tokens: 0, changed: false }
  let start = 0
  let candidate = [...messages]
  let total = estimateMessagesTokens(candidate)
  while (total > budget && start < messages.length - 1) {
    start += 1
    candidate = messages.slice(start)
    total = estimateMessagesTokens(candidate)
  }
  return {
    messages: candidate,
    dropped: messages.slice(0, start),
    tokens: total,
    changed: start > 0,
  }
}

/** Instructions handed to the model when we ask it to compact a conversation. */
export const SUMMARIZE_INSTRUCTION = [
  'You are compacting an ongoing conversation so it can continue without the original history.',
  'Summarise the transcript below into a dense briefing for the next assistant turn.',
  'Preserve, in this order of priority:',
  '1. explicit user requirements, constraints and corrections;',
  '2. decisions already made, and the reasoning behind them;',
  '3. concrete facts: file paths, identifiers, commands, numbers, error messages;',
  '4. unfinished work and the current blocker.',
  'Drop pleasantries, repetition and superseded attempts.',
  'Write the briefing only — no preamble, no markdown fence.',
].join('\n')

/** Render a message array as plain text for the summarisation prompt. */
export function transcriptOf(messages: readonly ChatMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const role = message.role === '' ? 'unknown' : message.role
    lines.push(`### ${role}`)
    lines.push(renderContent(message.content))
    // Keep tool-call structure that the next turn may need to reference.
    if (message['tool_calls'] !== undefined) lines.push(renderContent(message['tool_calls']))
  }
  return lines.join('\n')
}

function renderContent(content: unknown): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => renderContent(part)).filter(text => text !== '').join('\n')
  }
  if (typeof content === 'object') {
    const record = content as Record<string, unknown>
    for (const key of ['text', 'content', 'input']) {
      if (typeof record[key] === 'string') return record[key] as string
    }
    if (record['type'] !== undefined && typeof record['type'] === 'string') {
      return `[${record['type']}]`
    }
    return safeStringify(record)
  }
  return String(content)
}

/** Build the synthetic system message that carries a compaction summary. */
export function summaryMessage(summary: string): ChatMessage {
  return {
    role: 'system',
    content: [
      'The earlier part of this conversation was compacted to fit the model context window.',
      'Briefing produced from the dropped turns:',
      '',
      summary.trim(),
    ].join('\n'),
  }
}

export interface SummarizeDeps {
  /**
   * 发一次非流式补全。必须解析出助手文本，或 reject，
   * 好让调用方回退到纯截断。
   */
  complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string>
}

export interface SummarizeResult {
  messages: ChatMessage[]
  summary?: string
  /** Why summarisation was skipped, when it was. */
  skipped?: string
  tokens: number
}

/**
 * 把 `messages` 压缩到 `budget`，尽可能总结被丢弃的轮次。
 *
 * 请求摘要时使用**有界**的转录文本，使压缩调用自身永远不会超窗：若被丢弃的
 * 轮次极大，只总结其中最新的一片，最老的那些标注为已省略。
 */
export async function compactWithSummary(
  messages: readonly ChatMessage[],
  options: CompactOptions,
  deps: SummarizeDeps,
  signal?: AbortSignal,
): Promise<SummarizeResult> {
  const first = compactMessages(messages, options)
  if (!first.changed) return { messages: first.messages, tokens: first.tokens, summary: undefined, skipped: undefined }

  // Give the summariser a bounded slice of the transcript.
  const summaryBudget = Math.max(256, Math.floor(options.budget / 4))
  let toSummarize = first.dropped
  let elided = 0
  while (estimateMessagesTokens(toSummarize) > summaryBudget && toSummarize.length > 1) {
    toSummarize = toSummarize.slice(1)
    elided += 1
  }

  let summary: string | undefined
  let skipped: string | undefined
  try {
    const instruction = elided > 0
      ? `${SUMMARIZE_INSTRUCTION}\n\nNote: the ${elided} oldest turn(s) were elided before this transcript.`
      : SUMMARIZE_INSTRUCTION
    const suffix = elided > 0 ? `\n(the ${elided} oldest turn(s) were elided)` : ''
    const request: ChatMessage[] = [
      { role: 'system', content: instruction },
      { role: 'user', content: `${transcriptOf(toSummarize)}${suffix}` },
    ]
    const text = await deps.complete(request, signal)
    if (text.trim() !== '') summary = text.trim()
    else skipped = 'summariser returned an empty summary'
  } catch (error: unknown) {
    skipped = `summarisation failed: ${String(error)}`
  }

  if (summary === undefined) {
    // No summary: fall back to plain truncation, which is still better than
    // surfacing a hard 400 to the user.
    return { messages: first.messages, skipped, tokens: first.tokens }
  }

  const withSummary = injectSummary(first.messages, summary)

  // The summary may itself push us back over budget; hard truncate if so.
  if (estimateMessagesTokens(withSummary) > options.budget) {
    const truncated = hardTruncate(withSummary, options.budget)
    return { messages: truncated.messages, summary, tokens: truncated.tokens }
  }
  return { messages: withSummary, summary, tokens: estimateMessagesTokens(withSummary) }
}

/**
 * Re-insert a summary as: pinned instructions → summary → surviving tail.
 *
 * 顺序有意义。钉住（system/developer）的消息必须排在摘要之前，这样后加的
 * 合成 system 消息永远不会覆盖 harness 自己的指令；尾部紧随其后，使最新一轮
 * 问答是模型最后读到的内容。
 *
 * `compacted` 总是由 `compactMessages` 从 `original` 派生而来，所以它携带的
 * 钉住消息就是原件 —— 无需再从 `original` 里重新添加。
 */
function injectSummary(compacted: readonly ChatMessage[], summary: string): ChatMessage[] {
  const pinned: ChatMessage[] = []
  const rest: ChatMessage[] = []
  for (const message of compacted) {
    if (isPinnedRole(message.role)) pinned.push(message)
    else rest.push(message)
  }
  return [...pinned, summaryMessage(summary), ...rest]
}
