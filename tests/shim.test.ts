/**
 * 多账号 failover shim 测试。
 *
 * 注入假凭据目录（candidates 覆盖）+ 假 fetch（按凭据限流）+ 假 identity，
 * 覆盖：健康检查、429 换号成功、全冷却 429 语义、secret 鉴权失败 401、
 * 成功流转发 noteServed、上限预算与 401 恢复路径。
 *
 * mock 手法参照 dsh-workbuddy-xdpool/tests/failover.test.ts。
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TRAE_AUTH_STORAGE_KEY } from '../src/decrypt.ts'
import type { TraeStorageCandidate } from '../src/paths.ts'
import { TraeAccountPool } from '../src/pool.ts'
import { TraeCatalog } from '../src/catalog.ts'
import { TraeUpstreamClient } from '../src/upstream.ts'
import { createTraePoolShim, parseRateLimitReset, stampTraeWireTarget, TRAE_DEFAULT_COOLDOWN_MS } from '../src/shim.ts'
import type { TraeIdentity } from '../src/identity.ts'

const shims: { close(): Promise<void> }[] = []

afterEach(async () => {
  while (shims.length > 0) await shims.pop()?.close()
})

/** 生成一份桌面 storage.json 文档（明文 JSON 鉴权值，无需解密）。 */
function storageDocument(options: { token: string; userId: string; host?: string; expiredAt?: number }): string {
  return JSON.stringify({
    [TRAE_AUTH_STORAGE_KEY]: JSON.stringify({
      token: options.token,
      refreshToken: `refresh-${options.token}`,
      userId: options.userId,
      account: { username: options.userId },
      host: options.host ?? 'https://api.trae.cn',
      expiredAt: new Date(options.expiredAt ?? Date.now() + 3_600_000).toISOString(),
    }),
  })
}

/** 建一个假凭据目录并写入 `count` 个账号，返回候选列表。 */
async function fakeCandidates(count: number): Promise<{ candidates: TraeStorageCandidate[]; ownPaths: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'trae-shim-'))
  const candidates: TraeStorageCandidate[] = []
  for (let i = 0; i < count; i += 1) {
    const path = join(dir, `storage-${i}.json`)
    await writeFile(path, storageDocument({ token: `token-${i}`, userId: `user-${i}` }), 'utf8')
    candidates.push({ edition: 'cn', path, source: 'desktop' })
  }
  return { candidates, ownPaths: [] }
}

/** 本机身份（deviceId 是签到 x-device-id 的判定量）。 */
function identityOf(_account: unknown): Promise<TraeIdentity | undefined> {
  return Promise.resolve({
    machineId: 'machine-abc',
    deviceId: 'device-dc-42',
    platform: 'win32',
    appVersion: '2.1.0',
    buildVersion: '20260716',
  })
}

/** 一个 SSE 成功响应（OpenAI 兼容的分片 + [DONE]）。 */
function sseResponse(text = 'hello'): Response {
  // 必须是 **Trae 原生**的命名 SSE 事件（`event: output` + `{"response":...}`），
  // 而不是 OpenAI 形状的分片：上游返回的流会先经 `bridgeTraeSoloStreamOrFail`
  // 转成 OpenAI chunk，只有原生事件才会被识别为正文。
  const frames = [
    `event: output\ndata: ${JSON.stringify({ response: text })}\n\n`,
    'event: done\ndata: {"finish_reason":"stop"}\n\n',
  ].join('')
  return new Response(frames, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/**
 * 假 fetch：对前 `failures` 个**不同**凭据回答 429，其余回答 SSE。
 *
 * 按不同 token 计数而非「下标 < N」：池按 priority 顺序抽干账号，而该顺序
 * 由凭据元数据推导，所以测试不能假定哪个账号是哪个下标。
 */
function rotationFetch(failures: number, state: { hit: string[]; seen?: Set<string> }, resetAt?: number) {
  const seen = state.seen ?? new Set<string>()
  state.seen = seen
  // 注意：必须用**本地时间**拼这个字符串。上游的中文限流文案里是本地时间，
  // 而 parseRateLimitReset 用 Date.parse 按本地时区解读；若照 toISOString()
  // （UTC）去拼，在东八区会得到 8 小时**之前**的时刻，冷却当场过期，被限流的
  // 账号立刻又可派活 —— 测试会表现为「换号失败、一直 429」。
  const at = new Date(resetAt ?? Date.now() + 10 * 60 * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const resetText = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  return async (url: unknown, init: RequestInit): Promise<Response> => {
    const headers = init.headers as Record<string, string>
    // Trae 用 Cloud-IDE-JWT / X-Ide-Token 认证，而不是 OpenAI 风格的
    // Authorization: Bearer —— mock 必须读对头，否则所有账号看起来是同一个。
    const token = (headers['X-Ide-Token'] ?? headers['Authorization'] ?? '').replace('Bearer ', '')
    // 只统计聊天请求：成功后会有一个后台积分刷新（pay 家族）也会带同一个
    // token，把它算进来会污染「第几个不同账号」的计数。积分刷新一律成功。
    if (!String(url).includes('/llm_utils_chat')) {
      return new Response(JSON.stringify({ usage_summary: { total_amount: 100 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    state.hit.push(token)
    seen.add(token)
    if (seen.size <= failures) {
      return new Response(JSON.stringify({ message: `请求过于频繁，将在 ${resetText} 重置` }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return sseResponse()
  }
}

/** 装配一套（池 + 客户端 + 目录 + shim）。 */
async function assemble(options: {
  accounts: number
  fetchImpl: (url: unknown, init: RequestInit) => Promise<Response>
  distribution?: 'priority' | 'round-robin'
}) {
  const { candidates, ownPaths } = await fakeCandidates(options.accounts)
  const client = new TraeUpstreamClient({ fetchImpl: options.fetchImpl as typeof fetch })
  const pool = new TraeAccountPool({
    candidates,
    ownPaths,
    ...options.distribution === undefined ? {} : { distribution: options.distribution },
    logger: { warn() {}, info() {}, error() {} },
  })
  await pool.scan()
  const catalog = new TraeCatalog('cn')
  const shim = createTraePoolShim({
    pool,
    client,
    catalog,
    region: 'cn',
    identityOf,
    logger: { warn() {}, info() {}, error() {} },
  })
  shims.push(shim)
  await shim.ready
  return { shim, pool, catalog, client }
}

/**
 * 用 node:http 直发一次请求并只取状态码。
 *
 * 用于需要控制 **禁止头**（如 Host）的用例 —— undici 的 fetch 会静默丢弃它们，
 * 于是那些分支永远测不到。
 */
function rawRequest(baseUrl: string, path: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const req = request({
      host: url.hostname,
      port: url.port,
      path,
      method: 'GET',
      headers,
    }, response => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

/** 发一次 chat 请求。 */
function chat(shim: { baseUrl(): string; token(): string }, body: unknown, token?: string): Promise<Response> {
  return fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? shim.token()}` },
    body: JSON.stringify(body),
  })
}

const BODY = { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }

describe('健康检查与路由', () => {
  it('/healthz 返回池状态', async () => {
    const { shim } = await assemble({ accounts: 2, fetchImpl: rotationFetch(0, { hit: [] }) })
    const response = await fetch(`${shim.baseUrl()}/healthz`, {
      headers: { Authorization: `Bearer ${shim.token()}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; pool: { count: number } }
    expect(body.ok).toBe(true)
    expect(body.pool.count).toBe(2)
  })

  it('/v1/models 返回目录中的模型', async () => {
    const { shim } = await assemble({ accounts: 1, fetchImpl: rotationFetch(0, { hit: [] }) })
    const response = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { Authorization: `Bearer ${shim.token()}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { object: string; data: { id: string }[] }
    expect(body.object).toBe('list')
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.data.every(entry => typeof entry.id === 'string' && entry.id !== '')).toBe(true)
  })

  it('未知路由返回 404', async () => {
    const { shim } = await assemble({ accounts: 1, fetchImpl: rotationFetch(0, { hit: [] }) })
    const response = await fetch(`${shim.baseUrl()}/nope`, {
      headers: { Authorization: `Bearer ${shim.token()}` },
    })
    expect(response.status).toBe(404)
  })

  it('非回环 Host 被拒（DNS rebinding 防护）', async () => {
    const { shim } = await assemble({ accounts: 1, fetchImpl: rotationFetch(0, { hit: [] }) })
    // 必须用 node:http 直发：undici 的 fetch 把 Host 当作禁止头，会静默丢弃，
    // 于是测不到 Host 校验分支。
    const status = await rawRequest(shim.baseUrl(), '/healthz', {
      Authorization: `Bearer ${shim.token()}`,
      Host: 'evil.example.com',
    })
    expect(status).toBe(403)
  })
})

describe('secret 鉴权', () => {
  it('缺失或错误的 bearer 返回 401', async () => {
    const { shim } = await assemble({ accounts: 1, fetchImpl: rotationFetch(0, { hit: [] }) })
    const missing = await fetch(`${shim.baseUrl()}/healthz`)
    expect(missing.status).toBe(401)
    const wrong = await fetch(`${shim.baseUrl()}/healthz`, {
      headers: { Authorization: 'Bearer wrong-secret' },
    })
    expect(wrong.status).toBe(401)
  })

  it('错误的 bearer 不会触达上游', async () => {
    const state = { hit: [] as string[] }
    const { shim } = await assemble({ accounts: 1, fetchImpl: rotationFetch(0, state) })
    await chat(shim, BODY, 'wrong-secret')
    expect(state.hit).toHaveLength(0)
  })
})

describe('429 换号与成功转发', () => {
  it('第一个账号被限流后，同一请求内换号成功', async () => {
    const state = { hit: [] as string[] }
    const { shim, pool } = await assemble({ accounts: 3, fetchImpl: rotationFetch(1, state) })
    const response = await chat(shim, BODY)
    expect(response.status).toBe(200)
    // 两个不同的账号被尝试过：限流的那个 + 成功的那个。
    expect(new Set(state.hit).size).toBe(2)
    // 被限流的账号进入了**模型级**冷却：status().cooling 只统计整账号冷却，
    // 所以这里为 0，而 modelCooldowns 上有记录（账号整体仍可用于其他模型）。
    expect(pool.status().cooling).toBe(0)
    const cooled = pool.list().filter(account => Object.keys(account.modelCooldowns).length > 0)
    expect(cooled).toHaveLength(1)
  })

  it('成功的账号被记为已服务（noteServed）', async () => {
    const state = { hit: [] as string[] }
    const { shim, pool } = await assemble({ accounts: 2, fetchImpl: rotationFetch(1, state) })
    await chat(shim, BODY)
    expect(pool.lastServedId()).toBeDefined()
  })

  it('多账号被限流仍能换到健康账号', async () => {
    const state = { hit: [] as string[] }
    const { shim, pool } = await assemble({ accounts: 4, fetchImpl: rotationFetch(3, state) })
    const response = await chat(shim, BODY)
    expect(response.status).toBe(200)
    expect(new Set(state.hit).size).toBe(4)
    // 三个账号被模型级冷却（不是整账号冷却）。
    const cooled = pool.list().filter(account => Object.keys(account.modelCooldowns).length > 0)
    expect(cooled).toHaveLength(3)
  })

  it('SSE 流转发到调用方（含 [DONE]）', async () => {
    const { shim } = await assemble({ accounts: 1, fetchImpl: rotationFetch(0, { hit: [] }) })
    const response = await chat(shim, BODY)
    const text = await response.text()
    expect(text).toContain('hello')
    expect(text).toContain('[DONE]')
  })

  it('限流只冷却被请求的那个模型，同账号其他模型仍可用', async () => {
    const state = { hit: [] as string[] }
    const { shim, pool } = await assemble({ accounts: 2, fetchImpl: rotationFetch(1, state) })
    await chat(shim, BODY)
    // 被冷却的是**模型**，不是账号：按 modelCooldowns 找，而不是按
    // cooldownUntilMs（后者只表示整账号冷却）。
    const cooled = pool.list().find(account => Object.keys(account.modelCooldowns).length > 0)!
    expect(cooled).toBeDefined()
    expect(Object.keys(cooled.modelCooldowns)).toEqual(['glm-5.2'])
    // 整账号未被冷却 —— 该账号的其他模型仍可用。
    expect(cooled.cooldownUntilMs).toBe(0)
  })
})

describe('全部冷却时的 429 语义', () => {
  it('所有账号冷却时报 429 soft_rate，而不是 401', async () => {
    const state = { hit: [] as string[] }
    const { shim } = await assemble({ accounts: 2, fetchImpl: rotationFetch(2, state) })
    // 第一次请求把两个账号都限流掉。
    const first = await chat(shim, BODY)
    expect(first.status).toBe(429)
    // 第二次请求在第一次尝试就找不到账号 —— 必须仍然报 429（临时），
    // 绝不能报 401「请登录」（那会把用户送去重新认证一个只是限流的账号）。
    const second = await chat(shim, BODY)
    expect(second.status).toBe(429)
    const body = await second.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe('soft_rate')
    expect(body.error.message).toContain('rate-limited')
  })

  it('池里没有任何账号时报 401 not_signed_in', async () => {
    const { shim } = await assemble({ accounts: 0, fetchImpl: rotationFetch(0, { hit: [] }) })
    const response = await chat(shim, BODY)
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { type: string } }
    expect(body.error.type).toBe('not_signed_in')
  })
})

describe('凭据失效（401）恢复路径', () => {
  it('上游 401 且刷新无效时冷却该账号并报 session_dead', async () => {
    const state = { hit: [] as string[] }
    const { shim, pool } = await assemble({
      accounts: 1,
      fetchImpl: async (_url, init) => {
        const headers = init.headers as Record<string, string>
        state.hit.push((headers['X-Ide-Token'] ?? headers['Authorization'] ?? '').replace('Bearer ', ''))
        return new Response(JSON.stringify({ message: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })
    const response = await chat(shim, BODY)
    // 唯一账号的凭据被上游拒绝 → 池报 dead → shim 报 session_dead。
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { type: string } }
    expect(body.error.type).toBe('session_dead')
    expect(pool.deadCredentials()).toHaveLength(1)
  })
})

describe('请求体校验', () => {
  it('非 JSON Content-Type 返回 415', async () => {
    const { shim } = await assemble({ accounts: 1, fetchImpl: rotationFetch(0, { hit: [] }) })
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${shim.token()}` },
      body: 'not json',
    })
    expect(response.status).toBe(415)
  })
})

describe('parseRateLimitReset 与冷却兜底', () => {
  it('解析 13 位 epoch 毫秒的 resetAt/reset_time', () => {
    const at = Date.now() + 60_000
    expect(parseRateLimitReset(`{"resetAt":${at}}`)).toBe(at)
    expect(parseRateLimitReset(`{"reset_time":${at}}`)).toBe(at)
  })

  it('解析本地化的「将在 YYYY-MM-DD HH:mm:ss」', () => {
    const parsed = parseRateLimitReset('请求过于频繁，将在 2030-01-02 03:04:05 重置')
    expect(parsed).toBe(Date.parse('2030-01-02T03:04:05'))
  })

  it('识别不出 reset 时间时返回 undefined（由默认冷却兜底）', () => {
    expect(parseRateLimitReset('too many requests')).toBeUndefined()
  })

  it('默认冷却兜底是 60 秒', () => {
    expect(TRAE_DEFAULT_COOLDOWN_MS).toBe(60_000)
  })

  it('无法解析 reset 的 429 仍让账号进入冷却（不会永久可用）', async () => {
    const { shim, pool } = await assemble({
      accounts: 1,
      fetchImpl: async () => new Response(JSON.stringify({ message: 'too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    })
    const response = await chat(shim, BODY)
    expect(response.status).toBe(429)
    const account = pool.list()[0]!
    expect(account.modelCooldowns['glm-5.2']).toBeGreaterThan(Date.now())
    // 兜底是 60 秒量级，而不是无限期。
    expect(account.modelCooldowns['glm-5.2']!).toBeLessThanOrEqual(Date.now() + TRAE_DEFAULT_COOLDOWN_MS + 5_000)
  })
})

describe('region 与账本', () => {
  it('region 维度的 shim 不会派发其他区域的账号', async () => {
    const state = { hit: [] as string[] }
    const { shim, pool } = await assemble({ accounts: 2, fetchImpl: rotationFetch(0, state) })
    // 池里的账号都是 CN；用一个只服务 ai 区域的 shim 去请求必须失败。
    const aiShim = createTraePoolShim({
      pool,
      client: new TraeUpstreamClient({ fetchImpl: rotationFetch(0, { hit: [] }) as typeof fetch }),
      catalog: new TraeCatalog('ai'),
      region: 'ai',
      identityOf,
      logger: { warn() {}, info() {}, error() {} },
    })
    shims.push(aiShim)
    await aiShim.ready
    const response = await chat(aiShim, BODY)
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { type: string } }
    expect(body.error.type).toBe('not_signed_in')
    // 且没有向上游发出任何请求。
    expect(state.hit).toHaveLength(0)
    void shim
  })
})

describe('�����ĳ�����Ϣ��Լ�����뱻 DSH �� matcher ʶ��', () => {
  it('��Ϣƥ�� dsh-llm �� isContextWindowExceededError ���', async () => {
    // ��δ������ Harness ����Լ��`dsh-compaction-basic` ��
    // `isContextWindowExceededError()` �����Ƿ�ѹ�������ԡ�����Ϣ��ƥ�䣬Harness
    // �ῴ��һ���޷������ 400�������ָ�·�����û��õ�һ�������ĶԻ���
    const { contextOverflowMessage } = await import('../src/shim.ts')
    // ����������ͬ��ƥ�������ԣ������Ƕ��������Լ�д���ַ�����������
    const matches = (detail: string): boolean =>
      /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
      || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)

    expect(matches(contextOverflowMessage('glm-5.2'))).toBe(true)
    expect(matches(contextOverflowMessage(undefined))).toBe(true)
    expect(matches(contextOverflowMessage('glm-5.2', 'still too long'))).toBe(true)
  })

  it('isContextTooLong ʶ�� Trae ��ͨ�õĳ��޴��', async () => {
    const { isContextTooLong } = await import('../src/shim.ts')
    expect(isContextTooLong('{"error":{"code":"context_length_exceeded"}}')).toBe(true)
    expect(isContextTooLong('input length too long')).toBe(true)
    expect(isContextTooLong('This model\'s maximum context length was exceeded')).toBe(true)
    expect(isContextTooLong('the prompt exceeds the context window')).toBe(true)
    // ��ͨ��������ܱ�����Ϊ���ޡ�
    expect(isContextTooLong('{"error":{"code":1005}}')).toBe(false)
    expect(isContextTooLong('rate limited')).toBe(false)
  })
})

describe('stampTraeWireTarget：按目录回放 wire config_name/function（Seed 排队根因的姊妹缺陷）', () => {
  const row = {
    id: 'Display-Id',
    name: 'Display Name',
    contextWindow: 200_000,
    supportsImages: false,
    wireConfigName: 'wire-config-x',
    wireFunction: 'solo_work_remote',
    supportedEfforts: ['low', 'high'] as const,
  }
  const catalog = { find: (id: string) => (id === 'Display-Id' ? row : undefined) }

  it('盖 config_name（=model）与归属 function，并修剪未宣告的 reasoning_effort', () => {
    const out = JSON.parse(stampTraeWireTarget(JSON.stringify({
      model: 'Display-Id',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'xhigh',
    }), catalog)) as Record<string, unknown>
    expect(out['model']).toBe('wire-config-x')
    expect(out['function']).toBe('solo_work_remote')
    expect(out['reasoning_effort']).toBeUndefined()
  })

  it('目录宣告支持的档位保留', () => {
    const out = JSON.parse(stampTraeWireTarget(JSON.stringify({
      model: 'Display-Id',
      messages: [],
      reasoning_effort: 'low',
    }), catalog)) as Record<string, unknown>
    expect(out['reasoning_effort']).toBe('low')
  })

  it('请求体显式携带的 function 被尊重（不被目录覆盖）', () => {
    const out = JSON.parse(stampTraeWireTarget(JSON.stringify({
      model: 'Display-Id',
      messages: [],
      function: 'chat_v3',
    }), catalog)) as Record<string, unknown>
    expect(out['function']).toBe('chat_v3')
    expect(out['model']).toBe('wire-config-x')
  })

  it('只有 function、没有 wireConfigName 时只盖章 function', () => {
    const cat = { find: () => ({ id: 'm', name: 'm', contextWindow: 200_000, supportsImages: false, wireFunction: 'solo_coder' }) }
    const out = JSON.parse(stampTraeWireTarget(JSON.stringify({ model: 'm', messages: [] }), cat)) as Record<string, unknown>
    expect(out['model']).toBe('m')
    expect(out['function']).toBe('solo_coder')
  })

  it('目录无该行 / 非法 JSON / 无 model：原样返回不动', () => {
    expect(stampTraeWireTarget(JSON.stringify({ model: 'unknown', messages: [] }), catalog)).toContain('"model":"unknown"')
    expect(stampTraeWireTarget('{not json', catalog)).toBe('{not json')
    expect(stampTraeWireTarget(JSON.stringify({ messages: [] }), catalog)).toBe(JSON.stringify({ messages: [] }))
  })

  it('端到端：shim 发往 llm_utils_chat 的 envelope 带上 wire 章，SSE 标签保留显示 id', async () => {
    const seen: { body: Record<string, unknown> }[] = []
    const fetchImpl = (async (url: unknown, init: RequestInit) => {
      if (String(url).includes('/llm_utils_chat')) {
        seen.push({ body: JSON.parse(init.body as string) as Record<string, unknown> })
        return sseResponse('hello')
      }
      return new Response(JSON.stringify({ usage_summary: { total_amount: 100 } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    const assembled = await assemble({ accounts: 1, fetchImpl })
    assembled.catalog.update([{
      id: 'Display-Id',
      name: 'Seed-2.1-Pro-0915',
      contextWindow: 200_000,
      supportsImages: false,
      wireConfigName: 'wire-config-x',
      wireFunction: 'solo_work_remote',
      supportedEfforts: ['low', 'high'],
    }])
    const response = await chat(assembled.shim, {
      model: 'Display-Id',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'medium',
    })
    expect(response.status).toBe(200)
    // 上游收到的是 wire config_name + 归属 function，且未支持的档位被剪掉。
    expect(seen[0]?.body).toMatchObject({
      model: 'wire-config-x',
      config_name: 'wire-config-x',
      function: 'solo_work_remote',
      stream: true,
    })
    expect(seen[0]?.body['reasoning_effort']).toBeUndefined()
    // 回到调用方的 SSE chunk 标签仍是 DSH 请求的显示 id（不是 wire 内部名）。
    const text = await response.text()
    expect(text).toContain('"model":"Display-Id"')
  })
})
