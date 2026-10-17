/**
 * Trae 上游客户端测试（mock fetch，零网络）。
 *
 * 覆盖契约（见团队计划「关键契约」与 docs/RESEARCH.md）：
 * - `get_detail_param` union：多 function 依次询问、首个命中者拥有 config_name、
 *   单 function 失败不隐藏其他名册、窗口/输出上限/reasoning 字段解析；
 * - 倍率折后优先：wire 的 `display_contact_config.consumption_rate.data.rate`
 *   压过远端目录 `features.consumption_rate`；
 * - `/models` 远端骨架：分组 union、同 id 保留更强容量行；
 * - `llm_utils_chat`：prepareSoloBody envelope + SSE→OpenAI 转换（含 200 内早期
 *   拒绝转为真实错误）；
 * - 积分：packs 解析（含 `entitlement_base_info.end_time`）、到期提醒字段；
 * - 签到：status 双口径字段、claim 业务码 0 / 9004 / 9095 分支与 x-device-id 头。
 *
 * mock 手法：注入 `fetchImpl`，逐条断言实际发出的 URL / 头 / body。
 */

import { describe, expect, it } from 'vitest'
import {
  parseActivities,
  parseCheckinClaim,
  parseCheckinStatus,
  parseCreditsSnapshot,
  TraeUpstreamClient,
  TRAE_EXPIRING_SOON_WINDOW_MS,
  classifyTraeError,
} from '../src/upstream.ts'
import { prepareSoloBody } from '../src/solo.ts'
import { bridgeTraeSoloStream } from '../src/solo-bridge.ts'
import type { TraeRequestIdentity } from '../src/protocol.ts'

/** 一次被记录的 mock 请求。 */
interface RecordedRequest {
  url: string
  init: RequestInit
  /** 已解析的请求体（非 JSON 时为原始字符串）。 */
  body: unknown
}

/** 假凭据（CN 区域：host 决定 region）。 */
function credential(overrides: Partial<{ accessToken: string; userId: string; host: string; edition: 'cn' | 'sg' | 'solo' | 'solo-sg' }> = {}) {
  return {
    accessToken: overrides.accessToken ?? 'token-cn-1',
    userId: overrides.userId ?? 'user-1',
    host: overrides.host ?? 'https://api.trae.cn',
    edition: overrides.edition ?? 'cn' as const,
  }
}

/** 本机身份（deviceId 是签到 x-device-id 的判定量）。 */
function identity(): TraeRequestIdentity['identity'] {
  return {
    machineId: 'machine-abc',
    deviceId: 'device-dc-42',
    appVersion: '2.1.0',
    buildVersion: '20260716',
    platform: 'win32',
  }
}

/** 组装 `{ credential, identity }` 请求包。 */
function request(overrides: Parameters<typeof credential>[0] = {}): TraeRequestIdentity {
  return { credential: credential(overrides), identity: identity() }
}

/** 造一个 JSON 应答。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 造一个 SSE 应答。 */
function sseResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 读回一个 SSE 应答的全部文本。 */
async function readAll(response: Response): Promise<string> {
  return await response.text()
}

/**
 * 造一个按 URL 路由的 mock fetch，并把每个请求记录到 `requests`。
 * `routes` 命中返回固定应答；未命中抛错（避免静默漏测）。
 */
function mockFetch(routes: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const finalInit = init ?? {}
    let body: unknown = finalInit.body
    if (typeof body === 'string') {
      try { body = JSON.parse(body) as unknown } catch { /* 保留原始字符串 */ }
    }
    requests.push({ url, init: finalInit, body })
    return await routes(url, finalInit)
  }) as typeof fetch
  return { fetchImpl, requests }
}

/** 一行 `get_detail_param` config（含内嵌 JSON 的倍率字符串）。 */
function wireRow(options: {
  configName: string
  displayName?: string
  promptMaxTokens?: number
  devTokens?: number
  maxTokens?: number
  rate?: number
  rateEnabled?: boolean
  reasoning?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    config_name: options.configName,
    display_config: { display_name: options.displayName ?? options.configName },
    model_detail_list: [{
      ...options.promptMaxTokens === undefined ? {} : { prompt_max_tokens: options.promptMaxTokens },
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    }],
    ...options.devTokens === undefined ? {} : { context_window_tokens: { dev: options.devTokens } },
    ...options.rate === undefined ? {} : {
      display_contact_config: JSON.stringify({
        consumption_rate: {
          enable: options.rateEnabled ?? true,
          data: { rate: options.rate },
        },
      }),
    },
    ...options.reasoning === undefined ? {} : options.reasoning,
  }
}

/** 一行远端目录模型。 */
function remoteRow(options: {
  name: string
  displayName?: string
  dev?: number
  max?: number
  rate?: number
  multimodal?: boolean
  efforts?: string[]
  defaultLevel?: string
}): Record<string, unknown> {
  return {
    name: options.name,
    display_name: options.displayName ?? options.name,
    multimodal: options.multimodal ?? false,
    ...options.max === undefined ? {} : { max_mode: true },
    ...options.dev === undefined && options.max === undefined ? {} : {
      context_window_tokens: {
        ...options.dev === undefined ? {} : { dev: options.dev },
        ...options.max === undefined ? {} : { max: options.max },
      },
    },
    features: JSON.stringify({
      ...options.rate === undefined ? {} : { consumption_rate: { enable: true, data: { rate: options.rate } } },
      reasoning: { enable: (options.efforts ?? []).length > 0 },
    }),
    ...options.efforts === undefined ? {} : {
      reasoning_effort_config: { options: options.efforts, ...options.defaultLevel === undefined ? {} : { default_level: options.defaultLevel } },
    },
  }
}

describe('classifyTraeError 错误分类', () => {
  it('把 HTTP 状态映射到冷却/换号策略所需的类别', () => {
    // 401/403 → authentication（凭据失效，刷新/冷却账号）
    expect(classifyTraeError(401)).toBe('authentication')
    expect(classifyTraeError(403)).toBe('authentication')
    // 402 → hard_credit（积分耗尽/订阅门槛）
    expect(classifyTraeError(402)).toBe('hard_credit')
    // 429 → soft_rate（限流，模型级冷却）
    expect(classifyTraeError(429)).toBe('soft_rate')
    expect(classifyTraeError(404)).toBe('not_found')
    expect(classifyTraeError(500)).toBe('server')
    expect(classifyTraeError(503)).toBe('server')
    expect(classifyTraeError(400)).toBe('client')
  })
})

describe('fetchModels：get_detail_param union 目录', () => {
  it('依次询问区域 function 并给每个 config_name 盖章首个命中者', async () => {
    const calls: string[] = []
    const { fetchImpl, requests } = mockFetch((url) => {
      const body = JSON.parse(String(requests.at(-1)?.init.body ?? '{}')) as { function?: string }
      calls.push(body.function ?? '')
      if (body.function === 'solo_work_remote') {
        return jsonResponse({ config_info_list: [wireRow({ configName: 'glm-5.2', displayName: 'GLM-5.2', promptMaxTokens: 200_000, maxTokens: 64_000, rate: 0.08 })] })
      }
      if (body.function === 'solo_work_lite') {
        // 同一个 config_name 在第二个 function 也出现——首个命中者必须继续拥有它。
        return jsonResponse({ config_info_list: [wireRow({ configName: 'glm-5.2', rate: 0.99 }), wireRow({ configName: 'kimi-k2.6', promptMaxTokens: 200_000 })] })
      }
      return jsonResponse({ config_info_list: [] })
    })
    const client = new TraeUpstreamClient({ fetchImpl })

    const models = await client.fetchModels(request())
    const byId = new Map(models.map(model => [model.id, model]))

    // CN 区五个 function 全部被问到（顺序即 TRAE_DIRECTORY_FUNCTIONS.cn）。
    expect(calls).toEqual(['solo_work_remote', 'solo_work_lite', 'solo_agent_remote', 'chat_v3', 'solo_coder'])
    // 首个命中者拥有该 id：function 与倍率都来自 solo_work_remote，而不是后到的 0.99。
    expect(byId.get('glm-5.2')).toMatchObject({
      id: 'glm-5.2',
      name: 'GLM-5.2',
      contextWindow: 200_000,
      maxTokens: 64_000,
      creditMultiplier: 0.08,
      function: 'solo_work_remote',
    })
    expect(byId.get('kimi-k2.6')).toMatchObject({ function: 'solo_work_lite' })
    // 每个 function 都打到 CN chat 网关的 get_detail_param。
    expect(requests.every(entry => entry.url === 'https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param')).toBe(true)
    expect(requests.every(entry => (entry.init.headers as Record<string, string>)['Authorization'] === 'Cloud-IDE-JWT token-cn-1')).toBe(true)
  })

  it('单个 function 失败不隐藏其他 function 的名册', async () => {
    const { fetchImpl } = mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { function?: string }
      if (body.function === 'solo_work_remote') return jsonResponse({ message: 'boom' }, 500)
      if (body.function === 'solo_work_lite') return jsonResponse({ config_info_list: [wireRow({ configName: 'kimi-k2.6' })] })
      return jsonResponse({ config_info_list: [] })
    })
    const client = new TraeUpstreamClient({ fetchImpl })

    await expect(client.fetchModels(request())).resolves.toMatchObject([{ id: 'kimi-k2.6' }])
  })

  it('全部 function 都空/失败时抛可读错误', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ config_info_list: [] }))
    const client = new TraeUpstreamClient({ fetchImpl })

    await expect(client.fetchModels(request())).rejects.toThrow(/contained no models/)
  })

  it('窗口回退链：prompt_max_tokens 优先，其次 context_window_tokens.dev', async () => {
    const { fetchImpl } = mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { function?: string }
      if (body.function !== 'solo_work_remote') return jsonResponse({ config_info_list: [] })
      return jsonResponse({
        config_info_list: [
          wireRow({ configName: 'a', promptMaxTokens: 200_000, devTokens: 100_000 }),
          wireRow({ configName: 'b', devTokens: 128_000, maxTokens: 32_000 }),
        ],
      })
    })
    const client = new TraeUpstreamClient({ fetchImpl })
    const byId = new Map((await client.fetchModels(request())).map(model => [model.id, model]))

    expect(byId.get('a')?.contextWindow).toBe(200_000)
    expect(byId.get('b')?.contextWindow).toBe(128_000)
    expect(byId.get('b')?.maxTokens).toBe(32_000)
  })

  it('解析 reasoning 档位（options 在行顶层，与 model_detail_list 的窗口字段合并读取）', async () => {
    const { fetchImpl } = mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { function?: string }
      if (body.function !== 'solo_work_remote') return jsonResponse({ config_info_list: [] })
      return jsonResponse({
        config_info_list: [wireRow({
          configName: 'thinker',
          // 窗口/输出上限在 model_detail_list 里，reasoning 档位在行顶层：解析器
          // 必须同时看两处（`{ ...config, ...detail }`）。`high` 是 5 个标准档位
          // 之一；不在标准表里的值（如上游的 `light`/`extra_high`）被丢弃。
          promptMaxTokens: 200_000,
          reasoning: {
            reasoning_effort_options: ['low', 'medium', 'high', 'extra_high'],
            default_reasoning_effort: 'high',
          },
        })],
      })
    })
    const client = new TraeUpstreamClient({ fetchImpl })
    const [model] = await client.fetchModels(request())

    expect(model?.reasoning).toEqual({ supported: ['low', 'medium', 'high'], defaultEffort: 'high' })
    expect(model?.contextWindow).toBe(200_000)
  })

  it('ai 区只问四个 function 并路由到 ai 网关', async () => {
    const seen: string[] = []
    const { fetchImpl, requests } = mockFetch((_url, init) => {
      seen.push((JSON.parse(String(init.body)) as { function: string }).function)
      return jsonResponse({ config_info_list: seen.length === 1 ? [wireRow({ configName: 'gpt-5.4' })] : [] })
    })
    const client = new TraeUpstreamClient({ fetchImpl })

    await client.fetchModels(request({ host: 'https://coresg-normal.trae.ai', edition: 'sg' }))

    expect(seen).toEqual(['solo_work_remote', 'solo_work_lite', 'solo_agent_remote', 'chat_v3'])
    expect(requests[0]?.url).toBe('https://coresg-normal.trae.ai/api/ide/v1/get_detail_param')
  })
})

describe('fetchRemoteCatalog / mergeCatalog：倍率折后优先与骨架保留', () => {
  it('union 全部 function 分组，同 id 保留更强容量行', async () => {
    const { fetchImpl, requests } = mockFetch(() => jsonResponse({
      code: 0,
      data: {
        list: [
          { function: 'solo_agent', models: [remoteRow({ name: 'glm-5.2', displayName: 'GLM-5.2', dev: 116_000, max: 1_000_000, rate: 0.8 })] },
          { function: 'solo_agent_remote', models: [remoteRow({ name: 'glm-5.2', displayName: 'GLM-5.2', dev: 200_000, max: 1_000_000, rate: 0.8 })] },
          { function: 'chat_v3', models: [remoteRow({ name: 'kimi-k2.6', displayName: 'Kimi-K2.6', dev: 200_000 })] },
        ],
      },
    }))
    const client = new TraeUpstreamClient({ fetchImpl })

    const remote = await client.fetchRemoteCatalog(request())
    const byId = new Map(remote.map(model => [model.id, model]))

    // 同 id 两行 max 相同时取更宽的 dev（顺序无关的确定性窗口）。
    expect(byId.get('glm-5.2')?.contextWindow).toBe(200_000)
    expect(byId.get('glm-5.2')?.maxContextWindow).toBe(1_000_000)
    expect(byId.get('kimi-k2.6')).toMatchObject({ name: 'Kimi-K2.6', contextWindow: 200_000 })
    // CN 远端目录网关 + 区域化请求包装。
    expect(requests[0]?.url).toContain('https://solo.trae.cn/api/remote/v1/models?functions=')
    expect((requests[0]?.init.headers as Record<string, string>)['x-trae-user-timezone']).toBe('Asia/Shanghai')
  })

  it('倍率折后优先：wire 的 display_contact_config 压过远端 consumption_rate', async () => {
    const client = new TraeUpstreamClient({ fetchImpl: mockFetch(() => jsonResponse({})) as unknown as typeof fetch })
    const merged = client.mergeCatalog(
      [{
        id: 'glm-5.2',
        name: 'GLM-5.2',
        multimodal: false,
        contextWindow: 200_000,
        // 远端报的是未折扣值（限时 1 折活动下与 IDE 显示相差 10 倍）。
        creditMultiplier: 0.8,
        reasoningSupported: false,
      }],
      [{
        id: 'glm-5.2',
        name: 'GLM-5.2',
        contextWindow: 200_000,
        maxTokens: 64_000,
        creditMultiplier: 0.08,
        function: 'solo_work_remote',
      }],
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'glm-5.2',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      multiplier: 0.08,
      wireFunction: 'solo_work_remote',
    })
  })

  it('wire 缺省时保留远端倍率，且无 wire 匹配的骨架行也保留（wireConfigName 缺省）', async () => {
    const client = new TraeUpstreamClient({ fetchImpl: mockFetch(() => jsonResponse({})) as unknown as typeof fetch })
    const merged = client.mergeCatalog(
      [
        { id: 'glm-5.2', name: 'GLM-5.2', multimodal: false, contextWindow: 200_000, creditMultiplier: 0.8, reasoningSupported: false },
        // 远端目录的骨架行：wire 名册是账号范围的，没列不等于调不了。
        { id: 'kimi-k2.6', name: 'Kimi-K2.6', multimodal: false, contextWindow: 200_000, reasoningSupported: false },
      ],
      [{ id: 'glm-5.2', name: 'GLM-5.2', creditMultiplier: 0.08 }],
    )
    const byId = new Map(merged.map(model => [model.id, model]))

    expect(byId.get('glm-5.2')?.multiplier).toBe(0.08)
    expect(byId.get('glm-5.2')?.wireConfigName).toBeUndefined()
    expect(byId.get('kimi-k2.6')).toMatchObject({ id: 'kimi-k2.6', name: 'Kimi-K2.6' })
    expect(byId.get('kimi-k2.6')?.wireConfigName).toBeUndefined()
    expect(byId.get('kimi-k2.6')?.wireFunction).toBeUndefined()
  })

  it('wire 的 config_name 与远端 id 不同时记为 wireConfigName', async () => {
    const client = new TraeUpstreamClient({ fetchImpl: mockFetch(() => jsonResponse({})) as unknown as typeof fetch })
    const merged = client.mergeCatalog(
      [{ id: 'glm-5.2', name: 'GLM-5.2', multimodal: false, contextWindow: 200_000, reasoningSupported: false }],
      [{ id: 'glm-5.2-official', name: 'GLM-5.2', function: 'solo_work_lite' }],
    )

    expect(merged[0]).toMatchObject({ id: 'glm-5.2', wireConfigName: 'glm-5.2-official', wireFunction: 'solo_work_lite' })
  })
})

describe('prepareSoloBody：llm_utils_chat envelope', () => {
  it('改写为 Trae envelope：config_name=model、stream 恒真、function 盖章优先', () => {
    const prepared = JSON.parse(prepareSoloBody(JSON.stringify({
      model: 'glm-5.2',
      function: 'solo_work_remote',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
      temperature: 0.3,
      max_tokens: 100,
    }))) as Record<string, unknown>

    expect(prepared['config_name']).toBe('glm-5.2')
    expect(prepared['model']).toBe('glm-5.2')
    expect(prepared['stream']).toBe(true)
    // 目录 function 盖章优先于缺省。
    expect(prepared['function']).toBe('solo_work_remote')
    expect(prepared['reasoning_effort']).toBe('high')
    expect(prepared['messages']).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    // 非 OpenAI 可选字段不进入 envelope（避免参数校验失败）。
    expect(prepared).not.toHaveProperty('temperature')
    expect(prepared).not.toHaveProperty('max_tokens')
  })

  it('developer→system、工具参数 stringify、assistant tool_calls→function_call', () => {
    const prepared = JSON.parse(prepareSoloBody(JSON.stringify({
      model: 'glm-5.2',
      messages: [
        { role: 'developer', content: 'be brief' },
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"a":1}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    }))) as Record<string, unknown>

    const messages = prepared['messages'] as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'be brief' }] })
    expect(messages[1]?.['tool_calls']).toEqual([{ id: 'c1', function_call: { name: 'read', arguments: '{"a":1}' } }])
    const tools = prepared['tools'] as Array<{ function: { parameters: unknown } }>
    expect(tools[0]?.function.parameters).toBe('{"type":"object"}')
    // 缺省 function 使用 solo_work_lite。
    expect(prepared['function']).toBe('solo_work_lite')
  })

  it('tool 消息缺 tool_call_id 时抛错', () => {
    expect(() => prepareSoloBody(JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'tool', content: 'x' }] })))
      .toThrow(/tool_call_id/)
  })
})

describe('chatStream：llm_utils_chat + SSE→OpenAI', () => {
  it('把 SSE 事件转换为 OpenAI chunk（content/reasoning/tool_calls/usage/finish）', async () => {
    const { fetchImpl, requests } = mockFetch(() => sseResponse([
      'event: output\ndata: {"response":"hel"}\n\n',
      'event: output\ndata: {"response":"lo","reasoning_content":"think"}\n\n',
      'event: output\ndata: {"response":"","tool_calls":[{"index":0,"id":"c1","type":"function","function_call":{"name":"read","arguments":"{}"}}]}\n\n',
      'event: token_usage\ndata: {"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cache_read_input_tokens":8}\n\n',
      'event: done\ndata: {"finish_reason":"tool_calls"}\n\n',
      'data: [DONE]\n\n',
    ]))
    const client = new TraeUpstreamClient({ fetchImpl })

    const result = await client.chatStream(request(), JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const text = await readAll(result.response)
    expect(text).toContain('"content":"hel"')
    expect(text).toContain('"content":"lo"')
    expect(text).toContain('"reasoning_content":"think"')
    expect(text).toContain('"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read","arguments":"{}"}}]')
    expect(text).toContain('"prompt_tokens":10')
    expect(text).toContain('"cached_tokens":8')
    expect(text).toContain('"finish_reason":"tool_calls"')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)

    // 请求本身：CN chat 端点 + prepareSoloBody 的 envelope + SSE Accept 头。
    expect(requests[0]?.url).toBe('https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat')
    expect(requests[0]?.body).toMatchObject({ config_name: 'glm-5.2', stream: true, function: 'solo_work_lite' })
    expect((requests[0]?.init.headers as Record<string, string>)['Accept']).toBe('text/event-stream')
    expect((requests[0]?.init.headers as Record<string, string>)['x-app-id']).toBe('6eefa01c-1036-4c7e-9ca5-d891f63bfcd8')
    // 构建号必须数字化（点分串会被上游按 number 绑定拒绝）。
    expect((requests[0]?.init.headers as Record<string, string>)['x-app-version-code']).toBe('20260716')
  })

  it('HTTP 失败按 classifyTraeError 分类（401/402/429）', async () => {
    for (const [status, kind] of [[401, 'authentication'], [402, 'hard_credit'], [429, 'soft_rate'], [500, 'server']] as const) {
      const { fetchImpl } = mockFetch(() => new Response('nope', { status }))
      const client = new TraeUpstreamClient({ fetchImpl })
      const result = await client.chatStream(request(), JSON.stringify({ model: 'glm-5.2', messages: [] }))
      expect(result).toMatchObject({ ok: false, status, kind })
    }
  })

  it('HTTP 200 流内早期拒绝转成真实错误（1005 订阅门槛 → 402 hard_credit）', async () => {
    const { fetchImpl } = mockFetch(() => sseResponse([
      'event: error\ndata: {"code":1005,"message":"need a plan","extra":"{\\"plan\\":0}"}\n\n',
    ]))
    const client = new TraeUpstreamClient({ fetchImpl })

    const result = await client.chatStream(request(), JSON.stringify({ model: 'gpt-5.4', messages: [] }))
    expect(result).toMatchObject({ ok: false, status: 402, kind: 'hard_credit' })
    if (!result.ok) expect(result.message).toContain('Trae code 1005')
  })

  it('transport 失败归类为 server（便于换号）', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const client = new TraeUpstreamClient({ fetchImpl })

    await expect(client.chatStream(request(), JSON.stringify({ model: 'glm-5.2', messages: [] })))
      .resolves.toMatchObject({ ok: false, status: 0, kind: 'server' })
  })

  // ── 首字节（响应头阶段）超时回归 ────────────────────────────────────────
  //
  // 连接建立但响应头永不返回时：旧实现等满 120 秒兜底、归类成可重试的 server，
  // shim 换号再来一轮 → 用户白等数分钟。这三条用例钉住：早失败、归为不可重试、
  // 消息可读；且响应头秒回后 body 再慢也不能被这个超时误杀（排队是 body 阶段）。
  it('上游不吐字节时按首字节超时早失败，且归类为 client（不可重试）', async () => {
    // 模拟「连接建立但永不返回」：fetch 承诺永不 settle，只能被 signal 中止。
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
      })
      throw new Error('unreachable')
    }) as unknown as typeof fetch
    // 20ms 首字节超时：用例本身必须在毫秒级跑完，否则就是在测它要修的慢路径。
    const client = new TraeUpstreamClient({ fetchImpl, firstByteTimeoutMs: 20 })

    const started = Date.now()
    const result = await client.chatStream(request(), JSON.stringify({ model: 'Doubao-Seed-2.1-Pro', messages: [{ role: 'user', content: 'hi' }] }))
    const elapsed = Date.now() - started

    expect(result.ok).toBe(false)
    // client = 不可重试：换账号救不了一个不服务的模型，重试只会延长等待。
    expect(result.ok === false && result.kind).toBe('client')
    expect(result.ok === false && result.message).toContain('未在')
    expect(elapsed).toBeLessThan(2000)
  })

  it('首字节超时不影响正常响应（未触发就不截断）', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({}))
    const client = new TraeUpstreamClient({ fetchImpl, firstByteTimeoutMs: 60_000 })

    // 立即返回 200：首字节超时远未到，请求照常完成。
    const result = await client.chatPrepared(request(), JSON.stringify({
      model: 'glm-5.2', config_name: 'glm-5.2', function: 'solo_work_lite', stream: true,
    }))
    expect(result.ok).toBe(true)
  })

  it('首字节超时只覆盖响应头：响应头秒回后，body 慢于超时时间也不得被中断（排队回归）', async () => {
    // 复现 Seed 排队形态：响应头立即返回，正文事件在 2.5 个首字节超时后才到。
    // 旧实现用无法解除的 AbortSignal.timeout()，会在第 15 秒整把健康长流 abort。
    const encoder = new TextEncoder()
    const slowBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise(resolve => setTimeout(resolve, 50))
        controller.enqueue(encoder.encode('event: output\ndata: {"response":"late"}\n\n'))
        controller.enqueue(encoder.encode('event: done\ndata: {"finish_reason":"stop"}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    const fetchImpl = (async () =>
      new Response(slowBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch
    const client = new TraeUpstreamClient({ fetchImpl, firstByteTimeoutMs: 20 })

    const result = await client.chatStream(request(), JSON.stringify({ model: 'glm-5.2', messages: [] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const text = await readAll(result.response)
    expect(text).toContain('"content":"late"')
  })

  it('调用方传入的 signal 仍然能取消请求（与首字节超时取先到者）', async () => {
    const controller = new AbortController()
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
      })
      throw new Error('unreachable')
    }) as unknown as typeof fetch
    // 首字节超时给得极长，确保是调用方的 signal 先中止，而不是超时。
    const client = new TraeUpstreamClient({ fetchImpl, firstByteTimeoutMs: 60_000 })
    setTimeout(() => controller.abort(), 20)

    const started = Date.now()
    const result = await client.chatStream(request(), JSON.stringify({ model: 'glm-5.2', messages: [] }), controller.signal)
    expect(result.ok).toBe(false)
    // 调用方取消不是「模型不服务」，按 transport 失败归类为可重试的 server。
    expect(result.ok === false && result.kind).toBe('server')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('非法 JSON 请求体归类为 client（不发请求）', async () => {
    const { fetchImpl, requests } = mockFetch(() => jsonResponse({}))
    const client = new TraeUpstreamClient({ fetchImpl })

    await expect(client.chatStream(request(), '{not json')).resolves.toMatchObject({ ok: false, kind: 'client' })
    expect(requests).toHaveLength(0)
  })
})

describe('bridgeTraeSoloStream 原语', () => {
  it('干净 EOF 也补齐 finish chunk 与 [DONE]', async () => {
    const text = await readAll(bridgeTraeSoloStream(sseResponse([
      'event: output\ndata: {"response":"OK"}\n\n',
    ]), 'glm-5.2'))

    expect(text).toContain('"model":"glm-5.2"')
    expect(text).toContain('"content":"OK"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('CRLF 与跨 chunk 拆行都能正确解析', async () => {
    const text = await readAll(bridgeTraeSoloStream(sseResponse([
      'event: outp',
      'ut\r\ndata: {"respo',
      'nse":"split"}\r\n\r\n',
    ]), 'glm-5.2'))

    expect(text).toContain('"content":"split"')
  })

  // ── 服务端排队可见性（Seed-2.1-Pro-0915「长时间无响应」根因回归）──────────
  //
  // 实测热门模型在 HTTP 200 后只发 queue_begin/request_wait_in_queue/
  // progress_notice，正文要等数分钟。这些帧必须变成 SSE 注释转发出去：
  // 让排队在网络上可见、让中间层保活，同时 OpenAI 消费方按规范忽略注释、
  // 消息内容一个字都不被污染，排到后正文照常产出。
  it('request_wait_in_queue/progress_notice 转发为 SSE 注释帧，正文随后照常产出', async () => {
    const text = await readAll(bridgeTraeSoloStream(sseResponse([
      'event: queue_begin\ndata: {"queue_id":"q1"}\n\n',
      'event: request_wait_in_queue\ndata: {"position":145,"message":"Too many current requests"}\n\n',
      'event: progress_notice\ndata: "Processing_1"\n\n',
      'event: output\ndata: {"response":"hi"}\n\n',
      'event: done\ndata: {"finish_reason":"stop"}\n\n',
    ]), 'Doubao-Seed-2.1-Pro'))

    // 排队位置与处理心跳都作为注释帧出现……
    expect(text).toContain(': trae-queue position=145')
    expect(text).toContain(': trae-processing')
    // ……但正文 chunk 与完成帧不受影响。
    expect(text).toContain('"model":"Doubao-Seed-2.1-Pro"')
    expect(text).toContain('"content":"hi"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    // 注释绝不能混进任何 OpenAI data 负载。
    const dataLines = text.split(/\r?\n/).filter(line => line.startsWith('data:') && !line.startsWith('data: [DONE]'))
    for (const line of dataLines) {
      const payload = JSON.parse(line.slice(5).trim()) as { choices?: unknown[] }
      // 每个 data 帧都保持 OpenAI chunk 形状（没有把排队文本当 content）。
      expect(Array.isArray(payload.choices)).toBe(true)
    }
    // 没有任何正文 chunk 携带排队文本。
    expect(text).not.toContain('"content":"Processing')
  })
})

describe('parseCreditsSnapshot：积分包与到期提醒', () => {
  it('解析总量/分包/到期字段，并算出最近到期与 3 天内到期额度', () => {
    const now = Date.UTC(2026, 9, 11, 0, 0, 0)
    const snapshot = parseCreditsSnapshot({
      is_credits_billing: true,
      usage_summary: { total_amount: 1200, consumed_amount: 350 },
      user_entitlement_pack_list: [
        {
          display_desc: '每月登录赠送',
          entitlement_base_info: {
            entitlement_id: 'monthly_bonus_202610',
            // 8 天后到期——不在 3 天提醒窗口内。
            end_time: now + 8 * 24 * 60 * 60 * 1000,
            quota: { credits_limit: 500 },
            currency: 1,
          },
          usage: { credits_amount: 120 },
        },
        {
          display_desc: '签到奖励',
          entitlement_base_info: {
            entitlement_id: 'checkin_20261008',
            // 1 天后到期——命中 3 天窗口。
            end_time: now + 24 * 60 * 60 * 1000,
            quota: { credits_limit: 200 },
            currency: 0,
          },
          usage: { credits_amount: 50 },
        },
        {
          // 无到期时间：不参与提醒（绝不把 0 当成"已过期"）。
          display_desc: '一次性福利',
          entitlement_base_info: { entitlement_id: 'legacy', quota: { credits_limit: 500 } },
          usage: { credits_amount: 0 },
        },
      ],
    }, now)

    expect(snapshot.total).toBe(1200)
    expect(snapshot.consumed).toBe(350)
    expect(snapshot.available).toBe(850)
    expect(snapshot.packs).toHaveLength(3)
    expect(snapshot.packs[0]).toMatchObject({ displayDesc: '每月登录赠送', entitlementId: 'monthly_bonus_202610', creditsLimit: 500, consumed: 120, currency: 1 })
    expect(snapshot.packs[2]).toMatchObject({ displayDesc: '一次性福利', endTimeMs: 0 })
    // nearestExpiryMs 是最近一个未过期包。
    expect(snapshot.nearestExpiryMs).toBe(now + 24 * 60 * 60 * 1000)
    // 3 天内到期额度 = 200 - 50（已用掉的不算），monthly 与无到期包都不计。
    expect(snapshot.expiringSoon).toBe(150)
    expect(snapshot.expiringSoonWindowMs).toBe(TRAE_EXPIRING_SOON_WINDOW_MS)
  })

  it('end_time 是秒级时间戳，必须按秒解析（上游实测值）', () => {
    // 实证：参照插件文档记录 `start_time=1790382849` = 2026-09-26 08:34:09（北京）
    // —— 十位数即秒。当毫秒用会得到 1970 年，且每个包都判定为「已过期」。
    const seconds = 1790382849
    const expected = seconds * 1000
    const snapshot = parseCreditsSnapshot({
      usage_summary: { total_amount: 200, consumed_amount: 0 },
      user_entitlement_pack_list: [{
        display_desc: '签到奖励',
        entitlement_base_info: { entitlement_id: 'checkin', end_time: seconds, quota: { credits_limit: 200 } },
        usage: { credits_amount: 0 },
      }],
    }, expected - 60 * 60 * 1000) // 以到期前 1 小时为「现在」

    expect(snapshot.packs[0]?.endTimeMs).toBe(expected)
    expect(new Date(snapshot.packs[0]!.endTimeMs).getUTCFullYear()).toBe(2026)
    expect(snapshot.nearestExpiryMs).toBe(expected)
  })

  it('已经是毫秒的时间戳不被重复放大', () => {
    const ms = Date.UTC(2026, 9, 26)
    const snapshot = parseCreditsSnapshot({
      usage_summary: { total_amount: 200, consumed_amount: 0 },
      user_entitlement_pack_list: [{
        display_desc: '签到奖励',
        entitlement_base_info: { entitlement_id: 'checkin', end_time: ms, quota: { credits_limit: 200 } },
        usage: { credits_amount: 0 },
      }],
    }, ms - 1000)

    // 大于 1e12 视为毫秒，原样保留（保护未来上游改用毫秒）。
    expect(snapshot.packs[0]?.endTimeMs).toBe(ms)
  })

  it('已过期的包不计入到期提醒', () => {
    const now = Date.UTC(2026, 9, 11)
    const snapshot = parseCreditsSnapshot({
      usage_summary: { total_amount: 100, consumed_amount: 100 },
      user_entitlement_pack_list: [{
        display_desc: '过期包',
        entitlement_base_info: { entitlement_id: 'old', end_time: now - 1000, quota: { credits_limit: 300 } },
        usage: { credits_amount: 300 },
      }],
    }, now)

    expect(snapshot.nearestExpiryMs).toBeUndefined()
    expect(snapshot.expiringSoon).toBeUndefined()
    expect(snapshot.available).toBe(0)
  })

  it('缺字段/畸形载荷不会抛错', () => {
    expect(parseCreditsSnapshot(undefined).total).toBe(0)
    expect(parseCreditsSnapshot({ user_entitlement_pack_list: [null, 'x', 3] }).packs).toEqual([])
  })
})

describe('fetchCredits：pay 端点与请求体', () => {
  it('打到 CN pay 网关并带 require_usage:true', async () => {
    const { fetchImpl, requests } = mockFetch(() => jsonResponse({
      usage_summary: { total_amount: 10, consumed_amount: 4 },
      user_entitlement_pack_list: [],
    }))
    const client = new TraeUpstreamClient({ fetchImpl })

    const snapshot = await client.fetchCredits(request())

    expect(snapshot.available).toBe(6)
    expect(requests[0]?.url).toBe('https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage')
    expect(requests[0]?.body).toEqual({ require_usage: true })
    expect((requests[0]?.init.headers as Record<string, string>)['Authorization']).toBe('Cloud-IDE-JWT token-cn-1')
  })

  it('HTTP 失败抛错（调用方据此展示诊断）', async () => {
    const { fetchImpl } = mockFetch(() => new Response('nope', { status: 503 }))
    const client = new TraeUpstreamClient({ fetchImpl })

    await expect(client.fetchCredits(request())).rejects.toThrow(/HTTP 503/)
  })
})

describe('签到：status / claim 的字段与业务码分支', () => {
  it('status 保留双口径字段（账号级 checked_in 与设备级 did_checked_in 不可合并）', () => {
    expect(parseCheckinStatus({ checked_in: true, did_checked_in: false, credits: 150, enable: true, extra_credits: 50 }))
      .toEqual({ checkedIn: true, didCheckedIn: false, credits: 150, enabled: true, extraCredits: 50 })
    // enable 缺省视为开启；extra_credits 为 0 时省略。
    expect(parseCheckinStatus({ checked_in: false, did_checked_in: true, credits: 0 }))
      .toEqual({ checkedIn: false, didCheckedIn: true, credits: 0, enabled: true })
    expect(parseCheckinStatus({ checked_in: false, did_checked_in: false, credits: 100, enable: false }).enabled).toBe(false)
  })

  it('claim 业务码：0 成功 / 9004 缺 x-device-id / 9095 设备今日已签', () => {
    expect(parseCheckinClaim({ code: 0, message: 'ok' })).toEqual({ claimed: true, code: 0, message: 'ok' })
    expect(parseCheckinClaim({ code: 9004, message: 'The submitted order parameters are incorrect' }))
      .toEqual({ claimed: false, code: 9004, message: 'The submitted order parameters are incorrect' })
    expect(parseCheckinClaim({ code: 9095, message: '当前设备今日已经签到，请明日再来哦～' }))
      .toEqual({ claimed: false, code: 9095, message: '当前设备今日已经签到，请明日再来哦～' })
    // HTTP 200 但没有 code：视为成功（上游成功态不总是回 code）。
    expect(parseCheckinClaim({})).toEqual({ claimed: true, code: 0, message: '' })
  })

  it('status/claim 都必须带 x-device-id 头，并打到 CN pay 网关', async () => {
    const { fetchImpl, requests } = mockFetch((url) => url.endsWith('/status')
      ? jsonResponse({ checked_in: false, did_checked_in: false, credits: 150, enable: true })
      : jsonResponse({ code: 0, message: 'ok' }))
    const client = new TraeUpstreamClient({ fetchImpl })

    const status = await client.fetchCheckinStatus(request(), 'device-dc-42')
    const claim = await client.claimCheckin(request(), 'device-dc-42')

    expect(status).toMatchObject({ checkedIn: false, didCheckedIn: false, credits: 150 })
    expect(claim).toMatchObject({ claimed: true, code: 0 })
    expect(requests.map(entry => entry.url)).toEqual([
      'https://api.trae.cn/trae/api/v2/ug/checkin_credits/status',
      'https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim',
    ])
    // 设备口径完全由这个头决定：缺它上游答 9004。
    for (const entry of requests) {
      expect((entry.init.headers as Record<string, string>)['x-device-id']).toBe('device-dc-42')
    }
  })

  it('缺省 deviceId 时不发 x-device-id 头（上游随后回 9004）', async () => {
    const { fetchImpl, requests } = mockFetch(() => jsonResponse({ code: 9004, message: 'order parameters incorrect' }))
    const client = new TraeUpstreamClient({ fetchImpl })

    await expect(client.claimCheckin(request(), '')).resolves
      .toMatchObject({ claimed: false, code: 9004 })
    expect((requests[0]?.init.headers as Record<string, string>)['x-device-id']).toBeUndefined()
  })
})

describe('fetchActivities：活动规则', () => {
  it('解析 commercial_activities 并打到 CN pay 网关', async () => {
    const { fetchImpl, requests } = mockFetch(() => jsonResponse({
      commercial_activities: [
        { activity_id: 'checkin_credits', Enabled: true, activity_type: 3, start_time_ms: 1, end_time_ms: 2, work_extra: { credits: 200 } },
        { activity_id: 'disabled_one', Enabled: false, activity_type: 9 },
      ],
    }))
    const client = new TraeUpstreamClient({ fetchImpl })

    const activities = await client.fetchActivities(request())

    expect(activities).toHaveLength(2)
    expect(activities[0]).toMatchObject({ activityId: 'checkin_credits', enabled: true, activityType: 3, startTimeMs: 1, endTimeMs: 2, workExtra: { credits: 200 } })
    expect(activities[1]).toMatchObject({ activityId: 'disabled_one', enabled: false, activityType: 9, startTimeMs: 0 })
    expect(requests[0]?.url).toBe('https://api.trae.cn/trae/api/v2/ug/activity/info')
  })

  it('畸形载荷返回空数组而不是抛错', () => {
    expect(parseActivities(undefined)).toEqual([])
    expect(parseActivities({ commercial_activities: 'nope' })).toEqual([])
    expect(parseActivities({ commercial_activities: [null] })).toEqual([])
  })
})

describe('区域路由', () => {
  it('ai 凭据的 pay 家族走 growsg 网关（上游对 ai 区答 404，由调用方呈现）', async () => {
    const { fetchImpl, requests } = mockFetch(() => new Response('Not Found', { status: 404 }))
    const client = new TraeUpstreamClient({ fetchImpl })
    const aiRequest = request({ host: 'https://coresg-normal.trae.ai', edition: 'sg' })

    await expect(client.fetchCredits(aiRequest)).rejects.toThrow(/HTTP 404/)
    expect(requests[0]?.url).toBe('https://growsg-normal.trae.ai/trae/api/v2/pay/web_user_ent_usage')
  })

  it('options.bases 可覆盖网关（诊断/测试用）', async () => {
    const { fetchImpl, requests } = mockFetch(() => jsonResponse({ usage_summary: {}, user_entitlement_pack_list: [] }))
    const client = new TraeUpstreamClient({ fetchImpl, bases: { pay: 'http://127.0.0.1:1' } })

    await client.fetchCredits(request())
    expect(requests[0]?.url).toBe('http://127.0.0.1:1/trae/api/v2/pay/web_user_ent_usage')
  })
})
