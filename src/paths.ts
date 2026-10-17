/**
 * Trae 桌面端 / CLI 的凭据候选路径（移植自 dsh-connect-trae/src/paths.ts，语义逐字段保持）。
 *
 * 4 种 edition（cn/sg/solo/solo-sg）各自的 `User/globalStorage/storage.json`
 * 候选路径，以及 Trae CLI 自己的 dotfile home 中的裸 JWT 候选。
 *
 * @module dsh-connect-trae-models/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Trae 的四种安装形态：国内桌面版、国际桌面版、国内 SOLO、国际 SOLO。 */
export type TraeEdition = 'cn' | 'sg' | 'solo' | 'solo-sg'

/**
 * 凭据落盘位置。`desktop` 候选是 Electron 的 `globalStorage/storage.json`，
 * 其鉴权值是加密的；`cli` 候选是 Trae CLI 写入的裸 JWT，无需解密。
 */
export type TraeCredentialSource = 'desktop' | 'cli'

export interface TraeStorageCandidate {
  edition: TraeEdition
  path: string
  source: TraeCredentialSource
}

const APP_NAMES: Readonly<Record<TraeEdition, string>> = {
  cn: 'Trae CN',
  sg: 'Trae',
  solo: 'TRAE SOLO CN',
  'solo-sg': 'TRAE SOLO',
}

/**
 * Trae CLI 自己的 home 目录名。它们刻意与上面的 Electron app-support 名称分开：
 * CLI 用的是一个点前缀目录（macOS 观察为 `~/.trae-cn`）而不是 `Application Support`
 * 下的条目，所以只装了 CLI 的机器上根本没有 `storage.json`。
 */
const CLI_HOME_NAMES: readonly string[] = ['.trae-cn', '.trae']

/** CLI 持久化裸 JWT 的文件名。 */
export const TRAE_CLI_TOKEN_FILENAME = 'trae-jwt-token'

/**
 * Linux 桌面版配置目录名。Linux 上的 Electron 应用通常用小写、无空格的名字，
 * 而不是 macOS 的 `Trae CN` 拼写，所以两种都要探测：只猜 macOS 拼写会静默漏掉
 * 真实安装，只猜 Linux 拼写会破坏所有现存用户。真实名字在真实 Linux 主机上
 * 尚未验证。
 */
const LINUX_APP_NAMES: Readonly<Record<TraeEdition, readonly string[]>> = {
  cn: ['trae-cn', 'Trae CN', 'trae', 'Trae'],
  sg: ['trae', 'Trae'],
  solo: ['trae-solo-cn', 'TRAE SOLO CN'],
  'solo-sg': ['trae-solo', 'TRAE SOLO'],
}

/**
 * Windows 桌面版配置目录名。
 *
 * Trae 是 VS Code 系的 Electron 应用，该系列在 Windows 上的每用户数据目录名
 * 取自安装器注册的产品名 —— 即 `product.json` 的 `win32DirName`，而非 macOS
 * bundle 拼写。实测于随包发布物（2026-09-26）：
 *
 *   Trae CN      -> win32DirName = "Trae CN"       (applicationName trae-cn)
 *   TRAE SOLO CN -> win32DirName = "TRAE SOLO CN"  (applicationName trae-solo-cn)
 *
 * 所以 macOS 拼写在这里恰好也是对的，且 `win32DirName` 是这一结论的依据。
 * 小写的 `applicationName` 拼写（`trae-cn`、`trae-solo-cn`）也一并探测，因为同一
 * 系列在 Linux 上用它们作配置目录，而某个安装器在真实 Windows 主机上究竟写哪一种
 * 从未得到确认（docs/WINDOWS_TOKEN_PROBE.md）。Windows 文件系统大小写不敏感，
 * 同时列出 `trae cn` 与 `Trae CN` 只会把同一目录探测两遍 —— 因此只列出真正不同
 * 的拼写。
 */
const WINDOWS_APP_NAMES: Readonly<Record<TraeEdition, readonly string[]>> = {
  cn: ['Trae CN', 'trae-cn'],
  sg: ['Trae'],
  solo: ['TRAE SOLO CN', 'trae-solo-cn'],
  'solo-sg': ['TRAE SOLO'],
}

/**
 * 某一种 edition 在 Windows 上的候选目录拼写，按探测顺序排列。
 *
 * 导出它是为了让身份读取与凭据扫描探测同一组名字：两者解析的文件不同
 * （安装目录的 `product.json` vs 每用户的 `storage.json`），但描述的是同一个安装，
 * 一种拼写对一方有效、对另一方无效是 bug 而不是偏好。
 */
export function traeWindowsAppNames(edition: TraeEdition): readonly string[] {
  return WINDOWS_APP_NAMES[edition]
}

/** 全部桌面端 storage.json 候选 + CLI token 候选，按探测顺序排列。 */
export function traeStorageCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): TraeStorageCandidate[] {
  const result: TraeStorageCandidate[] = []
  for (const edition of ['cn', 'sg', 'solo', 'solo-sg'] as const) {
    const app = APP_NAMES[edition]
    let roots: string[]
    let appNames: readonly string[]
    if (platform === 'darwin') {
      roots = [join(home, 'Library', 'Application Support')]
      appNames = [app]
    } else if (platform === 'win32') {
      roots = [env.APPDATA, join(home, 'AppData', 'Roaming')].filter((value, index, all): value is string =>
        typeof value === 'string' && value !== '' && all.indexOf(value) === index)
      appNames = WINDOWS_APP_NAMES[edition]
    } else if (platform === 'linux') {
      roots = [env.XDG_CONFIG_HOME || join(home, '.config')]
      appNames = LINUX_APP_NAMES[edition]
    } else {
      roots = []
      appNames = [app]
    }
    for (const root of roots) {
      for (const appName of appNames) {
        result.push({ edition, path: join(root, appName, 'User', 'globalStorage', 'storage.json'), source: 'desktop' })
      }
    }
  }
  return [...result, ...traeCliCandidates(platform, home, env)]
}

/**
 * CLI token 候选路径。这里只针对 CN/SOLO edition，理由与凭据存储忽略国际版
 * 桌面安装的理由相同；`.trae-cn` 映射为 `cn`，而 `.trae` 是 CLI 的国际 home，
 * 会被存储层的 edition 过滤跳过。
 *
 * CLI home 在目前观察到的所有平台上都是 `$HOME` 下的点前缀目录，但这只在
 * macOS 上验证过；Windows 与 Linux 拼写是推测性探测，未命中无害（每个候选
 * 都按顺序尝试）。
 */
export function traeCliCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): TraeStorageCandidate[] {
  const roots: string[] = []
  if (platform === 'win32') {
    for (const value of [env.USERPROFILE, home]) {
      if (typeof value === 'string' && value !== '' && !roots.includes(value)) roots.push(value)
    }
  } else {
    roots.push(home)
  }
  const result: TraeStorageCandidate[] = []
  for (const root of roots) {
    for (const name of CLI_HOME_NAMES) {
      // `.trae-cn` 是 CN CLI home。`.trae` 保留为低优先级兜底，这样在没有国际版
      // 安装的机器上，被改名的 CN home 仍能被发现；存储层随后按 edition 过滤。
      const edition: TraeEdition = name === '.trae-cn' ? 'cn' : 'sg'
      result.push({ edition, path: join(root, name, TRAE_CLI_TOKEN_FILENAME), source: 'cli' })
    }
  }
  return result
}
