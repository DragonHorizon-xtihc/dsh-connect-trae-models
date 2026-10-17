/**
 * Trae 多账号账号池测试。
 *
 * 注入假凭据目录（candidates 覆盖）+ 假 refresh 函数，覆盖：
 * 多账号发现去重、priority 轮转与模型级冷却、429 冷却后跳号、credentialDead
 * 标记与恢复、reserve 拦截、region 过滤、sticky 绑定、expiry 按 end_time 排序。
 *
 * mock 手法参照 dsh-workbuddy-xdpool/tests/pool-*.test.ts。
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TRAE_AUTH_STORAGE_KEY } from '../src/decrypt.ts'
import type { TraeEdition, TraeStorageCandidate } from '../src/paths.ts'
import { traeAccountId } from '../src/auth.ts'
import { TraeAccountPool } from '../src/pool.ts'
import type { TraeRegion } from '../src/region.ts'

/** 写一个桌面 storage.json 文档（明文 JSON 鉴权值，无需解密）。 */
function storageDocument(options: {
  token: string
  userId: string
  host?: string
  userRegion?: { region: string } | string
  expiredAt?: number
  refreshToken?: string
}): string {
  return JSON.stringify({
    [TRAE_AUTH_STORAGE_KEY]: JSON.stringify({
      token: options.token,
      refreshToken: options.refreshToken ?? `refresh-${options.token}`,
      userId: options.userId,
      account: { username: options.userId },
      host: options.host ?? 'https://api.trae.cn',
      ...options.userRegion === undefined ? {} : { userRegion: options.userRegion },
      expiredAt: new Date(options.expiredAt ?? Date.now() + 3_600_000).toISOString(),
    }),
  })
}

/** 建一个假凭据目录并把多个账号写进去，返回候选列表。 */
async function fakeCandidates(accounts: Array<{
  token: string
  userId: string
  edition?: TraeEdition
  host?: string
  userRegion?: { region: string } | string
  expiredAt?: number
  refreshToken?: string
  /** 额外写入一个插件自有副本（同一账号的更新 token）。 */
  ownRefresh?: boolean
}>): Promise<{ candidates: TraeStorageCandidate[]; ownPaths: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'trae-pool-'))
  const candidates: TraeStorageCandidate[] = []
  const ownPaths: string[] = []
  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i]!
    const path = join(dir, `storage-${i}.json`)
    await writeFile(path, storageDocument(account), 'utf8')
    candidates.push({ edition: account.edition ?? 'cn', path, source: 'desktop' })
    if (account.ownRefresh === true) {
      // 同一账号、更新 token 的自有副本：readAll 应取这份。
      const own = join(dir, `own-${i}.json`)
      await writeFile(own, JSON.stringify({
        version: 1,
        credential: {
          accessToken: `${account.token}-own`,
          refreshToken: account.refreshToken ?? `refresh-${account.token}`,
          userId: account.userId,
          accountName: account.userId,
          host: account.host ?? 'https://api.trae.cn',
          expiresAtMs: (account.expiredAt ?? Date.now() + 3_600_000) + 3_600_000,
          edition: account.edition ?? 'cn',
          source: 'dsh',
        },
      }), 'utf8')
      ownPaths.push(own)
    }
  }
  return { candidates, ownPaths }
}

/** 全部 token 都能刷新成功的假客户端。 */
function okRefresher() {
  return { refresh: async (credential: { accessToken: string }) => ({ accessToken: `fresh-${credential.accessToken}`, refreshToken: `refresh-${credential.accessToken}`, expiresAtMs: Date.now() + 3_600_000 }) }
}

/** 一个 priority 模式、三个账号（两 CN + 一国际）的池。 */
async function threeAccountPool(distribution: 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry' = 'priority', options?: { refresher?: { refresh: (credential: { accessToken: string }) => Promise<{ accessToken: string; refreshToken?: string; expiresAtMs: number }> } }) {
  const { candidates, ownPaths } = await fakeCandidates([
    { token: 'token-a', userId: 'user-a', expiredAt: Date.now() + 3 * 3_600_000 },
    { token: 'token-b', userId: 'user-b', expiredAt: Date.now() + 2 * 3_600_000 },
    { token: 'token-g', userId: 'user-g', edition: 'sg', host: 'https://growsg-normal.trae.ai', userRegion: { region: 'SG' } },
  ])
  const pool = new TraeAccountPool({
    candidates,
    ownPaths,
    distribution,
    client: options?.refresher ?? okRefresher(),
    logger: { warn() {}, info() {}, error() {} },
  })
  await pool.scan()
  return pool
}

describe('多账号发现与去重', () => {
  it('发现全部账号并按 traeAccountId 去重（region+userId）', async () => {
    const pool = await threeAccountPool()
    expect(pool.list()).toHaveLength(3)
    const ids = pool.list().map(account => account.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('同一账号登录在不同 edition 只算一个账号（跨 edition 去重）', async () => {
    // 同一个人（userId 相同）同时登录 Trae CN 与 TRAE SOLO CN：edition 只说明
    // 「从哪个客户端发现」，不是账号身份。本机实测该场景曾让同一账号在池里出现两遍。
    const { candidates } = await fakeCandidates([
      { token: 'token-cn', userId: 'same-user', edition: 'cn', expiredAt: Date.now() + 3_600_000 },
      { token: 'token-solo', userId: 'same-user', edition: 'solo', expiredAt: Date.now() + 7_200_000 },
    ])
    const pool = new TraeAccountPool({ candidates, logger: { warn() {}, info() {}, error() {} } })
    const found = await pool.scan()

    expect(found).toHaveLength(1)
    expect(pool.list()).toHaveLength(1)
    // 保留 token 有效期更晚的那份（solo 那份 +7.2s 晚于 cn 的 +3.6s）。
    expect(pool.list()[0]!.credential.accessToken).toBe('token-solo')
    // 仍归属国内区：两个 edition 都在国内侧，region 必须一致。
    expect(pool.list()[0]!.region).toBe('cn')
  })

  it('同一 userId 跨 region 仍是两个账号（cn 与 ai 不互通）', async () => {
    // region 走不同网关、不同积分体系，所以 region 必须留在去重键里。
    const { candidates } = await fakeCandidates([
      { token: 'token-cn', userId: 'same-user', edition: 'cn', host: 'https://api.trae.cn', expiredAt: Date.now() + 3_600_000 },
      { token: 'token-ai', userId: 'same-user', edition: 'sg', host: 'https://growsg-normal.trae.ai', userRegion: { region: 'SG' }, expiredAt: Date.now() + 3_600_000 },
    ])
    const pool = new TraeAccountPool({ candidates, logger: { warn() {}, info() {}, error() {} } })
    const found = await pool.scan()

    expect(found).toHaveLength(2)
    expect(new Set(pool.list().map(account => account.id)).size).toBe(2)
    expect(pool.list('cn')).toHaveLength(1)
    expect(pool.list('ai')).toHaveLength(1)
  })

  it('同一账号的桌面副本与更新的自有副本合并，只保留最新', async () => {
    const { candidates, ownPaths } = await fakeCandidates([
      { token: 'token-a', userId: 'user-a', ownRefresh: true },
    ])
    const pool = new TraeAccountPool({ candidates, ownPaths, logger: { warn() {}, info() {}, error() {} } })
    await pool.scan()
    expect(pool.list()).toHaveLength(1)
    // 自有副本的 token 更新（-own 后缀 + 更晚的 expiresAtMs），必须胜出。
    expect(pool.list()[0]!.credential.accessToken).toBe('token-a-own')
  })

  it('标签使用账号名；缺失时用 userId 前 8 位加 #', async () => {
    const pool = await threeAccountPool()
    const labels = pool.list().map(account => account.label)
    // fixture 里 accountName === userId，因此标签是「账号名#userId 前 8 位」。
    expect(labels).toContain('user-a#user-a')
    expect(labels).toContain('user-g#user-g')
    expect(labels.every(label => label.includes('#') || label.length > 0)).toBe(true)
  })

  it('账号名缺失时标签退回「userId 前 8 位#」，不冒充账号名', async () => {
    // 桌面存储可能只有 userId（企业登录/隐私模式）：标签必须仍能区分账号，
    // 且要带 # 尾标，让卡片上的「没有名字」与「名字就叫 xxx」可分辨。
    const dir = await mkdtemp(join(tmpdir(), 'trae-pool-nolabel-'))
    const path = join(dir, 'storage.json')
    await writeFile(path, JSON.stringify({
      [TRAE_AUTH_STORAGE_KEY]: JSON.stringify({
        token: 'token-noname',
        refreshToken: 'refresh-noname',
        userId: 'abcdef1234567890',
        host: 'https://api.trae.cn',
        expiredAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    }), 'utf8')
    const pool = new TraeAccountPool({
      candidates: [{ edition: 'cn', path, source: 'desktop' }],
      ownPaths: [],
      logger: { warn() {}, info() {}, error() {} },
    })
    await pool.scan()
    expect(pool.list()[0]!.label).toBe('abcdef12#')
  })

  it('账号 id 与凭据存储的 traeAccountId 一致', async () => {
    const pool = await threeAccountPool()
    for (const account of pool.list()) {
      expect(account.id).toBe(traeAccountId(account.credential))
    }
  })
})

describe('priority 分布与冷却', () => {
  it('队首账号连续服务，直到被惩罚', async () => {
    const pool = await threeAccountPool()
    const first = await pool.acquire()
    expect(first).toBeDefined()
    for (let i = 0; i < 4; i += 1) {
      expect((await pool.acquire())!.id).toBe(first!.id)
    }
  })

  it('整账号冷却后跳到下一个账号并停留', async () => {
    const pool = await threeAccountPool()
    const [head, second] = pool.list()
    expect((await pool.acquire())!.id).toBe(head!.id)
    pool.penalize(head.id, Date.now() + 60_000)
    expect((await pool.acquire())!.id).toBe(second!.id)
    expect((await pool.acquire())!.id).toBe(second!.id)
  })

  it('冷却结束后流量回到队首账号', async () => {
    const pool = await threeAccountPool()
    const head = pool.list()[0]!
    pool.penalize(head.id, Date.now() + 60_000)
    expect((await pool.acquire())!.id).not.toBe(head.id)
    pool.resetCooldowns()
    expect((await pool.acquire())!.id).toBe(head.id)
  })

  it('模型级 429 只冷却该模型：跳号到下一个账号，同账号其他模型仍可用', async () => {
    const pool = await threeAccountPool()
    const head = pool.list()[0]!
    const second = pool.list()[1]!
    pool.penalize(head.id, Date.now() + 60_000, 'claude-sonnet-4-5')
    // 该模型跳号……
    expect((await pool.acquire('claude-sonnet-4-5'))!.id).toBe(second.id)
    // ……同账号其他模型仍落在队首。
    expect((await pool.acquire('gpt-5'))!.id).toBe(head.id)
  })
})

describe('凭据失效（credentialDead）标记与恢复', () => {
  /** refresh 对 deadTokens 抛 ExchangeToken 吊销语义错误的池。 */
  function deadRefresher(deadTokens: readonly string[]) {
    return {
      refresh: async (credential: { accessToken: string }) => {
        if (deadTokens.includes(credential.accessToken)) {
          throw new Error('Trae token refresh failed (http 400): invalid_grant: Offline user session not found')
        }
        return { accessToken: `fresh-${credential.accessToken}`, expiresAtMs: Date.now() + 3_600_000 }
      },
    }
  }

  it('刷新被吊销时标记死亡并停止派活', async () => {
    const { candidates, ownPaths } = await fakeCandidates([
      { token: 'token-dead', userId: 'user-dead', expiredAt: Date.now() - 1000 },
      { token: 'token-live', userId: 'user-live' },
    ])
    const pool = new TraeAccountPool({
      candidates, ownPaths, client: deadRefresher(['token-dead']), logger: { warn() {}, info() {}, error() {} },
    })
    await pool.scan()
    const dead = pool.list().find(account => account.credential.accessToken === 'token-dead')!
    expect(await pool.refreshAccount(dead.id, { force: true })).toBe(false)
    expect(pool.deadCredentials().map(account => account.id)).toEqual([dead.id])

    // 死账号绝不再被派活。
    for (let i = 0; i < 3; i += 1) {
      const picked = await pool.acquire()
      expect(picked).toBeDefined()
      expect(picked!.id).not.toBe(dead.id)
    }
  })

  it('瞬时网络失败不标记死亡', async () => {
    const { candidates, ownPaths } = await fakeCandidates([
      { token: 'token-x', userId: 'user-x', expiredAt: Date.now() - 1000 },
    ])
    const pool = new TraeAccountPool({
      candidates, ownPaths,
      client: { refresh: async () => { throw new Error('fetch failed') } },
      logger: { warn() {}, info() {}, error() {} },
    })
    await pool.scan()
    const account = pool.list()[0]!
    expect(await pool.refreshAccount(account.id, { force: true })).toBe(true)
    expect(pool.deadCredentials()).toHaveLength(0)
  })

  it('全部账号被吊销时报 dead 而不是 cooling（补救措施相反）', async () => {
    const { candidates, ownPaths } = await fakeCandidates([
      { token: 'token-0', userId: 'user-0', expiredAt: Date.now() - 1000 },
      { token: 'token-1', userId: 'user-1', expiredAt: Date.now() - 1000 },
    ])
    const pool = new TraeAccountPool({
      candidates, ownPaths, client: deadRefresher(['token-0', 'token-1']), logger: { warn() {}, info() {}, error() {} },
    })
    await pool.scan()
    for (const account of pool.list()) await pool.refreshAccount(account.id, { force: true })
    const why = pool.unavailableReason()
    expect(why.reason).toBe('dead')
    expect(why.dead).toBe(2)
    expect(why.total).toBe(2)
    expect(why.cooling).toBe(0)
  })

  it('成功的刷新清掉死标记（恢复）', async () => {
    const { candidates, ownPaths } = await fakeCandidates([
      { token: 'token-0', userId: 'user-0', expiredAt: Date.now() - 1000 },
    ])
    let dead = true
    const pool = new TraeAccountPool({
      candidates, ownPaths,
      client: {
        refresh: async () => {
          if (dead) throw new Error('Trae token refresh failed (http 401): invalid_grant')
          return { accessToken: 'fresh-0', expiresAtMs: Date.now() + 3_600_000 }
        },
      },
      logger: { warn() {}, info() {}, error() {} },
    })
    await pool.scan()
    const account = pool.list()[0]!
    expect(await pool.refreshAccount(account.id, { force: true })).toBe(false)
    expect(pool.deadCredentials()).toHaveLength(1)

    dead = false
    pool.clearCredentialDead(account.id)
    expect(await pool.refreshAccount(account.id, { force: true })).toBe(true)
    expect(pool.deadCredentials()).toHaveLength(0)
  })
})

describe('积分保留线（reserve）拦截', () => {
  it('余额 ≤ 保留线的账号不派活', async () => {
    const pool = await threeAccountPool()
    const head = pool.list()[0]!
    // 报告余额 10，保留线 20：不派活。
    pool.noteCredits(head.id, 10)
    pool.setCreditReserves({ [head.id]: 20 })
    expect(pool.isReserved(head.id)).toBe(true)
    expect((await pool.acquire())!.id).not.toBe(head.id)
  })

  it('余额高于保留线的账号正常派活', async () => {
    const pool = await threeAccountPool()
    const head = pool.list()[0]!
    pool.noteCredits(head.id, 500)
    pool.setCreditReserves({ [head.id]: 20 })
    expect(pool.isReserved(head.id)).toBe(false)
    expect((await pool.acquire())!.id).toBe(head.id)
  })

  it('无余额读数的账号不被保留线拦住（未探测的池不能搁浅）', async () => {
    const pool = await threeAccountPool()
    const head = pool.list()[0]!
    pool.setCreditReserves({ [head.id]: 20 })
    expect(pool.creditsOf(head.id)).toBeUndefined()
    expect((await pool.acquire())!.id).toBe(head.id)
  })

  it('全部账号都低于保留线时报 reserve 原因', async () => {
    const pool = await threeAccountPool()
    for (const account of pool.list()) {
      pool.noteCredits(account.id, 5)
      pool.setCreditReserves({ ...pool.creditReservesInOrder(), [account.id]: 20 })
    }
    expect(pool.unavailableReason().reason).toBe('reserve')
  })

  it('noteCredits 直写到期时间；creditExpiryOf 读取', async () => {
    const pool = await threeAccountPool()
    const head = pool.list()[0]!
    const expiry = Date.now() + 86_400_000
    pool.noteCredits(head.id, 100, expiry)
    expect(pool.creditsOf(head.id)).toBe(100)
    expect(pool.creditExpiryOf(head.id)).toBe(expiry)
    // 未带到期时间的下一次读数清掉旧值。
    pool.noteCredits(head.id, 90)
    expect(pool.creditExpiryOf(head.id)).toBeUndefined()
  })
})

describe('关闭账号（disabled）与不可用原因', () => {
  it('被关闭的账号仍列出，但绝不派活', async () => {
    const pool = await threeAccountPool()
    const head = pool.list()[0]!
    pool.applyConfig({ disabledAccountIds: [head.id] })
    // 卡片要能把它显示出来才能重新打开，所以 list 必须保留它。
    expect(pool.list().map(account => account.id)).toContain(head.id)
    expect(pool.isDisabled(head.id)).toBe(true)
    expect(pool.disabledIdsInOrder()).toEqual([head.id])
    for (let i = 0; i < 3; i += 1) {
      expect((await pool.acquire())!.id).not.toBe(head.id)
    }
  })

  it('全部账号被关闭时报 disabled（补救是重新启用，不是等待）', async () => {
    const pool = await threeAccountPool()
    pool.applyConfig({ disabledAccountIds: pool.list().map(account => account.id) })
    const why = pool.unavailableReason()
    expect(why.reason).toBe('disabled')
    expect(why.disabled).toBe(3)
    expect(why.cooling).toBe(0)
    expect(await pool.acquire()).toBeUndefined()
    // 重新启用后立刻恢复服务。
    pool.applyConfig({ disabledAccountIds: [] })
    expect(await pool.acquire()).toBeDefined()
  })

  it('已过期的冷却视为可用，不再计入 cooling', async () => {
    const pool = await threeAccountPool()
    const head = pool.list()[0]!
    // 截止时刻在过去：冷却窗口已关闭，账号必须立刻回到轮转。
    pool.penalize(head.id, Date.now() - 5_000)
    expect(pool.unavailableReason().reason).toBe('none')
    expect(pool.status().cooling).toBe(0)
    expect((await pool.acquire())!.id).toBe(head.id)
  })

  it('某区域一个账号都没有时报 empty（补救是登录，不是等待）', async () => {
    const { candidates, ownPaths } = await fakeCandidates([
      { token: 'token-g', userId: 'user-g', edition: 'sg', host: 'https://growsg-normal.trae.ai', userRegion: { region: 'SG' } },
    ])
    const pool = new TraeAccountPool({ candidates, ownPaths, logger: { warn() {}, info() {}, error() {} } })
    await pool.scan()
    // 池里有账号，但都在国际区域：CN 维度的调用方看到的是「空的」。
    expect(pool.list()).toHaveLength(1)
    const why = pool.unavailableReason(undefined, 'cn')
    expect(why.reason).toBe('empty')
    expect(why.total).toBe(0)
    // 该区域没有账号时 acquire 必须返回 undefined，绝不能跨区域回退。
    expect(await pool.acquire(undefined, 'cn')).toBeUndefined()
    expect(await pool.acquire(undefined, 'ai')).toBeDefined()
  })
})

describe('region 过滤', () => {
  it('acquire 按 region 过滤：CN 调用拿不到国际账号，反之亦然', async () => {
    const pool = await threeAccountPool()
    const cnIds = pool.list('cn').map(account => account.id)
    const aiIds = pool.list('ai').map(account => account.id)
    expect(cnIds.length).toBe(2)
    expect(aiIds.length).toBe(1)
    for (let i = 0; i < 5; i += 1) {
      expect(cnIds).toContain((await pool.acquire(undefined, 'cn'))!.id)
      expect(aiIds).toContain((await pool.acquire(undefined, 'ai'))!.id)
    }
  })

  it('list(region) 只返回该区域账号', async () => {
    const pool = await threeAccountPool()
    expect(pool.list('cn').every(account => account.region === 'cn')).toBe(true)
    expect(pool.list('ai').every(account => account.region === 'ai')).toBe(true)
    expect(pool.list()).toHaveLength(3)
  })

  it('某区域账号全部冷却时，unavailableReason 按区域计数', async () => {
    const pool = await threeAccountPool()
    for (const account of pool.list('cn')) pool.penalize(account.id, Date.now() + 60_000)
    const why = pool.unavailableReason(undefined, 'cn')
    expect(why.reason).toBe('cooling')
    expect(why.total).toBe(2)
    // 国际账号不受 CN 冷却影响。
    expect(pool.unavailableReason(undefined, 'ai').reason).toBe('none')
  })
})

describe('sticky 绑定', () => {
  it('同一对话始终绑定同一账号', async () => {
    const pool = await threeAccountPool('sticky')
    const first = await pool.acquire(undefined, undefined, 'chat-a')
    expect(first).toBeDefined()
    for (let turn = 0; turn < 8; turn += 1) {
      expect((await pool.acquire(undefined, undefined, 'chat-a'))!.id).toBe(first!.id)
    }
  })

  it('每个新对话按轮转顺序取下一个账号', async () => {
    const pool = await threeAccountPool('sticky')
    const a = (await pool.acquire(undefined, undefined, 'chat-a'))!.id
    const b = (await pool.acquire(undefined, undefined, 'chat-b'))!.id
    const c = (await pool.acquire(undefined, undefined, 'chat-c'))!.id
    expect(new Set([a, b, c]).size).toBe(3)
    // 第四个对话回绕，前三个不受扰动。
    expect((await pool.acquire(undefined, undefined, 'chat-d'))!.id).toBe(a)
    expect((await pool.acquire(undefined, undefined, 'chat-b'))!.id).toBe(b)
  })

  it('绑定账号对该模型冷却时对话重绑到新账号', async () => {
    const pool = await threeAccountPool('sticky')
    const bound = (await pool.acquire('m1', undefined, 'chat-a'))!
    pool.penalize(bound.id, Date.now() + 60_000, 'm1')
    const moved = (await pool.acquire('m1', undefined, 'chat-a'))!
    expect(moved.id).not.toBe(bound.id)
    // 之后一直停在新账号上。
    expect((await pool.acquire('m1', undefined, 'chat-a'))!.id).toBe(moved.id)
    // 原账号只是模型级冷却：整账号状态未损。
    expect(pool.list().find(account => account.id === bound.id)!.cooldownUntilMs).toBe(0)
  })

  it('绑定数量有 LRU 上限', async () => {
    const pool = await threeAccountPool('sticky')
    for (let i = 0; i < 250; i += 1) {
      await pool.acquire(undefined, undefined, `chat-${i}`)
    }
    expect(pool.affinitySize()).toBeLessThanOrEqual(200)
    pool.clearAffinity()
    expect(pool.affinitySize()).toBe(0)
  })

  it('无对话键时回退轮转', async () => {
    const pool = await threeAccountPool('sticky')
    const seen = new Set<string>()
    for (let i = 0; i < 3; i += 1) seen.add((await pool.acquire())!.id)
    expect(seen.size).toBe(3)
  })
})

describe('expiry 分布（按积分包 end_time 排序）', () => {
  it('最近到期的账号先服务；无到期读数的账号排最后', async () => {
    const pool = await threeAccountPool('expiry')
    const [head, second, third] = pool.list()
    // third（国际）28 天后到期；head 12 小时；second 24 小时。
    pool.noteCredits(head.id, 100, Date.now() + 12 * 3_600_000)
    pool.noteCredits(second.id, 100, Date.now() + 24 * 3_600_000)
    pool.noteCredits(third.id, 100, Date.now() + 28 * 24 * 3_600_000)

    expect((await pool.acquire())!.id).toBe(head.id)
    // head 积分花完后（读数清掉），second 顶上。
    pool.noteCredits(head.id, 0)
    expect((await pool.acquire())!.id).toBe(second.id)
  })

  it('没有任何到期读数时退化为 priority（队首服务）', async () => {
    const pool = await threeAccountPool('expiry')
    const head = pool.list()[0]!
    for (let i = 0; i < 3; i += 1) {
      expect((await pool.acquire())!.id).toBe(head.id)
    }
  })
})

describe('round-robin 与 balanced', () => {
  it('round-robin 三个请求落在三个账号', async () => {
    const pool = await threeAccountPool('round-robin')
    const seen = new Set<string>()
    for (let i = 0; i < 3; i += 1) seen.add((await pool.acquire())!.id)
    expect(seen.size).toBe(3)
  })

  it('balanced 安静的池摊开访问而非抽干第一个', async () => {
    const pool = await threeAccountPool('balanced')
    const seen = new Set<string>()
    for (let i = 0; i < 12; i += 1) seen.add((await pool.acquire())!.id)
    expect(seen.size).toBeGreaterThan(1)
  })

  it('applyConfig 运行时切换分布', async () => {
    const pool = await threeAccountPool()
    expect(pool.currentDistribution()).toBe('priority')
    const head = (await pool.acquire())!.id
    expect((await pool.acquire())!.id).toBe(head)

    pool.applyConfig({ distribution: 'round-robin' })
    expect(pool.currentDistribution()).toBe('round-robin')
    const rotated = new Set<string>()
    for (let i = 0; i < 3; i += 1) rotated.add((await pool.acquire())!.id)
    expect(rotated.size).toBe(3)
  })
})

describe('token 刷新（ensureFresh）', () => {
  it('过期 token 通过注入的 refresh 刷新后可用', async () => {
    const { candidates, ownPaths } = await fakeCandidates([
      { token: 'token-expired', userId: 'user-exp', expiredAt: Date.now() - 1000 },
    ])
    let refreshes = 0
    const pool = new TraeAccountPool({
      candidates, ownPaths,
      client: {
        refresh: async credential => {
          refreshes += 1
          return { accessToken: `fresh-${credential.accessToken}`, refreshToken: 'rt2', expiresAtMs: Date.now() + 3_600_000 }
        },
      },
      logger: { warn() {}, info() {}, error() {} },
    })
    await pool.scan()
    const picked = await pool.acquire()
    expect(picked).toBeDefined()
    expect(picked!.credential.accessToken).toBe('fresh-token-expired')
    expect(refreshes).toBe(1)
  })

  it('并发派活同一账号只触发一次刷新（in-flight 去重）', async () => {
    const { candidates, ownPaths } = await fakeCandidates([
      { token: 'token-conc', userId: 'user-conc', expiredAt: Date.now() - 1000 },
    ])
    let refreshes = 0
    const pool = new TraeAccountPool({
      candidates, ownPaths,
      client: {
        refresh: async credential => {
          refreshes += 1
          await new Promise(resolve => setTimeout(resolve, 20))
          return { accessToken: `fresh-${credential.accessToken}`, expiresAtMs: Date.now() + 3_600_000 }
        },
      },
      logger: { warn() {}, info() {}, error() {} },
    })
    await pool.scan()
    const [a, b] = await Promise.all([pool.acquire(), pool.acquire()])
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(refreshes).toBe(1)
  })

  it('未配置刷新客户端时池仍可派活（无刷新路径）', async () => {
    const { candidates, ownPaths } = await fakeCandidates([{ token: 'token-ok', userId: 'user-ok' }])
    const pool = new TraeAccountPool({ candidates, ownPaths, logger: { warn() {}, info() {}, error() {} } })
    await pool.scan()
    const picked = await pool.acquire()
    expect(picked!.credential.accessToken).toBe('token-ok')
  })
})

describe('诊断与簿记', () => {
  it('penalizeExhausted 冷却整账号 30 分钟默认', async () => {
    const pool = await threeAccountPool()
    const head = pool.list()[0]!
    pool.penalizeExhausted(head.id)
    const why = pool.unavailableReason()
    expect(why.reason).toBe('cooling')
    expect((await pool.acquire())!.id).not.toBe(head.id)
    // 整账号冷却：任意模型都跳过它。
    expect((await pool.acquire('any-model'))!.id).not.toBe(head.id)
  })

  it('resetCooldowns 清掉全部冷却与死标记', async () => {
    const pool = await threeAccountPool()
    for (const account of pool.list()) {
      pool.penalize(account.id, Date.now() + 60_000)
      pool.penalize(account.id, Date.now() + 60_000, 'm1')
    }
    pool.penalizeCredentialDead(pool.list()[0]!.id)
    pool.resetCooldowns()
    expect(pool.unavailableReason().reason).toBe('none')
    expect(pool.deadCredentials()).toHaveLength(0)
    expect(pool.status().cooling).toBe(0)
  })

  it('status 与 diagnose 提供诊断快照', async () => {
    const pool = await threeAccountPool()
    expect(pool.status().count).toBe(3)
    const { tried, failures } = await pool.diagnose()
    expect(tried.length).toBeGreaterThan(0)
    // 注入的候选都存在且有效。
    expect(failures).toHaveLength(0)
  })

  it('noteServed 记录最近服务的账号', async () => {
    const pool = await threeAccountPool()
    const picked = await pool.acquire()
    expect(pool.lastServedId()).toBeUndefined()
    pool.noteServed(picked!.id)
    expect(pool.lastServedId()).toBe(picked!.id)
  })

  it('prefer 钉住的账号合格时绝对优先', async () => {
    const pool = await threeAccountPool()
    const target = pool.list()[2]!
    pool.prefer(target.id)
    for (let i = 0; i < 3; i += 1) {
      expect((await pool.acquire())!.id).toBe(target.id)
    }
  })
})

describe('类型导出面（后续任务约定）', () => {
  it('TraeDistribution 联合包含 5 种分布', async () => {
    const distributions: TraeDistribution[] = ['priority', 'round-robin', 'balanced', 'sticky', 'expiry']
    expect(distributions).toHaveLength(5)
  })

  it('TraeRegion 是 cn | ai', async () => {
    const regions: TraeRegion[] = ['cn', 'ai']
    expect(regions).toHaveLength(2)
  })
})
