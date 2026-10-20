/**
 * 凭据存储的合并/去重语义。
 *
 * 这里锁住三条规则，它们彼此相邻、极易互相踩坏：
 *  1. 同一账号的桌面登录压过 CLI 裸 JWT —— 即使 CLI 那份的 `exp` 更晚。
 *     （回归：`~/.trae-cn/trae-jwt-token` 被服务端吊销后文件不会改写，exp 仍
 *     指向未来；按有效期比较会让它顶掉 App 的实时登录，账号随即 401，整个区域
 *     的实时模型目录降级成静态回退。）
 *  2. 只有 CLI 凭据的机器仍然解析得出账号（不能为了修 1 而误伤 CLI-only）。
 *  3. 插件自有副本（刷新结果）有效期更晚时仍然胜出（`readAll` 的既有语义）。
 *  4. 同为桌面候选时保留有效期更晚的那份（Trae CN / TRAE SOLO CN 双安装）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TraeCredentialStore } from '../src/auth.ts'
import { TRAE_AUTH_STORAGE_KEY } from '../src/decrypt.ts'

/** 造一份裸 JWT：只有 payload 会被解析（签名不校验）。 */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

/** 一份桌面 `storage.json`：鉴权值可以是明文 JSON（parseTraeAuthValue 直接吃）。 */
async function desktopStorage(dir: string, name: string, auth: Record<string, unknown>): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify({ [TRAE_AUTH_STORAGE_KEY]: JSON.stringify(auth) }), 'utf8')
  return path
}

function store(candidates: { edition: 'cn'; path: string; source: 'desktop' | 'cli' }[], ownPaths: string[] = []): TraeCredentialStore {
  return new TraeCredentialStore({
    candidates,
    ownPaths,
    refresh: async () => { throw new Error('refresh must not be needed for a read') },
  })
}

describe('凭据去重：桌面登录与 CLI 裸 JWT', () => {
  it('CLI token 的 exp 更晚时，仍不得顶掉桌面实时登录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trae-cli-shadow-'))
    const desktopPath = await desktopStorage(dir, 'storage.json', {
      token: 'desktop-live-token',
      refreshToken: 'refresh-desktop',
      userId: 'user-1',
      host: 'https://api.trae.cn',
      expiredAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const cliPath = join(dir, 'trae-jwt-token')
    await writeFile(cliPath, jwt({
      data: { user_id: 'user-1' },
      exp: Math.floor((Date.now() + 3 * 86_400_000) / 1000),
    }), 'utf8')

    const credentials = await store([
      { edition: 'cn', path: desktopPath, source: 'desktop' },
      { edition: 'cn', path: cliPath, source: 'cli' },
    ]).readAll()

    expect(credentials).toHaveLength(1)
    expect(credentials[0]!.userId).toBe('user-1')
    // 关键断言：桌面 token 胜出，而不是 exp 更晚的 CLI token
    expect(credentials[0]!.accessToken).toBe('desktop-live-token')
    expect(credentials[0]!.source).toBe('desktop')
  })

  it('只有 CLI 凭据的机器仍然能解析出账号', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trae-cli-only-'))
    const cliPath = join(dir, 'trae-jwt-token')
    await writeFile(cliPath, jwt({
      data: { user_id: 'user-cli' },
      exp: Math.floor((Date.now() + 86_400_000) / 1000),
    }), 'utf8')

    const credentials = await store([{ edition: 'cn', path: cliPath, source: 'cli' }]).readAll()

    expect(credentials).toHaveLength(1)
    expect(credentials[0]!.userId).toBe('user-cli')
    expect(credentials[0]!.source).toBe('cli')
  })
})

describe('凭据合并：插件自有副本', () => {
  it('自有副本有效期更晚时胜出（刷新结果不被桌面副本静默丢弃）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trae-own-fresh-'))
    const desktopPath = await desktopStorage(dir, 'storage.json', {
      token: 'token-desktop',
      refreshToken: 'refresh-desktop',
      userId: 'user-own',
      host: 'https://api.trae.cn',
      expiredAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const ownPath = join(dir, '.trae-auth.json')
    await writeFile(ownPath, JSON.stringify({
      version: 1,
      credential: {
        accessToken: 'token-own-refreshed',
        refreshToken: 'refresh-own',
        userId: 'user-own',
        host: 'https://api.trae.cn',
        expiresAtMs: Date.now() + 7 * 86_400_000,
        edition: 'cn',
      },
    }), 'utf8')

    const credentials = await store(
      [{ edition: 'cn', path: desktopPath, source: 'desktop' }],
      [ownPath],
    ).readAll()

    expect(credentials).toHaveLength(1)
    expect(credentials[0]!.accessToken).toBe('token-own-refreshed')
    expect(credentials[0]!.source).toBe('dsh')
  })
})

describe('凭据去重：两个桌面安装', () => {
  it('同一账号在 Trae CN 与 TRAE SOLO CN 各有一份时，保留有效期更晚的那份', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trae-two-desktop-'))
    const older = await desktopStorage(dir, 'cn.json', {
      token: 'token-older',
      userId: 'user-both',
      host: 'https://api.trae.cn',
      expiredAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const newer = await desktopStorage(dir, 'solo.json', {
      token: 'token-newer',
      userId: 'user-both',
      host: 'https://api.trae.cn',
      expiredAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
    })

    const credentials = await store([
      { edition: 'cn', path: older, source: 'desktop' },
      { edition: 'cn', path: newer, source: 'desktop' },
    ]).readAll()

    expect(credentials).toHaveLength(1)
    expect(credentials[0]!.accessToken).toBe('token-newer')
  })
})
