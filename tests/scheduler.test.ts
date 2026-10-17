/**
 * 积分自动化调度器测试（假时钟 + 假上游 + 真账号池）。
 *
 * 覆盖契约（团队计划 t6「关键语义」与 docs/RESEARCH.md §5）：
 * - 调度：到点触发、同小时不重复、跨日重置、补跑错过的时段、多时段配置各跑一次；
 * - 签到判定：enable=false 跳过、checked_in 跳过且**不发 claim**、did_checked_in
 *   记 deviceSpent、claim 0 成功入账、9095 记 deviceSpent 但**不算失败**、
 *   9004 计失败且保留上游原话、无 deviceId 时不发 claim；
 * - 隔离：账号异常不影响其他账号、ai 区域整类跳过、冷却账号**不**被跳过；
 * - 账本：持久化往返、跨日丢弃、快照与状态文档；
 * - 手动触发：startRunAll 与 runAll(force) 绕过时段闸门且不消费时段。
 *
 * 账号池用真实的 TraeAccountPool（假凭据目录），上游用假客户端记录调用，
 * 时钟用可推进的 Date，因此不需要任何网络。
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TRAE_AUTH_STORAGE_KEY } from '../src/decrypt.ts'
import type { TraeIdentity } from '../src/identity.ts'
import type { TraeEdition, TraeStorageCandidate } from '../src/paths.ts'
import { TraeAccountPool } from '../src/pool.ts'
import {
  AUTOMATION_JOB_KINDS,
  dayKey,
  isFireHour,
  slotKey,
  TraeScheduler,
  type AutomationLedger,
} from '../src/scheduler.ts'
import type { TraeCheckinClaim, TraeCheckinStatus } from '../src/upstream.ts'

/** 写一个桌面 storage.json 文档（明文 JSON 鉴权值）。 */
function storageDocument(options: { token: string; userId: string; host?: string; userRegion?: unknown }): string {
  return JSON.stringify({
    [TRAE_AUTH_STORAGE_KEY]: JSON.stringify({
      token: options.token,
      refreshToken: `refresh-${options.token}`,
      userId: options.userId,
      account: { username: options.userId },
      host: options.host ?? 'https://api.trae.cn',
      ...options.userRegion === undefined ? {} : { userRegion: options.userRegion },
      expiredAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  })
}

/** 建一个含若干账号的假凭据目录，返回候选列表。 */
async function fakeCandidates(accounts: Array<{
  token: string
  userId: string
  edition?: TraeEdition
  host?: string
  userRegion?: unknown
}>): Promise<TraeStorageCandidate[]> {
  const dir = await mkdtemp(join(tmpdir(), 'trae-sched-'))
  const candidates: TraeStorageCandidate[] = []
  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i]!
    const path = join(dir, `storage-${i}.json`)
    await writeFile(path, storageDocument(account), 'utf8')
    candidates.push({ edition: account.edition ?? 'cn', path, source: 'desktop' })
  }
  return candidates
}

/** 两个 CN 账号 + 一个国际账号的池（真实 TraeAccountPool）。 */
async function testPool(): Promise<TraeAccountPool> {
  const candidates = await fakeCandidates([
    { token: 'token-a', userId: 'user-a' },
    { token: 'token-b', userId: 'user-b' },
    { token: 'token-g', userId: 'user-g', edition: 'sg', host: 'https://growsg-normal.trae.ai', userRegion: { region: 'SG' } },
  ])
  const pool = new TraeAccountPool({ candidates, logger: { warn() {}, info() {}, error() {} } })
  await pool.scan()
  return pool
}

/** 可推进的假时钟（北京时区语义由 scheduler 自己算）。 */
function fakeClock(iso: string): { now: () => Date; set: (next: string) => void; advanceMs: (ms: number) => void } {
  let current = new Date(iso)
  return {
    now: () => new Date(current),
    set: (next: string) => { current = new Date(next) },
    advanceMs: (ms: number) => { current = new Date(current.getTime() + ms) },
  }
}

/** 一次记录下来的上游调用。 */
interface Call { method: 'status' | 'claim'; accountId: string; deviceId: string }

/**
 * 假上游客户端：按账号返回预设的 status / claim 结果，并记录调用序列。
 *
 * 每个账号的结果可以是固定值，也可以是返回值的函数（用于「claim 后状态变化」）。
 */
function fakeClient(script: {
  status?: (accountId: string, seq: number) => TraeCheckinStatus
  claim?: (accountId: string) => TraeCheckinClaim
  throwOnStatus?: (accountId: string) => Error | undefined
}): { client: never; calls: Call[] } {
  const calls: Call[] = []
  const statusSeq = new Map<string, number>()
  const okStatus = (): TraeCheckinStatus => ({ checkedIn: false, didCheckedIn: false, credits: 100, enabled: true })
  const client = {
    async fetchCheckinStatus(request: { credential: { userId: string }; identity: { deviceId: string } }, deviceId: string) {
      const accountId = request.credential.userId
      calls.push({ method: 'status', accountId, deviceId })
      const failure = script.throwOnStatus?.(accountId)
      if (failure !== undefined) throw failure
      const seq = (statusSeq.get(accountId) ?? 0) + 1
      statusSeq.set(accountId, seq)
      return script.status?.(accountId, seq) ?? okStatus()
    },
    async claimCheckin(request: { credential: { userId: string } }, deviceId: string) {
      const accountId = request.credential.userId
      calls.push({ method: 'claim', accountId, deviceId })
      return script.claim?.(accountId) ?? { claimed: true, code: 0, message: 'ok' }
    },
  }
  return { client: client as never, calls }
}

/** 本机身份 fixture（deviceId 是签到设备口径的判定量）。 */
function identity(deviceId = 'device-dc-1'): TraeIdentity {
  return {
    edition: 'cn',
    machineId: 'machine-abc',
    deviceId,
    appVersion: '2.1.0',
    buildVersion: '20260716',
    platform: 'win32',
  }
}

/** 建一个已注入身份与假上游的调度器。 */
function makeScheduler(
  pool: TraeAccountPool,
  script: Parameters<typeof fakeClient>[0],
  options: {
    clock?: ReturnType<typeof fakeClock>
    enabled?: boolean
    checkinHours?: readonly number[]
    deviceId?: string
    loadEarnings?: () => AutomationLedger | undefined
    saveEarnings?: (ledger: AutomationLedger) => void
  } = {},
): { scheduler: TraeScheduler; calls: Call[]; clock: ReturnType<typeof fakeClock> } {
  const clock = options.clock ?? fakeClock('2026-10-11T01:00:00.000Z') // 北京 09:00
  const { client, calls } = fakeClient(script)
  const scheduler = new TraeScheduler(pool, client, {
    enabled: options.enabled ?? true,
    accountDelayMs: 0,
    now: clock.now,
    ...options.checkinHours === undefined ? {} : { checkinHours: options.checkinHours },
    ...options.loadEarnings === undefined ? {} : { loadEarnings: options.loadEarnings },
    ...options.saveEarnings === undefined ? {} : { saveEarnings: options.saveEarnings },
  })
  scheduler.setIdentity(identity(options.deviceId ?? 'device-dc-1'))
  return { scheduler, calls, clock }
}

/** 全部账号 id 的稳定顺序。 */
function ids(pool: TraeAccountPool): string[] {
  return pool.list('cn').map(account => account.id)
}

/** 某个账号的池 id（按 userId 找）。 */
function idOf(pool: TraeAccountPool, userId: string): string {
  const account = pool.list().find(entry => entry.credential.userId === userId)
  if (account === undefined) throw new Error(`no account ${userId}`)
  return account.id
}

describe('dayKey / slotKey / isFireHour（北京时区语义）', () => {
  it('日界与时段按 Asia/Shanghai 计算，而不是宿主本地时区', () => {
    // 2026-10-11T00:30Z = 北京 08:30（同一天）；T16:30Z = 北京次日 00:30。
    expect(dayKey(new Date('2026-10-11T00:30:00.000Z'))).toBe('2026-10-11')
    expect(dayKey(new Date('2026-10-11T16:30:00.000Z'))).toBe('2026-10-12')
    expect(slotKey(new Date('2026-10-11T01:00:00.000Z'))).toBe('2026-10-11T09')
    // 上游按北京自然日判幂等：跨日重置必须用同一个键。
    expect(slotKey(new Date('2026-10-11T23:00:00.000Z'))).toBe('2026-10-12T07')
  })

  it('isFireHour 在配置的小时上为真', () => {
    expect(isFireHour(new Date('2026-10-11T01:00:00.000Z'), [9])).toBe(true)
    expect(isFireHour(new Date('2026-10-11T01:00:00.000Z'), [10])).toBe(false)
  })

  it('目前只有 checkin 一类 job（Trae 自动化面收敛为签到）', () => {
    expect([...AUTOMATION_JOB_KINDS]).toEqual(['checkin'])
  })
})

describe('调度：到点触发 / 不重复 / 跨日重置 / 补跑', () => {
  it('到达配置小时即触发，全部 CN 账号各签一次', async () => {
    const pool = await testPool()
    const { scheduler, calls } = makeScheduler(pool, {})

    await scheduler.runDueNow()

    // 两个 CN 账号都会被处理；国际账号完全不出现在调用里。
    // 注意每个成功领取的账号是**三次**调用：status → claim → 读回 status
    // （积分面额取读回后的运行时值，绝不硬编码）。
    expect(new Set(calls.map(call => call.accountId))).toEqual(new Set(['user-a', 'user-b']))
    expect(calls.every(call => call.accountId !== 'user-g')).toBe(true)
    for (const userId of ['user-a', 'user-b']) {
      expect(calls.filter(call => call.accountId === userId).map(call => call.method))
        .toEqual(['status', 'claim', 'status'])
    }
    const state = scheduler.status().jobs.checkin
    expect(state.ok).toBe(2)
    expect(state.claimed).toBe(2)
    expect(state.failed).toBe(0)
  })

  it('同一个小时内第二次 tick 不重复运行', async () => {
    const pool = await testPool()
    const { scheduler, calls, clock } = makeScheduler(pool, {})

    await scheduler.runDueNow()
    const afterFirst = calls.length
    clock.advanceMs(30_000) // 仍在 09 点内
    await scheduler.runDueNow()

    expect(calls).toHaveLength(afterFirst)
  })

  it('多时段配置在每个小时各跑一次（firedSlots 是集合而不是单个时段）', async () => {
    const pool = await testPool()
    const clock = fakeClock('2026-10-11T01:00:00.000Z') // 北京 09:00
    const { scheduler, calls } = makeScheduler(pool, {}, { clock, checkinHours: [9, 21] })

    await scheduler.runDueNow()
    expect(scheduler.firedSlots('checkin')).toEqual(['2026-10-11T09'])

    // 跳到当晚 21:00（北京）——第二个时段必须还能跑。
    clock.set('2026-10-11T13:00:00.000Z')
    await scheduler.runDueNow()

    expect(scheduler.firedSlots('checkin')).toEqual(['2026-10-11T09', '2026-10-11T21'])
    // 两个账号 × 两轮 × 三次调用（status/claim/读回 status）。
    expect(calls).toHaveLength(12)
    expect(scheduler.status().jobs.checkin.claimed).toBe(4)
  })

  it('DSH 关闭期间错过的时段会在下次 tick 补跑（笔记本合盖场景）', async () => {
    const pool = await testPool()
    // 配置 9 点，但机器 14 点才起来：9 点那个时段没消费，补跑它。
    const clock = fakeClock('2026-10-11T06:00:00.000Z') // 北京 14:00
    const { scheduler, calls } = makeScheduler(pool, {}, { clock })

    await scheduler.runDueNow()

    expect(calls.length).toBeGreaterThan(0)
    // 消费的是**配置的小时** 09，不是运行时刻 14。
    expect(scheduler.firedSlots('checkin')).toEqual(['2026-10-11T09'])
  })

  it('跨日重置：次日同一小时可再次运行，且 firedSlots 不留昨天的键', async () => {
    const pool = await testPool()
    const clock = fakeClock('2026-10-11T01:00:00.000Z')
    const { scheduler, calls } = makeScheduler(pool, {}, { clock })

    await scheduler.runDueNow()
    const day1Calls = calls.length
    // 跳到次日北京 09:00。
    clock.set('2026-10-12T01:00:00.000Z')
    await scheduler.runDueNow()

    expect(calls).toHaveLength(day1Calls * 2)
    expect(scheduler.firedSlots('checkin')).toEqual(['2026-10-12T09'])
  })

  it('回归：跨日那一轮的时段消费必须活到运行结束（不能被收尾的滚日擦掉）', async () => {
    // 曾经的缺陷：tick 先 consumeSlot 再 runJob，而 runJob 收尾会调用 rollEarnings，
    // 后者在日界变化时清空 firedSlots —— 于是跨日那一轮刚消费的时段被立刻抹掉，
    // 闸门重新打开（同一小时可无限重跑），「今天跑过」的记录也丢了。
    // 这里直接钉住「消费 → 跑完」之后记录仍在。
    const pool = await testPool()
    const clock = fakeClock('2026-10-11T01:00:00.000Z')
    const { scheduler, calls } = makeScheduler(pool, {}, { clock })

    // 第一天先在 09 点跑一次，让 earningsDate 停在 10-11。
    await scheduler.runDueNow()
    expect(scheduler.firedSlots('checkin')).toEqual(['2026-10-11T09'])

    // 跨到次日同一小时：这一轮的消费必须留存。
    clock.set('2026-10-12T01:00:00.000Z')
    await scheduler.runDueNow()

    expect(scheduler.firedSlots('checkin')).toEqual(['2026-10-12T09'])
    // 再 tick 一次不得重复（闸门确实生效，而不是被清空后重新打开）。
    const afterDay2 = calls.length
    clock.advanceMs(10_000)
    await scheduler.runDueNow()
    expect(calls).toHaveLength(afterDay2)
  })

  it('手动 runAll 跨日时同样先滚日，记录不被收尾抹掉', async () => {
    const pool = await testPool()
    const clock = fakeClock('2026-10-11T01:00:00.000Z')
    const { scheduler } = makeScheduler(pool, {}, { clock })

    await scheduler.runAll()
    clock.set('2026-10-12T03:00:00.000Z')
    await scheduler.runAll()

    // 账本属于新的一天，且当天的收益落在 10-12 上。
    expect(Object.keys(scheduler.status().earningsToday).length).toBeGreaterThan(0)
    for (const entry of Object.values(scheduler.status().earningsToday)) {
      expect(entry.date).toBe('2026-10-12')
    }
  })

  it('enabled=false 时 tick 什么都不做', async () => {
    const pool = await testPool()
    const { scheduler, calls } = makeScheduler(pool, {}, { enabled: false })

    await scheduler.runDueNow()

    expect(calls).toEqual([])
    expect(scheduler.status().enabled).toBe(false)
  })

  it('start/stop 幂等且 status().running 反映真实状态', () => {
    const scheduler = new TraeScheduler(
      { list: () => [], isDisabled: () => false } as never,
      {} as never,
      { enabled: true, now: () => new Date('2026-10-11T01:00:00.000Z') },
    )
    expect(scheduler.status().running).toBe(false)
    scheduler.start()
    expect(scheduler.status().running).toBe(true)
    scheduler.start() // 幂等
    expect(scheduler.status().running).toBe(true)
    scheduler.stop()
    expect(scheduler.status().running).toBe(false)
    scheduler.stop() // 幂等
    expect(scheduler.status().running).toBe(false)
  })
})

describe('签到判定分支', () => {
  it('活动未开启（enable=false）→ 跳过，不算失败', async () => {
    const pool = await testPool()
    const { scheduler, calls } = makeScheduler(pool, {
      status: () => ({ checkedIn: false, didCheckedIn: false, credits: 100, enabled: false }),
    })

    await scheduler.runDueNow()

    expect(calls.every(call => call.method === 'status')).toBe(true)
    const state = scheduler.status().jobs.checkin
    expect(state.ok).toBe(2)
    expect(state.failed).toBe(0)
    expect(state.detail?.every(line => line.includes('未开启'))).toBe(true)
  })

  it('checked_in=true（账号级已到账）→ 跳过且**不发 claim**', async () => {
    const pool = await testPool()
    const { scheduler, calls } = makeScheduler(pool, {
      status: () => ({ checkedIn: true, didCheckedIn: false, credits: 150, enabled: true, extraCredits: 50 }),
    })

    await scheduler.runDueNow()

    // 已领取就不再发写请求：这是最重要的幂等守卫。
    expect(calls.some(call => call.method === 'claim')).toBe(false)
    const state = scheduler.status().jobs.checkin
    expect(state.claimed).toBe(0)
    expect(state.ok).toBe(2)
    expect(state.detail?.[0]).toContain('今日已签到')
  })

  it('did_checked_in=true 且 checked_in=false → 记 deviceSpent，不发 claim，不算失败', async () => {
    const pool = await testPool()
    const { scheduler, calls } = makeScheduler(pool, {
      status: () => ({ checkedIn: false, didCheckedIn: true, credits: 100, enabled: true }),
    })

    await scheduler.runDueNow()

    expect(calls.some(call => call.method === 'claim')).toBe(false)
    const state = scheduler.status().jobs.checkin
    expect(state.deviceSpent).toBe(2)
    expect(state.failed).toBe(0)
    expect(state.ok).toBe(2)
    // 设备名额被占**不是**「已领取」：明细必须如实区分，账本记 deviceSpent。
    expect(state.detail?.every(line => line.includes('名额已被其他账号占用'))).toBe(true)
    const earnings = scheduler.status().earningsToday
    for (const id of ids(pool)) expect(earnings[id]?.deviceSpent).toBe(true)
  })

  it('claim code 0 → 成功入账，金额取读回的状态（基础 + 额外），绝不硬编码', async () => {
    const pool = await testPool()
    const clock = fakeClock('2026-10-11T01:00:00.000Z')
    const { scheduler } = makeScheduler(pool, {
      // 首次读状态 → 未签；claim 之后再读 → 已签且面额 150+50。
      status: (_accountId, seq) => seq === 1
        ? { checkedIn: false, didCheckedIn: false, credits: 100, enabled: true }
        : { checkedIn: true, didCheckedIn: true, credits: 150, enabled: true, extraCredits: 50 },
      claim: () => ({ claimed: true, code: 0, message: 'ok' }),
    }, { clock })

    await scheduler.runDueNow()

    const state = scheduler.status().jobs.checkin
    expect(state.claimed).toBe(2)
    expect(state.credit).toBe(400) // 每账号 150 + 50
    const earnings = scheduler.status().earningsToday
    for (const id of ids(pool)) {
      expect(earnings[id]?.credit).toBe(200)
      expect(earnings[id]?.checkinCredit).toBe(200)
    }
  })

  it('claim code 9095（设备今日已签）→ 记 deviceSpent，**不算失败**', async () => {
    const pool = await testPool()
    const { scheduler } = makeScheduler(pool, {
      claim: () => ({ claimed: false, code: 9095, message: '当前设备今日已经签到，请明日再来哦～' }),
    })

    await scheduler.runDueNow()

    const state = scheduler.status().jobs.checkin
    expect(state.deviceSpent).toBe(2)
    expect(state.failed).toBe(0)
    expect(state.claimed).toBe(0)
    expect(state.detail?.[0]).toContain('9095')
  })

  it('claim code 9004（设备头未被接受）→ 计失败并保留上游原话', async () => {
    const pool = await testPool()
    const { scheduler } = makeScheduler(pool, {
      claim: () => ({ claimed: false, code: 9004, message: 'The submitted order parameters are incorrect' }),
    })

    await scheduler.runDueNow()

    const state = scheduler.status().jobs.checkin
    expect(state.failed).toBe(2)
    expect(state.claimed).toBe(0)
    expect(state.detail?.[0]).toContain('9004')
    expect(state.detail?.[0]).toContain('order parameters')
  })

  it('其它未知业务码 → 计失败（不静默吞掉）', async () => {
    const pool = await testPool()
    const { scheduler } = makeScheduler(pool, {
      claim: () => ({ claimed: false, code: 4030, message: 'forbidden' }),
    })

    await scheduler.runDueNow()

    const state = scheduler.status().jobs.checkin
    expect(state.failed).toBe(2)
    expect(state.detail?.[0]).toContain('4030')
  })

  it('读不到设备号 → status 照读但**不发 claim**（发了必然 9004）', async () => {
    const pool = await testPool()
    const { scheduler, calls } = makeScheduler(pool, {}, { deviceId: '' })

    await scheduler.runDueNow()

    expect(calls.every(call => call.method === 'status')).toBe(true)
    const state = scheduler.status().jobs.checkin
    expect(state.ok).toBe(2)
    expect(state.failed).toBe(0)
    expect(state.detail?.[0]).toContain('设备号')
  })

  it('claim 与 status 都携带同一个 x-device-id 值（设备口径的判定量）', async () => {
    const pool = await testPool()
    const { scheduler, calls } = makeScheduler(pool, {}, { deviceId: 'device-dc-99' })

    await scheduler.runDueNow()

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(call => call.deviceId === 'device-dc-99')).toBe(true)
  })
})

describe('账号筛选与失败隔离', () => {
  it('ai 区域账号整类跳过（国际版没有 /ug/* 端点族）', async () => {
    const pool = await testPool()
    const { scheduler, calls } = makeScheduler(pool, {})

    await scheduler.runDueNow()

    expect(calls.some(call => call.accountId === 'user-g')).toBe(false)
    expect(scheduler.status().jobs.checkin.ok).toBe(2)
  })

  it('一个账号抛错不影响其他账号（失败隔离）', async () => {
    const pool = await testPool()
    const { scheduler, calls } = makeScheduler(pool, {
      throwOnStatus: accountId => accountId === 'user-a' ? new Error('ECONNRESET') : undefined,
    })

    await scheduler.runDueNow()

    // user-a 失败，但 user-b 必须照签。
    expect(calls.some(call => call.accountId === 'user-b' && call.method === 'claim')).toBe(true)
    const state = scheduler.status().jobs.checkin
    expect(state.failed).toBe(1)
    expect(state.claimed).toBe(1)
    expect(state.detail?.some(line => line.includes('失败'))).toBe(true)
  })

  it('全部账号都抛错时整轮不崩，全部计入失败', async () => {
    const pool = await testPool()
    const { scheduler } = makeScheduler(pool, { throwOnStatus: () => new Error('boom') })

    await expect(scheduler.runDueNow()).resolves.toBeUndefined()
    expect(scheduler.status().jobs.checkin.failed).toBe(2)
  })

  it('被禁用的账号被跳过', async () => {
    const pool = await testPool()
    // 池的配置项名是 disabledAccountIds（卡片写入的用户选择）。
    pool.applyConfig({ disabledAccountIds: [idOf(pool, 'user-a')] })
    const { scheduler, calls } = makeScheduler(pool, {})

    await scheduler.runDueNow()

    expect(calls.some(call => call.accountId === 'user-a')).toBe(false)
    expect(calls.some(call => call.accountId === 'user-b')).toBe(true)
    expect(scheduler.status().jobs.checkin.claimed).toBe(1)
  })

  it('冷却中的账号**不**被跳过（签到走独立的 pay/ug 端点，不被对话限流连坐）', async () => {
    const pool = await testPool()
    // 让 user-a 进入整账号冷却（模拟对话侧刚吃到一个 429）。
    pool.penalize(idOf(pool, 'user-a'))
    const { scheduler, calls } = makeScheduler(pool, {})

    await scheduler.runDueNow()

    // 与 workbuddy scheduler 的刻意差异：冷却账号照样签到。
    expect(calls.some(call => call.accountId === 'user-a' && call.method === 'claim')).toBe(true)
    expect(scheduler.status().jobs.checkin.claimed).toBe(2)
  })

  it('池为空时整轮安静完成', async () => {
    const scheduler = new TraeScheduler(
      { list: () => [], isDisabled: () => false } as never,
      {} as never,
      { enabled: true, accountDelayMs: 0, now: () => new Date('2026-10-11T01:00:00.000Z') },
    )
    await scheduler.runDueNow()
    expect(scheduler.status().jobs.checkin.ok).toBe(0)
    expect(scheduler.status().jobs.checkin.message).toContain('签到')
  })
})

describe('账本持久化', () => {
  it('领取后写盘，且可通过 setEarningsPersistence 后置安装', async () => {
    const pool = await testPool()
    const saved: AutomationLedger[] = []
    const { scheduler } = makeScheduler(pool, {
      status: (_accountId, seq) => seq === 1
        ? { checkedIn: false, didCheckedIn: false, credits: 100, enabled: true }
        : { checkedIn: true, didCheckedIn: true, credits: 150, enabled: true, extraCredits: 50 },
    })

    // 构造后再装钩子：宿主 settings 服务就绪发生在构造之后。
    scheduler.setEarningsPersistence(ledger => { saved.push(ledger) })
    await scheduler.runDueNow()

    expect(saved.length).toBeGreaterThan(0)
    const latest = saved.at(-1)!
    expect(latest.date).toBe(dayKey(new Date('2026-10-11T01:00:00.000Z')))
    expect(Object.keys(latest.accounts).sort()).toEqual([...ids(pool)].sort())
    expect(latest.accounts[ids(pool)[0]!]?.credit).toBe(200)
  })

  it('构造时恢复当日账本（重启不丢当天收益）', async () => {
    const pool = await testPool()
    const accountId = ids(pool)[0]!
    const today = dayKey(new Date('2026-10-11T01:00:00.000Z'))
    const { scheduler } = makeScheduler(pool, {}, {
      loadEarnings: () => ({
        date: today,
        accounts: { [accountId]: { credit: 200, checkinCredit: 200, date: today } },
      }),
    })

    expect(scheduler.status().earningsToday[accountId]?.credit).toBe(200)
  })

  it('加载到更早日期的账本时丢弃（绝不把昨天当今天）', async () => {
    const pool = await testPool()
    const accountId = ids(pool)[0]!
    const { scheduler } = makeScheduler(pool, {}, {
      loadEarnings: () => ({
        date: '2026-10-10',
        accounts: { [accountId]: { credit: 999, checkinCredit: 999, date: '2026-10-10' } },
      }),
    })

    expect(scheduler.status().earningsToday[accountId]).toBeUndefined()
  })

  it('applyEarningsLedger 只接受今天，且可后置折入', async () => {
    const pool = await testPool()
    const accountId = ids(pool)[0]!
    const today = dayKey(new Date('2026-10-11T01:00:00.000Z'))
    const { scheduler } = makeScheduler(pool, {})

    scheduler.applyEarningsLedger({ date: '2026-10-10', accounts: { [accountId]: { credit: 5, checkinCredit: 5, date: '2026-10-10' } } })
    expect(scheduler.status().earningsToday[accountId]).toBeUndefined()

    scheduler.applyEarningsLedger({ date: today, accounts: { [accountId]: { credit: 7, checkinCredit: 7, date: today } } })
    expect(scheduler.status().earningsToday[accountId]?.credit).toBe(7)
  })

  it('跨日时清空逐账号计数与时段闸门', async () => {
    const pool = await testPool()
    const clock = fakeClock('2026-10-11T01:00:00.000Z')
    const { scheduler } = makeScheduler(pool, {}, { clock })

    await scheduler.runDueNow()
    expect(Object.keys(scheduler.status().earningsToday).length).toBeGreaterThan(0)

    clock.set('2026-10-12T01:00:00.000Z')
    // 状态读取先滚日：午夜之后不能报昨天的合计。
    expect(scheduler.status().earningsToday).toEqual({})
  })

  it('持久化钩子抛错不会打断运行', async () => {
    const pool = await testPool()
    const { scheduler } = makeScheduler(pool, {}, {
      saveEarnings: () => { throw new Error('disk full') },
    })

    await expect(scheduler.runDueNow()).resolves.toBeUndefined()
    expect(scheduler.status().jobs.checkin.claimed).toBe(2)
  })
})

describe('手动触发', () => {
  it('runAll 绕过时段闸门，手动跑完之后定时器不会在同一天重复', async () => {
    const pool = await testPool()
    const clock = fakeClock('2026-10-11T00:00:00.000Z') // 北京 08:00（未到 9 点）
    const { scheduler, calls } = makeScheduler(pool, {}, { clock })

    await scheduler.runAll()
    const afterManual = calls.length
    expect(afterManual).toBeGreaterThan(0)

    // 手动运行**不消费**调度时段：跳到 9 点后定时器仍应跑一次。
    clock.set('2026-10-11T01:00:00.000Z')
    await scheduler.runDueNow()

    expect(calls.length).toBe(afterManual * 2)
  })

  it('startRunAll 后台启动并返回是否启动；在途时第二次返回 false', async () => {
    const pool = await testPool()
    const { scheduler } = makeScheduler(pool, {})

    expect(scheduler.startRunAll()).toBe(true)
    // 立刻再按一次：在途，拒绝而不是排队。
    expect(scheduler.startRunAll()).toBe(false)
    // 等首轮结束（accountDelayMs=0，很快）。
    await vi.waitFor(() => { expect(scheduler.status().runInProgress).toBe(false) })
    expect(scheduler.status().lastPassAtMs).toBeDefined()
  })

  it('同一小时内的第二次手动运行被节流；force 可绕过', async () => {
    const pool = await testPool()
    const { scheduler, calls } = makeScheduler(pool, {})

    await scheduler.runAll()
    const afterFirst = calls.length
    // 同一个时钟小时内非 force 的手动运行是 no-op。
    await scheduler.runAll()
    expect(calls).toHaveLength(afterFirst)

    await scheduler.runAll(undefined, true)
    expect(calls.length).toBeGreaterThan(afterFirst)
  })

  it('status().lastPass 给出本次运行各账号所得', async () => {
    const pool = await testPool()
    const { scheduler } = makeScheduler(pool, {
      status: (_accountId, seq) => seq === 1
        ? { checkedIn: false, didCheckedIn: false, credits: 100, enabled: true }
        : { checkedIn: true, didCheckedIn: true, credits: 150, enabled: true, extraCredits: 50 },
    })

    await scheduler.runAll()

    const pass = scheduler.status().lastPass!
    for (const id of ids(pool)) expect(pass[id]?.credit).toBe(200)
  })
})

describe('配置', () => {
  it('applyConfig 的空调度表回落到默认值（不能被空数组吃掉）', async () => {
    const pool = await testPool()
    const { scheduler } = makeScheduler(pool, {}, { checkinHours: [9] })

    // 设置 schema 会把缺失列表物化成 []：必须回落到默认 [9]。
    scheduler.applyConfig({ checkinHours: [] })
    expect(scheduler.status().checkinHours).toEqual([9])

    scheduler.applyConfig({ checkinHours: [11] })
    expect(scheduler.status().checkinHours).toEqual([11])
  })

  it('applyConfig(enabled) 可运行时开关', async () => {
    const pool = await testPool()
    const { scheduler, calls } = makeScheduler(pool, {}, { enabled: false })

    await scheduler.runDueNow()
    expect(calls).toEqual([])

    scheduler.applyConfig({ enabled: true })
    await scheduler.runDueNow()
    expect(calls.length).toBeGreaterThan(0)
  })

  it('非法小时被过滤，且去重升序', () => {
    const scheduler = new TraeScheduler(
      { list: () => [], isDisabled: () => false } as never,
      {} as never,
      { checkinHours: [21, 9, 9, 24, -1, 2.5], now: () => new Date('2026-10-11T01:00:00.000Z') },
    )
    expect(scheduler.status().checkinHours).toEqual([9, 21])
  })

  it('extraJobHours 是保留的扩展点（当前无 job 消费，见 RESEARCH.md §5）', () => {
    const scheduler = new TraeScheduler(
      { list: () => [], isDisabled: () => false } as never,
      {} as never,
      { extraJobHours: [10, 11], now: () => new Date('2026-10-11T01:00:00.000Z') },
    )
    expect(scheduler.extensionHours()).toEqual([10, 11])
  })

  it('currentIdentity 回显已注入的设备号（诊断用，无 token 材料）', () => {
    const pool = { list: () => [], isDisabled: () => false } as never
    const scheduler = new TraeScheduler(pool, {} as never, { now: () => new Date('2026-10-11T01:00:00.000Z') })

    expect(scheduler.currentIdentity().deviceId).toBe('')
    scheduler.setIdentity(identity('device-dc-7'))
    expect(scheduler.currentIdentity()).toEqual({ deviceId: 'device-dc-7', machineId: 'machine-abc' })
  })
})
