import z from "@deepseek-ai/schemastery";
import { Api, Model } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
//#region src/reasoning.d.ts
/** Trae 推理档位：与上游 `reasoning_effort` wire 值一一对应。 */
declare const TRAE_REASONING_EFFORTS: readonly ["minimal", "low", "medium", "high", "xhigh"];
type TraeReasoningEffort = typeof TRAE_REASONING_EFFORTS[number];
/** 一个模型宣告的推理能力。 */
interface TraeReasoningCapability {
  supported: readonly TraeReasoningEffort[];
  defaultEffort?: TraeReasoningEffort;
}
/** 解析 `get_detail_param` 行的 `reasoning_effort_config`（不在选项列表时返回 undefined）。 */
declare function parseReasoningCapability(value: unknown): TraeReasoningCapability | undefined;
//#endregion
//#region src/model-metadata.d.ts
/** 远端目录宣告的推理能力（选项已被映射到标准档位）。 */
interface TraeDiscoveredReasoning {
  supported: TraeReasoningEffort[];
  defaultEffort?: TraeReasoningEffort;
}
/** 远端目录解析出的一行模型骨架。 */
interface TraeDiscoveredModel {
  id: string;
  name: string;
  multimodal: boolean;
  contextWindow?: number;
  maxContextWindow?: number;
  creditMultiplier?: number;
  reasoningSupported: boolean;
  reasoning?: TraeDiscoveredReasoning;
}
/** 只解析 Trae 远端模型 API 明确宣告的能力。 */
declare function parseTraeRemoteModel(value: unknown): TraeDiscoveredModel | undefined;
//#endregion
//#region src/region.d.ts
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
type TraeEdition$1 = 'cn' | 'sg' | 'solo' | 'solo-sg';
/** 存储/路由桶：国内（cn）服务或国际（ai）服务。两者网关互不相通。 */
type TraeRegion = 'cn' | 'ai';
/** 一个区域的上游网关 base 集合。 */
interface TraeRegionGateways {
  /** chat + agent API base（`llm_utils_chat` / `get_detail_param` 家族）。 */
  readonly chat: string;
  /** SOLO 远端模型目录 base（`/api/remote/v1`）。 */
  readonly remote: string;
  /** 积分/签到 API base（pay + ug 家族）。 */
  readonly pay: string;
}
/**
 * 各区域已验证网关（dsh-connect-trae region.ts 契约，禁止改动语义）。
 * ai 区域的 mchost 分片（api16/api22-normal-alisg.mchost.guru）应答相同字节，
 * 但 `coresg-normal.trae.ai` 是唯一稳定入口。
 */
declare const REGION_GATEWAYS: Readonly<Record<TraeRegion, TraeRegionGateways>>;
/** edition 标签 → 区域：国际版两种安装归属 `ai`。 */
declare function regionOfEdition(edition: TraeEdition$1): TraeRegion;
/**
 * 凭据 `userRegion` 声明 → 区域。桌面存储把它拼成对象
 * （`{"region":"CN","_aiRegion":"CN"}`），日志里也有裸的小写 `"sg"`。
 * 两种拼法都接受，大小写不敏感。
 */
declare function regionOfUserRegion(value: unknown): TraeRegion | undefined;
/** host → 区域（`.trae.ai` → ai；`.trae.cn`/`.trae.com.cn` → cn）。 */
declare function regionOfHost(host: string | undefined): TraeRegion | undefined;
/**
 * 凭据 → 区域，判定链与 dsh-connect-trae 相同（userRegion > host > edition），
 * 并在最前面增加一级：账号池（T2 的 pool）可能已经算好并写回的显式 `region`
 * 字段——有效值直接采纳，让多账号装配无需重复推导。
 * 每一级都来自凭据自身携带的数据，无需用户配置。
 */
declare function regionOfCredential(credential: {
  edition: TraeEdition$1;
  host?: string;
  userRegion?: string;
  region?: string;
}): TraeRegion;
//#endregion
//#region src/catalog.d.ts
/** 模型的一种输入模态。 */
type TraeInputModality = 'text' | 'image';
/**
 * 目录中的一行模型。`contextWindow` 是目录保证的窗口（用户预算可调整）；
 * `maxContextWindow` 是上游宣告的 Max 窗口（只用于预算上限，不产生第二个模型行）。
 */
interface TraeModelInfo {
  id: string;
  /** Trae 自身的显示名（不含倍率后缀；倍率后缀只加在给 DSH 的名字上）。 */
  name: string;
  /** 生效上下文窗口。目录保证必有正值：DSH 拒绝无窗口模型会拖垮整条 provider 路由。 */
  contextWindow: number;
  /** 单次输出的 token 上限；上游目录偶有缺省。 */
  maxOutputTokens?: number;
  /** 积分倍率（折后价，如 0.08 → 「 · x0.08」）。 */
  multiplier?: number;
  /** 上游宣告的推理档位（低配模型缺省）。 */
  supportedEfforts?: readonly string[];
  /** 当前是否对 DSH 暴露图片输入。 */
  supportsImages: boolean;
  /** 上游自己的 multimodal 宣告（图像能力的来源事实，可被显式 opt-in 叠加）。 */
  multimodal?: boolean;
  /** 上游宣告的 Max 档窗口（预算只能抬到这个值，绝不虚构）。 */
  maxContextWindow?: number;
  /** 上游标签（保留给卡片扩展，如 free）。 */
  tags?: readonly string[];
  /** `llm_utils_chat` 真正接受的 config_name；缺省 = id 本身就是 wire id。 */
  wireConfigName?: string;
  /** 目录中列出该模型的 function（chat 调用必须回放它）。 */
  wireFunction?: string;
}
/**
 * 目录保证的默认窗口。两个来源（远端目录/get_detail_param）都没报窗口的
 * 罕见模型用它兜底：没有窗口的模型会让 DSH 整条 provider 路由
 * `INVALID_MODEL_CONTEXT` 失败，比一个不精确的窗口严重得多。
 */
declare const TRAE_DEFAULT_CONTEXT_WINDOW = 200000;
/**
 * CN 回退名册（照抄 dsh-connect-trae catalog.ts，字段已实测核对）：
 * - id 必须是 `llm_utils_chat` 真正接受的 config_name（CN 的 DeepSeek 行带
 *   `-Official` 后缀；没有 `auto` 这种伪 id）；
 * - 每行必须带正整数 contextWindow（原因同上）；
 * - 图像输入缺省关闭，由用户的显式 opt-in 打开。
 */
declare const FALLBACK_TRAE_MODELS: readonly TraeModelInfo[];
/**
 * 国际（ai）回退名册（照抄 dsh-connect-trae，来自 2026-09-15 对
 * `coresg-normal.trae.ai/api/remote/v1/models` 的实测抓取）。两个区域名册几乎
 * 不重叠（CN 没有 Gemini/GPT/MiniMax 行），所以 ai 账号绝不能用 CN 名册播种。
 */
declare const FALLBACK_TRAE_MODELS_AI: readonly TraeModelInfo[];
/** 区域 → 回退名册。每个区域的 provider 只服务自己区域的名册。 */
declare function fallbackModelsFor(region: TraeRegion): readonly TraeModelInfo[];
/**
 * 给 DSH 的显示名：照 Trae 自己模型选择器的拼法，把倍率画进名字
 * （`Name · x0.08`）。行上的 `name` 保持纯净名——wire 解析等所有 join 都必须
 * 匹配不带后缀的名字；只有交给 DSH 的行用这个装饰名。
 */
declare function traeModelDisplayName(model: Pick<TraeModelInfo, 'name' | 'multiplier'>): string;
/** 目录行 ↔ `get_detail_param` 行（wire 侧），来自上游目录的权威 wire id。 */
interface TraeWireModel {
  /** 上游接受的 config_name（`llm_utils_chat` 的 wire id）。 */
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: {
    supported: readonly string[];
    defaultEffort?: string;
  };
  /**
   * 折后积分倍率，来自该行 `display_contact_config`（Trae IDE 渲染的数值）。
   * 优先于远端目录自己的 `consumption_rate`（后者可能是未折扣值，最高差 10 倍）。
   */
  creditMultiplier?: number;
  /** 列出该 config_name 的目录 function（chat 调用回放它，否则 4001/4011）。 */
  function?: string;
}
/**
 * 合并两个 Trae 模型来源为一个权威目录。
 *
 * - `remote`（`/api/remote/v1/models`）是模型骨架：显示 id、显示名、上下文窗口、
 *   倍率、推理与 multimodal 标志；
 * - `wire`（`get_detail_param`）提供真正的 `llm_utils_chat` config_name——chat
 *   端点唯一接受的 id——以及 `display_contact_config` 里的折后倍率（优先）。
 *
 * 合并规则（照抄 dsh-connect-trae mergeTraeModelSources，语义不变）：
 * 1. wire 按 id（config_name）或显示名 join 到 remote 行；
 * 2. **没有 wire 匹配的 remote 行也保留**——wire 名册是账号范围的，"免费账号没列"
 *    不能证明付费账号调不了；行保留后调用失败会给可读报错而不是静默消失；
 * 3. 倍率：wire 的折后值优先，remote 的 `consumption_rate` 兜底；
 * 4. wire 的 config_name 与 remote id 不同时记为 `wireConfigName`。
 */
declare function mergeTraeModelSources(remote: readonly TraeDiscoveredModel[], wire: readonly TraeWireModel[]): TraeModelInfo[];
/** 用户的模型选择（settings 分区存储）。 */
interface ModelSelection {
  /** 缺省 = 目录里所有模型都提供（新安装绝不能给空选择器）。 */
  enabledModelIds?: readonly string[];
  /** 缺省 = 跟随上游 multimodal 能力。 */
  imageModelIds?: readonly string[];
  /** 按模型 id 的上下文预算。 */
  contextBudgets?: Readonly<Record<string, number | undefined>>;
}
/** 用户选择的上下文预算数值类型（token 数）。 */
type TraeContextBudget = number;
/**
 * 应用单个模型的上下文预算。
 * 规则：预算必须落在 (0, 广告窗口上限] 内——上限 = maxContextWindow（若有）
 * 否则当前窗口。可以下调，也可以上调到上游真实宣告的 Max 档，但绝不虚构数值。
 */
declare function applyModelBudget(model: TraeModelInfo, budget: number | undefined): TraeModelInfo;
/** 模型目录：live 数据 + 静态回退 + 用户选择。 */
declare class TraeCatalog {
  private models;
  private listeners;
  /** 用户的模型选择。空对象 = 跟随目录不过滤。 */
  private selection;
  /** 当前 models 来自网关（live）还是静态表（fallback）。 */
  private source;
  /** live 列表最近一次落地的 ISO 时间。 */
  private lastUpdatedAt;
  /** 最近一次抓取失败的原因（展示用）。 */
  private lastError;
  /** 区域用于 reset() 时选对回退名册。 */
  private readonly region;
  /**
   * @param region 播种该区域的静态回退：每个区域的 provider 在第一次 live
   * 刷新落地前绝不能服务另一个区域的名册。
   */
  constructor(region?: TraeRegion);
  /** 当前完整目录（未套用 selection）。 */
  current(): readonly TraeModelInfo[];
  /**
   * DSH 实际应提供的模型：套用用户选择——停用的模型剔除，显式图片列表与上游
   * multimodal 标志并集决定图片输入，逐模型预算调整窗口。
   *
   * 与蓝本 dsh-workbuddy-xdpool 的语义一致：`enabledModelIds` **缺失** = 全部
   * 可见；空数组则是「用户撤回了每一个模型」这一显式选择，必须照办——所以这里
   * 不能把空数组也放宽成不筛选。
   *
   * 真正要防的是空数组被**无意写入**：schema 会把「从未配置」materialize 成
   * `[]`，那会让模型选择器整个空掉。防它的是写入侧的兜底（见 index.ts 的
   * applySelection 与卡片保存），不是在这里放宽过滤。
   */
  visible(): readonly TraeModelInfo[];
  /** 替换目录并通知 adapter 重建模型列表。空列表忽略（绝不接受空目录）。 */
  update(models: readonly TraeModelInfo[]): void;
  /** 恢复本区域的静态回退（例如上游长时间不可用后手动重置）。 */
  reset(): void;
  /** 本目录服务的区域。 */
  currentRegion(): TraeRegion;
  /** 替换用户选择；adapter 从 visible() 重建。 */
  applySelection(selection: ModelSelection): void;
  /** 当前生效的选择（卡片的保存回环用）。 */
  currentSelection(): ModelSelection;
  /** 当前目录来源（fallback 是降级但不是错误状态）。 */
  currentSource(): 'live' | 'fallback';
  /** live 列表最近一次落地时间（从未成功过则 undefined）。 */
  catalogUpdatedAt(): string | undefined;
  /** 最近一次抓取失败原因（未失败则 undefined）。 */
  lastFetchError(): string | undefined;
  /** 订阅目录变化；返回退订函数。 */
  onChange(listener: () => void): () => void;
  /** 按 id 找行（含 wire 信息，供 shim 解析 config_name）。 */
  find(id: string): TraeModelInfo | undefined;
  /** 从 live 合并结果替换目录；空列表时保留现状并记录失败。 */
  updateFromUpstream(models: readonly TraeModelInfo[]): void;
  /**
   * 记录一次抓取失败，但不重置当前列表：一次刷新失败不应把健康的会话降级到
   * 静态表——保留在跑的目录比“闪回旧名册”更安全。
   */
  noteFetchFailure(message: string): void;
  private notify;
}
//#endregion
//#region src/paths.d.ts
/**
 * Trae 桌面端 / CLI 的凭据候选路径（移植自 dsh-connect-trae/src/paths.ts，语义逐字段保持）。
 *
 * 4 种 edition（cn/sg/solo/solo-sg）各自的 `User/globalStorage/storage.json`
 * 候选路径，以及 Trae CLI 自己的 dotfile home 中的裸 JWT 候选。
 *
 * @module dsh-connect-trae-models/paths
 */
/** Trae 的四种安装形态：国内桌面版、国际桌面版、国内 SOLO、国际 SOLO。 */
type TraeEdition = 'cn' | 'sg' | 'solo' | 'solo-sg';
/**
 * 凭据落盘位置。`desktop` 候选是 Electron 的 `globalStorage/storage.json`，
 * 其鉴权值是加密的；`cli` 候选是 Trae CLI 写入的裸 JWT，无需解密。
 */
type TraeCredentialSource = 'desktop' | 'cli';
interface TraeStorageCandidate {
  edition: TraeEdition;
  path: string;
  source: TraeCredentialSource;
}
/** CLI 持久化裸 JWT 的文件名。 */
declare const TRAE_CLI_TOKEN_FILENAME = "trae-jwt-token";
/**
 * 某一种 edition 在 Windows 上的候选目录拼写，按探测顺序排列。
 *
 * 导出它是为了让身份读取与凭据扫描探测同一组名字：两者解析的文件不同
 * （安装目录的 `product.json` vs 每用户的 `storage.json`），但描述的是同一个安装，
 * 一种拼写对一方有效、对另一方无效是 bug 而不是偏好。
 */
declare function traeWindowsAppNames(edition: TraeEdition): readonly string[];
/** 全部桌面端 storage.json 候选 + CLI token 候选，按探测顺序排列。 */
declare function traeStorageCandidates(platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv): TraeStorageCandidate[];
/**
 * CLI token 候选路径。这里只针对 CN/SOLO edition，理由与凭据存储忽略国际版
 * 桌面安装的理由相同；`.trae-cn` 映射为 `cn`，而 `.trae` 是 CLI 的国际 home，
 * 会被存储层的 edition 过滤跳过。
 *
 * CLI home 在目前观察到的所有平台上都是 `$HOME` 下的点前缀目录，但这只在
 * macOS 上验证过；Windows 与 Linux 拼写是推测性探测，未命中无害（每个候选
 * 都按顺序尝试）。
 */
declare function traeCliCandidates(platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv): TraeStorageCandidate[];
//#endregion
//#region src/auth.d.ts
/** 解析后的 Trae 凭据。 */
interface TraeCredential {
  accessToken: string;
  refreshToken?: string;
  userId: string;
  accountName?: string;
  host: string;
  /**
   * 解密后的存储文档里的区域声明（`userRegion.region`，'CN' | 'SG'，可能小写）。
   * 与 host 一起决定路由桶，见 `regionOfCredential`。
   */
  userRegion?: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  edition: TraeEdition;
  source: 'desktop' | 'dsh' | 'cli';
}
/**
 * 为什么一个候选路径没有产出账号。
 *
 * 只携带路径与错误文本，绝不含 token 材料——这些字段要原样展示在卡片诊断里。
 */
interface TraeCandidateFailure {
  path: string;
  edition: TraeEdition;
  source: TraeCredentialSource;
  reason: 'missing' | 'unreadable' | 'invalid';
  message?: string;
}
/** 一次 token 刷新的产出。 */
interface TraeRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  host?: string;
}
interface TraeCredentialStoreOptions {
  /** 测试注入：只探测这些候选路径，不探测真实磁盘。 */
  candidates?: readonly TraeStorageCandidate[];
  /** 测试注入：自有副本路径列表（多账号版每账号一文件）。 */
  ownPaths?: readonly string[];
  /** 刷新函数（由池/上游客户端提供）。 */
  refresh: (credential: TraeCredential) => Promise<TraeRefreshOutcome>;
  /** token 距过期多久开始刷新；默认 5 分钟。 */
  refreshMarginMs?: number;
}
declare const TRAE_AUTH_FILENAME = ".trae-auth.json";
/** 把任一磁盘形状归一化为 TraeCredential；没有 access token 时返回 undefined。 */
declare function normalizeTraeCredential(raw: unknown, edition: TraeEdition, source: TraeCredential['source']): TraeCredential | undefined;
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
declare function traeAccountId(credential: Pick<TraeCredential, 'userId' | 'accountName'> & {
  userRegion?: string;
  host?: string;
  edition: TraeEdition;
}): string;
/**
 * 多账号凭据存储：发现本机全部 Trae 登录凭据并按账号去重。
 *
 * 与 dsh-connect-trae 的单账号 store 不同，这里没有 selected/current 概念 ——
 * 池需要每一个账号。刷新（ensureFresh）由池负责编排；存储层只做「发现 +
 * 归一化 + 每账号取最新」这一件可测试的事。
 */
declare class TraeCredentialStore {
  private readonly explicitCandidates;
  private readonly ownPaths;
  private readonly refresh;
  private readonly refreshMarginMs;
  constructor(options: TraeCredentialStoreOptions);
  /** 探测候选列表；测试可注入固定候选，生产走真实磁盘。 */
  candidates(): TraeStorageCandidate[];
  /**
   * 每个候选路径为何没有得到账号。只携带路径与错误文本，绝不含 token 材料，
   * 卡片诊断可以直接展示。
   */
  diagnose(): Promise<{
    tried: TraeStorageCandidate[];
    failures: TraeCandidateFailure[];
  }>;
  /** 解析一个候选文件的文本为凭据，或抛错。 */
  private credentialFrom;
  /** 读取全部桌面候选，一个损坏文件不能藏住其他有效账号。 */
  private readDesktopAll;
  /** 读取全部插件自有副本；缺失或损坏的文件跳过而不是传播。 */
  private readOwns;
  /**
   * 本机每个账号的最新凭据，按 traeAccountId 去重。
   *
   * 同一账号（edition+userId 相同）桌面副本与自有副本并存时，保留 expiresAtMs
   * 更新的那份：自有副本是本插件刷新后写入的结果，按桌面优先会静默丢弃每次
   * 刷新 —— 账号会永远显示「token 过期」而有效 token 就躺在隔壁文件里。
   * 插入顺序跟随桌面列表，重新扫描不会打乱池的队列。
   */
  readAll(): Promise<TraeCredential[]>;
  /** 当前 token 距过期还超过刷新余量的账号走这里；见 readAll 的合并语义。 */
  get refreshMargin(): number;
  /** 暴露刷新函数供池复用（池自己持有 in-flight 去重）。 */
  get refresher(): TraeCredentialStoreOptions['refresh'];
}
/** Trae 凭据与区域判定的便捷组合：池和上游客户端都会用。 */
declare function traeAccountRegion(credential: TraeCredential): TraeRegion;
//#endregion
//#region src/pool.d.ts
/** 池刷新 token 所需的最小上游面（避免循环 import）。 */
interface TraeTokenRefresher {
  refresh(credential: TraeCredential): Promise<TraeRefreshOutcome>;
}
/** 池内的一个 Trae 账号：凭据 + 池簿记。 */
interface TraeAccount {
  /** 稳定池键：sha256(edition+userId) 前 24 位（与凭据存储的 traeAccountId 一致）。 */
  id: string;
  /** 人类可读短标签：账号名，缺失时 `userId 前 8 位#`。 */
  label: string;
  credential: TraeCredential;
  /** 路由桶（cn | ai），由凭据的 userRegion > host 后缀 > edition 判定。 */
  region: TraeRegion;
  /**
   * 本账号对全部模型跳过的截止时刻（epoch ms）。只由整账号冷却设置
   * （欠费 hard_credit 30 分钟等）。常规 429 是按模型的，记在
   * {@link modelCooldowns}，绝不封整账号。
   */
  cooldownUntilMs: number;
  /** 按上游模型 id → 该模型在本账号被跳过的截止时刻（epoch ms）。 */
  modelCooldowns: Record<string, number>;
  /** 连续限流命中数，诊断用。 */
  rateLimitHits: number;
  /**
   * 本账号因上游拒绝其登录（401/403）而跳过的截止时刻。
   * 被吊销的会话在凭据文件里不可见：上游不会在杀掉 refresh token 时改写
   * expiresAtMs，所以死账号看起来永远新鲜。0/undefined 表示「未知已死」。
   */
  credentialDeadUntilMs?: number;
  /** 最近一次实际派活的时刻（epoch ms），balanced 的 idle 权重来源。 */
  lastUsedAt?: number;
}
/** 池如何选择哪个账号服务下一个请求。 */
type TraeDistribution = 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry';
interface TraeAccountPoolOptions {
  /** 发现/轮换事件的日志。 */
  logger?: {
    info?(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error?(...args: unknown[]): void;
  };
  /** 测试注入：只探测这些候选路径。 */
  candidates?: readonly TraeStorageCandidate[];
  /** 测试注入：插件自有副本路径列表。 */
  ownPaths?: readonly string[];
  /** 限流账号退出轮转的时长。 */
  cooldownMs?: number;
  /** 欠费账号休息时长（默认 30 分钟）。 */
  exhaustCooldownMs?: number;
  /** 登录被拒的账号休息时长（默认 30 分钟）。 */
  credentialDeadCooldownMs?: number;
  /** 用于临近过期刷新 token 的上游客户端。 */
  client?: TraeTokenRefresher;
  /** 距实际过期多久开始刷新；默认 5 分钟。 */
  refreshMarginMs?: number;
  /** 请求如何在池内分布。 */
  distribution?: TraeDistribution;
}
/**
 * 只读的 Trae 多账号池：发现、去重、区域分桶、限流/欠费/凭据失效冷却、
 * 5 种分布、积分保留、临近过期刷新（in-flight 去重）。
 */
declare class TraeAccountPool {
  private readonly logger;
  private readonly candidatesOverride;
  private readonly ownPaths;
  private cooldownMs;
  private exhaustCooldownMs;
  private credentialDeadCooldownMs;
  private readonly client;
  private readonly refreshMarginMs;
  private accounts;
  private distribution;
  /** round-robin 游标；priority 分布下不使用。 */
  private cursor;
  /** sticky：对话键 → 账号 id。插入顺序即 LRU 顺序：重绑先删后插。 */
  private readonly affinity;
  private lastScanAtMs;
  private preferredId;
  /** 用户在卡片上关掉的账号 id（仍列出，不派活）。 */
  private disabledIds;
  /** 每账号积分保留线，键为账号 id。0（或缺失）表示「花光即可」。 */
  private creditReserves;
  /** 每账号最近一次已知的积分余额。无读数视为可用。 */
  private creditBalances;
  /** 每账号最近的积分包到期时刻（epoch ms）。缺失 = 未探测或不紧急。 */
  private creditExpiry;
  /** 每账号 refresh 的 in-flight 去重。 */
  private refreshInflight;
  private readonly store;
  constructor(options?: TraeAccountPoolOptions);
  /** 重新应用只影响发现与冷却策略的配置，不重建池。 */
  applyConfig(options: {
    cooldownMs?: number;
    exhaustCooldownMs?: number;
    distribution?: TraeDistribution;
    disabledAccountIds?: readonly string[];
    creditReserves?: Readonly<Record<string, number>>;
  }): void;
  /** 当前分布模式（卡片展示）。 */
  currentDistribution(): TraeDistribution;
  /** 钉住优先使用的账号（卡片偏好选择）。 */
  prefer(accountId: string | undefined): void;
  /**
   * 当前被钉住的账号 id；undefined 表示没有钉选、走普通轮转。
   *
   * 暴露它是因为「钉选」必须可被看见：状态文档与对话栏都要标出哪一个账号
   * 被钉住，否则用户点完「切换用户」看到的是毫无变化的界面，无从判断是否生效。
   */
  preferredAccountId(): string | undefined;
  /** 用户是否关闭了该账号。 */
  isDisabled(accountId: string): boolean;
  /** 用户关闭的全部账号 id（发现顺序）。 */
  disabledIdsInOrder(): string[];
  /** 重新扫描凭据来源并合并新发现的账号（保留既有冷却状态）。 */
  scan(): Promise<TraeAccount[]>;
  /** 全部账号（含冷却状态）；带 region 时按区域过滤（CN/国际网关不互通）。 */
  list(region?: TraeRegion): readonly TraeAccount[];
  /**
   * 当前可派活的账号。
   *
   * 带 modelId 时：账号合格 = 未整账号冷却 且 该模型未冷却 —— hy4 上的 429
   * 只挡 hy4，同账号的 hy3 继续服务。积分低于保留线的账号不派活；
   * 无读数的账号留在局内（未探测的池不能被搁浅）。
   */
  private available;
  /**
   * 现在为什么没有账号可用 —— 供准确的报错。
   *
   * 池可以为需要相反补救措施的原因变空：没登录（用户要登录）、全部限流
   * （用户等待后重试即可）、全部被关闭（用户要重新启用）、凭据被拒
   * （重新登录而非等待）。计数在该区域的账号上进行。
   */
  unavailableReason(modelId?: string, region?: TraeRegion): {
    total: number;
    cooling: number;
    disabled: number;
    /** 因上游拒绝登录而被跳过的账号数。 */
    dead: number;
    reason: 'empty' | 'cooling' | 'disabled' | 'dead' | 'reserve' | 'none';
  };
  /** round-robin：游标轮转。 */
  private pickRoundRobin;
  /** 记住对话绑定的账号，维持 LRU 顺序。 */
  private bindAffinity;
  /**
   * sticky：该对话已绑定的账号（当它仍能为被请求的模型服务时）。
   * 无绑定或绑定不再合格时返回 undefined —— 调用方随后重绑，这正是限流对话
   * 跳到新账号而不是失败的机制。
   */
  private affinityAccount;
  /** 当前记住的绑定数（测试/诊断）。 */
  affinitySize(): number;
  /** 忘掉全部对话绑定（测试与设置变更）。 */
  clearAffinity(): void;
  /**
   * balanced：对合格账号按空闲权重随机抽取。
   * 权重 = 1 + min(idleHours * 0.5, 5)。刚服务过的账号输给闲置久的账号，
   * 小池不会锤死单个账号。无空闲历史的池权重全等，首批请求被摊开。
   */
  private pickByWeight;
  /**
   * expiry：积分包最近到期的账号先服务。
   *
   * 积分包是 use-it-or-lose-it，先花将死的比摊开花严格更优。无已知到期的
   * 账号排在最后 —— 「还没看」绝不能压过真实截止时间。没有任何到期读数的池
   * 表现得与 priority 一致（诚实的退化）。
   */
  private pickByExpiry;
  /**
   * 派发一个账号。
   *
   * - priority（默认）：队首账号服务一切直到被限流，然后下一个顶上；冷却结束
   *   即回到队首（它从未被消耗）。
   * - round-robin：连续请求轮转，花费摊匀。
   * - balanced：空闲加权随机，安静的池摊开而不是抽干第一个。
   * - sticky：每对话一账号（LRU 上限 200）；新对话按轮转顺序取下一个。
   * - expiry：积分包最近到期的先花，use-it-or-lose-it。
   *
   * 每种模式下显式 prefer 的账号在其合格时绝对优先；冷却按模型粒度跳过；
   * 未识别的 distribution 回退 priority。
   *
   * region 必须过滤：CN 与国际是不同网关，不可互通。
   */
  acquire(modelId?: string, region?: TraeRegion, conversationKey?: string): Promise<TraeAccount | undefined>;
  /** 记录一个账号实际服务了请求（上游 200 后由调用方调用；balanced 权重读同一表）。 */
  noteServed(accountId: string): void;
  /**
   * 记录一个账号最近的积分余额与最近积分包到期时刻。
   *
   * 到期时间直写不合并：已花掉或已过期的包从下一次读数消失，保留陈旧截止
   * 时间会把池钉在一个积分已经没了的账号上 —— 与 expiry 模式的意图相反。
   */
  noteCredits(accountId: string, balance: number, nearestExpiryMs?: number): void;
  /** 某账号最近的积分包到期时刻；未知为 undefined。 */
  creditExpiryOf(accountId: string): number | undefined;
  /** 某账号最近已知余额；从未读过为 undefined。 */
  creditsOf(accountId: string): number | undefined;
  /** 某账号的积分保留线；未设置为 0。 */
  creditReserveOf(accountId: string): number;
  /** 整体替换全部保留线（设置页每次 apply 调用，镜像保存的文档）。 */
  setCreditReserves(reserves: Readonly<Record<string, number>>): void;
  /** 当前生效的全部保留线，键为账号 id。 */
  creditReservesInOrder(): Record<string, number>;
  /** 账号是否仅因保留线被扣住（卡片区分「保分」与其他不可用原因）。 */
  isReserved(accountId: string): boolean;
  /** 最近实际服务的账号 id（卡片回答「我现在在用哪个账号」）。 */
  lastServedId(): string | undefined;
  /** 会话失效后对单个账号的尽力刷新（卡片手动刷新按钮）。 */
  refreshAccount(accountId: string, options?: {
    force?: boolean;
  }): Promise<boolean>;
  /**
   * 因上游拒绝登录（401/403）冷却整个账号。
   * 有直接证据时调用（请求刚返回 session_dead），不用猜：没有它，同一请求的
   * 下一次重试还会选中同一账号 —— 其凭据文件仍然声称有效 —— 8 次尝试全花在
   * 一个死账号上，健康账号永远轮不上。
   */
  penalizeCredentialDead(accountId: string): void;
  /** 凭据被证明重新有效后把账号放回轮转。 */
  clearCredentialDead(accountId: string): void;
  /** 当前因登录被拒而退出轮转的账号。 */
  deadCredentials(): readonly TraeAccount[];
  /**
   * 在过期余量内（或已过期）时刷新账号的 access token，按账号 in-flight 去重。
   * 刷新失败但 token 尚未过期时保留现有 token：刷新端点不可达绝不能掀翻一个
   * 还能用的会话。刷新成功是登录仍然活着的最强证明 —— 清掉任何先前的死标记。
   */
  private ensureFresh;
  /**
   * 上游报告积分耗尽（hard_credit）后冷却整账号。
   * 欠费是账号级条件（与按模型的限流相反）：该账号的全部模型在配额重置前
   * 都不可用，因此整账号冷却（不带 modelId）30 分钟。
   */
  penalizeExhausted(accountId: string): void;
  /**
   * 标记账号（或其某模型）被限流。
   *
   * 带 modelId：只冷却该账号上的该模型 —— 上游的限流按模型计
   * （「可切换其他模型继续使用」），同账号其他模型留在轮转里。
   * 不带 modelId：冷却整账号，调用方应只对真正横跨全部模型的限制这么用。
   */
  penalize(accountId: string, resetAtMs?: number, modelId?: string): void;
  /** 清除全部冷却（整账号与按模型），如设置页的重置按钮。 */
  resetCooldowns(): void;
  /** 诊断快照。整账号冷却计数（按模型冷却不计：只限一个模型时账号整体仍可用）。 */
  status(): {
    count: number;
    cooling: number;
    dead: number;
    lastScanAtMs: number;
  };
  /** 每个候选路径为何没有得到账号（卡片诊断）。 */
  diagnose(): Promise<{
    tried: TraeStorageCandidate[];
    failures: TraeCandidateFailure[];
  }>;
}
/** 便捷组合：凭据 → 池账号 id（与 traeAccountId 一致，供外部对账）。 */
declare function traePoolAccountId(credential: TraeCredential): string;
//#endregion
//#region src/protocol.d.ts
/**
 * Trae 请求头构造。移植自 dsh-connect-trae protocol.ts，语义不变：
 * - `Authorization: Cloud-IDE-JWT <token>` 认证；
 * - identity 头（x-machine-id / x-device-id 等）来自真实持久化的身份，绝不伪造；
 * - `x-app-version-code` 必须数字化——上游把该字段绑定为 number，点分构建串
 *   会被 `4001 ... parameter type does not match binding data` 拒绝
 *   （dsh-connect-trae 2026-08-29 实测）。
 *
 * 多账号版差异：方法接收 `{ credential, identity }` 对象而不是依赖注入的
 * 单账号 getter，让上游客户端可以按池内任意账号发请求。
 *
 * @module dsh-connect-trae-models/protocol
 */
/** 多账号场景下的请求身份包：凭据 + 本机稳定身份。 */
interface TraeRequestIdentity {
  /** 必备：凭据字段（与 dsh-connect-trae 的 TraeCredential 兼容，鸭子类型）。 */
  credential: {
    accessToken: string;
    userId: string;
    edition: TraeEditionImported;
  };
  /** 必备：本机身份（machineId/deviceId 等；deviceId 是签到 x-device-id 的判定量）。 */
  identity: {
    machineId: string;
    deviceId: string;
    appVersion?: string;
    buildVersion?: string;
    deviceBrand?: string;
    deviceCpu?: string;
    osVersion?: string;
    platform: string;
  };
}
type TraeEditionImported = 'cn' | 'sg' | 'solo' | 'solo-sg';
type TraeHeaderProfile = 'model-detail' | 'chat' | 'pay';
/** 保留纯数字构建版本；无法绑定时回退。 */
declare function normalizeTraeVersionCode(buildVersion: string | undefined): string;
/**
 * 请求头全集。chat/model-detail 走完整头集；pay 家族只需认证 + 基本头
 * （dsh-connect-trae usage.ts 的 authedHeaders 形态），并把 `x-device-id`
 * 单独控制——签到 claim 必须带、其余路由可选。
 */
declare function buildTraeHeaders(request: TraeRequestIdentity, options?: {
  appId?: string;
  requestId?: string;
  profile?: TraeHeaderProfile;
  deviceId?: string;
}): Record<string, string>;
/** URL 拼接：去掉多余斜杠。 */
declare function traeEndpoint(baseUrl: string, path: string): string;
//#endregion
//#region src/upstream.d.ts
/** 上游错误分类（shim 据此决定冷却与换号策略）。 */
type TraeUpstreamErrorKind = 'authentication' | 'hard_credit' | 'soft_rate' | 'not_found' | 'server' | 'client' | 'unconfigured';
/** chat 结果：成功给出可流式转发的 Response。 */
type TraeChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: TraeUpstreamErrorKind;
  message: string;
};
/** 按 HTTP 状态分类上游错误（dsh-connect-trae solo.ts 同语义）。 */
declare function classifyTraeError(status: number): TraeUpstreamErrorKind;
/** 一个积分包的到期/额度明细（到期提醒的数据源）。 */
interface TraeCreditPack {
  /** 来源描述（如「每月登录赠送」「签到奖励」）。 */
  displayDesc: string;
  /** 包 id。 */
  entitlementId: string;
  /** 该包总额度（`quota.credits_limit`）。 */
  creditsLimit?: number;
  /** 该包已耗（`usage.credits_amount`）。 */
  consumed?: number;
  /** 到期毫秒时间戳（`entitlement_base_info.end_time`；0 = 未回报）。 */
  endTimeMs: number;
  /** 积分币种（实测 0=免费、1=通用/Work）。 */
  currency?: number;
}
/** 积分快照：总量 + 分包明细 + 到期提醒字段。 */
interface TraeCreditsSnapshot {
  total: number;
  consumed: number;
  available: number;
  packs: TraeCreditPack[];
  /** 最近的未过期包到期毫秒时间戳（没有未过期包时 undefined）。 */
  nearestExpiryMs?: number;
  /** 3 天内到期的额度合计。 */
  expiringSoon?: number;
  /** 「3 天内到期」窗口的毫秒长度（测试与展示共用）。 */
  expiringSoonWindowMs: number;
}
/** 签到状态（双口径字段语义不可合并——见 docs/RESEARCH.md §1.1）。 */
interface TraeCheckinStatus {
  /** 账号级：该账号今日奖励包已存在（无论哪台设备领取的）。 */
  checkedIn: boolean;
  /** 设备级：按请求携带的 `x-device-id` 判定，本机今日名额已用掉。 */
  didCheckedIn: boolean;
  /** 基础奖励面额（上游回报的运行时值，绝不硬编码）。 */
  credits: number;
  /** 活动开关（缺省视为开启）。 */
  enabled: boolean;
  /** 当日额外奖励面额（随活动变动）。 */
  extraCredits?: number;
}
/** 领取结果。业务拒绝以 `claimed:false` + code 返回，不抛异常。 */
interface TraeCheckinClaim {
  /** 上游接受（`code === 0`）。 */
  claimed: boolean;
  /** 业务码：0 成功；9004 缺 x-device-id；9095 设备今日已签。 */
  code: number;
  /** 上游消息（截断，不含 token）。 */
  message: string;
}
/** 一条活动规则（`ug/activity/info`）。 */
interface TraeActivityRule {
  activityId: string;
  enabled: boolean;
  activityType: number;
  startTimeMs: number;
  endTimeMs: number;
  workExtra?: Record<string, unknown>;
}
interface TraeUpstreamClientOptions {
  /** 测试/诊断用 fetch 注入。 */
  fetchImpl?: typeof fetch;
  /** 请求超时毫秒。 */
  timeoutMs?: number;
  /**
   * 首字节超时毫秒：请求发出后这么久还没拿到响应头就判失败。
   * 缺省 {@link TRAE_FIRST_BYTE_TIMEOUT_MS}。
   */
  firstByteTimeoutMs?: number;
  /** 诊断日志。 */
  log?: (message: string, detail?: unknown) => void;
  /** 显式覆盖区域（测试用）；缺省按凭据推导。 */
  region?: 'cn' | 'ai';
  /** 显式覆盖网关 base（测试用）。 */
  bases?: Partial<Record<'chat' | 'remote' | 'pay', string>>;
}
/** 解析积分快照（含到期提醒字段），纯函数便于测试。 */
declare function parseCreditsSnapshot(payload: unknown, nowMs?: number): TraeCreditsSnapshot;
/** 解析签到状态，纯函数便于测试。 */
declare function parseCheckinStatus(payload: unknown): TraeCheckinStatus;
/** 解析领取结果，纯函数便于测试。 */
declare function parseCheckinClaim(payload: unknown): TraeCheckinClaim;
/** 解析活动规则，纯函数便于测试。 */
declare function parseActivities(payload: unknown): TraeActivityRule[];
declare class TraeUpstreamClient {
  private readonly options;
  private readonly fetchImpl;
  private readonly timeoutMs;
  private readonly firstByteTimeoutMs;
  constructor(options?: TraeUpstreamClientOptions);
  private regionOf;
  private signalOf;
  /**
   * `get_detail_param` union 目录：按区域依次问每个 function，首个列出某
   * config_name 的 function 拥有它（chat 必须回放该 function）。
   * 单个 function 失败不隐藏其他 function 的名册；全空才抛错。
   */
  fetchModels(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeWireModel[]>;
  /**
   * 远端目录 `/api/remote/v1/models`：union 全部 function 分组，同 id 保留
   * 更强容量行。这是模型骨架（显示 id/窗口/倍率/multimodal）的来源。
   */
  fetchRemoteCatalog(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeDiscoveredModel[]>;
  /** 合并远端骨架与 wire 目录（照抄 mergeTraeModelSources 语义）。 */
  mergeCatalog(remote: readonly TraeDiscoveredModel[], wire: readonly TraeWireModel[]): TraeModelInfo[];
  /**
   * 发起一次 `llm_utils_chat` 流式对话。
   *
   * `bodyJson` 是已经盖好 wire 章的 Trae envelope（config_name/function 由
   * shim 侧 `stampTraeWireTarget` 按目录解析；本方法不再做默认 function 猜测）。
   * 成功后经 peek 桥接把早期拒绝转为真实错误。HTTP 失败按
   * {@link classifyTraeError} 分类。
   *
   * @param labelModel 转发给 DSH 的 SSE chunk 标签；缺省用 envelope 里的
   *   config_name。shim 传入 DSH 原本请求的显示 id——wire config_name 可能与
   *   显示 id 不同（如 Seed-Code 家族），标签必须仍是调用方点名的那一个。
   */
  chatStream(request: TraeRequestIdentity, bodyJson: string, signal?: AbortSignal, labelModel?: string): Promise<TraeChatResult>;
  /** 便捷方法：调用方已持有 prepared envelope 时直接发（跳过 prepareSoloBody）。 */
  chatPrepared(request: TraeRequestIdentity, prepared: string, signal?: AbortSignal, labelModel?: string): Promise<TraeChatResult>;
  /**
   * 发出一次 chat 请求，带**首字节（响应头阶段）超时**。
   *
   * 只覆盖「等响应头」：连接建立但上游迟迟不回响应头时，旧写法用 120 秒兜底
   * 且把超时归为可重试的 `server`，shim 会反复换号白等数分钟。这里压到首字节
   * 超时并归为 `client`（不可重试）——响应头都没有时换账号没有意义。
   *
   * 注意 body 阶段（含热门模型的分钟级排队）不在本超时范围内：拿到响应头后
   * 定时器即解除，由 solo-bridge 的排队保活/静默保护与调用方 signal 负责。
   * 调用方 signal 与首字节超时取「先到者胜出」。
   */
  private postSoloChat;
  /**
   * 积分快照（CN only；`/trae/api/v2/pay/web_user_ent_usage`）。
   * 只读操作，不消耗积分。返回总量/分包/到期提醒字段。
   */
  fetchCredits(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeCreditsSnapshot>;
  /**
   * 签到状态（CN only）。读请求带 `x-device-id`（有则带）：`did_checked_in`
   * 是设备口径，缺头会让已签设备看起来和没签设备一样。
   */
  fetchCheckinStatus(request: TraeRequestIdentity, deviceId: string, signal?: AbortSignal): Promise<TraeCheckinStatus>;
  /**
   * 领取今日签到奖励（CN only；客户端中唯一的写操作）。
   * 必须携带 `x-device-id`——上游以它判定设备名额；缺失时上游答业务码 9004。
   * 业务拒绝（9004/9095）以 `claimed:false` 返回而不是抛错。
   */
  claimCheckin(request: TraeRequestIdentity, deviceId: string, signal?: AbortSignal): Promise<TraeCheckinClaim>;
  /** 活动规则（CN only；checkin_credits/new_user_credits/send_message_reward 等）。 */
  fetchActivities(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeActivityRule[]>;
  /** pay/ug 家族的 POST（HTTP 非 200 抛错；业务码由各方法自行解析）。 */
  private payPost;
}
/**
 * 方法级的独立包装（T4/T5 契约要求，见 index.ts 的说明）。
 *
 * 每个函数都是「建一个默认客户端，调同名方法」的薄包装，语义与实例方法完全
 * 一致——存在的理由是让调用方（shim 测试、主装配）可以在模块层单独 import 与
 * 打桩，而不必先构造 TraeUpstreamClient 实例。需要注入 fetch/super 诊断/网关
 * 覆盖时请直接用 TraeUpstreamClient。
 */
declare function fetchModels(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeWireModel[]>;
/** @see TraeUpstreamClient.fetchRemoteCatalog */
declare function fetchRemoteCatalog(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeDiscoveredModel[]>;
/** @see TraeUpstreamClient.mergeCatalog */
declare function mergeCatalog(remote: readonly TraeDiscoveredModel[], wire: readonly TraeWireModel[]): TraeModelInfo[];
/** @see TraeUpstreamClient.chatStream */
declare function chatStream(request: TraeRequestIdentity, bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult>;
/** @see TraeUpstreamClient.fetchCredits */
declare function fetchCredits(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeCreditsSnapshot>;
/** @see TraeUpstreamClient.fetchCheckinStatus */
declare function fetchCheckinStatus(request: TraeRequestIdentity, deviceId: string, signal?: AbortSignal): Promise<TraeCheckinStatus>;
/** @see TraeUpstreamClient.claimCheckin */
declare function claimCheckin(request: TraeRequestIdentity, deviceId: string, signal?: AbortSignal): Promise<TraeCheckinClaim>;
/** @see TraeUpstreamClient.fetchActivities */
declare function fetchActivities(request: TraeRequestIdentity, signal?: AbortSignal): Promise<TraeActivityRule[]>;
//#endregion
//#region src/identity.d.ts
interface TraeIdentity {
  edition: TraeEdition;
  machineId: string;
  deviceId: string;
  appVersion?: string;
  buildVersion?: string;
  deviceBrand?: string;
  deviceCpu?: string;
  osVersion?: string;
  platform: NodeJS.Platform;
}
interface TraeIdentityReadOptions {
  /** 测试用平台覆盖；默认 process.platform。 */
  platform?: NodeJS.Platform;
  /** 测试用 home 覆盖；默认 homedir()。 */
  home?: string;
  /** 测试用环境覆盖；默认 process.env。 */
  env?: NodeJS.ProcessEnv;
}
/** 从 Trae 自有文件读取稳定身份，绝不伪造随机 id。 */
declare function readTraeIdentity(candidate: TraeStorageCandidate, options?: TraeIdentityReadOptions): Promise<TraeIdentity>;
/**
 * 按顺序尝试候选并返回第一个能得到有效身份的；全部失败才硬报错。
 * 与凭据存储的 skip-missing 语义一致：只有 SOLO（没有 CN 安装）的机器也能正确
 * 解析，而不是钉死第一个候选然后在文件缺失上抛错。当所有候选都不在磁盘上时，
 * 错误里列出全部尝试过的路径；存在但解析失败的候选则暴露其自身错误。
 */
declare function pickTraeStorageIdentity(candidates: readonly TraeStorageCandidate[], options?: TraeIdentityReadOptions): Promise<TraeIdentity>;
/**
 * 只有 Trae CLI（`traecli`）的机器上的确定性身份。
 *
 * CLI-only 机器没有桌面 `storage.json`，桌面身份读取器无从读取 —— 但请求头仍然
 * 需要稳定的 machine/device id。以下一切来自 CLI 自己持久化的标识符（绝非
 * 每次请求的随机值）：
 *
 *   - `argv.json` 的 `crash-reporter-id` —— CLI 首次运行写入的稳定 per-install
 *     UUID，直接用作 device id。
 *   - `builtin/ide_version.json` 的 `version` —— CLI 构建，作为 `x-app-version`
 *     发送（桌面读取器从 `product.json` 拿它）。
 *   - device id + 主机名 + 用户名的 SHA-256 作 `machineId`，与官方客户端发送的
 *     64 位十六进制形状一致。
 *
 * `crash-reporter-id` 缺失时 device id 回退到同一哈希（仍然确定性）。完全没有
 * CLI home 的机器继续响亮地失败 —— 伪造的身份比可见的「未登录」更糟。
 */
declare function readTraeCliIdentity(edition: TraeEdition, options?: TraeIdentityReadOptions): Promise<TraeIdentity>;
/**
 * 解析一个 region 的请求身份：存在任何桌面安装时用桌面 storage 身份，
 * 否则用 CLI home 的确定性身份（见 {@link readTraeCliIdentity}）。
 *
 * 这是 WSL2 / CLI-only 场景需要的接缝：`traecli` 把 token 写到
 * `~/.trae-cn/trae-jwt-token`，磁盘上没有任何 `storage.json`，仅支持桌面的
 * 解析曾让目录刷新与聊天请求全部失败，即使账号本身已找到。
 */
declare function resolveTraeIdentity(candidates: readonly TraeStorageCandidate[], edition: TraeEdition, options?: TraeIdentityReadOptions): Promise<TraeIdentity>;
/** 由真实持久化身份派生的请求头，绝非每请求新造的随机身份。 */
declare function identityHeaders(identity: TraeIdentity): Record<string, string>;
//#endregion
//#region src/shim.d.ts
/** 池与 shim 共用的最小日志面。 */
interface ShimLogger {
  info?(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** 一个已监听的回环端点。 */
interface TraePoolShim {
  ready: Promise<void>;
  baseUrl(): string;
  /** 进程内 secret（adapter 把它当 OpenAI apiKey 用）。 */
  token(): string;
  close(): Promise<void>;
}
interface TraePoolShimOptions {
  pool: TraeAccountPool;
  client: TraeUpstreamClient;
  catalog: TraeCatalog;
  logger?: ShimLogger;
  /**
   * 把本 shim 限制在一个网关上。两个 shim 并排运行 —— 每区域一个 —— 每个都
   * 只能取属于自己网关的账号。缺省 = 全部账号（单区域部署）。
   */
  region?: TraeRegion;
  /** 每请求最多尝试几个账号。 */
  maxAttempts?: number;
  /**
   * 本机稳定身份（machineId/deviceId）。`deviceId` 是签到 `x-device-id` 的
   * 判定量，所以每个上游请求都要带上它。缺省时由 {@link TraePoolShimOptions.identityOf}
   * 或调用方在请求前解析；测试可注入。
   */
  identityOf?: (account: TraeAccount) => Promise<TraeIdentity | undefined>;
}
/** 上游未给 reset 时间时的限流冷却兜底（毫秒）。 */
declare const TRAE_DEFAULT_COOLDOWN_MS = 60000;
/**
 * 从 429 响应体解析冷却截止时刻。
 *
 * 上游有时给出 `resetAt`/`reset_time`（13 位 epoch 毫秒）或本地化的
 * 「将在 2026-10-11 12:00:00」；两者都拿不到时返回 undefined，由
 * {@link TRAE_DEFAULT_COOLDOWN_MS} 兜底 —— 一个识别不出的限流窗口绝不能让
 * 账号被无限期冷却，也绝不能完全不冷却。
 */
declare function parseRateLimitReset(body: string): number | undefined;
/**
 * 请求所属对话的稳定身份，供 `sticky` 使用。
 *
 * 用**第一条 user 消息**做键：它是 body 里唯一不随历史增长而改变的部分，所以
 * 一个对话的每一轮都哈希到同一个值，而新对话（开头消息不同）哈希到别的值。
 * 哈希而非存原文，让对话内容不进入池的内存。
 *
 * 两条开头完全相同的对话会共享账号 —— 罕见且无害：只意味着它们共用同一个
 * 账号的 prompt 缓存。
 */
declare function conversationKeyOf(raw: string): string | undefined;
/**
 * 按实时目录把 OpenAI 形状请求盖成真正的 Trae wire 目标。
 *
 * `llm_utils_chat` 只接受「列出该 config_name 的那个 function」与真实
 * config_name（glm-5.3 只在 `solo_work_remote` 下服务，`solo_work_lite`
 * 答 4001；部分模型的显示 id 与 wire config_name 不同）。目录合并层
 * （catalog.mergeTraeModelSources）已经把这两半算好放在 `wireFunction` /
 * `wireConfigName` 上，但早期移植漏掉了在请求路径上消费它们——所有请求都以
 * 缺省 `solo_work_lite`、显示 id 直发上游。这里补齐这一层（与 dsh-connect-trae
 * 的 TraeSoloBridge wire 解析同义）：
 *
 * - `model` 改写为 wire config_name（仅当目录行宣告了不同值）；
 * - `function` 盖为目录归属 function（请求体已显式带 function 时尊重显式值）；
 * - `reasoning_effort` 若未被该模型目录宣告支持则删除——上游对不支持的档位
 *   会 400，而 DSH 可能带着上一个模型的档位选择切模型。
 *
 * 纯函数：解析失败或没有目录行时原样返回，绝不因目录问题拦住请求。
 */
declare function stampTraeWireTarget(raw: string, catalog: Pick<TraeCatalog, 'find'>): string;
declare function createTraePoolShim(options: TraePoolShimOptions): TraePoolShim;
/**
 * 构造 Harness 必须能识别的溢出消息。
 *
 * 这刻意**不是**自由散文。`dsh-compaction-basic` 通过把到达它的文本送进
 * `isContextWindowExceededError()`（`@deepseek-ai/dsh-llm`）来决定是否
 * 压缩并重试，而那个匹配器只接受特定措辞：
 *
 *   - `context_length_exceeded` / `context window exceeded`
 *   - `maximum context length`
 *   - `<input|prompt|request|messages> too large|long for ... context`
 *   - `<input|prompt|request> exceeds the ... context window`
 *
 * 那句友善的「对话超出该模型的上下文窗口」一个都不匹配，Trae 上游自己的
 * 「input length too long」也不匹配。发出任何一个都意味着 Harness 看到一个
 * 无法分类的 400、跳过恢复路径、并留下一轮死掉的对话 —— 这正是本函数存在的
 * 原因。
 *
 * 前导从句承载机器匹配措辞；尾随从句是人读的。两者都要与
 * `tests/context-overflow-contract.test.ts` 保持同步。
 */
declare function contextOverflowMessage(modelId: string | undefined, detail?: string): string;
//#endregion
//#region src/adapter.d.ts
/** 国内（CN）网关的 provider 路由。 */
declare const TRAE_POOL_PROVIDER = "connect-trae-models";
/** 国际网关的 provider 路由。 */
declare const TRAE_GLOBAL_POOL_PROVIDER = "connect-trae-models-global";
/** 每个区域注册的 provider id。 */
declare const POOL_PROVIDER_BY_REGION: {
  readonly cn: "connect-trae-models";
  readonly ai: "connect-trae-models-global";
};
/** 每个区域注册的显示名，让选择器能把它们分组。 */
declare const POOL_NAME_BY_REGION: {
  readonly cn: "Trae Connect Models（国内版）";
  readonly ai: "Trae Connect Models（国际版）";
};
/**
 * 单次流读取挂起期间的 provider 空闲上限。
 *
 * 取 15 分钟（而不是常见的 5 分钟）是有证据的：2026-10-13 实测热门模型
 * Seed-2.1-Pro-0915 在 SOLO 通道晚高峰排队 300+ 位，`request_wait_in_queue`
 * 位置事件持续 6~10 分钟才排到（对照模型 glm-5.2 同期 1.1 秒首字）。5 分钟
 * 会在请求即将排到前被本地误杀。排队期间 solo-bridge 持续发 SSE 注释帧让
 * 代理层/日志可见，桥接层另有 90s「上游完全静默」保护，哑连接不会被放大到
 * 15 分钟——这个值只兜底「队列确实很长但仍在消化」。
 */
declare const TRAE_STREAM_IDLE_TIMEOUT_MS = 900000;
interface TraeAdapterOptions {
  shim: TraePoolShim;
  catalog: TraeCatalog;
  /** 插件上下文；pi-ai adapter 从它取 `attachments`/`fs`。 */
  ctx: Context;
  providerId?: string;
  displayName?: string;
}
/** {@link createTraeAdapter} 交回的东西。 */
interface TraeAdapter {
  providerId: string;
  displayName: string;
  adapter: PiAiAdapter;
  /** 从当前目录重建 pi-ai 模型列表。 */
  buildModels: () => Model<Api>[];
  /** 重建 adapter 的 provider 快照；目录更新后调用。 */
  invalidate: () => void;
}
/**
 * 装配 adapter。`getModels` 重读实时目录，且每个模型的 `baseUrl` 每次读取都
 * 重新解析，使 shim 的临时端口从启动后的第一份快照起就生效。
 * 只在 `shim.ready` 之后调用。
 */
declare function createTraeAdapter(options: TraeAdapterOptions): TraeAdapter;
//#endregion
//#region src/status-paths.d.ts
/**
 * 宿主与浏览器两半共享的常量与类型（**Node-free**）。
 *
 * 卡片在浏览器包里，不能 import 任何沾 `node:*` 的模块；而路由路径与文档形状
 * 又必须两半完全一致，所以它们单独住在这里。本文件**不得**引入任何 Node 内置
 * 或宿主实现（只允许 `import type`，编译后不留运行时依赖）。
 *
 * @module dsh-connect-trae-models/status-paths
 */
/** 插件自有路由前缀。全部路由挂宿主同源 web server。 */
declare const TRAE_POOL_ROUTE_PREFIX = "/plugins/dsh-connect-trae-models";
/** 只读池状态（账号行 + 模型 + shim + 自动化）。 */
declare const TRAE_POOL_STATUS_PATH = "/plugins/dsh-connect-trae-models/status";
/** 重新扫描本机 Trae 凭据（重读桌面快照）。 */
declare const TRAE_POOL_RESCAN_PATH = "/plugins/dsh-connect-trae-models/accounts/rescan";
/** 清除全部限流冷却。 */
declare const TRAE_POOL_RESET_COOLDOWN_PATH = "/plugins/dsh-connect-trae-models/cooldowns/reset";
/**
 * 手动签到（本插件**唯一**会改上游账号状态的用户触发路由）。
 *
 * 守卫比其它路由严得多：仅 POST、仅回环 origin、且读写顺序强制「先读状态、
 * 再决定是否 claim」，见 `web-status.ts` 的 JSDoc。
 */
declare const TRAE_POOL_CHECKIN_PATH = "/plugins/dsh-connect-trae-models/checkin";
/** 保存某区域的模型选择（写 settings 分区）。 */
declare const TRAE_POOL_MODELS_SAVE_PATH = "/plugins/dsh-connect-trae-models/models/save";
/** 开关一个账号是否参与轮转。 */
declare const TRAE_POOL_ACCOUNT_TOGGLE_PATH = "/plugins/dsh-connect-trae-models/accounts/disabled";
/** 立即运行一次自动化 job（卡片「立即运行」按钮）。 */
declare const TRAE_POOL_AUTOMATION_RUN_PATH = "/plugins/dsh-connect-trae-models/automation/run";
/**
 * 区域查询参数。
 *
 * 卡片一次只问一个区域：两个网关在不同主机上，名册几乎不重叠，把两边混进一个
 * 文档会让「这个模型到底调得动吗」无法回答。
 */
type TraePoolRegion = 'cn' | 'ai';
/** 默认区域（参数缺失时）。 */
declare const TRAE_POOL_DEFAULT_REGION: TraePoolRegion;
/** 一个积分包的展示信息（到期提醒的数据源）。 */
interface TraePoolWebCreditPack {
  /** 来源描述（如「每月登录赠送」「签到奖励」）。 */
  displayDesc: string;
  /** 该包额度上限（`quota.credits_limit`）。 */
  creditsLimit?: number;
  /** 该包已耗（`usage.credits_amount`）。 */
  consumed?: number;
  /** 到期毫秒时间戳（`entitlement_base_info.end_time`；0 = 未回报）。 */
  endTimeMs: number;
}
/** 一个账号的积分总览。 */
interface TraePoolWebCredits {
  total: number;
  consumed: number;
  available: number;
  packs: readonly TraePoolWebCreditPack[];
  /** 最近的未过期包到期毫秒时间戳。 */
  nearestExpiryMs?: number;
  /** 3 天内到期的额度合计。 */
  expiringSoon?: number;
}
/**
 * 一个账号的签到状态（**双口径**，语义不可合并）。
 *
 * `checkedIn` 是账号级：该账号今天的奖励包已经存在，无论哪台设备领的。
 * `didCheckedIn` 是设备级：按请求携带的 `x-device-id` 判定，本机今天的名额
 * 已用掉——**可能是为另一个账号用掉的**。
 *
 * 把后者当成「今天签过了」是一个已发生过的缺陷：切换账号后卡片显示「今日已
 * 签到」并禁用按钮，判断结论对但理由错，掩盖了新账号其实一分未得。
 */
interface TraePoolWebCheckin {
  /** 活动开关；仅 true 时卡片才展示领取按钮。 */
  enabled: boolean;
  /** 账号级：今日奖励已到账。 */
  checkedIn: boolean;
  /** 设备级：本机今日名额已用掉。 */
  didCheckedIn: boolean;
  /** 基础奖励面额（上游运行时值，绝不硬编码）。 */
  credits: number;
  /** 当日额外奖励面额。 */
  extraCredits?: number;
}
/** 一个账号的行（不含任何 token 材料）。 */
interface TraePoolWebAccount {
  id: string;
  label: string;
  region: TraePoolRegion;
  /** 凭据过期 ISO 时间戳。 */
  expiresAt?: string;
  /** 整账号冷却中（每个模型都被挡）。 */
  cooling: boolean;
  /** 整账号冷却解除的 ISO 时间戳；仅 cooling 时给出。 */
  cooldownUntil?: string;
  /**
   * 上游**拒绝过**该账号的登录（401/403）。
   *
   * 与 `cooling` 不同：等待修不好它，只有重新登录才行——凭据文件在被吊销时
   * 不会改写过期时间，所以死账号看起来永远新鲜。
   */
  credentialDead?: boolean;
  /** 死凭据标记解除的 ISO 时间戳；仅 credentialDead 时给出。 */
  credentialDeadUntil?: string;
  /** 当前生效的按模型冷却（账号整体不算 cooling，其它模型仍可服务）。 */
  modelCooldowns?: ReadonlyArray<{
    modelId: string;
    until: string;
  }>;
  /** 用户是否关闭了该账号（关闭后不派活，但仍在列出以便重开）。 */
  disabled: boolean;
  /** 连续限流命中数。 */
  rateLimitHits: number;
  /** 用户为该账号保留的积分下限。 */
  creditReserve: number;
  /** 是否**仅**因保留线而被挡下（账号本身健康）。 */
  reserved: boolean;
  /** 本进程最近一次实际派活时刻，ISO。 */
  lastUsedAt?: string;
  /** 积分总览（只读，best-effort）。 */
  credits?: TraePoolWebCredits;
  /** 积分读取失败的原因（脱敏、截断）。 */
  creditsError?: string;
  /** 今日签到状态（只读，best-effort）。 */
  checkin?: TraePoolWebCheckin;
  /** 签到状态读取失败的原因（脱敏、截断）。 */
  checkinError?: string;
  /**
   * 本机设备名额已被占用、但**不是**该账号领到的。
   *
   * 多账号池的核心约束：同一台机器一天只能为一个账号签到，其余账号必然
   * 9095。卡片必须如实呈现「设备受限」而不是「已领取」。
   */
  deviceSpent?: boolean;
}
/** 一个模型行（交给卡片）。 */
interface TraePoolWebModel {
  id: string;
  name: string;
  /** 折后积分倍率（如 0.08 → 「x0.08」）。 */
  multiplier?: number;
  /** 该模型当前是否在选择器里启用。 */
  enabled: boolean;
  /** 生效的图片输入支持（已叠加用户 opt-in 与上游 multimodal）。 */
  supportsImages: boolean;
  /** 生效上下文窗口（已叠加用户预算）。 */
  contextWindow: number;
  /** 上游宣告的窗口，未叠加预算。 */
  nativeContextWindow: number;
  /** 上游宣告的单次输出上限。 */
  maxOutputTokens?: number;
  /** 上游宣告的推理档位。 */
  supportedEfforts?: readonly string[];
}
/** 保存的模型选择（回显给卡片做草稿 diff）。 */
interface TraePoolWebModelSelection {
  /** 缺失 = 全部启用。 */
  enabledModelIds?: readonly string[];
  /** 缺失 = 跟随上游图片能力。 */
  imageModelIds?: readonly string[];
  /** 按模型 id 的上下文预算。 */
  contextBudgets?: Readonly<Record<string, number | undefined>>;
}
/** 一次手动签到的结果。 */
interface TraePoolWebCheckinClaim {
  /** 上游接受了领取。 */
  claimed: boolean;
  /** 账号级：今日奖励本来就在（未发 claim）。 */
  alreadyCheckedIn?: boolean;
  /** 设备级：本机名额已用掉（未发 claim，或上游答 9095）。 */
  deviceCheckedIn?: boolean;
  /** 上游业务码：0 成功、9095 设备今日已签。 */
  code?: number;
  /** 上游原话（脱敏、截断）。 */
  message?: string;
  /** 领取后的最新签到状态。 */
  checkin?: TraePoolWebCheckin;
}
/** 手动运行一次自动化的结果（异步启动的回执）。 */
interface TraePoolWebAutomationRunResult {
  ok: true;
  /** 是否真的启动了（在途时第二次是 false）。 */
  started: boolean;
  job?: string;
}
/** 一个自动化 job 的最近一次运行（卡片展示用）。 */
interface TraePoolWebAutomationJob {
  /** 最近一次完成的北京日 `YYYY-MM-DD`。 */
  lastRunDate?: string;
  /** 最近一次完成时刻 epoch ms（只给日期无法区分「跑了一次」和「跑了八次」）。 */
  lastRunAtMs?: number;
  /** 今天已消费的调度时段 `YYYY-MM-DDTHH`。 */
  firedSlots?: readonly string[];
  ok: number;
  failed: number;
  /** 本次运行真正领取成功的账号数。 */
  claimed: number;
  /** 本次运行入账的积分。 */
  credit: number;
  /** 本次因设备名额受限而跳过的账号数。 */
  deviceSpent: number;
  message?: string;
  detail?: readonly string[];
}
/** 今日某账号的自动化所得。 */
interface TraePoolWebAutomationEarnings {
  credit: number;
  checkinCredit: number;
  date: string;
  deviceSpent?: boolean;
}
/**
 * 签到 job 的默认执行时刻（本地小时，Asia/Shanghai）。
 *
 * 放在这个 Node-free 共享层而不是 `scheduler.ts`，因为浏览器半端也要用它：
 * 卡片切换自动化开关时必须把小时列表一并写回，而列表为空时要回落到宿主的
 * 同一默认值，否则卡片写一份「跑不起来的日程」而宿主再也读不回来。两份手抄
 * 的常量必然漂移，且漂移是无声的。
 */
declare const DEFAULT_CHECKIN_HOURS: readonly number[];
/** 自动化街区块。 */
interface TraePoolWebAutomation {
  enabled: boolean;
  running: boolean;
  /** 签到 job 的配置小时列表（北京时区）。 */
  checkinHours: readonly number[];
  jobs: {
    checkin: TraePoolWebAutomationJob;
  };
  /** 今日各账号收益；无所得的账号不出现。 */
  earningsToday: Readonly<Record<string, TraePoolWebAutomationEarnings>>;
  /** 是否有一次运行在途（卡片轮询它决定何时停止显示进度）。 */
  runInProgress: boolean;
  lastPassAtMs?: number;
}
/** 卡片渲染的 JSON 文档。 */
interface TraePoolWebStatus {
  ok: boolean;
  region: TraePoolRegion;
  accounts: readonly TraePoolWebAccount[];
  /** 池接下来会用的账号（轮转游标）。 */
  activeAccountId?: string;
  /**
   * 用户**钉选**的优先账号；缺失表示没有钉选、走普通轮转。
   *
   * 与 `activeAccountId` 是两件事：后者是「最近实际服务的那个」，由轮转游标
   * 决定、会自己变；前者是用户的显式选择，只有他切账号时才变。两者都放进文档
   * 是为了让「切换用户」看得见结果——否则钉选生效了界面却毫无变化。
   */
  preferredAccountId?: string;
  /** 冷却中的账号数。 */
  cooling: number;
  models: readonly TraePoolWebModel[];
  /** 保存的选择，卡片据此 diff 草稿。 */
  selection: TraePoolWebModelSelection;
  /** 请求如何在池内分布。 */
  distribution: string;
  shim: {
    running: boolean;
    baseUrl?: string;
  };
  automation: TraePoolWebAutomation;
  /** 当前生效的按账号积分保留线。 */
  creditReserves: Readonly<Record<string, number>>;
  /** 该区域的模型列表来自哪里（live = 网关，fallback = 静态表）。 */
  catalogSource?: 'live' | 'fallback';
  catalogUpdatedAt?: string;
  catalogError?: string;
}
/** 账号开关路由的请求体：一次一个账号。 */
interface TraePoolWebAccountToggle {
  accountId: string;
  /** true = 关闭；false = 放回轮转。 */
  disabled: boolean;
}
/** 手动运行路由的请求体。 */
interface TraePoolWebAutomationRun {
  /** job 名；省略 = 跑完整一轮。 */
  job?: string;
  /** 绕过「今天已跑过」闸门（再按一次按钮的含义）。 */
  force?: boolean;
}
/** 签到路由的请求体：一次一个账号。 */
interface TraePoolWebCheckinRequest {
  accountId: string;
  region?: TraePoolRegion;
}
/**
 * 剥掉一层 volatile 活引用。
 *
 * 0.1.7 把一个 volatile 字段以 `{ get(): T }` 交回而不是裸值，因此每次读标记
 * 字段都要解包：把引用往下一层传会拿对象去和字符串比较，字段被当成未设置。
 * 0.1.5 上字段已是裸值，这里是恒等。
 */
declare function unwrapVolatile<T>(value: T): T;
/**
 * 深拷贝一个配置值，把里面每一个活 `{get(): T}` 引用换它解析出的值。
 *
 * {@link unwrapVolatile} 只剥普通读取需要的那一层。settings 服务不同：它要校验
 * 并 `structuredClone` **整个**对象，任何残留引用都会让校验失败。
 */
declare function unwrapVolatileDeep<T>(value: T): T;
/**
 * 解析区域查询参数。
 *
 * 返回 `undefined` 表示**非法**（调用方答 400），而不是悄悄回落：卡片 tab 与
 * 文档必须指向同一个区域，静默回落会让用户看着 ai 的标签页读 cn 的数据。缺省
 * （参数不存在）才取 {@link TRAE_POOL_DEFAULT_REGION}。
 */
declare function parseRegionParam(value: string | null | undefined): TraePoolRegion | undefined;
//#endregion
//#region src/scheduler.d.ts
/** 调度循环的唤醒间隔（毫秒）。 */
declare const AUTOMATION_TICK_MS = 60000;
/**
 * 签到判定的时区。
 *
 * 上游按**北京自然日**幂等（同一日重复 claim 仍回 code 0 但额度不变），所以
 * 「今天签没签」必须用北京日算，而不是跑 DSH 那台机器的本地日。用 `getHours()`
 * 会让「09:00」变成宿主本地 09:00 —— 在非东八区机器上就是一次永远不到点的签到。
 */
declare const AUTOMATION_TIME_ZONE = "Asia/Shanghai";
/** 日志面，保持结构化以便任意宿主 logger 适配。 */
interface SchedulerLogger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}
/** 某账号今日的设备名额占用记录（9095 与 did_checked_in 都会产生）。 */
interface AutomationAccountEarnings {
  /** 从签到拿到的积分合计（基础 + 额外）。 */
  credit: number;
  /** 其中来自签到的部分，与 `credit` 相同——保留字段名以便卡片分栏显示。 */
  checkinCredit: number;
  /** 这些计数所属的北京日（`YYYY-MM-DD`）。 */
  date: string;
  /**
   * 本机设备号今天被用掉了、但**不是**当前账号领到的（账号级与设备级是两个
   * 独立事实）。UI 必须区分「已领取」与「设备名额被占」，见 RESEARCH.md §5.1。
   */
  deviceSpent?: boolean;
}
/**
 * 持久化的当日收益账本。
 *
 * `date` 是计数所属的北京时间日：加载时早于今天的账本被丢弃，而不是当作
 * 「今天」继续累加。
 */
interface AutomationLedger {
  date: string;
  accounts: Record<string, AutomationAccountEarnings>;
}
/** 单账号在**一次运行**里的所得（runPass 的逐账号结果，也是账本的增量）。 */
interface AutomationAccountGain {
  credit: number;
  checkinCredit: number;
  deviceSpent?: boolean;
}
/** 一类 job 的最近一次运行记录（出现在状态文档上）。 */
interface AutomationJobState {
  /** 最近一次完成运行的北京日 `YYYY-MM-DD`。 */
  lastRunDate?: string;
  /**
   * 最近一次运行所在（或消费）的调度时段 `YYYY-MM-DDTHH`。
   *
   * 调度去重键是时段而不是日期：只按日期去重会把每个 job 压成一天一次，
   * 而 `checkinHours: [9, 21]` 这类多时段配置就是要在多个小时各跑一次。
   */
  lastRunSlot?: string;
  /**
   * 今天已经消费掉的调度时段集合（`YYYY-MM-DDTHH`）。
   *
   * 真正的闸门是它、而不是单个「最后一个时段」字段：job 配 `[9, 21]` 会跑两次，
   * 一个标量只能记住其中一个——第二次运行会把第一次擦掉，于是 9 点那个候选又
   * 看起来没消费过，job 从 21 点起每小时重跑。
   *
   * 值永远是**配置的小时**，绝不是运行恰好结束的时刻。存结束时刻是原始缺陷：
   * 读取方拿它去和配置候选比对，两者几乎永远不相等，闸门就整天开着。
   *
   * 与其余 `states` 一样只在内存里：这是单进程的记录，而「补跑」设计本身
   * 就要求补上 DSH 关闭期间经过的小时。**会持久化的是 `AutomationLedger`**。
   */
  firedSlots?: readonly string[];
  /**
   * 最近一次运行**开始**所在时段（`YYYY-MM-DDTHH`）。
   *
   * 与 {@link firedSlots} 分开是刻意的：这是节流（同一个时钟小时内不重复启动），
   * 而 firedSlots 是调度账本。把两者混为一谈，正是「13:00 补跑擦掉 9 点记录」
   * 那个缺陷的来源。
   */
  lastFiredHour?: string;
  /** 最近一次完成运行的 epoch ms。 */
  lastRunAtMs?: number;
  /** 未抛错完成的账号数（含跳过的）。 */
  ok: number;
  /** 抛错的账号数（逐个跳过，运行继续）。 */
  failed: number;
  /** 本次运行真正领取成功的账号数。 */
  claimed: number;
  /** 本次运行签到入账的积分合计。 */
  credit: number;
  /** 本次运行因设备名额被占而跳过的账号数。 */
  deviceSpent: number;
  /** 最近一次运行的说明文字。 */
  message?: string;
  /** 可逐条核对的明细（每账号一行）。 */
  detail?: readonly string[];
}
/** 自动化配置。 */
interface AutomationOptions {
  /** 总开关；缺省 false（绝不默认开启写操作）。 */
  enabled?: boolean;
  /** 签到 job 的 hour list（北京时区）。缺省 `[9]`。 */
  checkinHours?: readonly number[];
  /**
   * 未来可自动任务的 hour list 扩展点。
   *
   * 现在**没有任何 job 消费它**：RESEARCH.md §5.1 已证 Trae 只有签到一个可自动
   * 的写操作（其余为一次性发放 / 需真实行为 / 接口未知 / 不存在）。保留这个字段
   * 是因为一旦上游开放新的可领取端点，加一个 job 不该需要改配置 schema 与卡片。
   */
  extraJobHours?: readonly number[];
  /** 账号之间的串行间隔；测试用 0。 */
  accountDelayMs?: number;
  /** 时钟注入（测试用假时钟）。 */
  now?: () => Date;
  /** 日志；缺省静默。 */
  logger?: SchedulerLogger;
  /** 构造时恢复当日账本。 */
  loadEarnings?: () => AutomationLedger | undefined;
  /** 账本变化时的持久化钩子。 */
  saveEarnings?: (ledger: AutomationLedger) => void | Promise<void>;
}
/** 自动化快照（状态文档与卡片用）。 */
interface AutomationStatus {
  enabled: boolean;
  /** 循环是否在跑。 */
  running: boolean;
  checkinHours: readonly number[];
  jobs: {
    checkin: AutomationJobState;
  };
  /** 今日各账号收益；只有真正有所得的账号出现。 */
  earningsToday: Readonly<Record<string, AutomationAccountEarnings>>;
  /** 当前是否有一次运行在途。 */
  runInProgress: boolean;
  /** 最近一次运行的整体结果。 */
  lastPassAtMs?: number;
  /** 最近一次运行的账号级结果。 */
  lastPass?: Readonly<Record<string, AutomationAccountGain>>;
}
/** job 种类。目前只有一个，类型保留以便扩展。 */
type AutomationJobKind = 'checkin';
/** 全部 job 种类（运行顺序即此顺序）。 */
declare const AUTOMATION_JOB_KINDS: readonly AutomationJobKind[];
/**
 * `date` 所属的自然日，`YYYY-MM-DD`（默认北京时区）。
 *
 * 上游按北京自然日判幂等，账本的日界必须与它一致；跨日重置也靠这个键。
 */
declare function dayKey(date: Date, timeZone?: string): string;
/**
 * `date` 所在的调度时段，`YYYY-MM-DDTHH`。
 *
 * 逐 job 的运行闸门以它为键，因此配了多个小时的 job 在每个小时各跑一次，而
 * 同一个小时内的第二次 tick 仍被拒。
 */
declare function slotKey(date: Date, timeZone?: string): string;
/** `now` 所在小时是否属于 `hours`。 */
declare function isFireHour(now: Date, hours: readonly number[], timeZone?: string): boolean;
/**
 * 积分自动化调度器。
 *
 * 循环每分钟醒一次，某 job 的某个配置小时**已经过去且该时段尚未消费**时触发。
 * 「已消费」按 job 记为 `YYYY-MM-DDTHH` 集合，跨日自动作废。
 *
 * 一切串行且失败隔离：一个账号抛错只跳过该账号并继续下一个，一次 job 抛错绝不
 * 停止循环。ai 区域账号整类跳过 —— 国际版没有 `/ug/*` 端点族（实测 404）。
 */
declare class TraeScheduler {
  private enabled;
  private checkinHours;
  private extraJobHours;
  private readonly delayMs;
  private readonly now;
  private readonly logger;
  private readonly pool;
  private readonly client;
  /** 逐 job 的运行记录。 */
  private readonly states;
  /** 今日各账号收益。 */
  private earnings;
  /** 当前 earnings 所属的北京日。 */
  private earningsDate;
  /** 最近一次运行的整体结果（状态文档用）。 */
  private lastPass;
  private lastPassAtMs;
  private timer;
  private running;
  private stopped;
  /** 一次运行在途（tick 与手动触发共用一个闸门）。 */
  private busy;
  /** 整轮在途（startRunAll 的返回依据）。 */
  private runInFlight;
  private saveEarningsFn;
  /**
   * @param pool 多账号池（T2）。签约只遍历 `pool.list('cn')`。
   * @param client 上游客户端（T3）。
   * @param options 配置；`enabled` 缺省 false。
   */
  constructor(pool: TraeAccountPool, client: TraeUpstreamClient, options?: AutomationOptions);
  /** 安装持久化钩子（宿主 settings 服务就绪后调用）。 */
  setEarningsPersistence(save: (ledger: AutomationLedger) => void | Promise<void>): void;
  /**
   * 折入一份此前持久化的账本（当它属于今天时）。
   *
   * 设置文档可读发生在构造之后，所以要有这个后置入口；更早日期的账本被忽略，
   * 计数因此永远不会把昨天说成今天。
   */
  applyEarningsLedger(ledger: AutomationLedger): void;
  /** 应用新配置；运行中调用是安全的。 */
  applyConfig(options: AutomationOptions): void;
  /** 启动循环。幂等。 */
  start(): void;
  /** 停止循环。幂等，且可在 `start` 之前调用。 */
  stop(): void;
  /** 状态快照。 */
  status(): AutomationStatus;
  /** 手动触发（卡片按钮）：后台推进整轮并立刻返回是否启动。 */
  startRunAll(job?: AutomationJobKind, force?: boolean): boolean;
  /**
   * 运行一轮（可指定单个 job）。
   *
   * `force` 绕过「今天已跑过」闸门，也就是「再按一次按钮」的含义。手动运行
   * **不消费调度时段**：10:35 按一次「立即运行」绝不能取消 21:00 那个时段。
   */
  runAll(job?: AutomationJobKind, force?: boolean): Promise<Record<string, AutomationAccountGain>>;
  /**
   * 运行单个 job 的全部账号。
   *
   * 串行遍历，账号级 try/catch 隔离：一个账号的 token 失效、429 或畸形载荷
   * 绝不能花掉其他账号当天的签到。
   */
  runJob(kind: AutomationJobKind, force?: boolean): Promise<Record<string, AutomationAccountGain>>;
  /**
   * 参与自动化的账号：CN 区域、未禁用。
   *
   * **不跳过冷却账号**（与 workbuddy scheduler 的刻意差异）：Trae 的账户级冷却
   * 是对话路由的闸门（429 限流 / 欠费 30 分钟），签到走独立的 pay/ug 端点，
   * 不该被对话侧限流连坐——跳过它只会让当天还能签到的账号白错过。
   */
  private eligibleAccounts;
  /** 单账号签到：status → enable/checked_in/did_checked_in 判定 → claim → 读回刷新。 */
  private runCheckin;
  /** 本机身份（缓存）。 */
  private identity;
  /** 注入本机身份（池扫描或宿主启动时解析一次）。 */
  setIdentity(identity: TraeIdentity): void;
  /** 当前注入的身份（诊断用；永不回显 token 材料）。 */
  currentIdentity(): {
    deviceId: string;
    machineId: string;
  };
  /**
   * 本次请求携带的本机身份。
   *
   * 未注入身份时给一个最小占位：签到路由只需要 `x-device-id` 的值判定设备口径，
   * 缺身份时 {@link deviceId} 返回空串、claim 会被跳过，因此这里不需要伪造任何
   * 真实身份字段（RESEARCH.md §1.2 明确排除设备号伪造）。
   */
  private requestIdentity;
  /** 本机设备号；读不到时是空串（`x-device-id` 的判定量）。 */
  private deviceId;
  /** 一行总结。 */
  private summarise;
  /** 某个 job 今天已消费的时段集合。 */
  private firedSlotsOf;
  /** 记录一个已消费的调度时段。 */
  private consumeSlot;
  /**
   * 此刻该 job 的到期时段，没有则 undefined。
   *
   * **最早**的未消费候选胜出，这样多时段配置才完整：消费掉最早的那个，把更晚
   * 的留给它自己的小时。
   */
  private dueSlot;
  /** 一个 job 配置的小时。 */
  private hoursOf;
  /**
   * 循环体：到点就跑。
   *
   * 状态筛选（enabled / stopped / busy）与异常隔离都在这里，保证循环本身绝不
   * 被一次失败拖死。
   */
  private tick;
  /** 今日各账号收益（先跨日重置，避免午夜后读到昨天的合计）。 */
  private earningsSnapshot;
  /** 把一次所得累加进当日账本；0 所得且无设备占用的记录不落账。 */
  private recordEarnings;
  /** 北京日翻转时清空逐账号计数。 */
  private rollEarnings;
  /** 账本快照落盘（无钩子时静默）。 */
  private persistEarnings;
  /** 暴露给状态文档的时段闸门（测试与诊断用）。 */
  firedSlots(kind: AutomationJobKind): readonly string[];
  /** 当前配置的扩展 job 时段（暂无 job 消费，见 AutomationOptions.extraJobHours）。 */
  extensionHours(): readonly number[];
  /** 单次 tick 的显式入口（测试用；生产由定时器驱动）。 */
  runDueNow(): Promise<void>;
}
//#endregion
//#region src/solo-bridge.d.ts
/** Trae 在 200 SSE body 里报告的一次上游失败。 */
interface TraeFailure {
  code?: number;
  message: string;
  extra?: unknown;
}
/**
 * 排队/处理中事件 → SSE 注释帧（`: …\n\n`）。
 *
 * Trae 的热门模型（实测 Seed-2.1-Pro-0915 晚高峰 SOLO 通道排队 300+ 位、等待
 * 数分钟）在 HTTP 200 之后只持续发 `request_wait_in_queue` / `progress_notice`，
 * 正文一个字都没有。OpenAI SSE 消费方按规范忽略以 `:` 开头的注释行，所以这些
 * 帧不改变消息内容，但完成两件事：
 * * 让排队位置在网络上可见（抓包/日志可诊断，而不是看起来连接死掉）；
 * * 持续刷新下游的「流空闲超时」——pi-ai adapter 的 300s idle timeout 按字节
 *   活动计时，没有这些帧，排队超过 300s 的请求会被本地误杀（2026-10-13 实测
 *   该模型排队 6 分钟仍未排到，这正是「长时间没有响应」的直接机理）。
 */
declare const TRAE_QUEUE_COMMENT = "trae-queue";
declare const TRAE_PROGRESS_COMMENT = "trae-processing";
declare const TRAE_HEARTBEAT_COMMENT = "trae-heartbeat";
/** 上游静默时的兜底保活间隔，必须显著小于下游 300s 流空闲超时。 */
declare const TRAE_KEEPALIVE_INTERVAL_MS = 20000;
/**
 * 上游完全静默（连排队位置都不发）多久判为哑连接。
 * 健康排队期 `request_wait_in_queue` 约每 1~3 秒一帧；90 秒无任何字节说明
 * 连接已事实死亡，用可读错误中止，而不是把等待放大到外层空闲超时。
 */
declare const TRAE_UPSTREAM_SILENCE_MS = 90000;
/** 流内失败的可读消息（保留原始码）。 */
declare function describeTraeFailure(failure: TraeFailure): string;
/** Trae 命名 SSE 事件流 → OpenAI chat-completion SSE 流（原语，恒答 200）。 */
declare function bridgeTraeSoloStream(response: Response, model: string): Response;
/**
 * 桥接一个上游应答，把早期拒绝变成真实错误结果。
 * {@link bridgeTraeSoloStream} 是同步原语（恒 200）；这是桥接类实际使用的策略。
 */
declare function bridgeTraeSoloStreamOrFail(response: Response, model: string): Promise<TraeChatResult>;
//#endregion
//#region src/solo.d.ts
/** `llm_utils_chat` 的缺省 function（无目录信息时的兜底）。 */
declare const TRAE_SOLO_FUNCTION = "solo_work_lite";
/**
 * 各区域依次 union 的目录 function（按优先序）。
 *
 * Trae 把可调用名册拆在多个 SOLO function 上，模型只能通过列出它的那个
 * function 调用（glm-5.3 只在 `solo_work_remote` 下可用，`solo_work_lite`
 * 答 `4001 param is invalid`——dsh-connect-trae 2026-09-15 实测）。目录把
 * 它们 union；首个列出某 config_name 的 function 拥有它，chat 调用回放该 function。
 *
 * `solo_agent` 故意缺席：它是 Remote-agent 名册 function，不是 chat function
 * （实测同一模型用它必答流内 `event:error {"code":4011}`）。`chat_v3` 名册最宽，
 * 排最后只补空隙，不扰动先到 function 的归属。CN 额外接 `solo_coder`
 * （2026-10-02 逐模型验证可调）。任何 chat function 都没列出的模型交给合并层
 * 保留（无 wire 目标时调用给可读报错而不是隐藏）。
 */
declare const TRAE_DIRECTORY_FUNCTIONS: Readonly<Record<'cn' | 'ai', readonly string[]>>;
/** chat 端点路径。 */
declare const TRAE_SOLO_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
/** 目录端点路径（`get_detail_param`）。 */
declare const TRAE_SOLO_MODELS_PATH = "/api/ide/v1/get_detail_param";
/**
 * 从 `get_detail_param` 行读折后积分倍率。
 *
 * Trae IDE 渲染的倍率在 `display_contact_config`——一个**字符串**里嵌的又一份
 * JSON——其 `consumption_rate.data.rate` 已是折后价（dsh-connect-trae 2026-09-13
 * 实测：Remote 目录报未折扣值 0.8，IDE 与该字段报 0.08，限时 1 折活动下最多差
 * 10 倍）。合并时该值优先于 Remote 目录的 `consumption_rate`。
 * ai 网关到处都没有 `consumption_rate`，没有该字段的行保持裸值——解析过但缺失，
 * 绝不虚构。
 */
declare function wireCreditMultiplier(config: Record<string, unknown>): number | undefined;
/**
 * 把 OpenAI 形状的请求改写为 `llm_utils_chat` 的证据化 envelope。
 * 该端点不是 OpenAI 兼容端点：显式构造 envelope，让 Pi/OpenAI 的可选字段
 * （temperature、max_tokens、tool_choice、response_format 等）不会让每个模型
 * 都撞上参数校验失败。
 *
 * 规则（照抄 dsh-connect-trae，全部实测）：
 * - `config_name` = model；`function` 优先用请求里已盖章的（目录解析产物），
 *   缺省用 functionName，再缺省 `solo_work_lite`；`stream` 恒 true；
 * - `developer` 角色 → `system`（上游只认 system/assistant/user/tool/function）；
 * - content 字符串 → `[{type:'text', text}]`；工具参数 JSON.stringify；
 * - assistant 的 `tool_calls[].function` → `function_call`；tool 消息必须有
 *   `tool_call_id`；`reasoning_effort` 字符串透传。
 */
declare function prepareSoloBody(source: string, defaultModel?: string, functionName?: string): string;
/** 把一个 function 返回的 config_info_list 合并进共享目录（首个命中者拥有该 id）。 */
declare function collectWireModels(list: readonly unknown[], directoryFunction: string, byId: Map<string, TraeWireModel>): void;
//#endregion
//#region src/sse.d.ts
/**
 * 增量 SSE 解码器 + Trae 命名事件解码。移植自 dsh-connect-trae sse.ts。
 * 支持 CRLF、chunk 拆行、多行 data。
 *
 * @module dsh-connect-trae-models/sse
 */
interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}
/** 增量 SSE 解码器，支持 CRLF、chunk 拆分与多行 data。 */
declare class SseDecoder {
  private buffer;
  private event;
  private id;
  private retry;
  private data;
  push(chunk: string): SseEvent[];
  finish(): SseEvent[];
  private consumeLine;
  private dispatch;
}
type TraeStreamEvent = {
  type: 'queue';
  position?: number;
} | {
  type: 'progress';
  notice: unknown;
} | {
  type: 'delta';
  text: string;
  reasoning?: string;
  toolCalls?: unknown;
} | {
  type: 'usage';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  /**
   * Trae 的提示缓存记账（`token_usage` 事件上的 `cache_read_input_tokens` /
   * `cache_creation_input_tokens`）。dsh-connect-trae 2026-09-22 实测：一条
   * 逐字节相同的 9224 token 提示报 `prompt_tokens: 9224` 而
   * `cache_read_input_tokens` 涨到 9216——它们是 `prompt_tokens` 的**子集**，
   * 是 OpenAI 约定而非 Anthropic 的独占口径，转发为 `cached_tokens` 在算术上
   * 是正确的。
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} | {
  type: 'done';
  finishReason: string;
} | {
  type: 'unknown';
  event?: string;
  data: unknown;
};
/** 把一个原始 SSE 事件解码为 Trae 流事件。 */
declare function decodeTraeEvent(event: SseEvent): TraeStreamEvent;
//#endregion
//#region src/decrypt.d.ts
/**
 * Trae 存储鉴权值的解密与 CLI JWT 解析（移植自 dsh-connect-trae/src/decrypt.ts，语义逐字段保持）。
 *
 * - `storage.json` 的 `iCubeAuthInfo://icube.cloudide` 值是 AES-128-CBC 加密的，
 *   带 102 字节的头部/派生层与 SHA-512 完整性校验。
 * - CLI 的 `trae-jwt-token` 是裸 JWT，无 AES 层，直接解析 claims。
 *
 * @module dsh-connect-trae-models/decrypt
 */
declare const TRAE_AUTH_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
/** 解密 storage.json 里的鉴权值：头 6 字节判型，SHA-512 双轮派生密钥，尾 64 字节为完整性校验。 */
declare function decryptTraeStorageValue(encoded: string): string;
/** 解析鉴权值：明文 JSON 直接用，密文先解密。 */
declare function parseTraeAuthValue(value: string): unknown;
/** 读取 storage.json 文档并解出鉴权对象。 */
declare function parseTraeStorageDocument(text: string): unknown;
/**
 * CLI `trae-jwt-token` 文件解出的一组 claims。
 *
 * CLI 写入的是裸的、未加密的 JWT —— 没有 `iCubeAuthInfo` 包装也没有 AES 层，
 * 所以刻意绕过 `parseTraeAuthValue`。只读取凭据存储需要的 claims；签名不校验，
 * 因为 token 只在本地消费，且每次请求都会被上游服务重新验证。
 */
interface TraeCliTokenClaims {
  /** 直接用作 `Cloud-IDE-JWT` bearer 的 token。 */
  accessToken: string;
  /** `data.user_id`；与同一账号桌面版的 `userId` 一致。 */
  userId: string;
  /** `exp` 对应的 epoch 毫秒，缺失或不可解析时为 undefined。 */
  expiresAtMs?: number;
}
/**
 * 解析 CLI token 文件。接受裸 JWT 本身，或包含它的 JSON 信封（磁盘形状只在
 * macOS 上验证过，未来 CLI 版本可能加包装）。
 */
declare function parseTraeCliToken(text: string): TraeCliTokenClaims;
//#endregion
//#region src/refresh.d.ts
/** DeviceInfo body 用的稳定设备身份，来自应用自己的 storage。 */
interface TraeRefreshDevice {
  deviceId: string;
  machineId: string;
}
/**
 * 用 refresh token 换新 access token，遵循调用 edition 的已验证契约。
 * `device` 只被官方客户端发送 DeviceInfo body 的 edition 使用；无法解析时
 * 省略该字段而不是发送空值。
 */
declare function refreshTraeCredential(credential: TraeCredential, signal?: AbortSignal, device?: TraeRefreshDevice): Promise<TraeRefreshOutcome>;
//#endregion
//#region src/context-budget.d.ts
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
interface ChatMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}
/** Estimate tokens for a plain string, accounting for CJK density. */
declare function estimateTextTokens(text: string): number;
/** Estimate the prompt cost of a whole message array. */
declare function estimateMessagesTokens(messages: readonly ChatMessage[]): number;
interface CompactOptions {
  /**
   * prompt 的 token 预算。为模型自身输出预留的部分已由调用方扣除，
   * 所以这就是 prompt 的上限。
   */
  budget: number;
  /** Keep at least this many trailing non-pinned messages verbatim. */
  keepRecent?: number;
}
interface CompactResult {
  /** The compacted message array. */
  messages: ChatMessage[];
  /** Messages removed (oldest first) — the summarisation input. */
  dropped: ChatMessage[];
  /** Estimated tokens after compaction. */
  tokens: number;
  /** Whether anything was actually removed. */
  changed: boolean;
}
/**
 * 丢弃最老的非钉住消息，直到估算值放得进 `budget`。
 *
 * 钉住（system/developer）的消息与最新 `keepRecent` 条消息被保留
 * —— 这里绝不动它们；若仅它们就超预算，调用方必须回退到总结或放弃。
 */
declare function compactMessages(messages: readonly ChatMessage[], options: CompactOptions): CompactResult;
/**
 * 最后手段：丢弃最老的消息，**包括**钉住的那些。
 *
 * 用在连摘要都无法把 prompt 压进预算时（例如粘贴了一整个巨大文档）。
 * 最新的一条消息永远保留。
 */
declare function hardTruncate(messages: readonly ChatMessage[], budget: number): CompactResult;
interface SummarizeDeps {
  /**
   * 发一次非流式补全。必须解析出助手文本，或 reject，
   * 好让调用方回退到纯截断。
   */
  complete(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}
interface SummarizeResult {
  messages: ChatMessage[];
  summary?: string;
  /** Why summarisation was skipped, when it was. */
  skipped?: string;
  tokens: number;
}
/**
 * 把 `messages` 压缩到 `budget`，尽可能总结被丢弃的轮次。
 *
 * 请求摘要时使用**有界**的转录文本，使压缩调用自身永远不会超窗：若被丢弃的
 * 轮次极大，只总结其中最新的一片，最老的那些标注为已省略。
 */
declare function compactWithSummary(messages: readonly ChatMessage[], options: CompactOptions, deps: SummarizeDeps, signal?: AbortSignal): Promise<SummarizeResult>;
//#endregion
//#region src/web-status.d.ts
/** 上游对「本设备今日已签到」的业务码。 */
declare const CHECKIN_DEVICE_ALREADY_CLAIMED = 9095;
/**
 * 「3 天内到期」提醒窗口。
 *
 * 与 `upstream.ts` 的 `TRAE_EXPIRING_SOON_WINDOW_MS` 同值；这里重新声明是为了
 * 让本模块的类型面自洽（值语义必须一致，测试钉住）。
 */
declare const EXPIRING_SOON_WINDOW_MS: number;
/** 构造依赖——池运行时的一个窄切片。 */
interface TraePoolStatusRouteOptions {
  pool: TraeAccountPool;
  /** 每个区域一个目录；卡片读当前 tab 对应的那个。 */
  catalogs: Readonly<Record<TraePoolRegion, TraeCatalog>>;
  client: TraeUpstreamClient;
  /** 惰性解析正在运行的 shim（尚未绑端口时 running=false）。 */
  shim?: (region: TraePoolRegion) => {
    running: boolean;
    baseUrl?: string;
  };
  /**
   * 签到自动化的状态读取器。
   *
   * 可选：无调度器的 profile（测试、CLI）也要能挂这些路由，卡片会把自动化显示
   * 为关闭，而不是显示一个坏掉的面板。
   */
  scheduler?: () => AutomationStatus;
  /**
   * 启动一次手动运行，返回「是否真的启动」而不是结果。
   *
   * 一整轮要几十秒（每账号一次上游往返），所以它在后台跑，卡片轮询状态看进度。
   */
  runAutomation?: (job: string | undefined, force: boolean) => boolean;
  /**
   * 当前配置文档（已解包 volatile）。
   *
   * 卡片要回显保存过的选择与保留线，而这些都住在 settings 里。以 thunk 而不是
   * 快照给出，文档才能反映此刻的值（包括 CLI 刚改过的）。
   */
  config?: () => Record<string, unknown>;
  /**
   * 持久化某区域的模型选择。
   *
   * 由宿主提供（settings 分区归它所有）；缺省时保存路由答 503 而不是假装成功。
   */
  saveSelection?: (region: TraePoolRegion, selection: TraePoolWebModelSelection) => Promise<void> | void;
  /**
   * 持久化某账号的开关。
   *
   * 宿主负责读改写整个 `disabledAccountIds` 列表——路由层不该知道 settings 的
   * 存储细节，否则它会变成第二个所有者。
   */
  setAccountDisabled?: (accountId: string, disabled: boolean) => Promise<void> | void;
  /** 重扫本机凭据。 */
  rescan?: () => Promise<void> | void;
  /** 清除全部冷却。 */
  resetCooldowns?: () => Promise<void> | void;
  /** 本机设备号（签到的设备口径判定量）；读不到时返回空串。 */
  deviceId?: () => string;
  /** 诊断日志。 */
  logger?: {
    warn?(...args: unknown[]): void;
    info?(...args: unknown[]): void;
  };
}
/** 把 token 类内容抹掉再送回浏览器。 */
declare function safeMessage(error: unknown): string;
/**
 * 组装卡片状态文档。
 *
 * 逐账号组账：`credits` 与 `checkin` 都是异步 best-effort —— 一个账号积分读失败
 * 只降级成该行的 `creditsError`，绝不让整份文档 500。这个取舍是刻意的：卡片最
 * 需要的「谁在冷却、谁被关掉、模型倍率多少」都来自本地簿记，不能因为一个账号的
 * 上游调用超时而一起消失。
 */
declare function buildTraePoolWebStatus(deps: TraePoolStatusRouteOptions, region: TraePoolRegion, options?: {
  probe?: boolean;
}): Promise<TraePoolWebStatus>;
/** 校验模型选择载荷；任何畸形都返回 undefined 让路由答 400，而不是写半个选择。 */
declare function parseSelection(body: Record<string, unknown>): TraePoolWebModelSelection | undefined;
/**
 * 在 `webServer` 可用的 context 上挂载路由。
 *
 * 调用方用 `ctx.inject(['webServer'], ...)`，让桌面端启动顺序无法让这次注册
 * 凭空消失。
 */
declare function registerTraePoolStatusRoute(ctx: Context, deps: TraePoolStatusRouteOptions): void;
/** 供宿主组装的便捷导出：解包 volatile 后的配置读取器工厂。 */
declare function configReader(read: () => unknown): () => Record<string, unknown>;
//#endregion
//#region src/index.d.ts
/** settings 分区命名空间（卡片与两个 provider 共用）。 */
declare const TRAE_POOL_SETTINGS_NS = "connect-trae-models";
/** 依赖注入：LLM seam（注册 provider/adapter）与 settings（挂卡片）。 */
declare const inject: string[];
/**
 * 插件配置 schema。字段形状与卡片保存的文档一一对应。
 *
 * 显式标注为 `z<TraePoolConfig>`：不标注时 tsdown 的 dts 生成器会因推导出的
 * 类型引用了 peer 依赖内部的 cosmokit 路径而报 TS2742（"cannot be named without
 * a reference to ... cosmokit"）—— 类型不可移植，声明文件生成失败，整个 build
 * 挂掉。显式标注让导出的类型只指向本文件自己的接口。
 */
declare const Config: z<TraePoolConfig>;
/**
 * 插件配置值的静态类型。
 *
 * 手写而不是从 schema 推导：schemastery 的默认导出在类型位置只是一个类型，
 * 没有可用的 infer 命名空间；而手写这个接口正好让「schema 与类型同步」成为
 * 一件需要显式核对的事，而不是被推导悄悄掩盖。
 */
interface TraePoolConfig {
  authFile?: string;
  cooldownMs?: number;
  distribution?: 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry';
  disabledAccountIds?: string[];
  creditReserves?: Record<string, number>;
  enabledModelIds?: string[];
  imageModelIds?: string[];
  contextBudgets?: Record<string, number>;
  modelSelectionCn?: ModelSelectionConfig;
  modelSelectionGlobal?: ModelSelectionConfig;
  automation?: AutomationConfig;
  automationEarnings?: AutomationLedger;
}
/**
 * 一个区域保存下来的模型选择。
 *
 * 刻意在本地声明而不是复用 catalog 的 `ModelSelection`：schemastery 推导出的
 * 形状用的是可变数组，而那个接口用 `readonly` 数组，两者在 `z<Config>` 标注下
 * 不兼容。形状保持一致即可，语义在同一处测试里对齐。
 */
interface ModelSelectionConfig {
  enabledModelIds?: string[];
  imageModelIds?: string[];
  contextBudgets?: Record<string, number>;
}
/**
 * 每日积分自动化配置。
 *
 * 同样是本地声明（理由见上）；字段名与调度器的 {@link AutomationOptions} 一一
 * 对应，装配时直接透传。
 */
interface AutomationConfig {
  enabled?: boolean;
  checkinHours?: number[];
  extraJobHours?: number[];
}
/** 卡片与 CLI 读到的实时快照。 */
interface TraePoolApi {
  pool: TraeAccountPool;
  /** 每区域一个目录，与注册的两个 provider 对应。 */
  catalogs: Readonly<Record<TraeRegion, TraeCatalog>>;
  client: TraeUpstreamClient;
  /** 每区域一个 shim。 */
  shims: Readonly<Record<TraeRegion, TraePoolShim>>;
  adapter: TraeAdapter | undefined;
  /** 签到自动化；与 core 一同装配，`start()` 前保持惰性。 */
  scheduler: TraeScheduler;
}
/** 实时 API；插件尚未 apply 时为 undefined。 */
declare function currentApi(): TraePoolApi | undefined;
/** 测试缝：不启动 cordis 也能装入一个 API 实例。 */
declare function setApi(next: TraePoolApi | undefined): void;
/**
 * 不注册任何东西地装配运行时对象。
 *
 * 每区域一个目录、一个 shim：CN 与国际网关的名册不同，共享目录会让选择器显示
 * 「碰巧先抓到的那份」列表。
 */
declare function createCore(logger?: {
  warn(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}): {
  client: TraeUpstreamClient;
  pool: TraeAccountPool;
  catalogs: {
    readonly cn: TraeCatalog;
    readonly ai: TraeCatalog;
  };
  scheduler: TraeScheduler;
};
/**
 * 装配并注册。
 *
 * 时序：装配 core → 注册两个 provider/adapter → 挂 settings 卡片 → 应用一次已
 * 保存的配置 → 后台播种目录 → 注入身份 → 起调度器。任何一步失败都只影响它
 * 自己，绝不阻断其余部分：模型路由必须在离线上游下也能立起来。
 */
declare function apply(ctx: Context, config?: TraePoolConfig): void;
declare const name = "llm-connect-trae-models";
//#endregion
export { AUTOMATION_JOB_KINDS, AUTOMATION_TICK_MS, AUTOMATION_TIME_ZONE, type AutomationAccountEarnings, type AutomationAccountGain, AutomationConfig, type AutomationJobKind, type AutomationJobState, type AutomationLedger, type AutomationOptions, type AutomationStatus, CHECKIN_DEVICE_ALREADY_CLAIMED, type ChatMessage, type CompactOptions, type CompactResult, Config, DEFAULT_CHECKIN_HOURS, EXPIRING_SOON_WINDOW_MS, FALLBACK_TRAE_MODELS, FALLBACK_TRAE_MODELS_AI, type ModelSelection, ModelSelectionConfig, POOL_NAME_BY_REGION, POOL_PROVIDER_BY_REGION, REGION_GATEWAYS, type SchedulerLogger, type ShimLogger, SseDecoder, TRAE_AUTH_FILENAME, TRAE_AUTH_STORAGE_KEY, TRAE_CLI_TOKEN_FILENAME, TRAE_DEFAULT_CONTEXT_WINDOW, TRAE_DEFAULT_COOLDOWN_MS, TRAE_DIRECTORY_FUNCTIONS, TRAE_GLOBAL_POOL_PROVIDER, TRAE_HEARTBEAT_COMMENT, TRAE_KEEPALIVE_INTERVAL_MS, TRAE_POOL_ACCOUNT_TOGGLE_PATH, TRAE_POOL_AUTOMATION_RUN_PATH, TRAE_POOL_CHECKIN_PATH, TRAE_POOL_DEFAULT_REGION, TRAE_POOL_MODELS_SAVE_PATH, TRAE_POOL_PROVIDER, TRAE_POOL_RESCAN_PATH, TRAE_POOL_RESET_COOLDOWN_PATH, TRAE_POOL_ROUTE_PREFIX, TRAE_POOL_SETTINGS_NS, TRAE_POOL_STATUS_PATH, TRAE_PROGRESS_COMMENT, TRAE_QUEUE_COMMENT, TRAE_REASONING_EFFORTS, TRAE_SOLO_CHAT_PATH, TRAE_SOLO_FUNCTION, TRAE_SOLO_MODELS_PATH, TRAE_STREAM_IDLE_TIMEOUT_MS, TRAE_UPSTREAM_SILENCE_MS, type TraeAccount, TraeAccountPool, type TraeAccountPoolOptions, type TraeActivityRule, type TraeAdapter, type TraeAdapterOptions, type TraeCandidateFailure, TraeCatalog, type TraeChatResult, type TraeCheckinClaim, type TraeCheckinStatus, type TraeCliTokenClaims, type TraeContextBudget, type TraeCredential, type TraeCredentialSource, TraeCredentialStore, type TraeCredentialStoreOptions, type TraeCreditPack, type TraeCreditsSnapshot, type TraeDistribution, type TraeEdition, type TraeIdentity, type TraeIdentityReadOptions, type TraeInputModality, type TraeModelInfo, TraePoolApi, TraePoolConfig, type TraePoolRegion, type TraePoolShim, type TraePoolShimOptions, type TraePoolStatusRouteOptions, type TraePoolWebAccount, type TraePoolWebAccountToggle, type TraePoolWebAutomation, type TraePoolWebAutomationEarnings, type TraePoolWebAutomationJob, type TraePoolWebAutomationRun, type TraePoolWebAutomationRunResult, type TraePoolWebCheckin, type TraePoolWebCheckinClaim, type TraePoolWebCheckinRequest, type TraePoolWebCreditPack, type TraePoolWebCredits, type TraePoolWebModel, type TraePoolWebModelSelection, type TraePoolWebStatus, type TraeRefreshDevice, type TraeRefreshOutcome, TraeScheduler, type TraeStorageCandidate, type TraeTokenRefresher, TraeUpstreamClient, type TraeUpstreamClientOptions, type TraeUpstreamErrorKind, type TraeWireModel, apply, applyModelBudget, bridgeTraeSoloStream, bridgeTraeSoloStreamOrFail, buildTraeHeaders, buildTraePoolWebStatus, chatStream, claimCheckin, classifyTraeError, collectWireModels, compactMessages, compactWithSummary, configReader, contextOverflowMessage, conversationKeyOf, createCore, createTraeAdapter, createTraePoolShim, currentApi, dayKey, decodeTraeEvent, decryptTraeStorageValue, describeTraeFailure, estimateMessagesTokens, estimateTextTokens, fallbackModelsFor, fetchActivities, fetchCheckinStatus, fetchCredits, fetchModels, fetchRemoteCatalog, hardTruncate, identityHeaders, inject, isFireHour, mergeCatalog, mergeTraeModelSources, name, normalizeTraeCredential, normalizeTraeVersionCode, parseActivities, parseCheckinClaim, parseCheckinStatus, parseCreditsSnapshot, parseRateLimitReset, parseReasoningCapability, parseRegionParam, parseSelection, parseTraeAuthValue, parseTraeCliToken, parseTraeRemoteModel, parseTraeStorageDocument, pickTraeStorageIdentity, prepareSoloBody, readTraeCliIdentity, readTraeIdentity, refreshTraeCredential, regionOfCredential, regionOfEdition, regionOfHost, regionOfUserRegion, registerTraePoolStatusRoute, resolveTraeIdentity, safeMessage, setApi, slotKey, stampTraeWireTarget, traeAccountId, traeAccountRegion, traeCliCandidates, traeEndpoint, traeModelDisplayName, traePoolAccountId, traeStorageCandidates, traeWindowsAppNames, unwrapVolatile, unwrapVolatileDeep, wireCreditMultiplier };