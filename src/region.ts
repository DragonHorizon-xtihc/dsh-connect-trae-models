/**
 * 区域模型：两个存储/路由桶（`cn` | `ai`）+ 每区域网关常量。
 *
 * 证据：dsh-connect-trae docs/INTL_SG_EVIDENCE.md（2026-09-15 实测）。两个区域
 * 的桌面端暴露相同的 wire 形状；差异只在网关、名册与刷新契约。凭据自带的三级
 * 区域证据按优先级采纳：显式 region > userRegion 声明 > host 后缀 > edition 标签。
 *
 * @module dsh-connect-trae-models/region
 */

/** Trae 桌面端四种安装形态（与凭据 discovery 层共用同一联合）。 */
export type TraeEdition = 'cn' | 'sg' | 'solo' | 'solo-sg'

/** 存储/路由桶：国内（cn）服务或国际（ai）服务。两者网关互不相通。 */
export type TraeRegion = 'cn' | 'ai'

/** 一个区域的上游网关 base 集合。 */
export interface TraeRegionGateways {
  /** chat + agent API base（`llm_utils_chat` / `get_detail_param` 家族）。 */
  readonly chat: string
  /** SOLO 远端模型目录 base（`/api/remote/v1`）。 */
  readonly remote: string
  /** 积分/签到 API base（pay + ug 家族）。 */
  readonly pay: string
}

/**
 * 各区域已验证网关（dsh-connect-trae region.ts 契约，禁止改动语义）。
 * ai 区域的 mchost 分片（api16/api22-normal-alisg.mchost.guru）应答相同字节，
 * 但 `coresg-normal.trae.ai` 是唯一稳定入口。
 */
export const REGION_GATEWAYS: Readonly<Record<TraeRegion, TraeRegionGateways>> = {
  cn: {
    chat: 'https://trae-api-cn.mchost.guru',
    remote: 'https://solo.trae.cn/api/remote/v1',
    pay: 'https://api.trae.cn',
  },
  ai: {
    chat: 'https://coresg-normal.trae.ai',
    remote: 'https://coresg-normal.trae.ai/api/remote/v1',
    pay: 'https://growsg-normal.trae.ai',
  },
}

/** edition 标签 → 区域：国际版两种安装归属 `ai`。 */
export function regionOfEdition(edition: TraeEdition): TraeRegion {
  return edition === 'sg' || edition === 'solo-sg' ? 'ai' : 'cn'
}

/**
 * 凭据 `userRegion` 声明 → 区域。桌面存储把它拼成对象
 * （`{"region":"CN","_aiRegion":"CN"}`），日志里也有裸的小写 `"sg"`。
 * 两种拼法都接受，大小写不敏感。
 */
export function regionOfUserRegion(value: unknown): TraeRegion | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value
  if (typeof raw !== 'string') return undefined
  const lowered = raw.trim().toLowerCase()
  if (lowered === 'cn') return 'cn'
  if (lowered === 'sg' || lowered === 'ai') return 'ai'
  return undefined
}

/** host → 区域（`.trae.ai` → ai；`.trae.cn`/`.trae.com.cn` → cn）。 */
export function regionOfHost(host: string | undefined): TraeRegion | undefined {
  if (host === undefined) return undefined
  const trimmed = host.trim()
  if (trimmed === '') return undefined
  let hostname: string
  try {
    hostname = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return undefined
  }
  if (hostname === 'trae.ai' || hostname.endsWith('.trae.ai')) return 'ai'
  if (hostname === 'trae.cn' || hostname.endsWith('.trae.cn') || hostname.endsWith('.trae.com.cn')) return 'cn'
  return undefined
}

/**
 * 凭据 → 区域，判定链与 dsh-connect-trae 相同（userRegion > host > edition），
 * 并在最前面增加一级：账号池（T2 的 pool）可能已经算好并写回的显式 `region`
 * 字段——有效值直接采纳，让多账号装配无需重复推导。
 * 每一级都来自凭据自身携带的数据，无需用户配置。
 */
export function regionOfCredential(credential: {
  edition: TraeEdition
  host?: string
  userRegion?: string
  region?: string
}): TraeRegion {
  if (credential.region === 'cn' || credential.region === 'ai') return credential.region
  return regionOfUserRegion(credential.userRegion)
    ?? regionOfHost(credential.host)
    ?? regionOfEdition(credential.edition)
}
