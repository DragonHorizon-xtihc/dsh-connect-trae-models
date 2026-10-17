/**
 * 卡片 Web 路由测试（mock deps + 真实 webServer 假实现）。
 *
 * 覆盖契约（团队计划 t7 与 docs/RESEARCH.md §5）：
 * - 状态文档组装：账号行/冷却/保留线/模型倍率/自动化块/目录来源；
 * - 逐账号探测的 **best-effort 降级**：积分或签到读失败只降级成该行的
 *   `creditsError`/`checkinError`，整份文档绝不 500；
 * - 到期提醒字段（`nearestExpiryMs`/`expiringSoon`）必须随积分一起产出；
 * - 签到守卫顺序（照抄 dsh-connect-trae web-status.ts 500-581 行）：
 *   ai 区 404 → 活动关闭 409 → 账号级 checked_in 回 alreadyCheckedIn（**不发
 *   claim**）→ 设备级 did_checked_in 回 deviceCheckedIn → 无设备号 409 → claim；
 * - 区域参数：缺失 = cn，未知值 = 400（不静默回落）；
 * - 其余路由的鉴权/校验/503 降级。
 *
 * 路由 handler 直接调用（不经 HTTP），另有一组用例走真实 webServer 假实现，
 * 验证注册形状与 disposer。
 */

import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  buildTraePoolWebStatus,
  parseSelection,
  registerTraePoolStatusRoute,
  safeMessage,
  CHECKIN_DEVICE_ALREADY_CLAIMED,
  type TraePoolStatusRouteOptions,
} from '../src/web-status.ts'
import {
  parseRegionParam,
  TRAE_POOL_ACCOUNT_SELECT_PATH,
  TRAE_POOL_ACCOUNT_TOGGLE_PATH,
  TRAE_POOL_AUTOMATION_RUN_PATH,
  TRAE_POOL_CHECKIN_PATH,
  TRAE_POOL_MODELS_SAVE_PATH,
  TRAE_POOL_RESET_COOLDOWN_PATH,
  TRAE_POOL_RESCAN_PATH,
  TRAE_POOL_STATUS_PATH,
  TRAE_POOL_ROUTE_PREFIX,
  unwrapVolatile,
  unwrapVolatileDeep,
} from '../src/status-paths.ts'
import { FALLBACK_TRAE_MODELS, TraeCatalog } from '../src/catalog.ts'
import type { TraeCreditsSnapshot, TraeCheckinStatus } from '../src/upstream.ts'

// ── 假件 ─────────────────────────────────────────────────────────────────

/** 假账号（形状对齐 pool.list() 的返回）。 */
function account(id: string, overrides: Partial<{
  label: string
  region: 'cn' | 'ai'
  cooldownUntilMs: number
  credentialDeadUntilMs: number
  modelCooldowns: Record<string, number>
  rateLimitHits: number
  lastUsedAt: number
  expiresAtMs: number
}> = {}) {
  return {
    id,
    label: overrides.label ?? `账号 ${id}`,
    region: overrides.region ?? 'cn' as const,
    credential: {
      accessToken: 'token-secret',
      userId: id,
      host: 'https://api.trae.cn',
      edition: 'cn' as const,
      expiresAtMs: overrides.expiresAtMs ?? Date.now() + 3_600_000,
      source: 'desktop' as const,
    },
    cooldownUntilMs: overrides.cooldownUntilMs ?? 0,
    modelCooldowns: overrides.modelCooldowns ?? {},
    rateLimitHits: overrides.rateLimitHits ?? 0,
    credentialDeadUntilMs: overrides.credentialDeadUntilMs,
    lastUsedAt: overrides.lastUsedAt,
  }
}

/** 假池。 */
function fakePool(options: {
  accounts?: ReturnType<typeof account>[]
  disabled?: readonly string[]
  reserves?: Record<string, number>
  lastServedId?: string
  distribution?: string
  preferredAccountId?: string
} = {}) {
  const list = options.accounts ?? [account('a1'), account('a2')]
  const disabled = new Set(options.disabled ?? [])
  const reserves = options.reserves ?? {}
  // 钉选状态存在假件里：路由写它、状态文档读它，两者必须看到同一个值，
  // 否则「切换用户」会出现写了却读不回来的假象。
  const state = { preferred: options.preferredAccountId }
  return {
    list: (region?: string) => (region === undefined ? list : list.filter(entry => entry.region === region)),
    isDisabled: (id: string) => disabled.has(id),
    disabledIdsInOrder: () => [...disabled],
    creditReserveOf: (id: string) => reserves[id] ?? 0,
    creditReservesInOrder: () => ({ ...reserves }),
    isReserved: (id: string) => (reserves[id] ?? 0) > 0,
    lastServedId: () => options.lastServedId,
    currentDistribution: () => options.distribution ?? 'priority',
    prefer: (id: string | undefined) => { state.preferred = id },
    preferredAccountId: () => state.preferred,
    resetCooldowns: vi.fn(),
  }
}

/** 假上游客户端：按账号返回预设结果，记录 claim 调用。 */
function fakeClient(script: {
  credits?: (accountId: string) => TraeCreditsSnapshot
  checkin?: (accountId: string, seq: number) => TraeCheckinStatus
  claim?: (accountId: string) => { claimed: boolean; code: number; message: string }
} = {}) {
  const claims: string[] = []
  const statusSeq = new Map<string, number>()
  const okStatus = (): TraeCheckinStatus => ({ checkedIn: false, didCheckedIn: false, credits: 100, enabled: true })
  const okCredits = (): TraeCreditsSnapshot => ({
    total: 1000,
    consumed: 400,
    available: 600,
    packs: [],
    expiringSoonWindowMs: 3 * 24 * 60 * 60 * 1000,
  })
  return {
    claims,
    fetchCredits: vi.fn(async (request: { credential: { userId: string } }) => script.credits?.(request.credential.userId) ?? okCredits()),
    fetchCheckinStatus: vi.fn(async (request: { credential: { userId: string } }) => {
      const id = request.credential.userId
      const seq = (statusSeq.get(id) ?? 0) + 1
      statusSeq.set(id, seq)
      return script.checkin?.(id, seq) ?? okStatus()
    }),
    claimCheckin: vi.fn(async (request: { credential: { userId: string } }) => {
      claims.push(request.credential.userId)
      return script.claim?.(request.credential.userId) ?? { claimed: true, code: 0, message: 'ok' }
    }),
  }
}

/** 组装 deps（未给出的用合理默认）。 */
function deps(overrides: Partial<TraePoolStatusRouteOptions> & {
  pool?: ReturnType<typeof fakePool>
  client?: ReturnType<typeof fakeClient>
} = {}): TraePoolStatusRouteOptions & { pool: ReturnType<typeof fakePool>; client: ReturnType<typeof fakeClient> } {
  const pool = overrides.pool ?? fakePool()
  const client = overrides.client ?? fakeClient()
  const catalogs = overrides.catalogs ?? {
    cn: new TraeCatalog('cn'),
    ai: new TraeCatalog('ai'),
  }
  return {
    ...overrides,
    pool: pool as never,
    client: client as never,
    catalogs,
  } as never
}

// ── 假 HTTP ──────────────────────────────────────────────────────────────

/** 假 webServer：记录注册并使用可手动触发的 handler。 */
function fakeWebServer() {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const disposers: string[] = []
  return {
    routes,
    disposers,
    server: {
      register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
        routes.set(route.path, route.handler)
        return () => {
          routes.delete(route.path)
          disposers.push(route.path)
        }
      },
    },
  }
}

/** 最小 ctx：只提供 webServer、effect 与 logger。 */
function fakeCtx(web: ReturnType<typeof fakeWebServer>) {
  const cleanups: Array<() => void> = []
  return {
    cleanups,
    ctx: {
      webServer: web.server,
      effect(fn: () => (() => void) | void) {
        const dispose = fn()
        if (typeof dispose === 'function') cleanups.push(dispose)
      },
      logger: { info() {}, warn() {} },
    },
  }
}

/** 假请求。 */
function request(options: { method?: string; url?: string; body?: unknown; origin?: string } = {}): IncomingMessage {
  const listeners = new Map<string, Array<(chunk?: unknown) => void>>()
  const req = {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.origin === undefined ? {} : { origin: options.origin },
    on(event: string, listener: (chunk?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return req
    },
    destroy() {},
  } as unknown as IncomingMessage
  // 异步触发 body 事件，模拟真实流。
  queueMicrotask(() => {
    if (options.body !== undefined) {
      const text = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      for (const listener of listeners.get('data') ?? []) listener(Buffer.from(text, 'utf8'))
    }
    for (const listener of listeners.get('end') ?? []) listener()
  })
  return req
}

/** 假响应，收集状态码与 JSON body。 */
function response(): { res: ServerResponse; result: () => { status: number; body: Record<string, unknown> } } {
  let status = 0
  const chunks: Buffer[] = []
  const res = {
    writeHead(code: number) { status = code; return res },
    end(payload?: string | Buffer) { if (payload !== undefined) chunks.push(Buffer.from(payload)); return res },
  } as unknown as ServerResponse
  return {
    res,
    result: () => ({
      status,
      body: chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
    }),
  }
}

/** 走一遍真实路由注册，返回可调用的 handler。 */
function mount(d: TraePoolStatusRouteOptions) {
  const web = fakeWebServer()
  const { ctx } = fakeCtx(web)
  registerTraePoolStatusRoute(ctx as never, d)
  return web
}

/** 调用一条已挂载路由。 */
async function call(
  web: ReturnType<typeof fakeWebServer>,
  path: string,
  options: { method?: string; url?: string; body?: unknown; origin?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const handler = web.routes.get(path)
  if (handler === undefined) throw new Error(`route not mounted: ${path}`)
  const { res, result } = response()
  await handler(request(options), res)
  return result()
}

// ── 测试 ─────────────────────────────────────────────────────────────────

describe('路由常量与共享工具', () => {
  it('全部路由挂在插件前缀下，路径唯一', () => {
    const paths = [
      TRAE_POOL_STATUS_PATH, TRAE_POOL_CHECKIN_PATH, TRAE_POOL_AUTOMATION_RUN_PATH,
      TRAE_POOL_RESCAN_PATH, TRAE_POOL_RESET_COOLDOWN_PATH, TRAE_POOL_MODELS_SAVE_PATH,
      TRAE_POOL_ACCOUNT_TOGGLE_PATH,
    ]
    expect(new Set(paths).size).toBe(paths.length)
    for (const path of paths) expect(path.startsWith(`${TRAE_POOL_ROUTE_PREFIX}/`)).toBe(true)
    expect(TRAE_POOL_STATUS_PATH).toBe('/plugins/dsh-connect-trae-models/status')
  })

  it('parseRegionParam：缺失 → 默认 cn；合法值原样；未知值 undefined', () => {
    expect(parseRegionParam(null)).toBe('cn')
    expect(parseRegionParam(undefined)).toBe('cn')
    expect(parseRegionParam('')).toBe('cn')
    expect(parseRegionParam('cn')).toBe('cn')
    expect(parseRegionParam('ai')).toBe('ai')
    // 非法值不被静默吞成 cn：调用方据此答 400。
    expect(parseRegionParam('global')).toBeUndefined()
    expect(parseRegionParam('CN')).toBeUndefined()
  })

  it('safeMessage 抹掉 token 并截断', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij'
    expect(safeMessage(new Error(`auth failed for ${jwt}`))).not.toContain(jwt)
    expect(safeMessage(new Error('failed?access_token=secret123'))).not.toContain('secret123')
    expect(safeMessage(new Error('x'.repeat(900))).length).toBe(500)
  })

  it('unwrapVolatile 剥活引用；unwrapVolatileDeep 递归', () => {
    expect(unwrapVolatile(5)).toBe(5)
    expect(unwrapVolatile({ get: () => 'live' })).toBe('live')
    expect(unwrapVolatileDeep({ a: { get: () => 1 }, b: [{ get: () => 'x' }] })).toEqual({ a: 1, b: ['x'] })
  })
})

describe('buildTraePoolWebStatus 文档组装', () => {
  it('账号行含冷却/保留线/禁用/倍率/自动化块', async () => {
    const now = Date.now()
    const pool = fakePool({
      accounts: [account('a1', { cooldownUntilMs: now + 60_000, rateLimitHits: 3, lastUsedAt: now - 1000 }), account('a2')],
      disabled: ['a2'],
      reserves: { a1: 50 },
      lastServedId: 'a1',
    })
    const status = await buildTraePoolWebStatus(deps({ pool }), 'cn')

    expect(status.ok).toBe(true)
    expect(status.region).toBe('cn')
    expect(status.accounts).toHaveLength(2)
    expect(status.cooling).toBe(1)
    expect(status.activeAccountId).toBe('a1')
    const a1 = status.accounts[0]!
    expect(a1).toMatchObject({ id: 'a1', cooling: true, rateLimitHits: 3, creditReserve: 50, reserved: true, disabled: false })
    expect(a1.cooldownUntil).toBeDefined()
    expect(a1.expiresAt).toBeDefined()
    const a2 = status.accounts[1]!
    expect(a2).toMatchObject({ id: 'a2', cooling: false, disabled: true, reserved: false })
    expect(a2.cooldownUntil).toBeUndefined()
  })

  it('模型行带上倍率、生效窗口与上游窗口（卡片要显示「你压到了 128K」）', async () => {
    const catalogs = { cn: new TraeCatalog('cn'), ai: new TraeCatalog('ai') }
    catalogs.cn.update([
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 128_000, maxContextWindow: 1_000_000, multiplier: 0.08, supportsImages: false, maxOutputTokens: 64_000, supportedEfforts: ['low', 'high'] },
    ])
    const status = await buildTraePoolWebStatus(deps({ catalogs }), 'cn')

    expect(status.models[0]).toMatchObject({
      id: 'glm-5.2',
      name: 'GLM-5.2',
      multiplier: 0.08,
      contextWindow: 128_000,
      nativeContextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      enabled: true,
    })
  })

  it('目录来源与失败原因随文档给出（fallback 是可解释的降级）', async () => {
    const catalogs = { cn: new TraeCatalog('cn'), ai: new TraeCatalog('ai') }
    const status = await buildTraePoolWebStatus(deps({ catalogs }), 'cn')
    expect(status.catalogSource).toBe('fallback')
    expect(status.models.length).toBe(FALLBACK_TRAE_MODELS.length)
  })

  it('ai 区域不去问 pay 端点（国际版没有积分/签到端点族）', async () => {
    const client = fakeClient()
    const pool = fakePool({ accounts: [account('g1', { region: 'ai' })] })
    const status = await buildTraePoolWebStatus(deps({ pool, client }), 'ai')

    expect(client.fetchCredits).not.toHaveBeenCalled()
    expect(client.fetchCheckinStatus).not.toHaveBeenCalled()
    expect(status.accounts[0]?.credits).toBeUndefined()
    expect(status.accounts[0]?.creditsError).toBeUndefined()
  })

  it('到期提醒字段随积分产出（nearestExpiryMs / expiringSoon）', async () => {
    const now = Date.now()
    const client = fakeClient({
      credits: () => ({
        total: 1200,
        consumed: 350,
        available: 850,
        packs: [
          { displayDesc: '每月登录赠送', entitlementId: 'm1', creditsLimit: 500, consumed: 120, endTimeMs: now + 8 * 86_400_000 },
          { displayDesc: '签到奖励', entitlementId: 'c1', creditsLimit: 200, consumed: 50, endTimeMs: now + 86_400_000 },
        ],
        nearestExpiryMs: now + 86_400_000,
        expiringSoon: 150,
        expiringSoonWindowMs: 3 * 86_400_000,
      }),
    })
    const status = await buildTraePoolWebStatus(deps({ client }), 'cn')

    const credits = status.accounts[0]!.credits!
    expect(credits.nearestExpiryMs).toBe(now + 86_400_000)
    expect(credits.expiringSoon).toBe(150)
    expect(credits.packs).toHaveLength(2)
    // 到期时间与来源描述必须到卡片：没有它就没有倒计时可显示。
    expect(credits.packs[1]).toMatchObject({ displayDesc: '签到奖励', creditsLimit: 200, consumed: 50, endTimeMs: now + 86_400_000 })
  })

  it('积分读失败只降级该行 creditsError，整份文档仍 200', async () => {
    const client = fakeClient()
    client.fetchCredits.mockRejectedValue(new Error('Trae usage endpoint returned HTTP 503'))
    const status = await buildTraePoolWebStatus(deps({ client }), 'cn')

    expect(status.ok).toBe(true)
    expect(status.accounts).toHaveLength(2)
    expect(status.accounts[0]?.credits).toBeUndefined()
    expect(status.accounts[0]?.creditsError).toContain('HTTP 503')
    // 签到探测不受积分失败影响。
    expect(status.accounts[0]?.checkin).toBeDefined()
  })

  it('签到读失败只降级 checkinError', async () => {
    const client = fakeClient()
    client.fetchCheckinStatus.mockRejectedValue(new Error('boom'))
    const status = await buildTraePoolWebStatus(deps({ client }), 'cn')

    expect(status.accounts[0]?.checkin).toBeUndefined()
    expect(status.accounts[0]?.checkinError).toBe('boom')
    expect(status.accounts[0]?.credits).toBeDefined()
  })

  it('probe:false 跳过全部上游探测（离线/冷启动路径）', async () => {
    const client = fakeClient()
    const status = await buildTraePoolWebStatus(deps({ client }), 'cn', { probe: false })

    expect(client.fetchCredits).not.toHaveBeenCalled()
    expect(client.fetchCheckinStatus).not.toHaveBeenCalled()
    expect(status.accounts).toHaveLength(2)
  })

  it('签名状态：did_checked_in 且账号未到账 → deviceSpent 不写成已领取', async () => {
    const client = fakeClient({
      checkin: () => ({ checkedIn: false, didCheckedIn: true, credits: 100, enabled: true }),
    })
    const status = await buildTraePoolWebStatus(deps({ client }), 'cn')

    expect(status.accounts[0]?.deviceSpent).toBe(true)
    expect(status.accounts[0]?.checkin).toMatchObject({ checkedIn: false, didCheckedIn: true })
  })

  it('已到账的账号不写 deviceSpent（字段缺席而不是 false）', async () => {
    const client = fakeClient({
      checkin: () => ({ checkedIn: true, didCheckedIn: true, credits: 150, enabled: true, extraCredits: 50 }),
    })
    const status = await buildTraePoolWebStatus(deps({ client }), 'cn')

    // 字段缺席而不是 false：卡片据「有没有这个键」区分「设备受限」与正常，
    // 这与 deviceSpent 在 scheduler 账本里的写法保持一致。
    expect(status.accounts[0]?.deviceSpent).toBeUndefined()
    expect(status.accounts[0]?.checkin).toMatchObject({ checkedIn: true, credits: 150, extraCredits: 50 })
  })

  it('无调度器时自动化块是空形状而不是缺失', async () => {
    const status = await buildTraePoolWebStatus(deps(), 'cn')
    expect(status.automation).toMatchObject({ enabled: false, running: false, runInProgress: false })
    expect(status.automation.jobs.checkin).toMatchObject({ ok: 0, claimed: 0 })
    expect(status.automation.earningsToday).toEqual({})
  })

  it('调度器状态与今日收益透传到文档', async () => {
    const status = await buildTraePoolWebStatus(deps({
      scheduler: () => ({
        enabled: true,
        running: true,
        checkinHours: [9],
        jobs: { checkin: { ok: 2, failed: 0, claimed: 2, credit: 200, deviceSpent: 0, message: '签到：2 个领取成功', lastRunDate: '2026-10-11', firedSlots: ['2026-10-11T09'] } },
        earningsToday: { a1: { credit: 100, checkinCredit: 100, date: '2026-10-11' } },
        runInProgress: false,
      }),
    }), 'cn')

    expect(status.automation.enabled).toBe(true)
    expect(status.automation.checkinHours).toEqual([9])
    expect(status.automation.jobs.checkin).toMatchObject({ claimed: 2, credit: 200, firedSlots: ['2026-10-11T09'] })
    expect(status.automation.earningsToday['a1']).toMatchObject({ credit: 100, date: '2026-10-11' })
  })

  it('保存的模型选择回显（分区键与 legacy 平键都认）', async () => {
    const withSection = await buildTraePoolWebStatus(deps({
      config: () => ({ modelSelectionCn: { enabledModelIds: ['glm-5.2'], contextBudgets: { 'glm-5.2': 128_000 } } }),
    }), 'cn')
    expect(withSection.selection.enabledModelIds).toEqual(['glm-5.2'])
    expect(withSection.models.find(m => m.id === 'glm-5.2')?.enabled).toBe(true)
    // 未在启用列表里的模型 enabled=false。
    expect(withSection.models.find(m => m.id === 'kimi-k2.6')?.enabled).toBe(false)

    const legacy = await buildTraePoolWebStatus(deps({
      config: () => ({ enabledModelIds: ['kimi-k2.6'] }),
    }), 'cn')
    expect(legacy.selection.enabledModelIds).toEqual(['kimi-k2.6'])
  })
})

describe('GET status 路由', () => {
  it('200 且返回文档；region 缺省为 cn', async () => {
    const web = mount(deps())
    const { status, body } = await call(web, TRAE_POOL_STATUS_PATH)
    expect(status).toBe(200)
    expect(body['region']).toBe('cn')
    expect(body['ok']).toBe(true)
  })

  it('?region=ai 返回 ai 文档', async () => {
    const web = mount(deps({ pool: fakePool({ accounts: [account('g1', { region: 'ai' })] }) }))
    const { body } = await call(web, TRAE_POOL_STATUS_PATH, { url: '/plugins/dsh-connect-trae-models/status?region=ai' })
    expect(body['region']).toBe('ai')
    expect((body['accounts'] as unknown[]).length).toBe(1)
  })

  it('未知 region 值 → 400（不静默回落）', async () => {
    const web = mount(deps())
    const { status, body } = await call(web, TRAE_POOL_STATUS_PATH, { url: '/plugins/dsh-connect-trae-models/status?region=global' })
    expect(status).toBe(400)
    expect(String(body['error'])).toContain('global')
  })

  it('非 GET → 405；非回环 origin → 403', async () => {
    const web = mount(deps())
    expect((await call(web, TRAE_POOL_STATUS_PATH, { method: 'POST' })).status).toBe(405)
    expect((await call(web, TRAE_POOL_STATUS_PATH, { origin: 'https://evil.example' })).status).toBe(403)
    // 回环 origin 放行。
    expect((await call(web, TRAE_POOL_STATUS_PATH, { origin: 'http://127.0.0.1:3080' })).status).toBe(200)
    expect((await call(web, TRAE_POOL_STATUS_PATH, { origin: 'http://localhost:3080' })).status).toBe(200)
  })
})

describe('POST checkin 守卫四分支（唯一改上游状态的路由）', () => {
  const cnDeps = (client: ReturnType<typeof fakeClient>) => deps({
    client,
    pool: fakePool({ accounts: [account('a1')] }),
    deviceId: () => 'device-dc-1',
  })

  it('ai 区 → 404（国际版无签到体系，明说而不是当网络故障）', async () => {
    const client = fakeClient()
    const web = mount(deps({ client, pool: fakePool({ accounts: [account('g1', { region: 'ai' })] }) }))

    const { status, body } = await call(web, TRAE_POOL_CHECKIN_PATH, {
      method: 'POST', body: { accountId: 'g1', region: 'ai' },
    })
    expect(status).toBe(404)
    expect(String(body['error'])).toContain('international')
    // 一次上游调用都不该发生。
    expect(client.fetchCheckinStatus).not.toHaveBeenCalled()
  })

  it('活动关闭 → 409，不发 claim', async () => {
    const client = fakeClient({ checkin: () => ({ checkedIn: false, didCheckedIn: false, credits: 100, enabled: false }) })
    const web = mount(cnDeps(client))

    const { status } = await call(web, TRAE_POOL_CHECKIN_PATH, { method: 'POST', body: { accountId: 'a1' } })
    expect(status).toBe(409)
    expect(client.claims).toEqual([])
  })

  it('账号级 checked_in → 200 alreadyCheckedIn，**不发 claim**', async () => {
    const client = fakeClient({ checkin: () => ({ checkedIn: true, didCheckedIn: false, credits: 150, enabled: true, extraCredits: 50 }) })
    const web = mount(cnDeps(client))

    const { status, body } = await call(web, TRAE_POOL_CHECKIN_PATH, { method: 'POST', body: { accountId: 'a1' } })
    expect(status).toBe(200)
    expect(body).toMatchObject({ claimed: false, alreadyCheckedIn: true, deviceCheckedIn: false })
    expect((body['checkin'] as Record<string, unknown>)['credits']).toBe(150)
    // 已到账就不再发写请求：这是最重要的幂等守卫。
    expect(client.claims).toEqual([])
  })

  it('设备级 did_checked_in 且账号未到账 → deviceCheckedIn:true，**不发 claim**', async () => {
    const client = fakeClient({ checkin: () => ({ checkedIn: false, didCheckedIn: true, credits: 100, enabled: true }) })
    const web = mount(cnDeps(client))

    const { status, body } = await call(web, TRAE_POOL_CHECKIN_PATH, { method: 'POST', body: { accountId: 'a1' } })
    expect(status).toBe(200)
    // 与 alreadyCheckedIn 分开回答：设备名额被占 ≠ 该账号已到账。
    expect(body).toMatchObject({ claimed: false, alreadyCheckedIn: false, deviceCheckedIn: true })
    expect(body['code']).toBe(CHECKIN_DEVICE_ALREADY_CLAIMED)
    expect(client.claims).toEqual([])
  })

  it('无设备号 → 409，不发注定 9004 的写请求', async () => {
    const client = fakeClient()
    const web = mount(deps({ client, pool: fakePool({ accounts: [account('a1')] }), deviceId: () => '' }))

    const { status } = await call(web, TRAE_POOL_CHECKIN_PATH, { method: 'POST', body: { accountId: 'a1' } })
    expect(status).toBe(409)
    expect(client.claims).toEqual([])
  })

  it('全部守卫通过 → claim 并回读状态', async () => {
    const client = fakeClient({
      checkin: (_id, seq) => seq === 1
        ? { checkedIn: false, didCheckedIn: false, credits: 100, enabled: true }
        : { checkedIn: true, didCheckedIn: true, credits: 150, enabled: true, extraCredits: 50 },
    })
    const web = mount(cnDeps(client))

    const { status, body } = await call(web, TRAE_POOL_CHECKIN_PATH, { method: 'POST', body: { accountId: 'a1' } })
    expect(status).toBe(200)
    expect(body).toMatchObject({ claimed: true, alreadyCheckedIn: false, code: 0 })
    expect((body['checkin'] as Record<string, unknown>)['credits']).toBe(150)
    expect(client.claims).toEqual(['a1'])
  })

  it('claim 回 9095（并发窗口抢走名额）→ 语义化为 deviceCheckedIn，不是硬错误', async () => {
    const client = fakeClient({ claim: () => ({ claimed: false, code: 9095, message: '当前设备今日已经签到' }) })
    const web = mount(cnDeps(client))

    const { status, body } = await call(web, TRAE_POOL_CHECKIN_PATH, { method: 'POST', body: { accountId: 'a1' } })
    expect(status).toBe(200)
    expect(body).toMatchObject({ claimed: false, deviceCheckedIn: true, code: 9095 })
  })

  it('未知账号 → 404；缺 accountId → 400', async () => {
    const web = mount(cnDeps(fakeClient()))
    expect((await call(web, TRAE_POOL_CHECKIN_PATH, { method: 'POST', body: { accountId: 'nope' } })).status).toBe(404)
    expect((await call(web, TRAE_POOL_CHECKIN_PATH, { method: 'POST', body: {} })).status).toBe(400)
  })

  it('仅 POST + 仅回环 origin', async () => {
    const web = mount(cnDeps(fakeClient()))
    expect((await call(web, TRAE_POOL_CHECKIN_PATH, { method: 'GET' })).status).toBe(405)
    expect((await call(web, TRAE_POOL_CHECKIN_PATH, { method: 'POST', body: { accountId: 'a1' }, origin: 'https://evil.example' })).status).toBe(403)
  })
})

describe('POST automation/run 路由', () => {
  const schedulerStatus = () => ({
    enabled: true,
    running: true,
    checkinHours: [9],
    jobs: { checkin: { ok: 0, failed: 0, claimed: 0, credit: 0, deviceSpent: 0 } },
    earningsToday: {},
    runInProgress: false,
  })

  it('启动一次运行并立即返回（不等待整轮）', async () => {
    const runAutomation = vi.fn(() => true)
    const web = mount(deps({ scheduler: schedulerStatus, runAutomation }))

    const { status, body } = await call(web, TRAE_POOL_AUTOMATION_RUN_PATH, { method: 'POST', body: { job: 'checkin', force: true } })
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, started: true, job: 'checkin' })
    expect(runAutomation).toHaveBeenCalledWith('checkin', true)
  })

  it('在途时第二次返回 started:false（幂等而不是报错）', async () => {
    const web = mount(deps({ scheduler: schedulerStatus, runAutomation: () => false }))
    const { status, body } = await call(web, TRAE_POOL_AUTOMATION_RUN_PATH, { method: 'POST', body: {} })
    expect(status).toBe(200)
    expect(body['started']).toBe(false)
  })

  it('未知 job 名 → 400（而不是静默什么都不做）', async () => {
    const web = mount(deps({ scheduler: schedulerStatus, runAutomation: () => true }))
    expect((await call(web, TRAE_POOL_AUTOMATION_RUN_PATH, { method: 'POST', body: { job: 'travel' } })).status).toBe(400)
  })

  it('无调度器 → 503；仅 POST', async () => {
    const web = mount(deps())
    expect((await call(web, TRAE_POOL_AUTOMATION_RUN_PATH, { method: 'POST', body: {} })).status).toBe(503)
    expect((await call(web, TRAE_POOL_AUTOMATION_RUN_PATH, { method: 'GET' })).status).toBe(405)
  })
})

describe('其余路由：rescan / reset / toggle / models save', () => {
  it('rescan 调用注入的重扫并 200', async () => {
    const rescan = vi.fn(async () => {})
    const web = mount(deps({ rescan }))
    const { status } = await call(web, TRAE_POOL_RESCAN_PATH, { method: 'POST' })
    expect(status).toBe(200)
    expect(rescan).toHaveBeenCalledTimes(1)
  })

  it('rescan 未接线 → 503', async () => {
    const web = mount(deps())
    expect((await call(web, TRAE_POOL_RESCAN_PATH, { method: 'POST' })).status).toBe(503)
  })

  it('cooldowns/reset 优先用注入实现，否则退回池自身', async () => {
    const pool = fakePool()
    const web = mount(deps({ pool }))
    expect((await call(web, TRAE_POOL_RESET_COOLDOWN_PATH, { method: 'POST' })).status).toBe(200)
    expect(pool.resetCooldowns).toHaveBeenCalledTimes(1)

    const custom = vi.fn(async () => {})
    const web2 = mount(deps({ resetCooldowns: custom }))
    await call(web2, TRAE_POOL_RESET_COOLDOWN_PATH, { method: 'POST' })
    expect(custom).toHaveBeenCalledTimes(1)
  })

  it('accounts/disabled 校验账号已知性并写回', async () => {
    const setAccountDisabled = vi.fn(async () => {})
    const web = mount(deps({ pool: fakePool({ accounts: [account('a1')] }), setAccountDisabled }))

    const ok = await call(web, TRAE_POOL_ACCOUNT_TOGGLE_PATH, { method: 'POST', body: { accountId: 'a1', disabled: true } })
    expect(ok.status).toBe(200)
    expect(setAccountDisabled).toHaveBeenCalledWith('a1', true)

    // 未知账号：任意字符串会把孤儿 id 留在设置文件里，卡片再也关不掉它。
    expect((await call(web, TRAE_POOL_ACCOUNT_TOGGLE_PATH, { method: 'POST', body: { accountId: 'ghost', disabled: true } })).status).toBe(400)
    // 非布尔 disabled。
    expect((await call(web, TRAE_POOL_ACCOUNT_TOGGLE_PATH, { method: 'POST', body: { accountId: 'a1', disabled: 'yes' } })).status).toBe(400)
  })

  it('models/save 写入该区域的选择', async () => {
    const saveSelection = vi.fn(async () => {})
    const web = mount(deps({ saveSelection }))

    const { status, body } = await call(web, TRAE_POOL_MODELS_SAVE_PATH, {
      method: 'POST',
      body: { region: 'cn', enabledModelIds: ['glm-5.2'], contextBudgets: { 'glm-5.2': 128_000 } },
    })
    expect(status).toBe(200)
    expect(body['region']).toBe('cn')
    expect(saveSelection).toHaveBeenCalledWith('cn', expect.objectContaining({ enabledModelIds: ['glm-5.2'] }))
  })

  it('models/save 拒绝畸形选择（不写半个进去）', async () => {
    const saveSelection = vi.fn(async () => {})
    const web = mount(deps({ saveSelection }))

    for (const body of [
      { enabledModelIds: 'glm-5.2' },
      { enabledModelIds: [1] },
      { contextBudgets: { 'glm-5.2': 10 } },        // 太小
      { contextBudgets: { 'glm-5.2': 1.5 } },       // 非整数
      { contextBudgets: ['x'] },
      { region: 'nope' },
    ]) {
      expect((await call(web, TRAE_POOL_MODELS_SAVE_PATH, { method: 'POST', body })).status).toBe(400)
    }
    expect(saveSelection).not.toHaveBeenCalled()
  })

  it('models/save 未接线 → 503', async () => {
    const web = mount(deps())
    expect((await call(web, TRAE_POOL_MODELS_SAVE_PATH, { method: 'POST', body: {} })).status).toBe(503)
  })

  // 选号（对话栏「切换用户」）——
  //
  // 这条路由只改本机派活顺序，但「钉到一个不存在的账号」会让请求一直等一个
  // 永远不会被派活的号，所以存在性必须校验；空串则是合法的「取消钉选」。
  it('accounts/select 钉选池内账号并回读得到', async () => {
    const web = mount(deps({ pool: fakePool() }))

    const { status, body } = await call(web, TRAE_POOL_ACCOUNT_SELECT_PATH, {
      method: 'POST',
      body: { region: 'cn', accountId: 'a2' },
    })
    expect(status).toBe(200)
    expect(body['accountId']).toBe('a2')
    // 写完必须能读回来：状态文档里的 preferredAccountId 是界面显示「使用中」的
    // 唯一依据，读不回来就等于这次切换没发生。
    const after = await call(web, TRAE_POOL_STATUS_PATH)
    expect(after.body['preferredAccountId']).toBe('a2')
  })

  it('accounts/select 空 accountId = 取消钉选', async () => {
    const web = mount(deps({ pool: fakePool({ preferredAccountId: 'a1' }) }))

    const { status } = await call(web, TRAE_POOL_ACCOUNT_SELECT_PATH, {
      method: 'POST',
      body: { region: 'cn', accountId: '' },
    })
    expect(status).toBe(200)
    const after = await call(web, TRAE_POOL_STATUS_PATH)
    expect(after.body['preferredAccountId']).toBeUndefined()
  })

  it('accounts/select 拒绝池内不存在的账号（404）', async () => {
    const web = mount(deps({ pool: fakePool() }))

    const { status } = await call(web, TRAE_POOL_ACCOUNT_SELECT_PATH, {
      method: 'POST',
      body: { region: 'cn', accountId: 'nope' },
    })
    expect(status).toBe(404)
  })

  it('accounts/select 只认本区域的账号（跨区 404）', async () => {
    const web = mount(deps({ pool: fakePool() }))

    // a2 在 cn 侧；问 ai 侧时它不属于那个池子。
    const { status } = await call(web, TRAE_POOL_ACCOUNT_SELECT_PATH, {
      method: 'POST',
      body: { region: 'ai', accountId: 'a2' },
    })
    expect(status).toBe(404)
  })

  it('accounts/select 拒绝 GET 与畸形 body', async () => {
    const web = mount(deps({ pool: fakePool() }))

    expect((await call(web, TRAE_POOL_ACCOUNT_SELECT_PATH, { method: 'GET' })).status).toBe(405)
    expect((await call(web, TRAE_POOL_ACCOUNT_SELECT_PATH, { method: 'POST', body: '{not json' })).status).toBe(400)
  })

  it('畸形 JSON body → 400', async () => {
    const web = mount(deps({ saveSelection: async () => {} }))
    expect((await call(web, TRAE_POOL_MODELS_SAVE_PATH, { method: 'POST', body: '{not json' })).status).toBe(400)
  })
})

describe('parseSelection（导出给卡片复用）', () => {
  it('空数组合法且保留（= 全部停用是有意义的状态）', () => {
    expect(parseSelection({ enabledModelIds: [] })).toEqual({ enabledModelIds: [] })
  })

  it('缺省字段缺席（保留文档语义「全部启用」）', () => {
    expect(parseSelection({})).toEqual({})
  })

  it('预算取整数且下限 1000', () => {
    expect(parseSelection({ contextBudgets: { a: 1000 } })).toEqual({ contextBudgets: { a: 1000 } })
    expect(parseSelection({ contextBudgets: { a: 999 } })).toBeUndefined()
  })
})

describe('路由注册生命周期', () => {
  it('注册全部八条路由，disposer 逐个卸载', () => {
    const web = fakeWebServer()
    const { ctx, cleanups } = fakeCtx(web)
    registerTraePoolStatusRoute(ctx as never, deps())

    // 八条：status / checkin / automation·run / accounts·rescan / cooldowns·reset /
    // models·save / accounts·disabled / accounts·select（对话栏「切换用户」用）。
    expect([...web.routes.keys()].sort()).toEqual([
      TRAE_POOL_ACCOUNT_SELECT_PATH,
      TRAE_POOL_ACCOUNT_TOGGLE_PATH,
      TRAE_POOL_AUTOMATION_RUN_PATH,
      TRAE_POOL_CHECKIN_PATH,
      TRAE_POOL_MODELS_SAVE_PATH,
      TRAE_POOL_RESET_COOLDOWN_PATH,
      TRAE_POOL_RESCAN_PATH,
      TRAE_POOL_STATUS_PATH,
    ].sort())

    for (const cleanup of cleanups) cleanup()
    expect(web.routes.size).toBe(0)
  })
})
