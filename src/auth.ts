/**
 * Trae 凭据模型与多账号凭据存储（改编自 dsh-connect-trae/src/auth.ts）。
 *
 * 与单账号版的关键差异：
 * - 去掉「单账号 selected 绑定」语义：本插件需要全部账号同时入池，不保存
 *   选择状态，`readAll` 仍按 traeAccountId=sha256(edition+userId) 去重、
 *   取每账号最新凭据。
 * - 保留插件自有副本的读取：池内账号刷新后的 token 写入自有副本文件，扫描时
 *   与桌面凭据按「每账号最新」合并。
 *
 * @module dsh-connect-trae-models/auth
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseTraeCliToken, parseTraeStorageDocument } from './decrypt.ts'
import { traeStorageCandidates, type TraeCredentialSource, type TraeEdition, type TraeStorageCandidate } from './paths.ts'
import { regionOfCredential, regionOfEdition, type TraeRegion } from './region.ts'

/** 解析后的 Trae 凭据。 */
export interface TraeCredential {
  accessToken: string
  refreshToken?: string
  userId: string
  accountName?: string
  host: string
  /**
   * 解密后的存储文档里的区域声明（`userRegion.region`，'CN' | 'SG'，可能小写）。
   * 与 host 一起决定路由桶，见 `regionOfCredential`。
   */
  userRegion?: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  edition: TraeEdition
  source: 'desktop' | 'dsh' | 'cli'
}

/**
 * 为什么一个候选路径没有产出账号。
 *
 * 只携带路径与错误文本，绝不含 token 材料——这些字段要原样展示在卡片诊断里。
 */
export interface TraeCandidateFailure {
  path: string
  edition: TraeEdition
  source: TraeCredentialSource
  reason: 'missing' | 'unreadable' | 'invalid'
  message?: string
}

/** 一次 token 刷新的产出。 */
export interface TraeRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  host?: string
}

export interface TraeCredentialStoreOptions {
  /** 测试注入：只探测这些候选路径，不探测真实磁盘。 */
  candidates?: readonly TraeStorageCandidate[]
  /** 测试注入：自有副本路径列表（多账号版每账号一文件）。 */
  ownPaths?: readonly string[]
  /** 刷新函数（由池/上游客户端提供）。 */
  refresh: (credential: TraeCredential) => Promise<TraeRefreshOutcome>
  /** token 距过期多久开始刷新；默认 5 分钟。 */
  refreshMarginMs?: number
}

/** Host used for CLI tokens, which carry no host claim of their own. */
const CLI_DEFAULT_HOST = 'https://api.trae.cn'

/** 插件自有副本的文档版本与文件名。 */
const OWN_VERSION = 1
export const TRAE_AUTH_FILENAME = '.trae-auth.json'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function timeToMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 从两种磁盘形状中提取 `userRegion.region` 字符串。 */
function userRegionOf(value: unknown): string | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

/** 把任一磁盘形状归一化为 TraeCredential；没有 access token 时返回 undefined。 */
export function normalizeTraeCredential(raw: unknown, edition: TraeEdition, source: TraeCredential['source']): TraeCredential | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const accessToken = optionalString(value['token']) ?? optionalString(value['accessToken'])
  if (accessToken === undefined) return undefined
  const expiresAtMs = timeToMs(value['expiredAt'] ?? value['expiresAt']) ?? 0
  const refreshExpiresAtMs = timeToMs(value['refreshExpiredAt'] ?? value['refreshExpiresAt'])
  const refreshToken = optionalString(value['refreshToken'])
  const userRegion = userRegionOf(value['userRegion'])
  const account = typeof value['account'] === 'object' && value['account'] !== null && !Array.isArray(value['account'])
    ? value['account'] as Record<string, unknown>
    : undefined
  const accountName = optionalString(account?.['username'])
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    userId: optionalString(value['userId']) ?? '',
    ...accountName === undefined ? {} : { accountName },
    host: optionalString(value['host']) ?? '',
    ...userRegion === undefined ? {} : { userRegion },
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    edition,
    source,
  }
}

/**
 * 稳定账号 id：sha256(region + userId)。userId 缺失时退回 accountName，
 * 再退回 'unknown'。同一账号重复登录（重新发现）得到同一 id，池内原地刷新。
 *
 * **键里是 region 而不是 edition**：edition 只说明「从哪个客户端发现」（cn /
 * sg / solo / solo-sg 四个安装），而同一个人完全可能同时登录 Trae CN 与
 * TRAE SOLO CN 两个客户端——把 edition 编进键会让同一个人在池里出现两遍
 * （本机实测：userId 867944646316548 同时躺在 cn 与 solo 两份 storage.json 里）。
 * region 才是路由桶（cn/ai 走不同网关、不同积分体系），必须留在键里。
 *
 * 参照插件 dsh-connect-trae 的同名函数用的是 edition，因为它是单账号插件、
 * 只读一个 edition，从未暴露这个问题；多账号池同时扫全部 edition，就必须按
 * 账号本身去重。
 */
export function traeAccountId(credential: Pick<TraeCredential, 'userId' | 'accountName'> & { userRegion?: string; host?: string; edition: TraeEdition }): string {
  // regionOfCredential 接受窄形状（userRegion > host 后缀 > edition 三级判定），
  // 这里不必把整份凭据传进来。
  const stable = `${regionOfCredential(credential)}\0${credential.userId || credential.accountName || 'unknown'}`
  return createHash('sha256').update(stable).digest('hex').slice(0, 24)
}

/** 解析插件自有副本文档；版本不符返回 undefined。 */
function parseOwn(text: string): TraeCredential | undefined {
  try {
    const document = JSON.parse(text) as { version?: unknown; credential?: unknown }
    if (document.version !== OWN_VERSION || typeof document.credential !== 'object' || document.credential === null) return undefined
    const stored = document.credential as Record<string, unknown>
    const edition = stored['edition']
    if (edition !== 'cn' && edition !== 'sg' && edition !== 'solo' && edition !== 'solo-sg') return undefined
    return normalizeTraeCredential({
      token: stored['accessToken'], refreshToken: stored['refreshToken'], userId: stored['userId'], host: stored['host'],
      userRegion: stored['userRegion'],
      account: stored['accountName'] === undefined ? undefined : { username: stored['accountName'] },
      expiredAt: stored['expiresAtMs'], refreshExpiredAt: stored['refreshExpiresAtMs'],
    }, edition, 'dsh')
  } catch { return undefined }
}

/**
 * 多账号凭据存储：发现本机全部 Trae 登录凭据并按账号去重。
 *
 * 与 dsh-connect-trae 的单账号 store 不同，这里没有 selected/current 概念 ——
 * 池需要每一个账号。刷新（ensureFresh）由池负责编排；存储层只做「发现 +
 * 归一化 + 每账号取最新」这一件可测试的事。
 */
export class TraeCredentialStore {
  private readonly explicitCandidates: readonly TraeStorageCandidate[] | undefined
  private readonly ownPaths: readonly string[]
  private readonly refresh: TraeCredentialStoreOptions['refresh']
  private readonly refreshMarginMs: number

  constructor(options: TraeCredentialStoreOptions) {
    this.explicitCandidates = options.candidates
    this.ownPaths = options.ownPaths ?? []
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60_000
  }

  /** 探测候选列表；测试可注入固定候选，生产走真实磁盘。 */
  candidates(): TraeStorageCandidate[] {
    // 显式覆盖（**包括空数组**）就是全部候选：空数组是「一个都别探测」这一
    // 明确指令，测试与受限部署都靠它做隔离。若让空数组落回真实磁盘发现，
    // 调用方就无法表达「没有候选」，测试也会意外读到本机真实登录。
    if (this.explicitCandidates !== undefined) return [...this.explicitCandidates]
    const all = traeStorageCandidates()
    // 全部桌面 edition 都要发现（按凭据自身区域路由）；CLI 只探测 CN home
    // （`.trae-cn`）：国际 CLI 裸 JWT 不带 host claim，SG 默认 host 未验证，
    // 错误路由比不发现更糟。
    const cliEdition: TraeEdition = 'cn'
    return all.filter(candidate => candidate.source === 'desktop' || candidate.edition === cliEdition)
  }

  /**
   * 每个候选路径为何没有得到账号。只携带路径与错误文本，绝不含 token 材料，
   * 卡片诊断可以直接展示。
   */
  async diagnose(): Promise<{ tried: TraeStorageCandidate[]; failures: TraeCandidateFailure[] }> {
    const tried = this.candidates()
    const failures: TraeCandidateFailure[] = []
    for (const candidate of tried) {
      const raw = await readFile(candidate.path, 'utf8').then(
        text => ({ text }),
        (error: unknown) => ({ error }),
      )
      if ('error' in raw) {
        const code = typeof raw.error === 'object' && raw.error !== null && 'code' in raw.error
          ? (raw.error as { code?: unknown }).code
          : undefined
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: code === 'ENOENT' ? 'missing' : 'unreadable',
          ...code === 'ENOENT' ? {} : { message: String(raw.error) },
        })
        continue
      }
      try {
        this.credentialFrom(candidate, raw.text)
      } catch (error: unknown) {
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: 'invalid',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { tried, failures }
  }

  /** 解析一个候选文件的文本为凭据，或抛错。 */
  private credentialFrom(candidate: TraeStorageCandidate, text: string): TraeCredential {
    let credential: TraeCredential | undefined
    if (candidate.source === 'cli') {
      // CLI token 不带 host claim 也不带 userRegion，用 CN host 而不是空串。
      // 只验证过 CN CLI home（`.trae-cn`）：国际 CLI token 无法正确路由（SG 默认
      // host 未验证），带可诊断错误拒绝而不是静默错路由到 CN 网关。
      if (regionOfEdition(candidate.edition) !== 'cn') {
        throw new Error(`Trae CLI tokens are only verified for the CN region; ${candidate.edition} CLI homes are not supported yet`)
      }
      const claims = parseTraeCliToken(text)
      credential = normalizeTraeCredential({
        token: claims.accessToken,
        userId: claims.userId,
        host: CLI_DEFAULT_HOST,
        expiredAt: claims.expiresAtMs,
      }, candidate.edition, 'cli')
    } else {
      credential = normalizeTraeCredential(parseTraeStorageDocument(text), candidate.edition, 'desktop')
    }
    if (credential === undefined) throw new Error(`${candidate.source} candidate could not be normalized into a credential`)
    return credential
  }

  /** 读取全部桌面候选，一个损坏文件不能藏住其他有效账号。 */
  private async readDesktopAll(): Promise<{ credentials: TraeCredential[]; failures: TraeCandidateFailure[] }> {
    const credentials: TraeCredential[] = []
    const failures: TraeCandidateFailure[] = []
    for (const candidate of this.candidates()) {
      try {
        const credential = this.credentialFrom(candidate, await readFile(candidate.path, 'utf8'))
        // 同一账号（region+userId 相同）的多个候选只留一份。
        //
        // 规则一（先判）：桌面凭据压过 CLI 凭据。`~/.trae-cn/trae-jwt-token` 是
        // Trae CLI 某次登录留下的裸 JWT，服务端吊销之后文件不会被改写，而它自带
        // 的 `exp` 仍指向未来 —— 实测该凭据在 get_detail_param 上回
        // `401 / 1001 not able to authenticate you`，而桌面 storage.json 里同一个
        // userId 的 token 正常 200。按有效期比较会让这份「看起来更新」的死 token
        // 顶掉 App 的实时登录，账号随即被上游判死（目录 401、积分 401），整个
        // 区域的实时目录降级成静态回退。
        //
        // 规则二：同为桌面候选时才保留有效期更晚的那份 —— 同一个人常同时登录
        // Trae CN 与 TRAE SOLO CN 两个客户端，两个安装的 token 刷新节奏不同，
        // 留旧的那个会让账号显示「即将过期」而有效 token 就躺在隔壁文件里。
        const existing = credentials.find(entry => traeAccountId(entry) === traeAccountId(credential))
        if (existing === undefined) {
          credentials.push(credential)
          continue
        }
        if (credential.source === 'cli' && existing.source === 'desktop') continue
        if (existing.source === 'cli' && credential.source === 'desktop') {
          credentials[credentials.indexOf(existing)] = credential
          continue
        }
        if (credential.expiresAtMs > existing.expiresAtMs) {
          credentials[credentials.indexOf(existing)] = credential
        }
      } catch (error: unknown) {
        // 一个过期、半写、不支持或已登出的 Trae 安装不能藏住其他账号的凭据。
        // 失败被记录而非丢弃，让 diagnose() 能解释静默的「未登录」。
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: code === 'ENOENT' ? 'missing' : code === undefined ? 'invalid' : 'unreadable',
          ...code === 'ENOENT' || (code === undefined && !(error instanceof Error)) ? {} : { message: error instanceof Error ? error.message : String(error) },
        })
        continue
      }
    }
    return { credentials, failures }
  }

  /** 读取全部插件自有副本；缺失或损坏的文件跳过而不是传播。 */
  private async readOwns(): Promise<TraeCredential[]> {
    const copies: TraeCredential[] = []
    for (const path of this.ownPaths) {
      try {
        const parsed = parseOwn(await readFile(path, 'utf8'))
        if (parsed !== undefined) copies.push(parsed)
      } catch {
        // 缺失或不可读 —— 尝试下一个候选。
      }
    }
    return copies
  }

  /**
   * 本机每个账号的最新凭据，按 traeAccountId 去重。
   *
   * 同一账号（edition+userId 相同）桌面副本与自有副本并存时，保留 expiresAtMs
   * 更新的那份：自有副本是本插件刷新后写入的结果，按桌面优先会静默丢弃每次
   * 刷新 —— 账号会永远显示「token 过期」而有效 token 就躺在隔壁文件里。
   * 插入顺序跟随桌面列表，重新扫描不会打乱池的队列。
   */
  async readAll(): Promise<TraeCredential[]> {
    const { credentials: desktop } = await this.readDesktopAll()
    const byAccount = new Map<string, TraeCredential>()
    const consider = (credential: TraeCredential): void => {
      const id = traeAccountId(credential)
      const incumbent = byAccount.get(id)
      if (incumbent === undefined || credential.expiresAtMs > incumbent.expiresAtMs) byAccount.set(id, credential)
    }
    for (const credential of desktop) consider(credential)
    // 自有副本对全部 edition 接受：它们是本插件自己写的刷新结果，国际账号的
    // 刷新凭据不能因为不是 CN edition 就被丢弃。
    for (const own of await this.readOwns()) consider(own)
    return [...byAccount.values()]
  }

  /** 当前 token 距过期还超过刷新余量的账号走这里；见 readAll 的合并语义。 */
  get refreshMargin(): number {
    return this.refreshMarginMs
  }

  /** 暴露刷新函数供池复用（池自己持有 in-flight 去重）。 */
  get refresher(): TraeCredentialStoreOptions['refresh'] {
    return this.refresh
  }
}

/** Trae 凭据与区域判定的便捷组合：池和上游客户端都会用。 */
export function traeAccountRegion(credential: TraeCredential): TraeRegion {
  return regionOfCredential(credential)
}
