import z from "@deepseek-ai/schemastery";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cpus, homedir, hostname, release } from "node:os";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/catalog.ts
/**
* 目录保证的默认窗口。两个来源（远端目录/get_detail_param）都没报窗口的
* 罕见模型用它兜底：没有窗口的模型会让 DSH 整条 provider 路由
* `INVALID_MODEL_CONTEXT` 失败，比一个不精确的窗口严重得多。
*/
const TRAE_DEFAULT_CONTEXT_WINDOW = 2e5;
/**
* CN 回退名册（照抄 dsh-connect-trae catalog.ts，字段已实测核对）：
* - id 必须是 `llm_utils_chat` 真正接受的 config_name（CN 的 DeepSeek 行带
*   `-Official` 后缀；没有 `auto` 这种伪 id）；
* - 每行必须带正整数 contextWindow（原因同上）；
* - 图像输入缺省关闭，由用户的显式 opt-in 打开。
*/
const FALLBACK_TRAE_MODELS = [
	{
		id: "DeepSeek-V4-Flash-Official",
		name: "DeepSeek-V4-Flash",
		contextWindow: 2e5,
		supportsImages: false,
		multimodal: false
	},
	{
		id: "DeepSeek-V4-Pro-Official",
		name: "DeepSeek-V4-Pro",
		contextWindow: 2e5,
		supportsImages: false,
		multimodal: false
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 2e5,
		supportsImages: false,
		multimodal: false
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 2e5,
		supportsImages: false,
		multimodal: false
	}
];
/**
* 国际（ai）回退名册（照抄 dsh-connect-trae，来自 2026-09-15 对
* `coresg-normal.trae.ai/api/remote/v1/models` 的实测抓取）。两个区域名册几乎
* 不重叠（CN 没有 Gemini/GPT/MiniMax 行），所以 ai 账号绝不能用 CN 名册播种。
*/
const FALLBACK_TRAE_MODELS_AI = [
	{
		id: "gemini-3.1-pro",
		name: "Gemini-3.1-Pro-Preview",
		contextWindow: 2e5,
		supportsImages: false,
		multimodal: false
	},
	{
		id: "gemini-3-flash-solo",
		name: "Gemini-3-Flash-Preview",
		contextWindow: 2e5,
		supportsImages: false,
		multimodal: false
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 2e5,
		supportsImages: false,
		multimodal: false
	},
	{
		id: "minimax-m2.7",
		name: "MiniMax-M2.7",
		contextWindow: 2e5,
		supportsImages: false,
		multimodal: false
	},
	{
		id: "kimi-k2.5",
		name: "Kimi-K2.5",
		contextWindow: 2e5,
		supportsImages: false,
		multimodal: false
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		contextWindow: 272e3,
		supportsImages: false,
		multimodal: false
	},
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		contextWindow: 272e3,
		supportsImages: false,
		multimodal: false
	}
];
/** 区域 → 回退名册。每个区域的 provider 只服务自己区域的名册。 */
function fallbackModelsFor(region) {
	return region === "ai" ? FALLBACK_TRAE_MODELS_AI : FALLBACK_TRAE_MODELS;
}
/**
* 给 DSH 的显示名：照 Trae 自己模型选择器的拼法，把倍率画进名字
* （`Name · x0.08`）。行上的 `name` 保持纯净名——wire 解析等所有 join 都必须
* 匹配不带后缀的名字；只有交给 DSH 的行用这个装饰名。
*/
function traeModelDisplayName(model) {
	return model.multiplier === void 0 ? model.name : `${model.name} · x${model.multiplier.toFixed(2)}`;
}
/** 显示名归一化，用于跨源 join（大小写与首尾空白不敏感）。 */
function displayKey(name) {
	return name.trim().toLowerCase();
}
/** 目录行的推理档位列表（reasoning 支持时才有）。 */
function effortsOf(reasoning) {
	return reasoning?.supported.length === 0 ? void 0 : reasoning?.supported;
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
function mergeTraeModelSources(remote, wire) {
	const wireByName = /* @__PURE__ */ new Map();
	const wireById = /* @__PURE__ */ new Map();
	for (const model of wire) {
		wireByName.set(displayKey(model.name), model);
		wireById.set(displayKey(model.id), model);
	}
	const result = [];
	for (const model of remote) {
		const wireModel = wireById.get(displayKey(model.id)) ?? wireByName.get(displayKey(model.name));
		const creditMultiplier = wireModel?.creditMultiplier ?? model.creditMultiplier;
		const window = model.contextWindow ?? wireModel?.contextWindow;
		result.push({
			id: model.id,
			name: model.name,
			contextWindow: window ?? 2e5,
			...model.maxContextWindow === void 0 ? {} : { maxContextWindow: model.maxContextWindow },
			...wireModel?.maxTokens === void 0 ? {} : { maxOutputTokens: wireModel.maxTokens },
			...creditMultiplier === void 0 ? {} : { multiplier: creditMultiplier },
			supportsImages: false,
			...model.multimodal === void 0 ? {} : { multimodal: model.multimodal },
			...effortsOf(model.reasoning) === void 0 ? {} : { supportedEfforts: effortsOf(model.reasoning) },
			...wireModel !== void 0 && wireModel.id !== "" && wireModel.id !== model.id ? { wireConfigName: wireModel.id } : {},
			...wireModel?.function === void 0 ? {} : { wireFunction: wireModel.function }
		});
	}
	return result;
}
/**
* 应用单个模型的上下文预算。
* 规则：预算必须落在 (0, 广告窗口上限] 内——上限 = maxContextWindow（若有）
* 否则当前窗口。可以下调，也可以上调到上游真实宣告的 Max 档，但绝不虚构数值。
*/
function applyModelBudget(model, budget) {
	if (budget === void 0 || !Number.isFinite(budget) || budget <= 0) return model;
	const ceiling = model.maxContextWindow ?? model.contextWindow;
	const window = Math.max(1, Math.min(Math.floor(budget), ceiling));
	if (window === model.contextWindow) return model;
	return {
		...model,
		contextWindow: window
	};
}
/** 模型目录：live 数据 + 静态回退 + 用户选择。 */
var TraeCatalog = class {
	models;
	listeners = /* @__PURE__ */ new Set();
	/** 用户的模型选择。空对象 = 跟随目录不过滤。 */
	selection = {};
	/** 当前 models 来自网关（live）还是静态表（fallback）。 */
	source = "fallback";
	/** live 列表最近一次落地的 ISO 时间。 */
	lastUpdatedAt;
	/** 最近一次抓取失败的原因（展示用）。 */
	lastError;
	/** 区域用于 reset() 时选对回退名册。 */
	region;
	/**
	* @param region 播种该区域的静态回退：每个区域的 provider 在第一次 live
	* 刷新落地前绝不能服务另一个区域的名册。
	*/
	constructor(region = "cn") {
		this.region = region;
		this.models = fallbackModelsFor(region);
	}
	/** 当前完整目录（未套用 selection）。 */
	current() {
		return this.models;
	}
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
	visible() {
		const enabled = this.selection.enabledModelIds;
		const allow = enabled === void 0 ? void 0 : new Set(enabled);
		const images = this.selection.imageModelIds;
		const imageSet = images === void 0 ? void 0 : new Set(images);
		const budgets = this.selection.contextBudgets;
		return this.models.filter((model) => allow === void 0 || allow.has(model.id)).map((model) => {
			let next = { ...model };
			if (imageSet !== void 0) next.supportsImages = next.supportsImages || imageSet.has(model.id);
			if (model.multimodal === true) next.supportsImages = true;
			next = applyModelBudget(next, budgets?.[model.id]);
			return next;
		});
	}
	/** 替换目录并通知 adapter 重建模型列表。空列表忽略（绝不接受空目录）。 */
	update(models) {
		if (models.length === 0) return;
		this.models = models;
		this.notify();
	}
	/** 恢复本区域的静态回退（例如上游长时间不可用后手动重置）。 */
	reset() {
		this.models = fallbackModelsFor(this.region);
		this.source = "fallback";
		this.notify();
	}
	/** 本目录服务的区域。 */
	currentRegion() {
		return this.region;
	}
	/** 替换用户选择；adapter 从 visible() 重建。 */
	applySelection(selection) {
		this.selection = selection;
		this.notify();
	}
	/** 当前生效的选择（卡片的保存回环用）。 */
	currentSelection() {
		return this.selection;
	}
	/** 当前目录来源（fallback 是降级但不是错误状态）。 */
	currentSource() {
		return this.source;
	}
	/** live 列表最近一次落地时间（从未成功过则 undefined）。 */
	catalogUpdatedAt() {
		return this.lastUpdatedAt;
	}
	/** 最近一次抓取失败原因（未失败则 undefined）。 */
	lastFetchError() {
		return this.lastError;
	}
	/** 订阅目录变化；返回退订函数。 */
	onChange(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	/** 按 id 找行（含 wire 信息，供 shim 解析 config_name）。 */
	find(id) {
		return this.models.find((model) => model.id === id);
	}
	/** 从 live 合并结果替换目录；空列表时保留现状并记录失败。 */
	updateFromUpstream(models) {
		if (models.length === 0) {
			this.noteFetchFailure("live catalog fetch returned no models");
			return;
		}
		this.update(models);
		this.source = "live";
		this.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
		this.lastError = void 0;
	}
	/**
	* 记录一次抓取失败，但不重置当前列表：一次刷新失败不应把健康的会话降级到
	* 静态表——保留在跑的目录比“闪回旧名册”更安全。
	*/
	noteFetchFailure(message) {
		this.lastError = message;
		this.notify();
	}
	notify() {
		for (const listener of this.listeners) listener();
	}
};
//#endregion
//#region src/adapter.ts
/**
* `connect-trae-models` 的 pi-ai provider：注册进 Harness LLM seam 的回环适配器，
* 由 `dsh-llm-pi-ai` 的公开扩展点装配。每个模型都指向 shim；账号轮换留在
* shim 内部。
*
* 装配方式（createProvider + openAICompletionsApi + 惰性 auth 面 + 以 shim
* 的进程内 secret 作 apiKey）沿用 dsh-workbuddy-xdpool / dsh-connect-trae 的
* 已验证设计（血统为 corrinehu/dsh-workbuddy-connect，MIT）。
*
* @module dsh-connect-trae-models/adapter
*/
/** 国内（CN）网关的 provider 路由。 */
const TRAE_POOL_PROVIDER = "connect-trae-models";
/** 国际网关的 provider 路由。 */
const TRAE_GLOBAL_POOL_PROVIDER = "connect-trae-models-global";
/** 每个区域注册的 provider id。 */
const POOL_PROVIDER_BY_REGION = {
	cn: TRAE_POOL_PROVIDER,
	ai: TRAE_GLOBAL_POOL_PROVIDER
};
/** 每个区域注册的显示名，让选择器能把它们分组。 */
const POOL_NAME_BY_REGION = {
	cn: "Trae Connect Models（国内版）",
	ai: "Trae Connect Models（国际版）"
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
const TRAE_STREAM_IDLE_TIMEOUT_MS = 9e5;
/** dsh-llm-pi-ai 默认值下的图片请求预算。 */
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* 惰性 pi-ai auth 面。该路由只通过每请求解析的 shim 共享 secret 认证，
* 所以 pi-ai 自己的凭据生命周期绝不能为它制造凭据。
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-connect-trae-models: this route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** 订阅制额度没有可推断的按 token 定价；报零。 */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** pi-ai 输入模态：只有目录宣告图片时才允许图片。 */
function modelInput(info) {
	return info.supportsImages ? ["text", "image"] : ["text"];
}
/** 只映射目录宣告的档位；DSH 未宣告的档位保持关闭。 */
function thinkingLevelMap(info) {
	const efforts = info.supportedEfforts;
	if (efforts === void 0 || efforts.length === 0) return void 0;
	const levels = [
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	];
	const map = {};
	for (const level of levels) map[level] = efforts.includes(level) ? level : null;
	map["off"] = null;
	return map;
}
/** 中点分隔符：在模型自带的连字符与倍率/徽标后缀之间不会歧义。 */
const DISPLAY_SEPARATOR = " · ";
/**
* 上游标签码 → 模型选择器里紧挨倍率显示的本地化促销标签。
* `free` 与 `limited-free` 折叠成同一个短标签，让下拉行保持可扫读。
*/
const TAG_LABEL = {
	"free": "限时免费",
	"limited-free": "限时免费",
	"night-discount": "夜间折扣"
};
/**
* 解析一行目录的显示后缀（`xN.NN`、促销徽标）。
* 没有可展示内容时返回 `undefined` —— 名字保持原样，免得在一个朴素模型后面
* 挂一个游离的分隔符。
*/
function displaySuffix(info) {
	const parts = [];
	if (info.multiplier === 0) parts.push("免费");
	else if (typeof info.multiplier === "number" && Number.isFinite(info.multiplier)) parts.push(`x${info.multiplier.toFixed(2)}`);
	for (const tag of info.tags ?? []) {
		const label = TAG_LABEL[tag];
		if (label !== void 0 && !parts.includes(label)) parts.push(label);
	}
	return parts.length === 0 ? void 0 : parts.join(DISPLAY_SEPARATOR);
}
/**
* 把目录的倍率 + 促销徽标应用到模型显示名上。
*
* 仅影响显示：wire 请求由 `model.id` 构造，所以这里的改名不可能影响路由、
* token 或上游计费。DSH 的 composer（ModelSelect）只渲染 `model.name`，这
* 正是倍率与徽标搭在名字上而非单独描述列的原因。
*/
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${DISPLAY_SEPARATOR}${suffix}`;
}
/**
* 构造一个指向回环 shim 的 pi-ai 模型描述符。
*
* `contextWindow` 必须有值：DSH 对无窗口模型会以 `INVALID_MODEL_CONTEXT`
* 失败，而那会拖垮**整条** provider 路由 —— 比一个不精确的窗口严重得多。
* 目录保证每行都有正整数窗口，这里仍兜底一次。
*/
function toPiModel(info, baseUrl, providerId) {
	const map = thinkingLevelMap(info);
	const contextWindow = Number.isFinite(info.contextWindow) && info.contextWindow > 0 ? info.contextWindow : TRAE_DEFAULT_CONTEXT_WINDOW;
	return {
		id: info.id,
		name: withCatalogDisplay(info.name, info),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: modelInput(info),
		cost: NO_COST,
		contextWindow,
		maxTokens: info.maxOutputTokens,
		reasoning: map !== void 0,
		...map === void 0 ? {} : { thinkingLevelMap: map },
		compat: { supportsReasoningEffort: map !== void 0 }
	};
}
/**
* 装配 adapter。`getModels` 重读实时目录，且每个模型的 `baseUrl` 每次读取都
* 重新解析，使 shim 的临时端口从启动后的第一份快照起就生效。
* 只在 `shim.ready` 之后调用。
*/
function createTraeAdapter(options) {
	const { shim, catalog } = options;
	const providerId = options.providerId ?? "connect-trae-models";
	const displayName = options.displayName ?? "Trae Connect Models";
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.visible().map((info) => toPiModel(info, baseUrl, providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: "Trae Connect Models loopback secret",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "Trae Connect Models"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: TRAE_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-connect-trae-models retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		providerId,
		displayName,
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			resolveAttachments: () => options.ctx.get("attachments"),
			resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => options.ctx.get("fs")?.processPathFromHostPath(hostPath), ref)
		}),
		buildModels,
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
//#endregion
//#region src/paths.ts
/**
* Trae 桌面端 / CLI 的凭据候选路径（移植自 dsh-connect-trae/src/paths.ts，语义逐字段保持）。
*
* 4 种 edition（cn/sg/solo/solo-sg）各自的 `User/globalStorage/storage.json`
* 候选路径，以及 Trae CLI 自己的 dotfile home 中的裸 JWT 候选。
*
* @module dsh-connect-trae-models/paths
*/
const APP_NAMES = {
	cn: "Trae CN",
	sg: "Trae",
	solo: "TRAE SOLO CN",
	"solo-sg": "TRAE SOLO"
};
/**
* Trae CLI 自己的 home 目录名。它们刻意与上面的 Electron app-support 名称分开：
* CLI 用的是一个点前缀目录（macOS 观察为 `~/.trae-cn`）而不是 `Application Support`
* 下的条目，所以只装了 CLI 的机器上根本没有 `storage.json`。
*/
const CLI_HOME_NAMES = [".trae-cn", ".trae"];
/** CLI 持久化裸 JWT 的文件名。 */
const TRAE_CLI_TOKEN_FILENAME = "trae-jwt-token";
/**
* Linux 桌面版配置目录名。Linux 上的 Electron 应用通常用小写、无空格的名字，
* 而不是 macOS 的 `Trae CN` 拼写，所以两种都要探测：只猜 macOS 拼写会静默漏掉
* 真实安装，只猜 Linux 拼写会破坏所有现存用户。真实名字在真实 Linux 主机上
* 尚未验证。
*/
const LINUX_APP_NAMES = {
	cn: [
		"trae-cn",
		"Trae CN",
		"trae",
		"Trae"
	],
	sg: ["trae", "Trae"],
	solo: ["trae-solo-cn", "TRAE SOLO CN"],
	"solo-sg": ["trae-solo", "TRAE SOLO"]
};
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
const WINDOWS_APP_NAMES = {
	cn: ["Trae CN", "trae-cn"],
	sg: ["Trae"],
	solo: ["TRAE SOLO CN", "trae-solo-cn"],
	"solo-sg": ["TRAE SOLO"]
};
/**
* 某一种 edition 在 Windows 上的候选目录拼写，按探测顺序排列。
*
* 导出它是为了让身份读取与凭据扫描探测同一组名字：两者解析的文件不同
* （安装目录的 `product.json` vs 每用户的 `storage.json`），但描述的是同一个安装，
* 一种拼写对一方有效、对另一方无效是 bug 而不是偏好。
*/
function traeWindowsAppNames(edition) {
	return WINDOWS_APP_NAMES[edition];
}
/** 全部桌面端 storage.json 候选 + CLI token 候选，按探测顺序排列。 */
function traeStorageCandidates(platform = process.platform, home = homedir(), env = process.env) {
	const result = [];
	for (const edition of [
		"cn",
		"sg",
		"solo",
		"solo-sg"
	]) {
		const app = APP_NAMES[edition];
		let roots;
		let appNames;
		if (platform === "darwin") {
			roots = [join(home, "Library", "Application Support")];
			appNames = [app];
		} else if (platform === "win32") {
			roots = [env.APPDATA, join(home, "AppData", "Roaming")].filter((value, index, all) => typeof value === "string" && value !== "" && all.indexOf(value) === index);
			appNames = WINDOWS_APP_NAMES[edition];
		} else if (platform === "linux") {
			roots = [env.XDG_CONFIG_HOME || join(home, ".config")];
			appNames = LINUX_APP_NAMES[edition];
		} else {
			roots = [];
			appNames = [app];
		}
		for (const root of roots) for (const appName of appNames) result.push({
			edition,
			path: join(root, appName, "User", "globalStorage", "storage.json"),
			source: "desktop"
		});
	}
	return [...result, ...traeCliCandidates(platform, home, env)];
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
function traeCliCandidates(platform = process.platform, home = homedir(), env = process.env) {
	const roots = [];
	if (platform === "win32") {
		for (const value of [env.USERPROFILE, home]) if (typeof value === "string" && value !== "" && !roots.includes(value)) roots.push(value);
	} else roots.push(home);
	const result = [];
	for (const root of roots) for (const name of CLI_HOME_NAMES) {
		const edition = name === ".trae-cn" ? "cn" : "sg";
		result.push({
			edition,
			path: join(root, name, TRAE_CLI_TOKEN_FILENAME),
			source: "cli"
		});
	}
	return result;
}
//#endregion
//#region src/identity.ts
/**
* Trae 稳定设备身份（移植自 dsh-connect-trae/src/identity.ts，语义逐字段保持）。
*
* machineId = storage 的 `telemetry.machineId`（官方聊天日志中 x-machine-id 的
* 64 位来源，root machineid 文件仅作兜底）。
* deviceId  = `iCubeAuthInfo://icube-dc:<id>` 的数字后缀 —— 官方 CN 聊天日志里
* x-device-id 的判定量（必保留精确语义），telemetry.devDeviceId 兜底，最后才是
* 由 machineId 派生的哈希。
*
* @module dsh-connect-trae-models/identity
*/
function nonEmpty(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/** `iCubeAuthInfo://icube-dc:` 前缀键对应的设备中心 id（恰为 x-device-id 判定来源）。 */
function deviceCenterId(storage) {
	const prefix = "iCubeAuthInfo://icube-dc:";
	const ids = Object.keys(storage).filter((key) => key.startsWith(prefix)).map((key) => key.slice(25)).filter(Boolean);
	return ids.length === 1 ? ids[0] : void 0;
}
/** 从 Trae 自有文件读取稳定身份，绝不伪造随机 id。 */
async function readTraeIdentity(candidate, options = {}) {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const storage = JSON.parse(await readFile(candidate.path, "utf8"));
	const appRoot = dirname(dirname(dirname(candidate.path)));
	const machineFile = nonEmpty(await readFile(join(appRoot, "machineid"), "utf8").catch(() => ""));
	const telemetryMachine = nonEmpty(storage["telemetry.machineId"]);
	const devDevice = nonEmpty(storage["telemetry.devDeviceId"]);
	const dcDevice = deviceCenterId(storage);
	const machineId = telemetryMachine ?? machineFile;
	if (machineId === void 0) throw new Error(`Trae ${candidate.edition} has no stable machine identity`);
	const deviceId = dcDevice ?? devDevice ?? createHash("sha256").update(machineId).digest("hex").slice(0, 32);
	const buildVersion = nonEmpty(storage["iCubeLastVersion"]);
	const appName = {
		cn: "Trae CN",
		sg: "Trae",
		solo: "TRAE SOLO CN",
		"solo-sg": "TRAE SOLO"
	}[candidate.edition];
	const productPaths = [];
	if (appName !== void 0 && (platform === "darwin" || platform === "win32")) {
		if (platform === "darwin") productPaths.push(join("/Applications", `${appName}.app`, "Contents", "Resources", "app", "product.json"));
		else {
			const localRoots = [env.LOCALAPPDATA, join(home, "AppData", "Local")].filter((value) => typeof value === "string" && value !== "").filter((value, index, all) => all.indexOf(value) === index);
			for (const root of localRoots) for (const spelling of traeWindowsAppNames(candidate.edition)) productPaths.push(join(root, "Programs", spelling, "resources", "app", "product.json"));
		}
	}
	let product = {};
	for (const path of productPaths) try {
		product = JSON.parse(await readFile(path, "utf8"));
		break;
	} catch {}
	const appVersion = nonEmpty(product["appVersion"]);
	const deviceBrand = platform === "darwin" ? nonEmpty(env["TRAE_DEVICE_BRAND"]) : void 0;
	const deviceCpu = cpus()[0]?.model.split(" ")[0];
	const osVersion = `${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform} ${release()}`;
	return {
		edition: candidate.edition,
		machineId,
		deviceId,
		...appVersion === void 0 ? {} : { appVersion },
		...buildVersion === void 0 ? {} : { buildVersion },
		...deviceBrand === void 0 ? {} : { deviceBrand },
		...deviceCpu === void 0 ? {} : { deviceCpu },
		osVersion,
		platform
	};
}
/** 判断某错误是否为「storage 文件不存在」（区别于解析/身份错误）。 */
function isFileMissing(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
/** 「磁盘上没有任何候选存在」错误的前缀；见 {@link pickTraeStorageIdentity}。 */
const STORAGE_MISSING_PREFIX = "Trae storage was not found";
/**
* 按顺序尝试候选并返回第一个能得到有效身份的；全部失败才硬报错。
* 与凭据存储的 skip-missing 语义一致：只有 SOLO（没有 CN 安装）的机器也能正确
* 解析，而不是钉死第一个候选然后在文件缺失上抛错。当所有候选都不在磁盘上时，
* 错误里列出全部尝试过的路径；存在但解析失败的候选则暴露其自身错误。
*/
async function pickTraeStorageIdentity(candidates, options = {}) {
	let lastError;
	let anyPresent = false;
	for (const candidate of candidates) try {
		return await readTraeIdentity(candidate, options);
	} catch (error) {
		lastError = error;
		if (!isFileMissing(error)) anyPresent = true;
	}
	const tried = candidates.map((item) => item.path).join(" or ");
	if (!anyPresent) throw new Error(`${STORAGE_MISSING_PREFIX} (${tried})`);
	throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`Trae identity could not be resolved (${tried})`);
}
/** 每个 edition 的 CLI 点前缀 home；CLI 用自己的 home，而不是 Application Support 条目。 */
const CLI_HOME_BY_EDITION = {
	cn: ".trae-cn",
	solo: ".trae-cn",
	sg: ".trae",
	"solo-sg": ".trae"
};
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
async function readTraeCliIdentity(edition, options = {}) {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const cliHome = join(home, CLI_HOME_BY_EDITION[edition]);
	const argv = await readJsonFile(join(cliHome, "argv.json"));
	const version = await readJsonFile(join(cliHome, "builtin", "ide_version.json"));
	const crashReporterId = nonEmpty(argv?.["crash-reporter-id"]);
	const host = nonEmpty(env["HOSTNAME"]) ?? await readHostname() ?? "unknown-host";
	const user = nonEmpty(env["USER"]) ?? nonEmpty(env["USERNAME"]) ?? "unknown-user";
	const deviceId = crashReporterId ?? createHash("sha256").update(`trae-cli\0${host}\0${user}`).digest("hex").slice(0, 32);
	const machineId = createHash("sha256").update(`trae-cli-machine\0${deviceId}\0${host}`).digest("hex");
	const appVersion = nonEmpty(version?.["version"]);
	const deviceCpu = cpus()[0]?.model.split(" ")[0];
	const osVersion = `${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform} ${release()}`;
	return {
		edition,
		machineId,
		deviceId,
		...appVersion === void 0 ? {} : { appVersion },
		...deviceCpu === void 0 ? {} : { deviceCpu },
		osVersion,
		platform
	};
}
/** 读取并解析 JSON 文件，容忍缺失与损坏内容。 */
async function readJsonFile(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/** OS 主机名，不可用时返回 undefined。 */
async function readHostname() {
	try {
		const { hostname } = await import("node:os");
		return nonEmpty(hostname());
	} catch {
		return;
	}
}
/**
* 解析一个 region 的请求身份：存在任何桌面安装时用桌面 storage 身份，
* 否则用 CLI home 的确定性身份（见 {@link readTraeCliIdentity}）。
*
* 这是 WSL2 / CLI-only 场景需要的接缝：`traecli` 把 token 写到
* `~/.trae-cn/trae-jwt-token`，磁盘上没有任何 `storage.json`，仅支持桌面的
* 解析曾让目录刷新与聊天请求全部失败，即使账号本身已找到。
*/
async function resolveTraeIdentity(candidates, edition, options = {}) {
	try {
		return await pickTraeStorageIdentity(candidates, options);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith(STORAGE_MISSING_PREFIX)) throw error;
		return readTraeCliIdentity(edition, options);
	}
}
/** 由真实持久化身份派生的请求头，绝非每请求新造的随机身份。 */
function identityHeaders(identity) {
	return {
		"x-machine-id": identity.machineId,
		"x-device-id": identity.deviceId,
		"x-device-type": identity.platform === "darwin" ? "mac" : identity.platform === "win32" ? "windows" : identity.platform,
		...identity.deviceBrand === void 0 ? {} : { "x-device-brand": identity.deviceBrand },
		...identity.deviceCpu === void 0 ? {} : { "x-device-cpu": identity.deviceCpu },
		...identity.osVersion === void 0 ? {} : { "x-os-version": identity.osVersion },
		...identity.appVersion === void 0 ? {} : {
			"x-app-version": identity.appVersion,
			"x-ide-version": identity.appVersion
		},
		...identity.buildVersion === void 0 ? {} : {
			"x-app-version-code": identity.buildVersion,
			"x-ide-version-code": identity.buildVersion
		},
		"x-ide-version-type": "stable"
	};
}
//#endregion
//#region src/refresh.ts
const REFRESH_CONTRACT = {
	cn: {
		path: "/cloudide/api/v3/trae/oauth/ExchangeToken",
		clientId: "ono9krqynydwx5",
		deviceInfo: false
	},
	sg: {
		path: "/cloudide/api/v3/trae/oauth/ExchangeToken",
		clientId: "ono9krqynydwx5",
		deviceInfo: false
	},
	solo: {
		path: "/cloudide/api/v3/trae/oauth/ExchangeToken",
		clientId: "ono9krqynydwx5",
		deviceInfo: false
	},
	"solo-sg": {
		path: "/trae/api/v3/oauth/ExchangeToken",
		clientId: "en1oxy7wnw8j9n",
		deviceInfo: true
	}
};
function normalizeHost(host) {
	const value = host.trim();
	if (value === "") throw new Error("Trae refresh host is missing");
	return value.replace(/\/$/, "");
}
/**
* 用 refresh token 换新 access token，遵循调用 edition 的已验证契约。
* `device` 只被官方客户端发送 DeviceInfo body 的 edition 使用；无法解析时
* 省略该字段而不是发送空值。
*/
async function refreshTraeCredential(credential, signal, device) {
	const contract = REFRESH_CONTRACT[credential.edition];
	if (contract === void 0) throw new Error(`Trae ${credential.edition} refresh contract is not verified`);
	if (credential.refreshToken === void 0) throw new Error("Trae refresh token is missing");
	const body = {
		ClientID: contract.clientId,
		ClientSecret: "-",
		RefreshToken: credential.refreshToken,
		UserID: credential.userId
	};
	if (contract.deviceInfo && device !== void 0) body["DeviceInfo"] = {
		DeviceID: device.deviceId,
		MachineID: device.machineId,
		PlatformCode: credential.edition === "solo-sg" ? "SOLO_PC" : "TRAE",
		DeviceType: "PC",
		DeviceName: hostname()
	};
	const response = await fetch(`${normalizeHost(credential.host)}${contract.path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: signal ?? AbortSignal.timeout(3e4)
	});
	if (!response.ok) throw new Error(`Trae token refresh failed (http ${response.status})`);
	const result = (await response.json()).Result;
	const accessToken = typeof result?.["Token"] === "string" ? result["Token"] : "";
	if (accessToken === "") throw new Error("Trae token refresh returned no token");
	const expiry = result?.["TokenExpireAt"];
	const expiresAtMs = typeof expiry === "number" ? expiry : typeof expiry === "string" ? Date.parse(expiry) : NaN;
	if (!Number.isFinite(expiresAtMs)) throw new Error("Trae token refresh returned an invalid expiry");
	const refreshToken = typeof result?.["RefreshToken"] === "string" && result["RefreshToken"] !== "" ? result["RefreshToken"] : void 0;
	return {
		accessToken,
		...refreshToken === void 0 ? {} : { refreshToken },
		expiresAtMs
	};
}
//#endregion
//#region src/decrypt.ts
/**
* Trae 存储鉴权值的解密与 CLI JWT 解析（移植自 dsh-connect-trae/src/decrypt.ts，语义逐字段保持）。
*
* - `storage.json` 的 `iCubeAuthInfo://icube.cloudide` 值是 AES-128-CBC 加密的，
*   带 102 字节的头部/派生层与 SHA-512 完整性校验。
* - CLI 的 `trae-jwt-token` 是裸 JWT，无 AES 层，直接解析 claims。
*
* @module dsh-connect-trae-models/decrypt
*/
const TRAE_AUTH_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
const SALT_A = Uint8Array.from([
	82,
	9,
	106,
	213,
	48,
	54,
	165,
	56,
	191,
	64,
	163,
	158,
	129,
	243,
	215,
	251,
	124,
	227,
	57,
	130,
	155,
	47,
	255,
	135,
	52,
	142,
	67,
	68,
	196,
	222,
	233,
	203,
	84,
	123,
	148,
	50,
	166,
	194,
	35,
	61,
	238,
	76,
	149,
	11,
	66,
	250,
	195,
	78,
	8,
	46,
	161,
	102,
	40,
	217,
	36,
	178,
	118,
	91,
	162,
	73,
	109,
	139,
	209,
	37
]);
const SALT_B = Uint8Array.from([
	31,
	221,
	168,
	51,
	136,
	7,
	199,
	49,
	177,
	18,
	16,
	89,
	39,
	128,
	236,
	95,
	96,
	81,
	127,
	169,
	25,
	181,
	74,
	13,
	45,
	229,
	122,
	159,
	147,
	201,
	156,
	239,
	160,
	224,
	59,
	77,
	174,
	42,
	245,
	176,
	200,
	235,
	187,
	60,
	131,
	83,
	153,
	97,
	23,
	43,
	4,
	126,
	186,
	119,
	214,
	38,
	225,
	105,
	20,
	99,
	85,
	33,
	12,
	125
]);
const SALT_C = Uint8Array.from([
	191,
	192,
	216,
	250,
	122,
	246,
	220,
	97,
	31,
	254,
	98,
	27,
	8,
	72,
	71,
	176,
	135,
	99,
	96,
	18,
	127,
	101,
	203,
	104,
	211,
	102,
	191,
	125,
	37,
	72,
	150,
	156,
	51,
	229,
	121,
	35,
	17,
	153,
	141,
	177,
	110,
	131,
	150,
	128,
	172,
	255,
	254,
	6,
	18,
	140,
	55,
	62,
	236,
	249,
	135,
	64,
	135,
	12,
	117,
	4,
	89,
	149,
	168,
	209
]);
const SALT_D = Uint8Array.from([
	246,
	204,
	26,
	232,
	232,
	70,
	129,
	109,
	223,
	146,
	169,
	242,
	23,
	241,
	105,
	145,
	50,
	196,
	165,
	42,
	254,
	120,
	3,
	54,
	244,
	207,
	209,
	85,
	53,
	6,
	138,
	106,
	175,
	148,
	31,
	204,
	186,
	186,
	165,
	182,
	87,
	142,
	49,
	10,
	39,
	110,
	26,
	154,
	86,
	56,
	173,
	125,
	18,
	64,
	198,
	225,
	99,
	99,
	83,
	82,
	191,
	134,
	76,
	170
]);
function xor(a, b) {
	return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)));
}
function encryptionType(header) {
	if (header.equals(Buffer.from([
		116,
		99,
		5,
		16,
		0,
		0
	]))) return "aes";
	if (header.equals(Buffer.from([
		18,
		57,
		32,
		32,
		2,
		3
	]))) return "aes-private";
	throw new Error("unsupported Trae auth encryption header");
}
/** 解密 storage.json 里的鉴权值：头 6 字节判型，SHA-512 双轮派生密钥，尾 64 字节为完整性校验。 */
function decryptTraeStorageValue(encoded) {
	const buffer = Buffer.from(encoded, "base64");
	if (buffer.length <= 102) throw new Error("Trae auth ciphertext is too short");
	const type = encryptionType(buffer.subarray(0, 6));
	const random = buffer.subarray(6, 38);
	const encrypted = buffer.subarray(38);
	const salt = type === "aes-private" ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B);
	const first = createHash("sha512").update(random).digest();
	const derived = createHash("sha512").update(Buffer.concat([first, salt])).digest();
	const decipher = createDecipheriv("aes-128-cbc", derived.subarray(0, 16), derived.subarray(16, 32));
	const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
	if (decrypted.length < 64) throw new Error("Trae auth plaintext is too short");
	const expected = decrypted.subarray(0, 64);
	const plaintext = decrypted.subarray(64);
	const actual = createHash("sha512").update(plaintext).digest();
	if (!expected.equals(actual)) throw new Error("Trae auth integrity check failed");
	return plaintext.toString("utf8");
}
/** 解析鉴权值：明文 JSON 直接用，密文先解密。 */
function parseTraeAuthValue(value) {
	const trimmed = value.trim();
	if (trimmed === "") throw new Error("Trae auth value is empty");
	const plaintext = trimmed.startsWith("{") ? trimmed : decryptTraeStorageValue(trimmed);
	return JSON.parse(plaintext);
}
/** 读取 storage.json 文档并解出鉴权对象。 */
function parseTraeStorageDocument(text) {
	const parsed = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Trae storage document must be an object");
	const value = parsed[TRAE_AUTH_STORAGE_KEY];
	if (typeof value !== "string") throw new Error(`Trae storage document has no ${TRAE_AUTH_STORAGE_KEY}`);
	return parseTraeAuthValue(value);
}
function decodeBase64UrlJson(segment) {
	try {
		const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
		const decoded = Buffer.from(padded, "base64").toString("utf8");
		const parsed = JSON.parse(decoded);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/**
* 解析 CLI token 文件。接受裸 JWT 本身，或包含它的 JSON 信封（磁盘形状只在
* macOS 上验证过，未来 CLI 版本可能加包装）。
*/
function parseTraeCliToken(text) {
	const trimmed = text.trim();
	if (trimmed === "") throw new Error("Trae CLI token file is empty");
	let token = trimmed;
	if (trimmed.startsWith("{")) {
		const envelope = JSON.parse(trimmed);
		const candidate = envelope["token"] ?? envelope["accessToken"] ?? envelope["jwt"];
		if (typeof candidate !== "string" || candidate.trim() === "") throw new Error("Trae CLI token document has no token field");
		token = candidate.trim();
	}
	const segments = token.split(".");
	if (segments.length !== 3 || segments.some((segment) => segment === "")) throw new Error("Trae CLI token is not a three-part JWT");
	const payload = decodeBase64UrlJson(segments[1]);
	if (payload === void 0) throw new Error("Trae CLI token payload is not decodable JSON");
	const data = typeof payload["data"] === "object" && payload["data"] !== null && !Array.isArray(payload["data"]) ? payload["data"] : void 0;
	const userId = typeof data?.["user_id"] === "string" ? data["user_id"] : void 0;
	if (userId === void 0 || userId === "") throw new Error("Trae CLI token has no data.user_id claim");
	const exp = payload["exp"];
	const expiresAtMs = typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1e3 : void 0;
	return {
		accessToken: token,
		userId,
		...expiresAtMs === void 0 ? {} : { expiresAtMs }
	};
}
//#endregion
//#region src/region.ts
/**
* 各区域已验证网关（dsh-connect-trae region.ts 契约，禁止改动语义）。
* ai 区域的 mchost 分片（api16/api22-normal-alisg.mchost.guru）应答相同字节，
* 但 `coresg-normal.trae.ai` 是唯一稳定入口。
*/
const REGION_GATEWAYS = {
	cn: {
		chat: "https://trae-api-cn.mchost.guru",
		remote: "https://solo.trae.cn/api/remote/v1",
		pay: "https://api.trae.cn"
	},
	ai: {
		chat: "https://coresg-normal.trae.ai",
		remote: "https://coresg-normal.trae.ai/api/remote/v1",
		pay: "https://growsg-normal.trae.ai"
	}
};
/** edition 标签 → 区域：国际版两种安装归属 `ai`。 */
function regionOfEdition(edition) {
	return edition === "sg" || edition === "solo-sg" ? "ai" : "cn";
}
/**
* 凭据 `userRegion` 声明 → 区域。桌面存储把它拼成对象
* （`{"region":"CN","_aiRegion":"CN"}`），日志里也有裸的小写 `"sg"`。
* 两种拼法都接受，大小写不敏感。
*/
function regionOfUserRegion(value) {
	const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value["region"] : value;
	if (typeof raw !== "string") return void 0;
	const lowered = raw.trim().toLowerCase();
	if (lowered === "cn") return "cn";
	if (lowered === "sg" || lowered === "ai") return "ai";
}
/** host → 区域（`.trae.ai` → ai；`.trae.cn`/`.trae.com.cn` → cn）。 */
function regionOfHost(host) {
	if (host === void 0) return void 0;
	const trimmed = host.trim();
	if (trimmed === "") return void 0;
	let hostname;
	try {
		hostname = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`).hostname;
	} catch {
		return;
	}
	if (hostname === "trae.ai" || hostname.endsWith(".trae.ai")) return "ai";
	if (hostname === "trae.cn" || hostname.endsWith(".trae.cn") || hostname.endsWith(".trae.com.cn")) return "cn";
}
/**
* 凭据 → 区域，判定链与 dsh-connect-trae 相同（userRegion > host > edition），
* 并在最前面增加一级：账号池（T2 的 pool）可能已经算好并写回的显式 `region`
* 字段——有效值直接采纳，让多账号装配无需重复推导。
* 每一级都来自凭据自身携带的数据，无需用户配置。
*/
function regionOfCredential(credential) {
	if (credential.region === "cn" || credential.region === "ai") return credential.region;
	return regionOfUserRegion(credential.userRegion) ?? regionOfHost(credential.host) ?? regionOfEdition(credential.edition);
}
//#endregion
//#region src/auth.ts
/**
* Trae 凭据模型与多账号凭据存储（改编自 dsh-connect-trae/src/auth.ts）。
*
* 与单账号版的关键差异：
* - 去掉「单账号 selected 绑定」语义：xdpool 需要全部账号同时入池，不保存
*   选择状态，`readAll` 仍按 traeAccountId=sha256(edition+userId) 去重、
*   取每账号最新凭据。
* - 保留插件自有副本的读取：池内账号刷新后的 token 写入自有副本文件，扫描时
*   与桌面凭据按「每账号最新」合并。
*
* @module dsh-connect-trae-models/auth
*/
/** Host used for CLI tokens, which carry no host claim of their own. */
const CLI_DEFAULT_HOST = "https://api.trae.cn";
/** 插件自有副本的文档版本与文件名。 */
const OWN_VERSION = 1;
const TRAE_AUTH_FILENAME = ".trae-auth.json";
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function timeToMs(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value > 0xe8d4a51000 ? value : value * 1e3;
	if (typeof value !== "string" || value.trim() === "") return void 0;
	const numeric = Number(value);
	if (Number.isFinite(numeric) && numeric > 0) return numeric > 0xe8d4a51000 ? numeric : numeric * 1e3;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/** 从两种磁盘形状中提取 `userRegion.region` 字符串。 */
function userRegionOf(value) {
	const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value["region"] : value;
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : void 0;
}
/** 把任一磁盘形状归一化为 TraeCredential；没有 access token 时返回 undefined。 */
function normalizeTraeCredential(raw, edition, source) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const value = raw;
	const accessToken = optionalString(value["token"]) ?? optionalString(value["accessToken"]);
	if (accessToken === void 0) return void 0;
	const expiresAtMs = timeToMs(value["expiredAt"] ?? value["expiresAt"]) ?? 0;
	const refreshExpiresAtMs = timeToMs(value["refreshExpiredAt"] ?? value["refreshExpiresAt"]);
	const refreshToken = optionalString(value["refreshToken"]);
	const userRegion = userRegionOf(value["userRegion"]);
	const accountName = optionalString((typeof value["account"] === "object" && value["account"] !== null && !Array.isArray(value["account"]) ? value["account"] : void 0)?.["username"]);
	return {
		accessToken,
		...refreshToken === void 0 ? {} : { refreshToken },
		userId: optionalString(value["userId"]) ?? "",
		...accountName === void 0 ? {} : { accountName },
		host: optionalString(value["host"]) ?? "",
		...userRegion === void 0 ? {} : { userRegion },
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		edition,
		source
	};
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
function traeAccountId(credential) {
	const stable = `${regionOfCredential(credential)}\0${credential.userId || credential.accountName || "unknown"}`;
	return createHash("sha256").update(stable).digest("hex").slice(0, 24);
}
/** 解析插件自有副本文档；版本不符返回 undefined。 */
function parseOwn(text) {
	try {
		const document = JSON.parse(text);
		if (document.version !== OWN_VERSION || typeof document.credential !== "object" || document.credential === null) return void 0;
		const stored = document.credential;
		const edition = stored["edition"];
		if (edition !== "cn" && edition !== "sg" && edition !== "solo" && edition !== "solo-sg") return void 0;
		return normalizeTraeCredential({
			token: stored["accessToken"],
			refreshToken: stored["refreshToken"],
			userId: stored["userId"],
			host: stored["host"],
			userRegion: stored["userRegion"],
			account: stored["accountName"] === void 0 ? void 0 : { username: stored["accountName"] },
			expiredAt: stored["expiresAtMs"],
			refreshExpiredAt: stored["refreshExpiresAtMs"]
		}, edition, "dsh");
	} catch {
		return;
	}
}
/**
* 多账号凭据存储：发现本机全部 Trae 登录凭据并按账号去重。
*
* 与 dsh-connect-trae 的单账号 store 不同，这里没有 selected/current 概念 ——
* 池需要每一个账号。刷新（ensureFresh）由池负责编排；存储层只做「发现 +
* 归一化 + 每账号取最新」这一件可测试的事。
*/
var TraeCredentialStore = class {
	explicitCandidates;
	ownPaths;
	refresh;
	refreshMarginMs;
	constructor(options) {
		this.explicitCandidates = options.candidates;
		this.ownPaths = options.ownPaths ?? [];
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
	}
	/** 探测候选列表；测试可注入固定候选，生产走真实磁盘。 */
	candidates() {
		if (this.explicitCandidates !== void 0) return [...this.explicitCandidates];
		const all = traeStorageCandidates();
		const cliEdition = "cn";
		return all.filter((candidate) => candidate.source === "desktop" || candidate.edition === cliEdition);
	}
	/**
	* 每个候选路径为何没有得到账号。只携带路径与错误文本，绝不含 token 材料，
	* 卡片诊断可以直接展示。
	*/
	async diagnose() {
		const tried = this.candidates();
		const failures = [];
		for (const candidate of tried) {
			const raw = await readFile(candidate.path, "utf8").then((text) => ({ text }), (error) => ({ error }));
			if ("error" in raw) {
				const code = typeof raw.error === "object" && raw.error !== null && "code" in raw.error ? raw.error.code : void 0;
				failures.push({
					path: candidate.path,
					edition: candidate.edition,
					source: candidate.source,
					reason: code === "ENOENT" ? "missing" : "unreadable",
					...code === "ENOENT" ? {} : { message: String(raw.error) }
				});
				continue;
			}
			try {
				this.credentialFrom(candidate, raw.text);
			} catch (error) {
				failures.push({
					path: candidate.path,
					edition: candidate.edition,
					source: candidate.source,
					reason: "invalid",
					message: error instanceof Error ? error.message : String(error)
				});
			}
		}
		return {
			tried,
			failures
		};
	}
	/** 解析一个候选文件的文本为凭据，或抛错。 */
	credentialFrom(candidate, text) {
		let credential;
		if (candidate.source === "cli") {
			if (regionOfEdition(candidate.edition) !== "cn") throw new Error(`Trae CLI tokens are only verified for the CN region; ${candidate.edition} CLI homes are not supported yet`);
			const claims = parseTraeCliToken(text);
			credential = normalizeTraeCredential({
				token: claims.accessToken,
				userId: claims.userId,
				host: CLI_DEFAULT_HOST,
				expiredAt: claims.expiresAtMs
			}, candidate.edition, "cli");
		} else credential = normalizeTraeCredential(parseTraeStorageDocument(text), candidate.edition, "desktop");
		if (credential === void 0) throw new Error(`${candidate.source} candidate could not be normalized into a credential`);
		return credential;
	}
	/** 读取全部桌面候选，一个损坏文件不能藏住其他有效账号。 */
	async readDesktopAll() {
		const credentials = [];
		const failures = [];
		for (const candidate of this.candidates()) try {
			const credential = this.credentialFrom(candidate, await readFile(candidate.path, "utf8"));
			const existing = credentials.find((entry) => traeAccountId(entry) === traeAccountId(credential));
			if (existing === void 0) credentials.push(credential);
			else if (credential.expiresAtMs > existing.expiresAtMs) credentials[credentials.indexOf(existing)] = credential;
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : void 0;
			failures.push({
				path: candidate.path,
				edition: candidate.edition,
				source: candidate.source,
				reason: code === "ENOENT" ? "missing" : code === void 0 ? "invalid" : "unreadable",
				...code === "ENOENT" || code === void 0 && !(error instanceof Error) ? {} : { message: error instanceof Error ? error.message : String(error) }
			});
			continue;
		}
		return {
			credentials,
			failures
		};
	}
	/** 读取全部插件自有副本；缺失或损坏的文件跳过而不是传播。 */
	async readOwns() {
		const copies = [];
		for (const path of this.ownPaths) try {
			const parsed = parseOwn(await readFile(path, "utf8"));
			if (parsed !== void 0) copies.push(parsed);
		} catch {}
		return copies;
	}
	/**
	* 本机每个账号的最新凭据，按 traeAccountId 去重。
	*
	* 同一账号（edition+userId 相同）桌面副本与自有副本并存时，保留 expiresAtMs
	* 更新的那份：自有副本是本插件刷新后写入的结果，按桌面优先会静默丢弃每次
	* 刷新 —— 账号会永远显示「token 过期」而有效 token 就躺在隔壁文件里。
	* 插入顺序跟随桌面列表，重新扫描不会打乱池的队列。
	*/
	async readAll() {
		const { credentials: desktop } = await this.readDesktopAll();
		const byAccount = /* @__PURE__ */ new Map();
		const consider = (credential) => {
			const id = traeAccountId(credential);
			const incumbent = byAccount.get(id);
			if (incumbent === void 0 || credential.expiresAtMs > incumbent.expiresAtMs) byAccount.set(id, credential);
		};
		for (const credential of desktop) consider(credential);
		for (const own of await this.readOwns()) consider(own);
		return [...byAccount.values()];
	}
	/** 当前 token 距过期还超过刷新余量的账号走这里；见 readAll 的合并语义。 */
	get refreshMargin() {
		return this.refreshMarginMs;
	}
	/** 暴露刷新函数供池复用（池自己持有 in-flight 去重）。 */
	get refresher() {
		return this.refresh;
	}
};
/** Trae 凭据与区域判定的便捷组合：池和上游客户端都会用。 */
function traeAccountRegion(credential) {
	return regionOfCredential(credential);
}
//#endregion
//#region src/pool.ts
/**
* Trae 多账号账号池（蓝本 = dsh-workbuddy-xdpool 的 WorkBuddyAccountPool）。
*
* 池发现本机全部 Trae 账号（经 TraeCredentialStore），按区域（cn | ai）分桶，
* 每请求派发一个健康账号，并从被上游限流/欠费/凭据失效的账号上轮换开。
* 发现只读：桌面端文件绝不被写入；刷新结果写进插件自有副本并回流进池。
*
* @module dsh-connect-trae-models/pool
*/
/** sticky 模式记住的对话→账号绑定上限（内存约束，LRU 淘汰）。 */
const STICKY_AFFINITY_LIMIT = 200;
/** balanced 模式：每空闲 1 小时的权重增量。 */
const IDLE_WEIGHT_PER_HOUR = .5;
/** balanced 模式：空闲加成的上限，防止长期闲置的账号永久统治。 */
const IDLE_WEIGHT_MAX = 5;
/** 欠费（hard_credit）整账号冷却默认值：30 分钟（积分包按自身周期重置）。 */
const EXHAUST_COOLDOWN_MS = 18e5;
/** 凭据失效（401/403）整账号冷却默认值：30 分钟。 */
const CREDENTIAL_DEAD_COOLDOWN_MS = 18e5;
/**
* 空闲权重：`1 + min(idleHours * 0.5, 5)`。基数 1 让每个合格账号都在局内
* （刚服务过的账号仍有一点机会），权重和永不为零。
* `lastUsedAt === undefined`（本进程从未使用）拿满加成：新启动时全体平权，
* 首批请求被摊开而不是永远落在第一条。
*/
function idleWeight(lastUsedAt, now) {
	if (lastUsedAt === void 0) return 6;
	const hours = (now - lastUsedAt) / 36e5;
	return 1 + Math.min(Math.max(hours, 0) * IDLE_WEIGHT_PER_HOUR, IDLE_WEIGHT_MAX);
}
/**
* 这次刷新失败是否证明凭据本身已死？
*
* ExchangeToken 对被吊销的 refresh token 的回答是明确的拒绝语义；网络失败、
* DNS 错误与 5xx 不证明任何事，绝不能把凭据标记为死 —— 否则一次抖动就让一个
* 健康账号退出轮转半小时。
*/
function isCredentialDeadError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("invalid_grant") || message.includes("Offline user session not found") || message.includes("session_dead") || message.includes("refresh token is missing") || /http (401|403)\b/.test(message);
}
/**
* 只读的 Trae 多账号池：发现、去重、区域分桶、限流/欠费/凭据失效冷却、
* 5 种分布、积分保留、临近过期刷新（in-flight 去重）。
*/
var TraeAccountPool = class {
	logger;
	candidatesOverride;
	ownPaths;
	cooldownMs;
	exhaustCooldownMs;
	credentialDeadCooldownMs;
	client;
	refreshMarginMs;
	accounts = [];
	distribution;
	/** round-robin 游标；priority 分布下不使用。 */
	cursor = 0;
	/** sticky：对话键 → 账号 id。插入顺序即 LRU 顺序：重绑先删后插。 */
	affinity = /* @__PURE__ */ new Map();
	lastScanAtMs = 0;
	preferredId;
	/** 用户在卡片上关掉的账号 id（仍列出，不派活）。 */
	disabledIds = /* @__PURE__ */ new Set();
	/** 每账号积分保留线，键为账号 id。0（或缺失）表示「花光即可」。 */
	creditReserves = /* @__PURE__ */ new Map();
	/** 每账号最近一次已知的积分余额。无读数视为可用。 */
	creditBalances = /* @__PURE__ */ new Map();
	/** 每账号最近的积分包到期时刻（epoch ms）。缺失 = 未探测或不紧急。 */
	creditExpiry = /* @__PURE__ */ new Map();
	/** 每账号 refresh 的 in-flight 去重。 */
	refreshInflight = /* @__PURE__ */ new Map();
	store;
	constructor(options = {}) {
		this.logger = options.logger;
		this.candidatesOverride = options.candidates;
		this.ownPaths = options.ownPaths ?? [];
		this.cooldownMs = options.cooldownMs ?? 6e4;
		this.exhaustCooldownMs = options.exhaustCooldownMs ?? EXHAUST_COOLDOWN_MS;
		this.credentialDeadCooldownMs = options.credentialDeadCooldownMs ?? CREDENTIAL_DEAD_COOLDOWN_MS;
		this.client = options.client;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.distribution = options.distribution ?? "priority";
		this.store = new TraeCredentialStore({
			candidates: options.candidates,
			ownPaths: options.ownPaths,
			refreshMarginMs: options.refreshMarginMs,
			refresh: async (credential) => {
				const refresher = options.client;
				if (refresher === void 0) throw new Error("connect-trae-models: no token refresher configured");
				return refresher.refresh(credential);
			}
		});
	}
	/** 重新应用只影响发现与冷却策略的配置，不重建池。 */
	applyConfig(options) {
		if (options.cooldownMs !== void 0 && options.cooldownMs >= 1e3) this.cooldownMs = options.cooldownMs;
		if (options.exhaustCooldownMs !== void 0 && options.exhaustCooldownMs >= 1e3) this.exhaustCooldownMs = options.exhaustCooldownMs;
		if (options.distribution !== void 0) this.distribution = options.distribution;
		if (options.disabledAccountIds !== void 0) this.disabledIds = new Set(options.disabledAccountIds);
		if (options.creditReserves !== void 0) this.setCreditReserves(options.creditReserves);
	}
	/** 当前分布模式（卡片展示）。 */
	currentDistribution() {
		return this.distribution;
	}
	/** 钉住优先使用的账号（卡片偏好选择）。 */
	prefer(accountId) {
		this.preferredId = accountId;
	}
	/**
	* 当前被钉住的账号 id；undefined 表示没有钉选、走普通轮转。
	*
	* 暴露它是因为「钉选」必须可被看见：状态文档与对话栏都要标出哪一个账号
	* 被钉住，否则用户点完「切换用户」看到的是毫无变化的界面，无从判断是否生效。
	*/
	preferredAccountId() {
		return this.preferredId;
	}
	/** 用户是否关闭了该账号。 */
	isDisabled(accountId) {
		return this.disabledIds.has(accountId);
	}
	/** 用户关闭的全部账号 id（发现顺序）。 */
	disabledIdsInOrder() {
		return this.accounts.filter((account) => this.disabledIds.has(account.id)).map((account) => account.id);
	}
	/** 重新扫描凭据来源并合并新发现的账号（保留既有冷却状态）。 */
	async scan() {
		const found = await this.store.readAll();
		const byId = /* @__PURE__ */ new Map();
		for (const account of this.accounts) byId.set(account.id, account);
		for (const credential of found) {
			const id = traeAccountId(credential);
			const existing = byId.get(id);
			if (existing === void 0) {
				byId.set(id, {
					id,
					label: accountLabel(credential),
					credential,
					region: regionOfCredential(credential),
					cooldownUntilMs: 0,
					modelCooldowns: {},
					rateLimitHits: 0
				});
				continue;
			}
			if (credential.expiresAtMs > existing.credential.expiresAtMs || credential.accessToken !== existing.credential.accessToken) {
				const signedInAgain = credential.accessToken !== existing.credential.accessToken || credential.refreshToken !== existing.credential.refreshToken;
				byId.set(id, {
					...existing,
					credential,
					label: accountLabel(credential),
					region: regionOfCredential(credential),
					...signedInAgain ? { credentialDeadUntilMs: 0 } : {}
				});
			}
		}
		const ordered = [...byId.values()];
		ordered.sort((a, b) => b.credential.expiresAtMs - a.credential.expiresAtMs);
		this.accounts = ordered;
		this.lastScanAtMs = Date.now();
		return this.accounts;
	}
	/** 全部账号（含冷却状态）；带 region 时按区域过滤（CN/国际网关不互通）。 */
	list(region) {
		if (region === void 0) return this.accounts;
		return this.accounts.filter((account) => account.region === region);
	}
	/**
	* 当前可派活的账号。
	*
	* 带 modelId 时：账号合格 = 未整账号冷却 且 该模型未冷却 —— hy4 上的 429
	* 只挡 hy4，同账号的 hy3 继续服务。积分低于保留线的账号不派活；
	* 无读数的账号留在局内（未探测的池不能被搁浅）。
	*/
	available(now, modelId, region) {
		return this.accounts.filter((account) => {
			if (this.disabledIds.has(account.id)) return false;
			const reserve = this.creditReserves.get(account.id);
			if (reserve !== void 0 && reserve > 0) {
				const balance = this.creditBalances.get(account.id);
				if (balance !== void 0 && balance <= reserve) return false;
			}
			if (account.cooldownUntilMs > now) return false;
			if ((account.credentialDeadUntilMs ?? 0) > now) return false;
			if (modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now) return false;
			if (region !== void 0 && account.region !== region) return false;
			return true;
		});
	}
	/**
	* 现在为什么没有账号可用 —— 供准确的报错。
	*
	* 池可以为需要相反补救措施的原因变空：没登录（用户要登录）、全部限流
	* （用户等待后重试即可）、全部被关闭（用户要重新启用）、凭据被拒
	* （重新登录而非等待）。计数在该区域的账号上进行。
	*/
	unavailableReason(modelId, region) {
		const now = Date.now();
		const inRegion = this.accounts.filter((account) => region === void 0 || account.region === region);
		if (inRegion.length === 0) return {
			total: 0,
			cooling: 0,
			disabled: 0,
			dead: 0,
			reason: "empty"
		};
		let cooling = 0;
		let disabled = 0;
		let dead = 0;
		for (const account of inRegion) {
			if (this.disabledIds.has(account.id)) {
				disabled += 1;
				continue;
			}
			if ((account.credentialDeadUntilMs ?? 0) > now) {
				dead += 1;
				continue;
			}
			const modelCooling = modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now;
			if (account.cooldownUntilMs > now || modelCooling) {
				cooling += 1;
				continue;
			}
			const reserve = this.creditReserves.get(account.id);
			if (reserve !== void 0 && reserve > 0) {
				const balance = this.creditBalances.get(account.id);
				if (balance !== void 0 && balance <= reserve) return {
					total: inRegion.length,
					cooling,
					disabled,
					dead,
					reason: "reserve"
				};
			}
		}
		if (dead > 0) return {
			total: inRegion.length,
			cooling,
			disabled,
			dead,
			reason: "dead"
		};
		if (cooling > 0) return {
			total: inRegion.length,
			cooling,
			disabled,
			dead,
			reason: "cooling"
		};
		if (disabled > 0) return {
			total: inRegion.length,
			cooling,
			disabled,
			dead,
			reason: "disabled"
		};
		return {
			total: inRegion.length,
			cooling,
			disabled,
			dead,
			reason: "none"
		};
	}
	/** round-robin：游标轮转。 */
	pickRoundRobin(pool) {
		const index = this.cursor % pool.length;
		const account = pool[index];
		if (account === void 0) return void 0;
		this.cursor = (index + 1) % pool.length;
		return account;
	}
	/** 记住对话绑定的账号，维持 LRU 顺序。 */
	bindAffinity(conversationKey, accountId) {
		this.affinity.delete(conversationKey);
		this.affinity.set(conversationKey, accountId);
		while (this.affinity.size > STICKY_AFFINITY_LIMIT) {
			const oldest = this.affinity.keys().next().value;
			if (oldest === void 0) break;
			this.affinity.delete(oldest);
		}
	}
	/**
	* sticky：该对话已绑定的账号（当它仍能为被请求的模型服务时）。
	* 无绑定或绑定不再合格时返回 undefined —— 调用方随后重绑，这正是限流对话
	* 跳到新账号而不是失败的机制。
	*/
	affinityAccount(pool, conversationKey) {
		if (conversationKey === void 0 || conversationKey === "") return void 0;
		const boundId = this.affinity.get(conversationKey);
		if (boundId === void 0) return void 0;
		const bound = pool.find((account) => account.id === boundId);
		if (bound === void 0) {
			this.affinity.delete(conversationKey);
			return;
		}
		this.bindAffinity(conversationKey, boundId);
		return bound;
	}
	/** 当前记住的绑定数（测试/诊断）。 */
	affinitySize() {
		return this.affinity.size;
	}
	/** 忘掉全部对话绑定（测试与设置变更）。 */
	clearAffinity() {
		this.affinity.clear();
	}
	/**
	* balanced：对合格账号按空闲权重随机抽取。
	* 权重 = 1 + min(idleHours * 0.5, 5)。刚服务过的账号输给闲置久的账号，
	* 小池不会锤死单个账号。无空闲历史的池权重全等，首批请求被摊开。
	*/
	pickByWeight(pool) {
		if (pool.length === 1) return pool[0];
		const now = Date.now();
		const weights = pool.map((account) => idleWeight(account.lastUsedAt, now));
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		if (!Number.isFinite(total) || total <= 0) return pool[0];
		let roll = Math.random() * total;
		for (let index = 0; index < pool.length; index += 1) {
			roll -= weights[index] ?? 0;
			if (roll < 0) return pool[index];
		}
		return pool[pool.length - 1];
	}
	/**
	* expiry：积分包最近到期的账号先服务。
	*
	* 积分包是 use-it-or-lose-it，先花将死的比摊开花严格更优。无已知到期的
	* 账号排在最后 —— 「还没看」绝不能压过真实截止时间。没有任何到期读数的池
	* 表现得与 priority 一致（诚实的退化）。
	*/
	pickByExpiry(pool) {
		let best;
		let bestAt = Number.POSITIVE_INFINITY;
		for (const account of pool) {
			const at = this.creditExpiry.get(account.id);
			if (at === void 0) continue;
			if (at < bestAt) {
				best = account;
				bestAt = at;
			}
		}
		return best ?? pool[0];
	}
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
	async acquire(modelId, region, conversationKey) {
		if (this.accounts.length === 0) await this.scan();
		const maxTries = this.accounts.length + 1;
		for (let attempt = 0; attempt < maxTries; attempt += 1) {
			let pool = this.available(Date.now(), modelId, region);
			if (pool.length === 0 && attempt === 0) {
				await this.scan();
				pool = this.available(Date.now(), modelId, region);
			}
			if (pool.length === 0) return void 0;
			if (this.preferredId !== void 0) {
				const preferred = pool.find((account) => account.id === this.preferredId);
				if (preferred !== void 0 && await this.ensureFresh(preferred)) return preferred;
			}
			if (this.distribution === "sticky") {
				const bound = this.affinityAccount(pool, conversationKey);
				if (bound !== void 0 && await this.ensureFresh(bound)) return bound;
			}
			const account = this.distribution === "round-robin" || this.distribution === "sticky" ? this.pickRoundRobin(pool) : this.distribution === "balanced" ? this.pickByWeight(pool) : this.distribution === "expiry" ? this.pickByExpiry(pool) : pool[0];
			if (account === void 0) return void 0;
			if (!await this.ensureFresh(account)) continue;
			if (this.distribution === "sticky" && conversationKey !== void 0 && conversationKey !== "") this.bindAffinity(conversationKey, account.id);
			return account;
		}
	}
	/** 记录一个账号实际服务了请求（上游 200 后由调用方调用；balanced 权重读同一表）。 */
	noteServed(accountId) {
		if (!this.accounts.some((account) => account.id === accountId)) return;
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		account.lastUsedAt = Date.now();
	}
	/**
	* 记录一个账号最近的积分余额与最近积分包到期时刻。
	*
	* 到期时间直写不合并：已花掉或已过期的包从下一次读数消失，保留陈旧截止
	* 时间会把池钉在一个积分已经没了的账号上 —— 与 expiry 模式的意图相反。
	*/
	noteCredits(accountId, balance, nearestExpiryMs) {
		if (!Number.isFinite(balance)) return;
		if (!this.accounts.some((account) => account.id === accountId)) return;
		this.creditBalances.set(accountId, balance);
		if (nearestExpiryMs === void 0 || !Number.isFinite(nearestExpiryMs)) {
			this.creditExpiry.delete(accountId);
			return;
		}
		this.creditExpiry.set(accountId, nearestExpiryMs);
	}
	/** 某账号最近的积分包到期时刻；未知为 undefined。 */
	creditExpiryOf(accountId) {
		return this.creditExpiry.get(accountId);
	}
	/** 某账号最近已知余额；从未读过为 undefined。 */
	creditsOf(accountId) {
		return this.creditBalances.get(accountId);
	}
	/** 某账号的积分保留线；未设置为 0。 */
	creditReserveOf(accountId) {
		return this.creditReserves.get(accountId) ?? 0;
	}
	/** 整体替换全部保留线（设置页每次 apply 调用，镜像保存的文档）。 */
	setCreditReserves(reserves) {
		const next = /* @__PURE__ */ new Map();
		for (const [id, value] of Object.entries(reserves)) if (Number.isFinite(value) && value > 0) next.set(id, Math.floor(value));
		this.creditReserves = next;
	}
	/** 当前生效的全部保留线，键为账号 id。 */
	creditReservesInOrder() {
		const out = {};
		for (const account of this.accounts) {
			const reserve = this.creditReserves.get(account.id);
			if (reserve !== void 0 && reserve > 0) out[account.id] = reserve;
		}
		return out;
	}
	/** 账号是否仅因保留线被扣住（卡片区分「保分」与其他不可用原因）。 */
	isReserved(accountId) {
		const reserve = this.creditReserves.get(accountId);
		if (reserve === void 0 || reserve <= 0) return false;
		const balance = this.creditBalances.get(accountId);
		return balance !== void 0 && balance <= reserve;
	}
	/** 最近实际服务的账号 id（卡片回答「我现在在用哪个账号」）。 */
	lastServedId() {
		let newest;
		for (const account of this.accounts) {
			if (account.lastUsedAt === void 0) continue;
			if (newest === void 0 || account.lastUsedAt > newest.at) newest = {
				id: account.id,
				at: account.lastUsedAt
			};
		}
		return newest?.id;
	}
	/** 会话失效后对单个账号的尽力刷新（卡片手动刷新按钮）。 */
	async refreshAccount(accountId, options) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return false;
		return await this.ensureFresh(account, options?.force === true);
	}
	/**
	* 因上游拒绝登录（401/403）冷却整个账号。
	* 有直接证据时调用（请求刚返回 session_dead），不用猜：没有它，同一请求的
	* 下一次重试还会选中同一账号 —— 其凭据文件仍然声称有效 —— 8 次尝试全花在
	* 一个死账号上，健康账号永远轮不上。
	*/
	penalizeCredentialDead(accountId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		const until = Date.now() + this.credentialDeadCooldownMs;
		account.credentialDeadUntilMs = Math.max(account.credentialDeadUntilMs ?? 0, until);
		this.logger?.warn(`dsh-connect-trae-models: ${account.label} 登录被上游拒绝；${new Date(until).toISOString()} 前不参与轮转（重新登录可恢复）`);
	}
	/** 凭据被证明重新有效后把账号放回轮转。 */
	clearCredentialDead(accountId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		account.credentialDeadUntilMs = 0;
	}
	/** 当前因登录被拒而退出轮转的账号。 */
	deadCredentials() {
		const now = Date.now();
		return this.accounts.filter((account) => (account.credentialDeadUntilMs ?? 0) > now);
	}
	/**
	* 在过期余量内（或已过期）时刷新账号的 access token，按账号 in-flight 去重。
	* 刷新失败但 token 尚未过期时保留现有 token：刷新端点不可达绝不能掀翻一个
	* 还能用的会话。刷新成功是登录仍然活着的最强证明 —— 清掉任何先前的死标记。
	*/
	async ensureFresh(account, force = false) {
		const client = this.client;
		if (client === void 0) return true;
		const credential = account.credential;
		if (!(credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + this.refreshMarginMs) && !force) return true;
		const existing = this.refreshInflight.get(account.id);
		if (existing !== void 0) {
			await existing;
			return (account.credentialDeadUntilMs ?? 0) <= Date.now();
		}
		const run = (async () => {
			if (credential.refreshToken === void 0 || credential.refreshToken === "") {
				if (credential.expiresAtMs > Date.now() + 3e4) return true;
				this.logger?.warn(`dsh-connect-trae-models: ${account.label} token 已过期且无 refresh token，请在 Trae 重新登录`);
				this.penalizeCredentialDead(account.id);
				return false;
			}
			try {
				const outcome = await client.refresh(credential);
				account.credential = {
					...credential,
					accessToken: outcome.accessToken,
					...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
					expiresAtMs: outcome.expiresAtMs,
					...outcome.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: outcome.refreshExpiresAtMs },
					...outcome.host === void 0 || outcome.host === "" ? {} : { host: outcome.host },
					source: "dsh"
				};
				this.clearCredentialDead(account.id);
				this.logger?.info?.(`dsh-connect-trae-models: 已刷新 ${account.label} 的 token`);
				return true;
			} catch (error) {
				if (isCredentialDeadError(error)) {
					this.penalizeCredentialDead(account.id);
					this.logger?.warn?.(`dsh-connect-trae-models: ${account.label} 的 refresh token 已被上游吊销；请重新登录恢复`, error);
					return false;
				}
				if (credential.expiresAtMs > Date.now() + 3e4) this.logger?.warn?.(`dsh-connect-trae-models: token 刷新失败但 ${account.label} 的 token 仍有效`, error);
				else this.logger?.error?.(`dsh-connect-trae-models: token 刷新失败且 ${account.label} 的 token 已过期`, error);
				return true;
			}
		})();
		this.refreshInflight.set(account.id, run);
		try {
			return await run;
		} finally {
			this.refreshInflight.delete(account.id);
		}
	}
	/**
	* 上游报告积分耗尽（hard_credit）后冷却整账号。
	* 欠费是账号级条件（与按模型的限流相反）：该账号的全部模型在配额重置前
	* 都不可用，因此整账号冷却（不带 modelId）30 分钟。
	*/
	penalizeExhausted(accountId) {
		const until = Date.now() + this.exhaustCooldownMs;
		this.penalize(accountId, until);
		this.logger?.warn(`dsh-connect-trae-models: 账号积分耗尽；整账号冷却至 ${new Date(until).toISOString()}`);
	}
	/**
	* 标记账号（或其某模型）被限流。
	*
	* 带 modelId：只冷却该账号上的该模型 —— 上游的限流按模型计
	* （「可切换其他模型继续使用」），同账号其他模型留在轮转里。
	* 不带 modelId：冷却整账号，调用方应只对真正横跨全部模型的限制这么用。
	*/
	penalize(accountId, resetAtMs, modelId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		account.rateLimitHits += 1;
		const until = resetAtMs ?? Date.now() + this.cooldownMs;
		if (modelId !== void 0 && modelId !== "") {
			account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until);
			this.logger?.warn(`dsh-connect-trae-models: ${account.label} 的模型 ${modelId} 被限流；冷却至 ${new Date(until).toISOString()}`);
			return;
		}
		account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until);
		this.logger?.warn(`dsh-connect-trae-models: 账号 ${account.label} 被限流；冷却至 ${new Date(until).toISOString()}`);
	}
	/** 清除全部冷却（整账号与按模型），如设置页的重置按钮。 */
	resetCooldowns() {
		for (const account of this.accounts) {
			account.cooldownUntilMs = 0;
			account.modelCooldowns = {};
			account.rateLimitHits = 0;
			account.credentialDeadUntilMs = 0;
		}
	}
	/** 诊断快照。整账号冷却计数（按模型冷却不计：只限一个模型时账号整体仍可用）。 */
	status() {
		const now = Date.now();
		return {
			count: this.accounts.length,
			cooling: this.accounts.filter((account) => account.cooldownUntilMs > now).length,
			dead: this.accounts.filter((account) => (account.credentialDeadUntilMs ?? 0) > now).length,
			lastScanAtMs: this.lastScanAtMs
		};
	}
	/** 每个候选路径为何没有得到账号（卡片诊断）。 */
	async diagnose() {
		return this.store.diagnose();
	}
};
/** 人类可读标签：账号名优先，缺失时 `userId 前 8 位#`。 */
function accountLabel(credential) {
	const name = credential.accountName;
	const discriminator = credential.userId.slice(0, 8);
	if (name !== void 0 && name !== "") return discriminator === "" ? name : `${name}#${discriminator}`;
	return discriminator === "" ? "Trae" : `${discriminator}#`;
}
/** 便捷组合：凭据 → 池账号 id（与 traeAccountId 一致，供外部对账）。 */
function traePoolAccountId(credential) {
	return traeAccountId(credential);
}
//#endregion
//#region src/status-paths.ts
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
const TRAE_POOL_ROUTE_PREFIX = "/plugins/dsh-connect-trae-models";
/** 只读池状态（账号行 + 模型 + shim + 自动化）。 */
const TRAE_POOL_STATUS_PATH = `${TRAE_POOL_ROUTE_PREFIX}/status`;
/** 重新扫描本机 Trae 凭据（重读桌面快照）。 */
const TRAE_POOL_RESCAN_PATH = `${TRAE_POOL_ROUTE_PREFIX}/accounts/rescan`;
/** 清除全部限流冷却。 */
const TRAE_POOL_RESET_COOLDOWN_PATH = `${TRAE_POOL_ROUTE_PREFIX}/cooldowns/reset`;
/**
* 手动签到（本插件**唯一**会改上游账号状态的用户触发路由）。
*
* 守卫比其它路由严得多：仅 POST、仅回环 origin、且读写顺序强制「先读状态、
* 再决定是否 claim」，见 `web-status.ts` 的 JSDoc。
*/
const TRAE_POOL_CHECKIN_PATH = `${TRAE_POOL_ROUTE_PREFIX}/checkin`;
/** 保存某区域的模型选择（写 settings 分区）。 */
const TRAE_POOL_MODELS_SAVE_PATH = `${TRAE_POOL_ROUTE_PREFIX}/models/save`;
/** 开关一个账号是否参与轮转。 */
const TRAE_POOL_ACCOUNT_TOGGLE_PATH = `${TRAE_POOL_ROUTE_PREFIX}/accounts/disabled`;
/** 立即运行一次自动化 job（卡片「立即运行」按钮）。 */
const TRAE_POOL_AUTOMATION_RUN_PATH = `${TRAE_POOL_ROUTE_PREFIX}/automation/run`;
/**
* 钉选优先账号：被钉住的账号只要合格就绝对优先派活（对话栏「切换用户」用它）。
*
* 只影响本机的派活顺序，不改上游账号状态、也不写凭据——与「停用账号」是两件
* 不同的事：停用是不让它参与轮转，钉选是在参与者里指定首选。
*/
const TRAE_POOL_ACCOUNT_SELECT_PATH = `${TRAE_POOL_ROUTE_PREFIX}/accounts/select`;
/** 默认区域（参数缺失时）。 */
const TRAE_POOL_DEFAULT_REGION = "cn";
/**
* 签到 job 的默认执行时刻（本地小时，Asia/Shanghai）。
*
* 放在这个 Node-free 共享层而不是 `scheduler.ts`，因为浏览器半端也要用它：
* 卡片切换自动化开关时必须把小时列表一并写回，而列表为空时要回落到宿主的
* 同一默认值，否则卡片写一份「跑不起来的日程」而宿主再也读不回来。两份手抄
* 的常量必然漂移，且漂移是无声的。
*/
const DEFAULT_CHECKIN_HOURS = [9];
/**
* 剥掉一层 volatile 活引用。
*
* 0.1.7 把一个 volatile 字段以 `{ get(): T }` 交回而不是裸值，因此每次读标记
* 字段都要解包：把引用往下一层传会拿对象去和字符串比较，字段被当成未设置。
* 0.1.5 上字段已是裸值，这里是恒等。
*/
function unwrapVolatile(value) {
	if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
	return value;
}
/**
* 深拷贝一个配置值，把里面每一个活 `{get(): T}` 引用换它解析出的值。
*
* {@link unwrapVolatile} 只剥普通读取需要的那一层。settings 服务不同：它要校验
* 并 `structuredClone` **整个**对象，任何残留引用都会让校验失败。
*/
function unwrapVolatileDeep(value) {
	const peeled = unwrapVolatile(value);
	if (Array.isArray(peeled)) return peeled.map((entry) => unwrapVolatileDeep(entry));
	if (peeled !== null && typeof peeled === "object") {
		const out = {};
		for (const [key, entry] of Object.entries(peeled)) out[key] = unwrapVolatileDeep(entry);
		return out;
	}
	return peeled;
}
/**
* 解析区域查询参数。
*
* 返回 `undefined` 表示**非法**（调用方答 400），而不是悄悄回落：卡片 tab 与
* 文档必须指向同一个区域，静默回落会让用户看着 ai 的标签页读 cn 的数据。缺省
* （参数不存在）才取 {@link TRAE_POOL_DEFAULT_REGION}。
*/
function parseRegionParam(value) {
	if (value === null || value === void 0 || value === "") return "cn";
	if (value === "cn" || value === "ai") return value;
}
//#endregion
//#region src/scheduler.ts
/** 调度循环的唤醒间隔（毫秒）。 */
const AUTOMATION_TICK_MS = 6e4;
/**
* 签到判定的时区。
*
* 上游按**北京自然日**幂等（同一日重复 claim 仍回 code 0 但额度不变），所以
* 「今天签没签」必须用北京日算，而不是跑 DSH 那台机器的本地日。用 `getHours()`
* 会让「09:00」变成宿主本地 09:00 —— 在非东八区机器上就是一次永远不到点的签到。
*/
const AUTOMATION_TIME_ZONE = "Asia/Shanghai";
/** 全部 job 种类（运行顺序即此顺序）。 */
const AUTOMATION_JOB_KINDS = ["checkin"];
/** 校准 hour list：空列表回落到默认值。 */
function hoursOrDefault(hours, fallback) {
	if (hours === void 0 || hours.length === 0) return fallback;
	return [...new Set(hours.filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))].sort((a, b) => a - b);
}
/** `date` 在 `timeZone` 下的日历部件（全部为补零字符串）。 */
function zonedParts(date, timeZone = AUTOMATION_TIME_ZONE) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(date);
	const pick = (type) => parts.find((part) => part.type === type)?.value ?? "00";
	return {
		year: pick("year"),
		month: pick("month"),
		day: pick("day"),
		hour: pick("hour")
	};
}
/**
* `date` 所属的自然日，`YYYY-MM-DD`（默认北京时区）。
*
* 上游按北京自然日判幂等，账本的日界必须与它一致；跨日重置也靠这个键。
*/
function dayKey(date, timeZone = AUTOMATION_TIME_ZONE) {
	const { year, month, day } = zonedParts(date, timeZone);
	return `${year}-${month}-${day}`;
}
/**
* `date` 所在的调度时段，`YYYY-MM-DDTHH`。
*
* 逐 job 的运行闸门以它为键，因此配了多个小时的 job 在每个小时各跑一次，而
* 同一个小时内的第二次 tick 仍被拒。
*/
function slotKey(date, timeZone = AUTOMATION_TIME_ZONE) {
	const { hour } = zonedParts(date, timeZone);
	return `${dayKey(date, timeZone)}T${hour}`;
}
/** `now` 所在小时是否属于 `hours`。 */
function isFireHour(now, hours, timeZone = AUTOMATION_TIME_ZONE) {
	return hours.includes(Number(zonedParts(now, timeZone).hour));
}
const sleep = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});
/** 账号短标签（明细行用）。 */
function accountWord(account) {
	return account.label === "" ? account.id.slice(0, 8) : account.label;
}
/** 签到所得金额：基础 + 额外。面额永远取运行时值，绝不硬编码（一年内已四次变动）。 */
function claimCredit(status) {
	return status.credits + (status.extraCredits ?? 0);
}
/**
* 积分自动化调度器。
*
* 循环每分钟醒一次，某 job 的某个配置小时**已经过去且该时段尚未消费**时触发。
* 「已消费」按 job 记为 `YYYY-MM-DDTHH` 集合，跨日自动作废。
*
* 一切串行且失败隔离：一个账号抛错只跳过该账号并继续下一个，一次 job 抛错绝不
* 停止循环。ai 区域账号整类跳过 —— 国际版没有 `/ug/*` 端点族（实测 404）。
*/
var TraeScheduler = class {
	enabled;
	checkinHours;
	extraJobHours;
	delayMs;
	now;
	logger;
	pool;
	client;
	/** 逐 job 的运行记录。 */
	states = { checkin: {
		ok: 0,
		failed: 0,
		claimed: 0,
		credit: 0,
		deviceSpent: 0
	} };
	/** 今日各账号收益。 */
	earnings = /* @__PURE__ */ new Map();
	/** 当前 earnings 所属的北京日。 */
	earningsDate;
	/** 最近一次运行的整体结果（状态文档用）。 */
	lastPass;
	lastPassAtMs;
	timer;
	running = false;
	stopped = false;
	/** 一次运行在途（tick 与手动触发共用一个闸门）。 */
	busy = false;
	/** 整轮在途（startRunAll 的返回依据）。 */
	runInFlight = false;
	saveEarningsFn;
	/**
	* @param pool 多账号池（T2）。签约只遍历 `pool.list('cn')`。
	* @param client 上游客户端（T3）。
	* @param options 配置；`enabled` 缺省 false。
	*/
	constructor(pool, client, options = {}) {
		this.pool = pool;
		this.client = client;
		this.now = options.now ?? (() => /* @__PURE__ */ new Date());
		this.logger = options.logger ?? {};
		this.delayMs = options.accountDelayMs ?? 800;
		this.checkinHours = hoursOrDefault(options.checkinHours, DEFAULT_CHECKIN_HOURS);
		this.extraJobHours = [...options.extraJobHours ?? []];
		this.earningsDate = dayKey(this.now());
		const restored = options.loadEarnings?.();
		if (restored !== void 0 && restored.date === this.earningsDate) for (const [id, entry] of Object.entries(restored.accounts)) this.earnings.set(id, entry);
		if (options.saveEarnings !== void 0) this.saveEarningsFn = options.saveEarnings;
		this.enabled = options.enabled ?? false;
	}
	/** 安装持久化钩子（宿主 settings 服务就绪后调用）。 */
	setEarningsPersistence(save) {
		this.saveEarningsFn = save;
	}
	/**
	* 折入一份此前持久化的账本（当它属于今天时）。
	*
	* 设置文档可读发生在构造之后，所以要有这个后置入口；更早日期的账本被忽略，
	* 计数因此永远不会把昨天说成今天。
	*/
	applyEarningsLedger(ledger) {
		const today = dayKey(this.now());
		if (ledger.date !== today) return;
		for (const [id, entry] of Object.entries(ledger.accounts)) this.earnings.set(id, entry);
		this.earningsDate = today;
	}
	/** 应用新配置；运行中调用是安全的。 */
	applyConfig(options) {
		if (options.enabled !== void 0) this.enabled = options.enabled;
		if (options.checkinHours !== void 0) this.checkinHours = hoursOrDefault(options.checkinHours, DEFAULT_CHECKIN_HOURS);
		if (options.extraJobHours !== void 0) this.extraJobHours = [...options.extraJobHours];
	}
	/** 启动循环。幂等。 */
	start() {
		if (this.timer !== void 0) return;
		this.stopped = false;
		this.running = true;
		this.timer = setInterval(() => {
			this.tick();
		}, AUTOMATION_TICK_MS);
		this.timer.unref?.();
	}
	/** 停止循环。幂等，且可在 `start` 之前调用。 */
	stop() {
		this.stopped = true;
		this.running = false;
		if (this.timer !== void 0) {
			clearInterval(this.timer);
			this.timer = void 0;
		}
	}
	/** 状态快照。 */
	status() {
		return {
			enabled: this.enabled,
			running: this.running,
			checkinHours: [...this.checkinHours],
			jobs: { checkin: { ...this.states.checkin } },
			earningsToday: this.earningsSnapshot(),
			runInProgress: this.runInFlight,
			...this.lastPassAtMs === void 0 ? {} : { lastPassAtMs: this.lastPassAtMs },
			...this.lastPass === void 0 ? {} : { lastPass: this.lastPass }
		};
	}
	/** 手动触发（卡片按钮）：后台推进整轮并立刻返回是否启动。 */
	startRunAll(job, force = false) {
		if (this.runInFlight) return false;
		this.runInFlight = true;
		this.runAll(job, force).catch((error) => {
			this.logger.warn?.("dsh-connect-trae-models automation run failed:", error);
		}).finally(() => {
			this.runInFlight = false;
		});
		return true;
	}
	/**
	* 运行一轮（可指定单个 job）。
	*
	* `force` 绕过「今天已跑过」闸门，也就是「再按一次按钮」的含义。手动运行
	* **不消费调度时段**：10:35 按一次「立即运行」绝不能取消 21:00 那个时段。
	*/
	async runAll(job, force = false) {
		const jobs = job === void 0 ? AUTOMATION_JOB_KINDS : [job];
		this.rollEarnings(dayKey(this.now()));
		const merged = {};
		for (const kind of jobs) {
			const gained = await this.runJob(kind, force);
			for (const [id, gain] of Object.entries(gained)) {
				const existing = merged[id];
				merged[id] = {
					credit: (existing?.credit ?? 0) + gain.credit,
					checkinCredit: (existing?.checkinCredit ?? 0) + gain.checkinCredit,
					...existing?.deviceSpent === true || gain.deviceSpent === true ? { deviceSpent: true } : {}
				};
			}
		}
		this.lastPass = merged;
		this.lastPassAtMs = this.now().getTime();
		return merged;
	}
	/**
	* 运行单个 job 的全部账号。
	*
	* 串行遍历，账号级 try/catch 隔离：一个账号的 token 失效、429 或畸形载荷
	* 绝不能花掉其他账号当天的签到。
	*/
	async runJob(kind, force = false) {
		const now = this.now();
		const today = dayKey(now);
		const state = this.states[kind];
		const slot = slotKey(now);
		if (!force && state.lastFiredHour === slot) return {};
		if (this.busy) return {};
		this.busy = true;
		const ctx = {
			today,
			detail: [],
			gained: {}
		};
		try {
			const accounts = this.eligibleAccounts();
			for (let index = 0; index < accounts.length; index += 1) {
				if (this.stopped) break;
				const account = accounts[index];
				try {
					await this.runCheckin(account, ctx);
				} catch (error) {
					state.failed += 1;
					this.logger.warn?.(`automation checkin ${accountWord(account)} failed:`, error);
					ctx.detail.push(`${accountWord(account)}: 失败（${describeError(error)}）`);
				}
				if (index < accounts.length - 1 && this.delayMs > 0 && !this.stopped) await sleep(this.delayMs);
			}
		} finally {
			this.busy = false;
		}
		state.lastFiredHour = slot;
		state.lastRunDate = today;
		state.lastRunSlot = slot;
		state.lastRunAtMs = this.now().getTime();
		state.message = this.summarise(kind, state);
		state.detail = ctx.detail;
		this.logger.info?.(`automation ${kind}: ${state.message}`);
		return ctx.gained;
	}
	/**
	* 参与自动化的账号：CN 区域、未禁用。
	*
	* **不跳过冷却账号**（与 workbuddy scheduler 的刻意差异）：Trae 的账户级冷却
	* 是对话路由的闸门（429 限流 / 欠费 30 分钟），签到走独立的 pay/ug 端点，
	* 不该被对话侧限流连坐——跳过它只会让当天还能签到的账号白错过。
	*/
	eligibleAccounts() {
		return this.pool.list("cn").filter((account) => !this.pool.isDisabled(account.id));
	}
	/** 单账号签到：status → enable/checked_in/did_checked_in 判定 → claim → 读回刷新。 */
	async runCheckin(account, ctx) {
		const state = this.states.checkin;
		const label = accountWord(account);
		const request = {
			credential: account.credential,
			identity: this.requestIdentity()
		};
		const deviceId = this.deviceId();
		const status = await this.client.fetchCheckinStatus(request, deviceId);
		if (!status.enabled) {
			state.ok += 1;
			ctx.detail.push(`${label}: 签到活动未开启`);
			return;
		}
		if (status.checkedIn) {
			state.ok += 1;
			ctx.detail.push(`${label}: 今日已签到（${status.credits} 积分已到账）`);
			this.recordEarnings(account.id, ctx.today, {
				credit: 0,
				checkinCredit: 0
			});
			return;
		}
		if (status.didCheckedIn) {
			state.ok += 1;
			state.deviceSpent += 1;
			ctx.detail.push(`${label}: 本机今日签到名额已被其他账号占用（该账号未获得）`);
			this.recordEarnings(account.id, ctx.today, {
				credit: 0,
				checkinCredit: 0,
				deviceSpent: true
			});
			ctx.gained[account.id] = {
				credit: 0,
				checkinCredit: 0,
				deviceSpent: true
			};
			return;
		}
		if (deviceId === "") {
			state.ok += 1;
			ctx.detail.push(`${label}: 读不到本机设备号，跳过领取（上游会回 9004）`);
			return;
		}
		const claim = await this.client.claimCheckin(request, deviceId);
		if (claim.claimed) {
			const credit = claimCredit(await this.client.fetchCheckinStatus(request, deviceId).catch(() => status));
			state.ok += 1;
			state.claimed += 1;
			state.credit += credit;
			ctx.detail.push(`${label}: 签到成功 +${credit} 积分`);
			this.recordEarnings(account.id, ctx.today, {
				credit,
				checkinCredit: credit
			});
			ctx.gained[account.id] = {
				credit,
				checkinCredit: credit
			};
			return;
		}
		if (claim.code === 9095) {
			state.ok += 1;
			state.deviceSpent += 1;
			ctx.detail.push(`${label}: 本机今日已签到（上游 9095），未发放`);
			this.recordEarnings(account.id, ctx.today, {
				credit: 0,
				checkinCredit: 0,
				deviceSpent: true
			});
			ctx.gained[account.id] = {
				credit: 0,
				checkinCredit: 0,
				deviceSpent: true
			};
			return;
		}
		if (claim.code === 9004) {
			state.failed += 1;
			ctx.detail.push(`${label}: 上游拒绝（9004 设备头未被接受）：${claim.message}`);
			return;
		}
		state.failed += 1;
		ctx.detail.push(`${label}: 领取被拒（code ${claim.code}）：${claim.message}`);
	}
	/** 本机身份（缓存）。 */
	identity;
	/** 注入本机身份（池扫描或宿主启动时解析一次）。 */
	setIdentity(identity) {
		this.identity = identity;
	}
	/** 当前注入的身份（诊断用；永不回显 token 材料）。 */
	currentIdentity() {
		return {
			deviceId: this.deviceId(),
			machineId: this.identity?.machineId ?? ""
		};
	}
	/**
	* 本次请求携带的本机身份。
	*
	* 未注入身份时给一个最小占位：签到路由只需要 `x-device-id` 的值判定设备口径，
	* 缺身份时 {@link deviceId} 返回空串、claim 会被跳过，因此这里不需要伪造任何
	* 真实身份字段（RESEARCH.md §1.2 明确排除设备号伪造）。
	*/
	requestIdentity() {
		const identity = this.identity;
		if (identity === void 0) return {
			machineId: "",
			deviceId: "",
			platform: process.platform
		};
		return identity;
	}
	/** 本机设备号；读不到时是空串（`x-device-id` 的判定量）。 */
	deviceId() {
		return this.identity?.deviceId ?? "";
	}
	/** 一行总结。 */
	summarise(kind, state) {
		const parts = [`${state.ok} 个账号已处理`];
		if (state.claimed > 0) parts.push(`${state.claimed} 个领取成功 +${state.credit} 积分`);
		if (state.deviceSpent > 0) parts.push(`${state.deviceSpent} 个本机名额受限`);
		if (state.failed > 0) parts.push(`${state.failed} 个失败`);
		return `签到：${parts.join("，")}`;
	}
	/** 某个 job 今天已消费的时段集合。 */
	firedSlotsOf(kind) {
		const stored = this.states[kind].firedSlots;
		if (stored === void 0) return /* @__PURE__ */ new Set();
		const today = dayKey(this.now());
		return new Set(stored.filter((entry) => entry.startsWith(`${today}T`)));
	}
	/** 记录一个已消费的调度时段。 */
	consumeSlot(kind, slot) {
		const today = dayKey(this.now());
		const next = /* @__PURE__ */ new Set([...this.firedSlotsOf(kind), slot]);
		this.states[kind].firedSlots = [...next].filter((entry) => entry.startsWith(`${today}T`)).sort();
	}
	/**
	* 此刻该 job 的到期时段，没有则 undefined。
	*
	* **最早**的未消费候选胜出，这样多时段配置才完整：消费掉最早的那个，把更晚
	* 的留给它自己的小时。
	*/
	dueSlot(kind, now) {
		const hours = this.hoursOf(kind);
		if (hours.length === 0) return void 0;
		const current = Number(zonedParts(now).hour);
		const today = dayKey(now);
		const fired = this.firedSlotsOf(kind);
		for (const candidate of [...hours].sort((a, b) => a - b)) {
			if (candidate > current) break;
			const slot = `${today}T${String(candidate).padStart(2, "0")}`;
			if (!fired.has(slot)) return slot;
		}
	}
	/** 一个 job 配置的小时。 */
	hoursOf(kind) {
		switch (kind) {
			case "checkin": return this.checkinHours;
		}
	}
	/**
	* 循环体：到点就跑。
	*
	* 状态筛选（enabled / stopped / busy）与异常隔离都在这里，保证循环本身绝不
	* 被一次失败拖死。
	*/
	async tick() {
		if (!this.enabled || this.stopped || this.busy) return;
		try {
			const now = this.now();
			const slot = slotKey(now);
			this.rollEarnings(dayKey(now));
			for (const kind of AUTOMATION_JOB_KINDS) {
				if (this.stopped) return;
				const consumed = this.dueSlot(kind, now);
				if (consumed === void 0) continue;
				if (this.states[kind].lastFiredHour === slot) continue;
				this.consumeSlot(kind, consumed);
				await this.runJob(kind, true);
			}
		} catch (error) {
			this.logger.warn?.("dsh-connect-trae-models automation tick failed:", error);
		}
	}
	/** 今日各账号收益（先跨日重置，避免午夜后读到昨天的合计）。 */
	earningsSnapshot() {
		this.rollEarnings(dayKey(this.now()));
		const out = {};
		for (const [id, entry] of this.earnings) out[id] = { ...entry };
		return out;
	}
	/** 把一次所得累加进当日账本；0 所得且无设备占用的记录不落账。 */
	recordEarnings(accountId, today, delta) {
		this.rollEarnings(today);
		const existing = this.earnings.get(accountId);
		const credit = (existing?.credit ?? 0) + delta.credit;
		const checkinCredit = (existing?.checkinCredit ?? 0) + delta.checkinCredit;
		const deviceSpent = existing?.deviceSpent === true || delta.deviceSpent === true;
		if (credit === 0 && checkinCredit === 0 && !deviceSpent) return;
		this.earnings.set(accountId, {
			credit,
			checkinCredit,
			date: today,
			...deviceSpent ? { deviceSpent: true } : {}
		});
		this.persistEarnings();
	}
	/** 北京日翻转时清空逐账号计数。 */
	rollEarnings(today) {
		if (this.earningsDate === today) return;
		this.earnings.clear();
		this.earningsDate = today;
		for (const kind of AUTOMATION_JOB_KINDS) {
			const state = this.states[kind];
			state.firedSlots = [];
			state.lastFiredHour = void 0;
			state.lastRunSlot = void 0;
			state.lastRunDate = void 0;
		}
		this.lastPass = void 0;
		this.persistEarnings();
	}
	/** 账本快照落盘（无钩子时静默）。 */
	persistEarnings() {
		if (this.saveEarningsFn === void 0) return;
		const ledger = {
			date: this.earningsDate,
			accounts: this.earningsSnapshot()
		};
		try {
			const outcome = this.saveEarningsFn(ledger);
			if (outcome instanceof Promise) outcome.catch(() => {});
		} catch (error) {
			this.logger.warn?.("dsh-connect-trae-models automation ledger save failed:", error);
		}
	}
	/** 暴露给状态文档的时段闸门（测试与诊断用）。 */
	firedSlots(kind) {
		return [...this.firedSlotsOf(kind)];
	}
	/** 当前配置的扩展 job 时段（暂无 job 消费，见 AutomationOptions.extraJobHours）。 */
	extensionHours() {
		return [...this.extraJobHours];
	}
	/** 单次 tick 的显式入口（测试用；生产由定时器驱动）。 */
	async runDueNow() {
		await this.tick();
	}
};
/** 错误的一句话描述（明细行用，绝不回显 token）。 */
function describeError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}
//#endregion
//#region src/model-metadata.ts
function finitePositive$1(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/** `features` 在 wire 上是内嵌 JSON 字符串。 */
function parseFeatures(value) {
	if (typeof value !== "string" || value === "") return void 0;
	try {
		return record(JSON.parse(value));
	} catch {
		return;
	}
}
const EFFORT_MAP = {
	light: "low",
	high: "high",
	extra_high: "xhigh"
};
/** 只解析 Trae 远端模型 API 明确宣告的能力。 */
function parseTraeRemoteModel(value) {
	const raw = record(value);
	if (raw === void 0 || typeof raw.name !== "string" || raw.name === "") return void 0;
	const context = record(raw.context_window_tokens);
	const dev = finitePositive$1(context?.["dev"]);
	const max = raw.max_mode === true ? finitePositive$1(context?.["max"]) : void 0;
	const features = parseFeatures(raw.features);
	const consumption = record(features?.["consumption_rate"]);
	const consumptionData = record(consumption?.["data"]);
	const creditMultiplier = consumption?.["enable"] === true ? finitePositive$1(consumptionData?.["rate"]) : void 0;
	const reasoningSupported = record(features?.["reasoning"])?.["enable"] === true;
	const reasoningConfig = record(raw.reasoning_effort_config);
	const supported = (Array.isArray(reasoningConfig?.["options"]) ? reasoningConfig["options"] : []).flatMap((option) => {
		if (typeof option !== "string") return [];
		const effort = EFFORT_MAP[option];
		return effort === void 0 ? [] : [effort];
	});
	const rawDefault = reasoningConfig?.["default_level"];
	const mappedDefault = typeof rawDefault === "string" ? EFFORT_MAP[rawDefault] : void 0;
	const defaultEffort = mappedDefault !== void 0 && supported.includes(mappedDefault) ? mappedDefault : void 0;
	return {
		id: raw.name,
		name: typeof raw.display_name === "string" && raw.display_name !== "" ? raw.display_name : raw.name,
		multimodal: raw.multimodal === true,
		...dev === void 0 ? {} : { contextWindow: dev },
		...max === void 0 ? {} : { maxContextWindow: max },
		...creditMultiplier === void 0 ? {} : { creditMultiplier },
		reasoningSupported,
		...supported.length === 0 ? {} : { reasoning: {
			supported,
			...defaultEffort === void 0 ? {} : { defaultEffort }
		} }
	};
}
//#endregion
//#region src/protocol.ts
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
/** 从 identityHeaders 平铺出的身份头集合（键名与官方客户端观测一致）。 */
function identityHeaders$1(identity) {
	return {
		"x-machine-id": identity.machineId,
		"x-device-id": identity.deviceId,
		"x-device-type": identity.platform === "darwin" ? "mac" : identity.platform === "win32" ? "windows" : identity.platform,
		...identity.deviceBrand === void 0 ? {} : { "x-device-brand": identity.deviceBrand },
		...identity.deviceCpu === void 0 ? {} : { "x-device-cpu": identity.deviceCpu },
		...identity.osVersion === void 0 ? {} : { "x-os-version": identity.osVersion },
		...identity.appVersion === void 0 ? {} : {
			"x-app-version": identity.appVersion,
			"x-ide-version": identity.appVersion
		},
		...identity.buildVersion === void 0 ? {} : {
			"x-app-version-code": identity.buildVersion,
			"x-ide-version-code": identity.buildVersion
		},
		"x-ide-version-type": "stable"
	};
}
/**
* 上游无法绑定时的兜底构建号（dsh-connect-trae 观测值，保持一致便于对照）。
*/
const TRAE_VERSION_CODE_FALLBACK = "20260716";
/** 保留纯数字构建版本；无法绑定时回退。 */
function normalizeTraeVersionCode(buildVersion) {
	if (buildVersion === void 0 || buildVersion.trim() === "") return TRAE_VERSION_CODE_FALLBACK;
	const trimmed = buildVersion.trim();
	return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK;
}
/**
* 请求头全集。chat/model-detail 走完整头集；pay 家族只需认证 + 基本头
* （dsh-connect-trae usage.ts 的 authedHeaders 形态），并把 `x-device-id`
* 单独控制——签到 claim 必须带、其余路由可选。
*/
function buildTraeHeaders(request, options = {}) {
	const traceId = (options.requestId ?? randomUUID()).replaceAll("-", "").slice(0, 32);
	const profile = options.profile ?? "chat";
	const appId = options.appId ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
	const auth = {
		"Authorization": `Cloud-IDE-JWT ${request.credential.accessToken}`,
		"X-Ide-Token": request.credential.accessToken,
		"Content-Type": "application/json"
	};
	if (profile === "pay") return {
		...auth,
		"User-Agent": "Mozilla/5.0",
		"Origin": "https://www.trae.cn",
		"Referer": "https://www.trae.cn/",
		...options.deviceId === void 0 || options.deviceId === "" ? {} : { "x-device-id": options.deviceId }
	};
	const common = {
		...auth,
		"x-plugin-channel": "icube-ai",
		"User-Agent": `Trae/${request.identity.appVersion ?? request.identity.buildVersion ?? "unknown"}`,
		"x-app-id": appId,
		...identityHeaders$1(request.identity),
		"x-app-version-code": normalizeTraeVersionCode(request.identity.buildVersion),
		"x-ide-version-code": normalizeTraeVersionCode(request.identity.buildVersion),
		"x-custom-trace-id": traceId,
		"x-flow-traceparent": `04-${traceId}-${traceId.slice(0, 16)}-01`,
		"request-traffic-type": "prod"
	};
	if (profile === "model-detail") return {
		...common,
		"Accept": "application/json"
	};
	return {
		...common,
		"Accept": "text/event-stream"
	};
}
/** URL 拼接：去掉多余斜杠。 */
function traeEndpoint(baseUrl, path) {
	return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
//#endregion
//#region src/reasoning.ts
/** Trae 推理档位：与上游 `reasoning_effort` wire 值一一对应。 */
const TRAE_REASONING_EFFORTS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh"
];
/** 解析 `get_detail_param` 行的 `reasoning_effort_config`（不在选项列表时返回 undefined）。 */
function parseReasoningCapability(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const record = value;
	const supported = (Array.isArray(record["reasoning_effort_options"]) ? record["reasoning_effort_options"] : []).filter((item) => typeof item === "string" && TRAE_REASONING_EFFORTS.includes(item));
	const rawDefault = record["default_reasoning_effort"];
	const defaultEffort = typeof rawDefault === "string" && supported.includes(rawDefault) ? rawDefault : void 0;
	if (supported.length === 0 && defaultEffort === void 0) return void 0;
	return {
		supported,
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
//#endregion
//#region src/solo.ts
/** `llm_utils_chat` 的缺省 function（无目录信息时的兜底）。 */
const TRAE_SOLO_FUNCTION = "solo_work_lite";
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
const TRAE_DIRECTORY_FUNCTIONS = {
	cn: [
		"solo_work_remote",
		TRAE_SOLO_FUNCTION,
		"solo_agent_remote",
		"chat_v3",
		"solo_coder"
	],
	ai: [
		"solo_work_remote",
		TRAE_SOLO_FUNCTION,
		"solo_agent_remote",
		"chat_v3"
	]
};
/** chat 端点路径。 */
const TRAE_SOLO_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
/** 目录端点路径（`get_detail_param`）。 */
const TRAE_SOLO_MODELS_PATH = "/api/ide/v1/get_detail_param";
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
function wireCreditMultiplier(config) {
	const raw = config["display_contact_config"];
	if (typeof raw !== "string" || raw === "") return void 0;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null) return void 0;
	const consumption = parsed["consumption_rate"];
	if (typeof consumption !== "object" || consumption === null) return void 0;
	const entry = consumption;
	if (entry["enable"] !== true) return void 0;
	const data = entry["data"];
	if (typeof data !== "object" || data === null) return void 0;
	const rate = data["rate"];
	return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : void 0;
}
function finitePositive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
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
function prepareSoloBody(source, defaultModel = "glm-5.2", functionName) {
	const input = JSON.parse(source);
	const model = typeof input["model"] === "string" && input["model"].trim() !== "" ? input["model"].trim() : defaultModel;
	const body = {
		...Array.isArray(input["messages"]) ? { messages: input["messages"] } : {},
		model,
		config_name: model,
		function: typeof input["function"] === "string" && input["function"] !== "" ? input["function"] : functionName ?? "solo_work_lite",
		stream: true,
		...Array.isArray(input["tools"]) ? { tools: input["tools"] } : {},
		...typeof input["reasoning_effort"] === "string" ? { reasoning_effort: input["reasoning_effort"] } : {}
	};
	if (Array.isArray(body["messages"])) for (const raw of body["messages"]) {
		if (typeof raw !== "object" || raw === null) continue;
		const message = raw;
		if (message["role"] === "developer") message["role"] = "system";
		if (typeof message["content"] === "string") message["content"] = [{
			type: "text",
			text: message["content"]
		}];
		if (message["role"] === "assistant" && Array.isArray(message["tool_calls"])) for (const rawCall of message["tool_calls"]) {
			if (typeof rawCall !== "object" || rawCall === null) continue;
			const call = rawCall;
			if (typeof call["function"] === "object" && call["function"] !== null) {
				call["function_call"] = call["function"];
				delete call["function"];
			}
		}
		if (message["role"] === "tool") {
			if (typeof message["tool_call_id"] !== "string" || message["tool_call_id"] === "") throw new Error("Trae SOLO tool message requires tool_call_id");
		}
	}
	if (Array.isArray(body["tools"])) for (const raw of body["tools"]) {
		if (typeof raw !== "object" || raw === null) continue;
		const fn = raw["function"];
		if (typeof fn !== "object" || fn === null) continue;
		const record = fn;
		if (typeof record["parameters"] === "object" && record["parameters"] !== null) record["parameters"] = JSON.stringify(record["parameters"]);
	}
	return JSON.stringify(body);
}
/** 把一个 function 返回的 config_info_list 合并进共享目录（首个命中者拥有该 id）。 */
function collectWireModels(list, directoryFunction, byId) {
	for (const raw of list) {
		if (typeof raw !== "object" || raw === null) continue;
		const config = raw;
		const id = typeof config["config_name"] === "string" ? config["config_name"] : "";
		if (id === "") continue;
		if (byId.has(id)) continue;
		const display = typeof config["display_config"] === "object" && config["display_config"] !== null ? config["display_config"] : {};
		const details = Array.isArray(config["model_detail_list"]) ? config["model_detail_list"] : [];
		const detail = typeof details[0] === "object" && details[0] !== null ? details[0] : {};
		const contextTokens = typeof config["context_window_tokens"] === "object" && config["context_window_tokens"] !== null ? config["context_window_tokens"] : {};
		const promptMaxTokens = finitePositive(detail["prompt_max_tokens"]);
		const devTokens = finitePositive(contextTokens["dev"]);
		const contextWindow = promptMaxTokens ?? devTokens;
		const maxTokens = finitePositive(detail["max_tokens"]);
		const reasoning = parseReasoningCapability({
			...config,
			...detail
		});
		byId.set(id, {
			id,
			name: typeof display["display_name"] === "string" && display["display_name"] !== "" ? display["display_name"] : id,
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens },
			...reasoning === void 0 ? {} : { reasoning },
			...wireCreditMultiplier(config) === void 0 ? {} : { creditMultiplier: wireCreditMultiplier(config) },
			function: directoryFunction
		});
	}
}
//#endregion
//#region src/sse.ts
/** 增量 SSE 解码器，支持 CRLF、chunk 拆分与多行 data。 */
var SseDecoder = class {
	buffer = "";
	event;
	id;
	retry;
	data = [];
	push(chunk) {
		this.buffer += chunk;
		const events = [];
		while (true) {
			const match = /\r?\n/.exec(this.buffer);
			if (match === null || match.index === void 0) break;
			const line = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			const emitted = this.consumeLine(line);
			if (emitted !== void 0) events.push(emitted);
		}
		return events;
	}
	finish() {
		const events = [];
		if (this.buffer !== "") {
			const emitted = this.consumeLine(this.buffer);
			this.buffer = "";
			if (emitted !== void 0) events.push(emitted);
		}
		const final = this.dispatch();
		if (final !== void 0) events.push(final);
		return events;
	}
	consumeLine(line) {
		if (line === "") return this.dispatch();
		if (line.startsWith(":")) return void 0;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") this.event = value;
		else if (field === "data") this.data.push(value);
		else if (field === "id" && !value.includes("\0")) this.id = value;
		else if (field === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
	}
	dispatch() {
		if (this.data.length === 0) {
			this.event = void 0;
			this.retry = void 0;
			return;
		}
		const result = {
			...this.event === void 0 || this.event === "" ? {} : { event: this.event },
			data: this.data.join("\n"),
			...this.id === void 0 ? {} : { id: this.id },
			...this.retry === void 0 ? {} : { retry: this.retry }
		};
		this.event = void 0;
		this.retry = void 0;
		this.data = [];
		return result;
	}
};
/** 把一个原始 SSE 事件解码为 Trae 流事件。 */
function decodeTraeEvent(event) {
	if (event.data === "[DONE]") return {
		type: "done",
		finishReason: "stop"
	};
	let payload;
	try {
		payload = JSON.parse(event.data);
	} catch {
		return {
			type: "unknown",
			...event.event === void 0 ? {} : { event: event.event },
			data: event.data
		};
	}
	const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
	if (event.event === "request_wait_in_queue") return {
		type: "queue",
		...typeof record["position"] === "number" ? { position: record["position"] } : {}
	};
	if (event.event === "progress_notice") return {
		type: "progress",
		notice: payload
	};
	if (event.event === "token_usage") return {
		type: "usage",
		...typeof record["prompt_tokens"] === "number" ? { inputTokens: record["prompt_tokens"] } : {},
		...typeof record["completion_tokens"] === "number" ? { outputTokens: record["completion_tokens"] } : {},
		...typeof record["total_tokens"] === "number" ? { totalTokens: record["total_tokens"] } : {},
		...typeof record["reasoning_tokens"] === "number" ? { reasoningTokens: record["reasoning_tokens"] } : {},
		...typeof record["cache_read_input_tokens"] === "number" ? { cacheReadTokens: record["cache_read_input_tokens"] } : {},
		...typeof record["cache_creation_input_tokens"] === "number" ? { cacheWriteTokens: record["cache_creation_input_tokens"] } : {}
	};
	if (event.event === "done" || typeof record["finish_reason"] === "string" && record["response"] === void 0) return {
		type: "done",
		finishReason: typeof record["finish_reason"] === "string" ? record["finish_reason"] : "stop"
	};
	if (event.event === "output" || record["response"] !== void 0 || record["reasoning_content"] !== void 0) return {
		type: "delta",
		text: typeof record["response"] === "string" ? record["response"] : "",
		...typeof record["reasoning_content"] === "string" ? { reasoning: record["reasoning_content"] } : {},
		...record["tool_calls"] === void 0 || record["tool_calls"] === null ? {} : { toolCalls: record["tool_calls"] }
	};
	return {
		type: "unknown",
		...event.event === void 0 ? {} : { event: event.event },
		data: payload
	};
}
//#endregion
//#region src/solo-bridge.ts
/**
* SSE → OpenAI 流转换。移植自 dsh-connect-trae sse.ts + solo-bridge.ts，
* 语义不变：Trae 的命名 SSE 事件（output/token_usage/done/error…）转换成
* OpenAI chat-completion chunk；200 body 内的早期拒绝（error 事件）转换成
* 真实的 HTTP 错误，而不是让 DSH 看到一个空完成流。
*
* @module dsh-connect-trae-models/solo-bridge
*/
/**
* 流内错误码语义（dsh-connect-trae 2026-10-01 实测）：
* - `1005`：该模型需要付费计划（HTTP 200 + `event:error {"code":1005}`）；
* - `4011`：请求使用的 function 不服务该模型（message 谎称限流，实为不在此服务）；
* - `4001`：该 function 不接受这个 config_name。
*/
const TRAE_ERROR_HINTS = {
	1005: "Trae requires a paid plan for this model; the current account's plan does not cover it",
	4001: "Trae does not serve this model under the SOLO function the request used (config_name rejected)",
	4011: "Trae refused this model under the SOLO function the request used"
};
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
const TRAE_QUEUE_COMMENT = "trae-queue";
const TRAE_PROGRESS_COMMENT = "trae-processing";
const TRAE_HEARTBEAT_COMMENT = "trae-heartbeat";
/** 上游静默时的兜底保活间隔，必须显著小于下游 300s 流空闲超时。 */
const TRAE_KEEPALIVE_INTERVAL_MS = 2e4;
/**
* 上游完全静默（连排队位置都不发）多久判为哑连接。
* 健康排队期 `request_wait_in_queue` 约每 1~3 秒一帧；90 秒无任何字节说明
* 连接已事实死亡，用可读错误中止，而不是把等待放大到外层空闲超时。
*/
const TRAE_UPSTREAM_SILENCE_MS = 9e4;
/** `extra` 在 wire 上是 JSON 字符串；解包读 `plan`。 */
function traeErrorPlan(extra) {
	let value = extra;
	if (typeof value === "string") try {
		value = JSON.parse(value);
	} catch {
		return;
	}
	if (typeof value !== "object" || value === null) return void 0;
	const plan = value["plan"];
	return typeof plan === "number" ? plan : void 0;
}
/** 流内失败的可读消息（保留原始码）。 */
function describeTraeFailure(failure) {
	const plan = traeErrorPlan(failure.extra);
	const parts = [
		failure.code === void 0 ? "Trae refused the request" : TRAE_ERROR_HINTS[failure.code] ?? "Trae refused the request",
		...plan === void 0 ? [] : [`plan ${plan}`],
		...failure.code === void 0 ? [] : [`Trae code ${failure.code}`]
	];
	const detail = failure.message.trim();
	return detail === "" ? parts.join(" · ") : `${parts.join(" · ")} · upstream: ${detail}`;
}
/** 流内失败 → HTTP 状态 + 错误分类。1005 是订阅门槛：402 最真实且让客户端停止重试。 */
function classifyTraeFailure(failure) {
	return failure.code === 1005 ? {
		status: 402,
		kind: "hard_credit"
	} : {
		status: 400,
		kind: "client"
	};
}
/** 识别流内失败事件；其余返回 undefined。 */
function traeFailureOf(decoded) {
	if (decoded.type !== "unknown") return void 0;
	const payload = decoded.data;
	const code = typeof payload?.["code"] === "number" ? payload["code"] : void 0;
	if (decoded.event !== "error" && !(code !== void 0 && code >= 4e3)) return void 0;
	return {
		...code === void 0 ? {} : { code },
		message: typeof payload?.["message"] === "string" ? payload["message"] : "",
		...payload?.["extra"] === void 0 ? {} : { extra: payload["extra"] }
	};
}
function normalizeToolCalls(value) {
	if (!Array.isArray(value)) return [];
	const calls = [];
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const record = raw;
		const rawFunction = typeof record["function_call"] === "object" && record["function_call"] !== null ? record["function_call"] : typeof record["function"] === "object" && record["function"] !== null ? record["function"] : {};
		const fn = {
			...typeof rawFunction["name"] === "string" ? { name: rawFunction["name"] } : {},
			...typeof rawFunction["arguments"] === "string" ? { arguments: rawFunction["arguments"] } : {}
		};
		calls.push({
			index: typeof record["index"] === "number" ? record["index"] : calls.length,
			...typeof record["id"] === "string" ? { id: record["id"] } : {},
			...record["type"] === "function" ? { type: "function" } : {},
			...Object.keys(fn).length === 0 ? {} : { function: fn }
		});
	}
	return calls;
}
/** Trae 命名 SSE 事件流 → OpenAI chat-completion SSE 流（原语，恒答 200）。 */
function bridgeTraeSoloStream(response, model) {
	const source = response.body;
	if (source === null) return new Response(null, { status: 502 });
	return bridgeTraeSource(source, model);
}
/** {@link bridgeTraeSoloStream} 的字节流版本。 */
function bridgeTraeSource(source, model) {
	const id = `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
	const created = Math.floor(Date.now() / 1e3);
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const sse = new SseDecoder();
	let sawToolCalls = false;
	let emittedFinishReason = false;
	let upstreamEnded = false;
	let upstreamError;
	let usage;
	const chunk = (delta, finishReason = null) => encoder.encode(`data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{
			index: 0,
			delta,
			finish_reason: finishReason
		}],
		...usage === void 0 ? {} : { usage }
	})}\n\n`);
	const stream = new ReadableStream({
		async start(controller) {
			const reader = source.getReader();
			let finished = false;
			let lastProgressCommentAt = 0;
			let lastUpstreamReadAt = Date.now();
			const comment = (text) => {
				if (!finished && controller.desiredSize !== null && controller.desiredSize > 0) controller.enqueue(encoder.encode(`: ${text}\n\n`));
			};
			const keepalive = setInterval(() => {
				if (finished) return;
				if (Date.now() - lastUpstreamReadAt > 9e4) {
					finished = true;
					clearInterval(keepalive);
					reader.cancel().catch(() => {});
					controller.error(/* @__PURE__ */ new Error(`Trae upstream fell silent for ${Math.round(TRAE_UPSTREAM_SILENCE_MS / 1e3)}s (no queue position or content events); aborting the stalled stream`));
					return;
				}
				comment(TRAE_HEARTBEAT_COMMENT);
			}, TRAE_KEEPALIVE_INTERVAL_MS);
			const consume = (event) => {
				const decoded = decodeTraeEvent(event);
				if (decoded.type === "unknown") {
					const failure = traeFailureOf(decoded);
					if (failure !== void 0) upstreamError = new Error(describeTraeFailure(failure));
					return;
				}
				if (decoded.type === "queue") {
					comment(decoded.position === void 0 ? TRAE_QUEUE_COMMENT : `${TRAE_QUEUE_COMMENT} position=${decoded.position}`);
					return;
				}
				if (decoded.type === "progress") {
					const now = Date.now();
					if (now - lastProgressCommentAt >= 5e3) {
						lastProgressCommentAt = now;
						comment(TRAE_PROGRESS_COMMENT);
					}
					return;
				}
				if (decoded.type === "delta") {
					const delta = {};
					if (decoded.text !== "") delta["content"] = decoded.text;
					if (decoded.reasoning !== void 0 && decoded.reasoning !== "") delta["reasoning_content"] = decoded.reasoning;
					const toolCalls = normalizeToolCalls(decoded.toolCalls);
					if (toolCalls.length > 0) {
						sawToolCalls = true;
						delta["tool_calls"] = toolCalls;
					}
					if (Object.keys(delta).length > 0) controller.enqueue(chunk(delta));
				} else if (decoded.type === "usage") {
					const cacheRead = decoded.cacheReadTokens;
					const cacheWrite = decoded.cacheWriteTokens;
					const details = {
						...cacheRead === void 0 ? {} : { cached_tokens: cacheRead },
						...cacheWrite === void 0 ? {} : { cache_write_tokens: cacheWrite }
					};
					usage = {
						...decoded.inputTokens === void 0 ? {} : { prompt_tokens: decoded.inputTokens },
						...decoded.outputTokens === void 0 ? {} : { completion_tokens: decoded.outputTokens },
						...decoded.totalTokens === void 0 ? {} : { total_tokens: decoded.totalTokens },
						...Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details }
					};
				} else if (decoded.type === "done") {
					upstreamEnded = true;
					if (!emittedFinishReason) {
						emittedFinishReason = true;
						if (upstreamError !== void 0) {
							controller.error(upstreamError);
							return;
						}
						controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : decoded.finishReason || "stop"));
					}
				}
			};
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					lastUpstreamReadAt = Date.now();
					for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event);
				}
				for (const event of sse.finish()) consume(event);
				if (upstreamError !== void 0 && !upstreamEnded) {
					controller.error(upstreamError);
					return;
				}
				if (!emittedFinishReason) {
					emittedFinishReason = true;
					controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : "stop"));
				}
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				finished = true;
				clearInterval(keepalive);
				controller.close();
			} catch (error) {
				finished = true;
				clearInterval(keepalive);
				controller.error(error);
			} finally {
				finished = true;
				clearInterval(keepalive);
				reader.releaseLock();
			}
		},
		cancel(reason) {
			return source.cancel(reason);
		}
	});
	return new Response(stream, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" }
	});
}
/** {@link openTraeSource} 在放弃寻找失败前最多读这么多 chunk / 字节。 */
const PEEK_MAX_CHUNKS = 64;
const PEEK_MAX_BYTES = 262144;
/** 回放 peek 消耗的字节，再继续排空上游。 */
function replayTraeSource(buffered, reader, ended) {
	let index = 0;
	return new ReadableStream({
		async pull(controller) {
			const chunk = buffered[index];
			if (chunk !== void 0) {
				index += 1;
				controller.enqueue(chunk);
				return;
			}
			if (ended) {
				controller.close();
				return;
			}
			const next = await reader.read();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(next.value);
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
		}
	});
}
/**
* 打开上游应答；Trae 在输出任何内容**之前**拒绝时快速失败。
* peek 只读流头部并逐字节回放，健康应答的额外缓冲不超过第一个事件。
*/
async function openTraeSource(response) {
	const body = response.body;
	if (body === null) return {
		ok: false,
		status: 502,
		kind: "server",
		message: "Trae upstream returned no response body"
	};
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const sse = new SseDecoder();
	const buffered = [];
	let bytes = 0;
	let ended = false;
	try {
		while (buffered.length < PEEK_MAX_CHUNKS && bytes < PEEK_MAX_BYTES) {
			const next = await reader.read();
			if (next.done) {
				ended = true;
				break;
			}
			buffered.push(next.value);
			bytes += next.value.byteLength;
			let answered = false;
			for (const event of sse.push(decoder.decode(next.value, { stream: true }))) {
				const decoded = decodeTraeEvent(event);
				const failure = traeFailureOf(decoded);
				if (failure !== void 0) {
					await reader.cancel().catch(() => {});
					return {
						ok: false,
						...classifyTraeFailure(failure),
						message: describeTraeFailure(failure)
					};
				}
				if (decoded.type !== "unknown") answered = true;
			}
			if (answered) break;
		}
	} catch (error) {
		reader.releaseLock();
		return {
			ok: false,
			status: 0,
			kind: "server",
			message: `transport error: ${String(error)}`
		};
	}
	return {
		ok: true,
		source: replayTraeSource(buffered, reader, ended)
	};
}
/**
* 桥接一个上游应答，把早期拒绝变成真实错误结果。
* {@link bridgeTraeSoloStream} 是同步原语（恒 200）；这是桥接类实际使用的策略。
*/
async function bridgeTraeSoloStreamOrFail(response, model) {
	const opened = await openTraeSource(response);
	if (!opened.ok) return opened;
	return {
		ok: true,
		response: bridgeTraeSource(opened.source, model)
	};
}
//#endregion
//#region src/upstream.ts
/**
* 多账号 Trae 上游客户端：chat / 目录 / 积分 / 签到 / 活动。
*
* 与 dsh-connect-trae 的单账号注入式客户端不同，这里每个方法都显式携带
* `{ credential, identity }`（账号池为每次调用挑一个账号发请求）。
*
* @module dsh-connect-trae-models/upstream
*/
/** 按 HTTP 状态分类上游错误（dsh-connect-trae solo.ts 同语义）。 */
function classifyTraeError(status) {
	if (status === 401 || status === 403) return "authentication";
	if (status === 402) return "hard_credit";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	return "client";
}
function asNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/**
* 把一个上游时间戳归一化到毫秒。
*
* `entitlement_base_info.end_time` 是**秒级**时间戳——实测基准
* `start_time=1790382849` 对应 2026-09-26 08:34:09（北京），十位数即秒。
* 直接当毫秒用会让 `new Date()` 落到 1970 年，并让每个包都判定为「已过期」，
* 于是到期提醒要么显示 1970 年、要么整体走灰显分支。
*
* 判定按量级而不是按字段：大于 1e12 的已经是毫秒（保护未来上游改用毫秒），
* 其余乘以 1000。0/负数/非数字返回 0（= 上游未回报到期时间，不是「已过期」）。
*/
function toEpochMs(value) {
	const raw = asNumber(value);
	if (raw === void 0 || raw <= 0) return 0;
	return raw > 0xe8d4a51000 ? raw : raw * 1e3;
}
function recordOf(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/** 默认的「3 天内到期」提醒窗口。 */
const TRAE_EXPIRING_SOON_WINDOW_MS = 2592e5;
/** 区域的 pay base（积分/签到/活动家族）。 */
function payBaseFor(region, options) {
	return options.bases?.pay ?? REGION_GATEWAYS[region].pay;
}
/** 解析积分快照（含到期提醒字段），纯函数便于测试。 */
function parseCreditsSnapshot(payload, nowMs = Date.now()) {
	const doc = recordOf(payload) ?? {};
	const summary = recordOf(doc["usage_summary"]) ?? {};
	const total = asNumber(summary["total_amount"]) ?? 0;
	const consumed = asNumber(summary["consumed_amount"]) ?? 0;
	const packs = [];
	const rawPacks = Array.isArray(doc["user_entitlement_pack_list"]) ? doc["user_entitlement_pack_list"] : [];
	let nearestExpiryMs;
	let expiringSoon = 0;
	for (const raw of rawPacks) {
		const pack = recordOf(raw);
		if (pack === void 0) continue;
		const base = recordOf(pack["entitlement_base_info"]) ?? {};
		const quota = recordOf(base["quota"]) ?? {};
		const usage = recordOf(pack["usage"]) ?? {};
		const creditsLimit = asNumber(quota["credits_limit"]);
		const packConsumed = asNumber(usage["credits_amount"]);
		const endTimeMs = toEpochMs(base["end_time"]);
		packs.push({
			displayDesc: typeof pack["display_desc"] === "string" ? pack["display_desc"] : "",
			entitlementId: typeof base["entitlement_id"] === "string" ? base["entitlement_id"] : "",
			endTimeMs,
			currency: asNumber(base["currency"]),
			...creditsLimit === void 0 ? {} : { creditsLimit },
			...packConsumed === void 0 ? {} : { consumed: packConsumed }
		});
		if (endTimeMs > nowMs) {
			if (nearestExpiryMs === void 0 || endTimeMs < nearestExpiryMs) nearestExpiryMs = endTimeMs;
			if (endTimeMs <= nowMs + 2592e5) {
				const remaining = creditsLimit !== void 0 && packConsumed !== void 0 ? Math.max(0, creditsLimit - packConsumed) : creditsLimit ?? 0;
				expiringSoon += remaining;
			}
		}
	}
	return {
		total,
		consumed,
		available: total - consumed,
		packs,
		expiringSoonWindowMs: TRAE_EXPIRING_SOON_WINDOW_MS,
		...nearestExpiryMs === void 0 ? {} : { nearestExpiryMs },
		...expiringSoon > 0 ? { expiringSoon } : {}
	};
}
/** 解析签到状态，纯函数便于测试。 */
function parseCheckinStatus(payload) {
	const doc = recordOf(payload) ?? {};
	const extraCredits = asNumber(doc["extra_credits"]);
	return {
		checkedIn: doc["checked_in"] === true,
		didCheckedIn: doc["did_checked_in"] === true,
		credits: asNumber(doc["credits"]) ?? 0,
		enabled: doc["enable"] !== false,
		...extraCredits === void 0 || extraCredits <= 0 ? {} : { extraCredits }
	};
}
/** 解析领取结果，纯函数便于测试。 */
function parseCheckinClaim(payload) {
	const doc = recordOf(payload) ?? {};
	const code = asNumber(doc["code"]) ?? 0;
	return {
		claimed: code === 0,
		code,
		message: typeof doc["message"] === "string" ? doc["message"].slice(0, 200) : ""
	};
}
/** 解析活动规则，纯函数便于测试。 */
function parseActivities(payload) {
	const doc = recordOf(payload) ?? {};
	const rawActivities = Array.isArray(doc["commercial_activities"]) ? doc["commercial_activities"] : [];
	const activities = [];
	for (const raw of rawActivities) {
		const rule = recordOf(raw);
		if (rule === void 0) continue;
		activities.push({
			activityId: typeof rule["activity_id"] === "string" ? rule["activity_id"] : "",
			enabled: rule["Enabled"] === true,
			activityType: asNumber(rule["activity_type"]) ?? 0,
			startTimeMs: asNumber(rule["start_time_ms"]) ?? 0,
			endTimeMs: asNumber(rule["end_time_ms"]) ?? 0,
			...rule["work_extra"] === void 0 ? {} : { workExtra: rule["work_extra"] }
		});
	}
	return activities;
}
/** 远端目录 `/models` 的回应分组解析（同 id 保留更强容量行）。 */
function preferStrongerRow(candidate, incumbent) {
	if (incumbent === void 0) return candidate;
	const candidateMax = candidate.maxContextWindow;
	const incumbentMax = incumbent.maxContextWindow;
	if (candidateMax !== void 0 && incumbentMax === void 0) return candidate;
	if (candidateMax === void 0 && incumbentMax !== void 0) return incumbent;
	if (candidateMax !== void 0 && incumbentMax !== void 0 && candidateMax !== incumbentMax) return candidateMax > incumbentMax ? candidate : incumbent;
	return (candidate.contextWindow ?? 0) > (incumbent.contextWindow ?? 0) ? candidate : incumbent;
}
/** 远端目录要问的 function 分组（两个区域同表，见 dsh-connect-trae solo-remote.ts）。 */
const TRAE_REMOTE_DIRECTORY_FUNCTIONS = [
	"solo_agent",
	"solo_agent_remote",
	"solo_work_remote",
	"solo_work_lite",
	"chat_v3",
	"solo_coder",
	"builder_v3"
];
var TraeUpstreamClient = class {
	options;
	fetchImpl;
	timeoutMs;
	firstByteTimeoutMs;
	constructor(options = {}) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 3e4;
		this.firstByteTimeoutMs = options.firstByteTimeoutMs ?? 15e3;
	}
	regionOf(request) {
		return this.options.region ?? regionOfCredential(request.credential);
	}
	signalOf(signal) {
		return signal ?? AbortSignal.timeout(this.timeoutMs);
	}
	/**
	* `get_detail_param` union 目录：按区域依次问每个 function，首个列出某
	* config_name 的 function 拥有它（chat 必须回放该 function）。
	* 单个 function 失败不隐藏其他 function 的名册；全空才抛错。
	*/
	async fetchModels(request, signal) {
		const region = this.regionOf(request);
		const base = this.options.bases?.chat ?? REGION_GATEWAYS[region].chat;
		const headers = {
			...buildTraeHeaders(request, { profile: "model-detail" }),
			Accept: "application/json"
		};
		const byId = /* @__PURE__ */ new Map();
		const failures = [];
		for (const directoryFunction of TRAE_DIRECTORY_FUNCTIONS[region]) {
			let list;
			try {
				const response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_MODELS_PATH), {
					method: "POST",
					headers,
					body: JSON.stringify({
						function: directoryFunction,
						config_names: null,
						need_prompt: false,
						current_config_info: null,
						poly_prompt: true,
						mode_type: null,
						agent_type: null
					}),
					signal: this.signalOf(signal)
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const document = await response.json();
				list = Array.isArray(document["config_info_list"]) ? document["config_info_list"] : [];
			} catch (error) {
				failures.push(`${directoryFunction}: ${String(error).slice(0, 80)}`);
				continue;
			}
			collectWireModels(list, directoryFunction, byId);
		}
		const models = [...byId.values()];
		if (models.length === 0) throw new Error(`Trae models response contained no models (${failures.join("; ") || "empty directory"})`);
		return models;
	}
	/**
	* 远端目录 `/api/remote/v1/models`：union 全部 function 分组，同 id 保留
	* 更强容量行。这是模型骨架（显示 id/窗口/倍率/multimodal）的来源。
	*/
	async fetchRemoteCatalog(request, signal) {
		const region = this.regionOf(request);
		const base = this.options.bases?.remote ?? REGION_GATEWAYS[region].remote;
		const dressing = region === "ai" ? {
			referer: "https://coresg-normal.trae.ai/",
			timezone: "Asia/Singapore",
			language: "en"
		} : {
			referer: "https://solo.trae.cn/",
			timezone: "Asia/Shanghai",
			language: "zh-cn"
		};
		const headers = {
			"Authorization": `Cloud-IDE-JWT ${request.credential.accessToken}`,
			"Content-Type": "application/json",
			"x-trae-client-type": "web",
			"x-trae-user-timezone": dressing.timezone,
			"x-preferenced-language": dressing.language,
			"Referer": dressing.referer,
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
		};
		const functions = TRAE_REMOTE_DIRECTORY_FUNCTIONS.join(",");
		const response = await this.fetchImpl(`${base}/models?functions=${functions}`, {
			headers,
			signal: this.signalOf(signal)
		});
		if (!response.ok) throw new Error(`SOLO remote models returned HTTP ${response.status}`);
		const groups = (await response.json()).data?.list ?? [];
		const byId = /* @__PURE__ */ new Map();
		for (const group of groups) for (const raw of group.models ?? []) {
			const model = parseTraeRemoteModel(raw);
			if (model === void 0) continue;
			byId.set(model.id, preferStrongerRow(model, byId.get(model.id)));
		}
		const models = [...byId.values()];
		if (models.length === 0) throw new Error("SOLO remote models response contained no models");
		return models;
	}
	/** 合并远端骨架与 wire 目录（照抄 mergeTraeModelSources 语义）。 */
	mergeCatalog(remote, wire) {
		return mergeTraeModelSources(remote, wire);
	}
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
	async chatStream(request, bodyJson, signal, labelModel) {
		let prepared;
		try {
			prepared = prepareSoloBody(bodyJson, void 0, void 0);
		} catch {
			return {
				ok: false,
				status: 400,
				kind: "client",
				message: "invalid JSON request"
			};
		}
		const region = this.regionOf(request);
		const base = this.options.bases?.chat ?? REGION_GATEWAYS[region].chat;
		const headers = buildTraeHeaders(request, { profile: "chat" });
		const sent = await this.postSoloChat(base, headers, prepared, signal);
		if (!sent.ok) {
			this.options.log?.("dsh-connect-trae-models: llm_utils_chat rejected", {
				status: sent.status,
				message: sent.message
			});
			return sent;
		}
		let model = typeof labelModel === "string" && labelModel !== "" ? labelModel : "glm-5.2";
		try {
			const input = JSON.parse(prepared);
			if (typeof input["model"] === "string" && input["model"] !== "" && labelModel === void 0) model = input["model"];
		} catch {}
		return await bridgeTraeSoloStreamOrFail(sent.response, model);
	}
	/** 便捷方法：调用方已持有 prepared envelope 时直接发（跳过 prepareSoloBody）。 */
	async chatPrepared(request, prepared, signal, labelModel) {
		const region = this.regionOf(request);
		const base = this.options.bases?.chat ?? REGION_GATEWAYS[region].chat;
		const headers = buildTraeHeaders(request, { profile: "chat" });
		const sent = await this.postSoloChat(base, headers, prepared, signal);
		if (!sent.ok) return sent;
		let model = typeof labelModel === "string" && labelModel !== "" ? labelModel : "glm-5.2";
		try {
			const input = JSON.parse(prepared);
			if (typeof input["model"] === "string" && input["model"] !== "" && labelModel === void 0) model = input["model"];
		} catch {}
		return await bridgeTraeSoloStreamOrFail(sent.response, model);
	}
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
	async postSoloChat(base, headers, prepared, signal) {
		const firstByte = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			firstByte.abort();
		}, this.firstByteTimeoutMs);
		const combined = signal === void 0 ? firstByte.signal : AbortSignal.any([signal, firstByte.signal]);
		let response;
		try {
			response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_CHAT_PATH), {
				method: "POST",
				headers,
				body: prepared,
				signal: combined
			});
		} catch (error) {
			if (timedOut && !signal?.aborted) return {
				ok: false,
				status: 0,
				kind: "client",
				message: `Trae 模型未在 ${Math.round(this.firstByteTimeoutMs / 1e3)} 秒内开始响应（已中止）；该模型可能当前不可用，请更换模型重试`
			};
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		} finally {
			clearTimeout(timer);
		}
		if (!response.ok) {
			const text = (await response.text()).slice(0, 1024);
			return {
				ok: false,
				status: response.status,
				kind: classifyTraeError(response.status),
				message: text || `Trae SOLO returned HTTP ${response.status}`
			};
		}
		return {
			ok: true,
			response
		};
	}
	/**
	* 积分快照（CN only；`/trae/api/v2/pay/web_user_ent_usage`）。
	* 只读操作，不消耗积分。返回总量/分包/到期提醒字段。
	*/
	async fetchCredits(request, signal) {
		return parseCreditsSnapshot(await this.payPost(request, "/trae/api/v2/pay/web_user_ent_usage", { require_usage: true }, signal), Date.now());
	}
	/**
	* 签到状态（CN only）。读请求带 `x-device-id`（有则带）：`did_checked_in`
	* 是设备口径，缺头会让已签设备看起来和没签设备一样。
	*/
	async fetchCheckinStatus(request, deviceId, signal) {
		return parseCheckinStatus(await this.payPost(request, "/trae/api/v2/ug/checkin_credits/status", {}, signal, deviceId));
	}
	/**
	* 领取今日签到奖励（CN only；客户端中唯一的写操作）。
	* 必须携带 `x-device-id`——上游以它判定设备名额；缺失时上游答业务码 9004。
	* 业务拒绝（9004/9095）以 `claimed:false` 返回而不是抛错。
	*/
	async claimCheckin(request, deviceId, signal) {
		return parseCheckinClaim(await this.payPost(request, "/trae/api/v2/ug/checkin_credits/claim", {}, signal, deviceId));
	}
	/** 活动规则（CN only；checkin_credits/new_user_credits/send_message_reward 等）。 */
	async fetchActivities(request, signal) {
		return parseActivities(await this.payPost(request, "/trae/api/v2/ug/activity/info", {}, signal));
	}
	/** pay/ug 家族的 POST（HTTP 非 200 抛错；业务码由各方法自行解析）。 */
	async payPost(request, path, data, signal, deviceId) {
		const base = payBaseFor(this.regionOf(request), this.options);
		const headers = buildTraeHeaders(request, {
			profile: "pay",
			deviceId
		});
		const response = await this.fetchImpl(traeEndpoint(base, path), {
			method: "POST",
			headers,
			body: JSON.stringify(data),
			signal: this.signalOf(signal)
		});
		if (!response.ok) throw new Error(`Trae usage endpoint ${path} returned HTTP ${response.status}`);
		return await response.json();
	}
};
/**
* 方法级的独立包装（T4/T5 契约要求，见 index.ts 的说明）。
*
* 每个函数都是「建一个默认客户端，调同名方法」的薄包装，语义与实例方法完全
* 一致——存在的理由是让调用方（shim 测试、主装配）可以在模块层单独 import 与
* 打桩，而不必先构造 TraeUpstreamClient 实例。需要注入 fetch/super 诊断/网关
* 覆盖时请直接用 TraeUpstreamClient。
*/
function fetchModels(request, signal) {
	return new TraeUpstreamClient().fetchModels(request, signal);
}
/** @see TraeUpstreamClient.fetchRemoteCatalog */
function fetchRemoteCatalog(request, signal) {
	return new TraeUpstreamClient().fetchRemoteCatalog(request, signal);
}
/** @see TraeUpstreamClient.mergeCatalog */
function mergeCatalog(remote, wire) {
	return mergeTraeModelSources(remote, wire);
}
/** @see TraeUpstreamClient.chatStream */
function chatStream(request, bodyJson, signal) {
	return new TraeUpstreamClient().chatStream(request, bodyJson, signal);
}
/** @see TraeUpstreamClient.fetchCredits */
function fetchCredits(request, signal) {
	return new TraeUpstreamClient().fetchCredits(request, signal);
}
/** @see TraeUpstreamClient.fetchCheckinStatus */
function fetchCheckinStatus(request, deviceId, signal) {
	return new TraeUpstreamClient().fetchCheckinStatus(request, deviceId, signal);
}
/** @see TraeUpstreamClient.claimCheckin */
function claimCheckin(request, deviceId, signal) {
	return new TraeUpstreamClient().claimCheckin(request, deviceId, signal);
}
/** @see TraeUpstreamClient.fetchActivities */
function fetchActivities(request, signal) {
	return new TraeUpstreamClient().fetchActivities(request, signal);
}
//#endregion
//#region src/context-budget.ts
/** Rough character-per-token ratio. CJK is ~1 token/char, latin ~1/4. */
const CHARS_PER_TOKEN_LATIN = 4;
const CHARS_PER_TOKEN_CJK = 1;
/** Fixed per-message overhead the chat template adds (role markers etc.). */
const PER_MESSAGE_TOKEN_OVERHEAD = 4;
/** Every image/tool part costs at least this much once decoded. */
const PER_PART_TOKEN_FLOOR = 16;
/**
* 估算一条消息 `content` 的 token 成本。
*
* 刻意保守（宁可高估），让我们稍微提前压缩，而不是到上游才发现超限。
*/
function estimateContentTokens(content) {
	if (content === null || content === void 0) return 0;
	if (typeof content === "string") return estimateTextTokens(content);
	if (typeof content === "number" || typeof content === "boolean") return PER_PART_TOKEN_FLOOR;
	if (Array.isArray(content)) {
		let total = 0;
		for (const part of content) total += estimateContentTokens(part);
		return total;
	}
	if (typeof content === "object") {
		const record = content;
		let total = PER_PART_TOKEN_FLOOR;
		for (const key of [
			"text",
			"image_url",
			"input",
			"content"
		]) if (key in record) total += estimateContentTokens(record[key]);
		if (total === PER_PART_TOKEN_FLOOR) total += estimateTextTokens(safeStringify(record));
		return total;
	}
	return 0;
}
/** Estimate tokens for a plain string, accounting for CJK density. */
function estimateTextTokens(text) {
	if (text === "") return 0;
	let cjk = 0;
	for (const char of text) if (isCjk(char.codePointAt(0) ?? 0)) cjk += 1;
	const latin = text.length - cjk;
	return Math.ceil(cjk / CHARS_PER_TOKEN_CJK + latin / CHARS_PER_TOKEN_LATIN);
}
function isCjk(code) {
	return code >= 12288 && code <= 12351 || code >= 12352 && code <= 12543 || code >= 13312 && code <= 19903 || code >= 19968 && code <= 40959 || code >= 63744 && code <= 64255 || code >= 65280 && code <= 65519 || code >= 131072 && code <= 191471;
}
function safeStringify(value) {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}
/** Estimate the prompt cost of a whole message array. */
function estimateMessagesTokens(messages) {
	let total = 0;
	for (const message of messages) {
		total += PER_MESSAGE_TOKEN_OVERHEAD;
		total += estimateContentTokens(message.content);
		if (message["tool_calls"] !== void 0) total += estimateContentTokens(message["tool_calls"]);
		if (message["name"] !== void 0) total += estimateTextTokens(String(message["name"]));
	}
	return total;
}
/** True when `role` carries instructions that must survive compaction. */
function isPinnedRole(role) {
	return role === "system" || role === "developer";
}
/**
* 丢弃最老的非钉住消息，直到估算值放得进 `budget`。
*
* 钉住（system/developer）的消息与最新 `keepRecent` 条消息被保留
* —— 这里绝不动它们；若仅它们就超预算，调用方必须回退到总结或放弃。
*/
function compactMessages(messages, options) {
	const keepRecent = Math.max(1, options.keepRecent ?? 4);
	const estimate = estimateMessagesTokens(messages);
	if (estimate <= options.budget) return {
		messages: [...messages],
		dropped: [],
		tokens: estimate,
		changed: false
	};
	const pinned = [];
	const body = [];
	for (const message of messages) if (isPinnedRole(message.role)) pinned.push(message);
	else body.push(message);
	const keep = Math.min(keepRecent, body.length);
	const tail = body.slice(body.length - keep);
	const head = body.slice(0, body.length - keep);
	let dropCount = 0;
	let candidate = [
		...pinned,
		...head,
		...tail
	];
	let total = estimateMessagesTokens(candidate);
	while (total > options.budget && dropCount < head.length) {
		dropCount += 1;
		candidate = [
			...pinned,
			...head.slice(dropCount),
			...tail
		];
		total = estimateMessagesTokens(candidate);
	}
	const dropped = head.slice(0, dropCount);
	return {
		messages: candidate,
		dropped,
		tokens: total,
		changed: dropCount > 0
	};
}
/**
* 最后手段：丢弃最老的消息，**包括**钉住的那些。
*
* 用在连摘要都无法把 prompt 压进预算时（例如粘贴了一整个巨大文档）。
* 最新的一条消息永远保留。
*/
function hardTruncate(messages, budget) {
	if (messages.length === 0) return {
		messages: [],
		dropped: [],
		tokens: 0,
		changed: false
	};
	let start = 0;
	let candidate = [...messages];
	let total = estimateMessagesTokens(candidate);
	while (total > budget && start < messages.length - 1) {
		start += 1;
		candidate = messages.slice(start);
		total = estimateMessagesTokens(candidate);
	}
	return {
		messages: candidate,
		dropped: messages.slice(0, start),
		tokens: total,
		changed: start > 0
	};
}
/** Instructions handed to the model when we ask it to compact a conversation. */
const SUMMARIZE_INSTRUCTION = [
	"You are compacting an ongoing conversation so it can continue without the original history.",
	"Summarise the transcript below into a dense briefing for the next assistant turn.",
	"Preserve, in this order of priority:",
	"1. explicit user requirements, constraints and corrections;",
	"2. decisions already made, and the reasoning behind them;",
	"3. concrete facts: file paths, identifiers, commands, numbers, error messages;",
	"4. unfinished work and the current blocker.",
	"Drop pleasantries, repetition and superseded attempts.",
	"Write the briefing only — no preamble, no markdown fence."
].join("\n");
/** Render a message array as plain text for the summarisation prompt. */
function transcriptOf(messages) {
	const lines = [];
	for (const message of messages) {
		const role = message.role === "" ? "unknown" : message.role;
		lines.push(`### ${role}`);
		lines.push(renderContent(message.content));
		if (message["tool_calls"] !== void 0) lines.push(renderContent(message["tool_calls"]));
	}
	return lines.join("\n");
}
function renderContent(content) {
	if (content === null || content === void 0) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => renderContent(part)).filter((text) => text !== "").join("\n");
	if (typeof content === "object") {
		const record = content;
		for (const key of [
			"text",
			"content",
			"input"
		]) if (typeof record[key] === "string") return record[key];
		if (record["type"] !== void 0 && typeof record["type"] === "string") return `[${record["type"]}]`;
		return safeStringify(record);
	}
	return String(content);
}
/** Build the synthetic system message that carries a compaction summary. */
function summaryMessage(summary) {
	return {
		role: "system",
		content: [
			"The earlier part of this conversation was compacted to fit the model context window.",
			"Briefing produced from the dropped turns:",
			"",
			summary.trim()
		].join("\n")
	};
}
/**
* 把 `messages` 压缩到 `budget`，尽可能总结被丢弃的轮次。
*
* 请求摘要时使用**有界**的转录文本，使压缩调用自身永远不会超窗：若被丢弃的
* 轮次极大，只总结其中最新的一片，最老的那些标注为已省略。
*/
async function compactWithSummary(messages, options, deps, signal) {
	const first = compactMessages(messages, options);
	if (!first.changed) return {
		messages: first.messages,
		tokens: first.tokens,
		summary: void 0,
		skipped: void 0
	};
	const summaryBudget = Math.max(256, Math.floor(options.budget / 4));
	let toSummarize = first.dropped;
	let elided = 0;
	while (estimateMessagesTokens(toSummarize) > summaryBudget && toSummarize.length > 1) {
		toSummarize = toSummarize.slice(1);
		elided += 1;
	}
	let summary;
	let skipped;
	try {
		const instruction = elided > 0 ? `${SUMMARIZE_INSTRUCTION}\n\nNote: the ${elided} oldest turn(s) were elided before this transcript.` : SUMMARIZE_INSTRUCTION;
		const suffix = elided > 0 ? `\n(the ${elided} oldest turn(s) were elided)` : "";
		const request = [{
			role: "system",
			content: instruction
		}, {
			role: "user",
			content: `${transcriptOf(toSummarize)}${suffix}`
		}];
		const text = await deps.complete(request, signal);
		if (text.trim() !== "") summary = text.trim();
		else skipped = "summariser returned an empty summary";
	} catch (error) {
		skipped = `summarisation failed: ${String(error)}`;
	}
	if (summary === void 0) return {
		messages: first.messages,
		skipped,
		tokens: first.tokens
	};
	const withSummary = injectSummary(first.messages, summary);
	if (estimateMessagesTokens(withSummary) > options.budget) {
		const truncated = hardTruncate(withSummary, options.budget);
		return {
			messages: truncated.messages,
			summary,
			tokens: truncated.tokens
		};
	}
	return {
		messages: withSummary,
		summary,
		tokens: estimateMessagesTokens(withSummary)
	};
}
/**
* Re-insert a summary as: pinned instructions → summary → surviving tail.
*
* 顺序有意义。钉住（system/developer）的消息必须排在摘要之前，这样后加的
* 合成 system 消息永远不会覆盖 harness 自己的指令；尾部紧随其后，使最新一轮
* 问答是模型最后读到的内容。
*
* `compacted` 总是由 `compactMessages` 从 `original` 派生而来，所以它携带的
* 钉住消息就是原件 —— 无需再从 `original` 里重新添加。
*/
function injectSummary(compacted, summary) {
	const pinned = [];
	const rest = [];
	for (const message of compacted) if (isPinnedRole(message.role)) pinned.push(message);
	else rest.push(message);
	return [
		...pinned,
		summaryMessage(summary),
		...rest
	];
}
//#endregion
//#region src/shim.ts
/**
* 回环 OpenAI 兼容端点 + 多账号自动容错换号。
*
* pi-ai provider 指向这里。每个 chat 请求从账号池取一个账号；上游回答限流时，
* shim 冷却该账号、换下一个、在同一请求内重试 —— 所以 `429 soft_rate` 永远
* 不会以「一轮对话失败」的形式到达用户面前。
*
* 安全模型（Host/Origin 回环校验、常量时间 bearer 比较、随机端口、进程内
* secret、请求体上限、错误→状态码映射）沿用 dsh-workbuddy-xdpool 的已验证设计
* （其血统为 corrinehu/dsh-workbuddy-connect，MIT）。
*
* @module dsh-connect-trae-models/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** 压缩摘要文本的上限，防止一次异常上游把内存吃光。 */
const COMPLETION_TEXT_LIMIT = 262144;
/** 各上游失败类映射到的 HTTP 状态码。 */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	authentication: 401,
	not_found: 502,
	server: 502,
	client: 400,
	unconfigured: 503
};
/** 上游未给 reset 时间时的限流冷却兜底（毫秒）。 */
const TRAE_DEFAULT_COOLDOWN_MS = 6e4;
/**
* 从 429 响应体解析冷却截止时刻。
*
* 上游有时给出 `resetAt`/`reset_time`（13 位 epoch 毫秒）或本地化的
* 「将在 2026-10-11 12:00:00」；两者都拿不到时返回 undefined，由
* {@link TRAE_DEFAULT_COOLDOWN_MS} 兜底 —— 一个识别不出的限流窗口绝不能让
* 账号被无限期冷却，也绝不能完全不冷却。
*/
function parseRateLimitReset(body) {
	const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body);
	if (epochMs !== null) return Number(epochMs[1]);
	const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body);
	if (localized !== null) {
		const parsed = Date.parse(localized[1].replace(" ", "T"));
		if (!Number.isNaN(parsed)) return parsed;
	}
}
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/** Host 必须指向回环；在路由前就挡掉 DNS rebinding。 */
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/** 带 Origin 时必须是回环；非浏览器客户端不发 Origin，直接放行。 */
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** chat POST 必须带 JSON body 类型（挡掉简单请求 CSRF）。 */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/**
* 上游失败体是否表示请求超出了模型上下文窗口。
*
* Trae 的表述与 WorkBuddy 不同：除通用的 `context_length_exceeded` 外，还会
* 出现「input length too long」与 `"code":1005` 家族之外的窗口类文案，
* 所以这里同时接受正则化的通用说法。
*/
function isContextTooLong(body) {
	if (body.includes("context_length_exceeded")) return true;
	if (body.includes("input length too long")) return true;
	if (body.includes("context window exceeded")) return true;
	if (body.includes("maximum context length")) return true;
	if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true;
	return false;
}
/**
* 请求的无内容形态描述，供上游拒绝时记日志。
*
* `client` 类失败（HTTP 400）通常带空的 `param`，错误本身说不出是哪个参数被
* 拒 —— 用户只看到「请求参数不满足当前模型要求」而无从下手。记录形态
* （顶层键、按角色的消息数、工具数、近似 prompt 大小）让这类拒绝能从日志里
* 诊断出来。
*
* 刻意只记形态：无消息内容、无工具 schema、无 token。它会落进日志文件，而它
* 描述的那个对话属于用户。
*/
function requestShape(raw) {
	try {
		const parsed = JSON.parse(raw);
		const keys = Object.keys(parsed).sort();
		const messages = Array.isArray(parsed["messages"]) ? parsed["messages"] : [];
		const byRole = /* @__PURE__ */ new Map();
		let chars = 0;
		for (const entry of messages) {
			if (typeof entry !== "object" || entry === null) continue;
			const message = entry;
			const role = typeof message["role"] === "string" ? message["role"] : "?";
			byRole.set(role, (byRole.get(role) ?? 0) + 1);
			chars += JSON.stringify(message["content"] ?? "").length;
		}
		const roles = [...byRole.entries()].map(([role, n]) => `${role}:${n}`).join(" ");
		const tools = Array.isArray(parsed["tools"]) ? parsed["tools"].length : 0;
		return `keys=[${keys.join(" ")}] messages=${messages.length}${roles === "" ? "" : ` (${roles})`} tools=${tools} contentChars=${chars}`;
	} catch {
		return "body was not parseable JSON";
	}
}
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
function conversationKeyOf(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.messages)) return void 0;
		for (const entry of parsed.messages) {
			if (typeof entry !== "object" || entry === null) continue;
			const message = entry;
			if (message["role"] !== "user") continue;
			const content = typeof message["content"] === "string" ? message["content"] : JSON.stringify(message["content"] ?? "");
			return createHash("sha256").update(content).digest("hex").slice(0, 32);
		}
		return;
	} catch {
		return;
	}
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/** 取请求里的 model 字段（限流按模型计，所以冷却要带 modelId）。 */
function modelIdOf(raw) {
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed.model === "string" && parsed.model !== "" ? parsed.model : void 0;
	} catch {
		return;
	}
}
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
function stampTraeWireTarget(raw, catalog) {
	let parsed;
	try {
		const candidate = JSON.parse(raw);
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return raw;
		parsed = candidate;
	} catch {
		return raw;
	}
	const requestedModel = typeof parsed["model"] === "string" && parsed["model"] !== "" ? parsed["model"] : void 0;
	if (requestedModel === void 0) return raw;
	const entry = catalog.find(requestedModel);
	if (entry === void 0) return raw;
	let changed = false;
	if (entry.wireConfigName !== void 0 && entry.wireConfigName !== "" && entry.wireConfigName !== requestedModel) {
		parsed["model"] = entry.wireConfigName;
		changed = true;
	}
	if (entry.wireFunction !== void 0 && entry.wireFunction !== "") {
		const explicit = parsed["function"];
		if (typeof explicit !== "string" || explicit === "") {
			parsed["function"] = entry.wireFunction;
			changed = true;
		}
	}
	if (typeof parsed["reasoning_effort"] === "string") {
		const supported = entry.supportedEfforts;
		if (supported === void 0 || !supported.includes(parsed["reasoning_effort"])) {
			delete parsed["reasoning_effort"];
			changed = true;
		}
	}
	return changed ? JSON.stringify(parsed) : raw;
}
function createTraePoolShim(options) {
	const { pool, client, catalog } = options;
	const region = options.region;
	const logger = options.logger;
	const maxAttempts = options.maxAttempts ?? 8;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const a = Buffer.from(match[1]);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("trae shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	/**
	* 每账号最近一次余额刷新时刻，避免繁忙账号被每次请求探测。
	* 十分钟远在普通使用可能跨过保留线的窗口之内。
	*/
	const lastBalanceAt = /* @__PURE__ */ new Map();
	const BALANCE_REFRESH_MS = 6e5;
	/**
	* 尽力刷新一个账号已知的积分余额。
	*
	* 在成功请求后于后台运行。失败被刻意吞掉：保留线是安全特性，一次抖动的余额
	* 查询绝不能变成失败的用户请求或噪声日志。
	*/
	async function refreshBalance(account) {
		const now = Date.now();
		if (now - (lastBalanceAt.get(account.id) ?? 0) < BALANCE_REFRESH_MS) return;
		lastBalanceAt.set(account.id, now);
		try {
			const request = await identityOf(account);
			if (request === void 0) return;
			const credits = await client.fetchCredits(request);
			pool.noteCredits(account.id, credits.total, credits.nearestExpiryMs);
		} catch {}
	}
	/**
	* 把一个池账号包装成上游请求身份包。
	*
	* Trae 的每个上游方法都要 `{ credential, identity }`：identity 提供
	* `x-machine-id`/`x-device-id`，而 `deviceId` 还是签到名额的判定量。所以
	* 这里必须解析本机身份，而不是只传凭据。
	*/
	async function identityOf(account) {
		const identity = options.identityOf === void 0 ? void 0 : await options.identityOf(account);
		if (identity === void 0) {
			logger?.warn?.("dsh-connect-trae-models: 本机身份不可用，跳过该请求（签到与 x-device-id 依赖它）");
			return;
		}
		return {
			credential: {
				accessToken: account.credential.accessToken,
				userId: account.credential.userId,
				edition: account.credential.edition
			},
			identity: {
				machineId: identity.machineId,
				deviceId: identity.deviceId,
				platform: identity.platform,
				...identity.appVersion === void 0 ? {} : { appVersion: identity.appVersion },
				...identity.buildVersion === void 0 ? {} : { buildVersion: identity.buildVersion },
				...identity.deviceBrand === void 0 ? {} : { deviceBrand: identity.deviceBrand },
				...identity.deviceCpu === void 0 ? {} : { deviceCpu: identity.deviceCpu },
				...identity.osVersion === void 0 ? {} : { osVersion: identity.osVersion }
			}
		};
	}
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, {
					ok: true,
					pool: pool.status()
				});
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: "connect-trae-models"
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	/**
	* 服务一次 chat 补全，在限流时轮换账号。
	*
	* 被限流的账号按上游报告的窗口冷却（可解析时），并立刻尝试下一个账号 ——
	* 所以池里只要有健康成员，就永远不向调用方暴露 429。
	*/
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		const raw = (await readBody(req)).toString("utf8");
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const conversationKey = conversationKeyOf(raw);
		const modelId = modelIdOf(raw);
		const stamped = stampTraeWireTarget(raw, catalog);
		const tried = [];
		let last;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			if (controller.signal.aborted) return;
			const account = await pool.acquire(modelId, region, conversationKey);
			if (account === void 0) {
				const why = pool.unavailableReason(modelId, region);
				if (why.reason === "cooling") {
					const subject = modelId === void 0 ? "every Trae account is rate-limited" : `every account is rate-limited for model ${modelId}`;
					const upstream = last === void 0 ? "" : ` — ${last.message.slice(0, 200)}`;
					writeOpenAIError(res, 429, "soft_rate", `${subject} (${why.cooling}/${why.total} cooling, tried ${tried.length})${tried.length === 0 ? "" : `: ${tried.join(" → ")}`}${upstream}`);
					return;
				}
				if (why.reason === "disabled") {
					writeOpenAIError(res, 403, "no_enabled_account", `all ${why.total} Trae account(s) for this gateway are switched off; re-enable one on the pool card`);
					return;
				}
				if (why.reason === "reserve") {
					writeOpenAIError(res, 402, "reserve_floor", `every Trae account is at or below its credit reserve (${why.total} account(s)); lower the reserve on the pool card or top up credits`);
					return;
				}
				if (why.reason === "dead") {
					writeOpenAIError(res, 401, "session_dead", `${why.dead}/${why.total} Trae account(s) for this gateway were rejected by the upstream (their sign-in was revoked); sign in again in the Trae desktop app to restore them`);
					return;
				}
				writeOpenAIError(res, 401, "not_signed_in", why.total === 0 ? "no Trae credential found for this gateway; sign in on the Trae desktop app" : `no usable Trae credential among ${why.total} account(s) for this gateway; sign in again on the desktop app`);
				return;
			}
			tried.push(account.label);
			const request = await identityOf(account);
			if (request === void 0) {
				writeOpenAIError(res, 500, "identity_unavailable", "Trae machine identity could not be resolved");
				return;
			}
			const result = await client.chatStream(request, stamped, controller.signal, modelId);
			if (result.ok) {
				await serveSuccessfulStream(res, account, result, logger, refreshBalance, pool);
				return;
			}
			last = {
				kind: result.kind,
				status: result.status,
				message: result.message
			};
			if (result.kind === "authentication") {
				logger?.warn(`dsh-connect-trae-models: ${account.label} 会话失效；刷新 token 后重试`);
				const before = account.credential.accessToken;
				if (!await pool.refreshAccount(account.id, { force: true }) || account.credential.accessToken === before) {
					pool.penalizeCredentialDead(account.id);
					logger?.warn(`dsh-connect-trae-models: ${account.label} 登录已失效 (attempt ${attempt + 1}/${maxAttempts})；轮换`);
				}
				continue;
			}
			if (result.kind === "hard_credit") {
				pool.penalizeExhausted(account.id);
				logger?.warn(`dsh-connect-trae-models: ${account.label} 积分已耗尽 (attempt ${attempt + 1}/${maxAttempts})；轮换`);
				continue;
			}
			if (result.kind === "client") logger?.warn(`dsh-connect-trae-models: ${account.label} 判定请求无效 (model ${modelId ?? "(none)"}) — ${requestShape(raw)}；上游：${result.message.slice(0, 300)}`);
			if (result.kind !== "soft_rate") break;
			const resetAt = parseRateLimitReset(result.message) ?? Date.now() + 6e4;
			pool.penalize(account.id, resetAt, modelId);
			logger?.warn(`dsh-connect-trae-models: ${account.label} 在 ${modelId ?? "(no model)"} 上被限流 (attempt ${attempt + 1}/${maxAttempts})；轮换`);
		}
		if (last === void 0) {
			writeOpenAIError(res, 500, "internal", "chat request exhausted without a result");
			return;
		}
		if (isContextTooLong(last.message)) {
			const recovered = await recoverFromContextOverrun({
				raw: stamped,
				modelId,
				controller,
				region,
				logger,
				client,
				pool,
				maxAttempts,
				identityOf,
				contextWindow: modelId === void 0 ? void 0 : catalog.current().find((m) => m.id === modelId)?.contextWindow
			});
			if (recovered.ok) {
				await serveSuccessfulStream(res, recovered.account, recovered.result, logger, refreshBalance, pool);
				return;
			}
			writeOpenAIError(res, 400, "context_length_exceeded", contextOverflowMessage(modelId, recovered.detail));
			return;
		}
		writeOpenAIError(res, KIND_STATUS[last.kind], last.kind, `trae upstream ${last.kind} (http ${last.status}) after ${tried.length} account(s) [${tried.join(" → ")}]: ${last.message.slice(0, 400)}`);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
/**
* 把一次流式补全的 SSE 帧重组成单个字符串。
*
* 只用于内部压缩（总结被丢弃的轮次）：chat 端点本身总是流式，所以这里把帧
* 收集起来。任何失败都会抛出，让压缩器回退到纯截断，而不是让用户的这一轮
* 失败。
*/
async function readCompletionText(response) {
	if (response.body === null) throw new Error("compaction upstream returned no body");
	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	let buffer = "";
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let split = buffer.indexOf("\n\n");
			while (split !== -1) {
				text += contentOfFrame(buffer.slice(0, split));
				buffer = buffer.slice(split + 2);
				if (text.length > COMPLETION_TEXT_LIMIT) return text.slice(0, COMPLETION_TEXT_LIMIT);
				split = buffer.indexOf("\n\n");
			}
		}
		if (buffer.trim() !== "") text += contentOfFrame(buffer);
	} finally {
		reader.releaseLock?.();
	}
	return text;
}
/** 从一帧 SSE 里取出 `choices[0].delta.content`（或非流式的 `message.content`）。 */
function contentOfFrame(frame) {
	let out = "";
	for (const rawLine of frame.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "" || payload === "[DONE]") continue;
		let parsed;
		try {
			parsed = JSON.parse(payload);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const choices = parsed.choices;
		if (!Array.isArray(choices)) continue;
		const first = choices[0];
		if (typeof first !== "object" || first === null) continue;
		const choice = first;
		const delta = choice["delta"];
		if (typeof delta === "object" && delta !== null) {
			const content = delta["content"];
			if (typeof content === "string") out += content;
		}
		const message = choice["message"];
		if (typeof message === "object" && message !== null) {
			const content = message["content"];
			if (typeof content === "string") out += content;
		}
	}
	return out;
}
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
function contextOverflowMessage(modelId, detail = "") {
	return `This model's maximum context length was exceeded: the prompt is too large for ${modelId === void 0 ? "the model" : `model ${modelId}`}, and the conversation could not be compacted in place${detail === "" ? "" : ` (${detail})`}. Compact the conversation, or start a new chat.`;
}
/**
* 把一个已经成功的上游流转发为 SSE 响应。
*
* 抽出来是为了让上下文超限恢复路径复用与首次命中**完全相同**的簿记
* （noteServed + 后台余额刷新）。
*/
async function serveSuccessfulStream(res, account, result, logger, refreshBalance, pool) {
	logger?.info?.(`dsh-connect-trae-models: 由 ${account.label} 服务`);
	pool.noteServed(account.id);
	refreshBalance(account);
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no"
	});
	let sawDone = false;
	let queueLogged = false;
	const body = Readable.fromWeb(result.response.body);
	body.on("data", (chunk) => {
		if (chunk.includes("[DONE]")) sawDone = true;
		if (!queueLogged && chunk.includes("trae-queue")) {
			queueLogged = true;
			const match = /trae-queue(?: position=(\d+))?/.exec(chunk.toString("utf8"));
			logger?.info?.(`dsh-connect-trae-models: 上游排队中（位置 ${match?.[1] ?? "未知"}），已发送保活帧等待`);
		}
	});
	body.on("error", (error) => {
		logger?.warn("dsh-connect-trae-models: 上游流中途失败", error);
		if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
	});
	body.pipe(res);
}
/**
* 压缩一个过长的对话并重试一次。
*
* 策略依次为：
*  1. 丢弃最老的轮次，保留 system 消息与最新一轮问答；
*  2. 让模型总结被丢弃的轮次并把这句摘要拼接回去；
*  3. 最后手段：硬截断。
*
* 只有连截断后的 prompt 仍超限才返回 `ok: false` —— 调用方随后把原始可操作的
* 400 交给用户。
*/
async function recoverFromContextOverrun(options) {
	const { raw, modelId, controller, region, logger, client, pool, maxAttempts, identityOf } = options;
	let parsed;
	try {
		const candidate = JSON.parse(raw);
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return {
			ok: false,
			detail: "request body was not a JSON object"
		};
		parsed = candidate;
	} catch {
		return {
			ok: false,
			detail: "request body was not parseable JSON"
		};
	}
	const rawMessages = parsed["messages"];
	if (!Array.isArray(rawMessages)) return {
		ok: false,
		detail: "request carried no messages array"
	};
	const messages = rawMessages.filter((value) => typeof value === "object" && value !== null && !Array.isArray(value));
	if (messages.length === 0) return {
		ok: false,
		detail: "request carried no usable messages"
	};
	const overrunTokens = estimateMessagesTokens(messages);
	const realWindow = options.contextWindow;
	const fromWindow = realWindow !== void 0 && realWindow > 0 ? Math.max(512, Math.floor(realWindow * .8) - 2048) : Number.POSITIVE_INFINITY;
	const fromOverrun = Math.max(512, Math.floor(overrunTokens / 2));
	const budget = Math.min(fromWindow, fromOverrun);
	logger?.warn(`dsh-connect-trae-models: ${modelId ?? "(no model)"} 上下文超限 (~${overrunTokens} tokens, catalog window ${realWindow ?? "unknown"})；压缩到 ~${budget} 后重试一次`);
	let summary;
	let compacted = messages;
	let compactionDetail = "";
	try {
		const summariser = await pool.acquire(modelId, region);
		const summariserRequest = summariser === void 0 ? void 0 : await identityOf(summariser);
		if (summariser === void 0 || summariserRequest === void 0) compactionDetail = "no account available to summarise with";
		else {
			const outcome = await compactWithSummary(messages, {
				budget,
				keepRecent: 6
			}, { complete: async (request, signal) => {
				const body = JSON.stringify({
					...parsed,
					stream: true,
					max_tokens: Math.max(256, Math.floor(budget / 2)),
					messages: request
				});
				const result = await client.chatStream(summariserRequest, body, signal ?? controller.signal, modelId);
				if (!result.ok) throw new Error(`compaction upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 300)}`);
				return await readCompletionText(result.response);
			} }, controller.signal);
			compacted = outcome.messages;
			summary = outcome.summary;
			if (outcome.skipped !== void 0) compactionDetail = outcome.skipped;
		}
	} catch (error) {
		compactionDetail = `summarisation failed: ${String(error)}`;
	}
	if (estimateMessagesTokens(compacted) > budget) compacted = hardTruncate(compacted, budget).messages;
	if (summary === void 0 && estimateMessagesTokens(compacted) >= overrunTokens) return {
		ok: false,
		detail: compactionDetail === "" ? "compaction could not reduce the prompt" : compactionDetail
	};
	const retryBody = JSON.stringify({
		...parsed,
		messages: compacted
	});
	const tried = [];
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		if (controller.signal.aborted) return {
			ok: false,
			detail: "client disconnected"
		};
		const account = await pool.acquire(modelId, region);
		if (account === void 0) return {
			ok: false,
			detail: "no account available after compaction"
		};
		const request = await identityOf(account);
		if (request === void 0) return {
			ok: false,
			detail: "machine identity unavailable after compaction"
		};
		tried.push(account.label);
		const result = await client.chatStream(request, retryBody, controller.signal, modelId);
		if (result.ok) {
			logger?.info?.(`dsh-connect-trae-models: ${modelId ?? "(no model)"} 已从上下文超限恢复 (summarised: ${summary === void 0 ? "no" : "yes"})`);
			return {
				ok: true,
				account,
				result
			};
		}
		if (isContextTooLong(result.message)) return {
			ok: false,
			detail: "prompt still exceeded the window after compaction"
		};
		if (result.kind === "authentication") {
			const before = account.credential.accessToken;
			if (!await pool.refreshAccount(account.id, { force: true }) || account.credential.accessToken === before) pool.penalizeCredentialDead(account.id);
			continue;
		}
		if (result.kind === "hard_credit") {
			pool.penalizeExhausted(account.id);
			continue;
		}
		if (result.kind === "soft_rate") {
			const resetAt = parseRateLimitReset(result.message) ?? Date.now() + 6e4;
			pool.penalize(account.id, resetAt, modelId);
			continue;
		}
		return {
			ok: false,
			detail: `upstream ${result.kind} after compaction`
		};
	}
	return {
		ok: false,
		detail: `no account served the compacted request (tried ${tried.length})`
	};
}
//#endregion
//#region src/web-status.ts
/** 上游对「本设备今日已签到」的业务码。 */
const CHECKIN_DEVICE_ALREADY_CLAIMED = 9095;
/**
* 「3 天内到期」提醒窗口。
*
* 与 `upstream.ts` 的 `TRAE_EXPIRING_SOON_WINDOW_MS` 同值；这里重新声明是为了
* 让本模块的类型面自洽（值语义必须一致，测试钉住）。
*/
const EXPIRING_SOON_WINDOW_MS = 2592e5;
/** 每账号探测的上游调用超时（长于它视为不可达，降级为错误文案）。 */
const ACCOUNT_PROBE_TIMEOUT_MS = 15e3;
/**
* 读出池里被钉选的账号，访问器缺失时按「没有钉选」处理。
*
* 状态文档是**只读**组装路径：某个可选访问器不在（测试替身、老宿主、后续精简）
* 时，最坏的结果应该是「看不到钉选标记」，而不是整份文档 500——那会让账号列表、
* 积分与签到一起消失，把一个装饰性字段的缺失升级成功能故障。
*/
function readPreferredAccountId(pool) {
	const reader = pool.preferredAccountId;
	if (typeof reader !== "function") return void 0;
	try {
		const value = reader.call(pool);
		return typeof value === "string" && value !== "" ? value : void 0;
	} catch {
		return;
	}
}
/** 把 token 类内容抹掉再送回浏览器。 */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** 只接受回环浏览器来源；其它设备一律拒绝。 */
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}
/** 最小 POST body 读取器，带上限，防止挂起或超大 body 钉住宿主机内存。 */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		const LIMIT = 65536;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (text === "") {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(text);
				resolve(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {});
			} catch {
				reject(/* @__PURE__ */ new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}
/**
* 解析状态/签到路由的区域。
*
* 合法值之外一律 400（而不是静默回落）：卡片 tab 与文档必须指向同一个区域，
* 静默回落会让 ai 的标签页读到 cn 的数据。返回值 `undefined` 时响应已写完。
*/
function requestRegion(req, res, allowBody) {
	const fromBody = allowBody?.["region"];
	const raw = typeof fromBody === "string" ? fromBody : new URL(req.url ?? "/", "http://localhost").searchParams.get("region");
	const region = parseRegionParam(raw);
	if (region === void 0) {
		json(res, 400, { error: `unknown region: ${String(raw).slice(0, 32)}` });
		return;
	}
	return region;
}
/** 一个账号行的组装输入（把 pool 的簿记摊平）。 */
function toWebAccount(account, now, deps) {
	const cooling = account.cooldownUntilMs > now;
	const deadUntil = account.credentialDeadUntilMs ?? 0;
	const credentialDead = deadUntil > now;
	const modelCooldowns = Object.entries(account.modelCooldowns).filter(([, until]) => until > now).map(([modelId, until]) => ({
		modelId,
		until: new Date(until).toISOString()
	}));
	const credits = deps.credits;
	return {
		id: account.id,
		label: account.label,
		region: account.region,
		...account.credential.expiresAtMs > 0 ? { expiresAt: new Date(account.credential.expiresAtMs).toISOString() } : {},
		cooling,
		...cooling ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
		...credentialDead ? {
			credentialDead: true,
			credentialDeadUntil: new Date(deadUntil).toISOString()
		} : {},
		...modelCooldowns.length === 0 ? {} : { modelCooldowns },
		disabled: deps.disabled,
		rateLimitHits: account.rateLimitHits,
		creditReserve: deps.reserve,
		reserved: deps.reserved,
		...account.lastUsedAt === void 0 ? {} : { lastUsedAt: new Date(account.lastUsedAt).toISOString() },
		...credits === void 0 ? {} : { credits: {
			total: credits.total,
			consumed: credits.consumed,
			available: credits.available,
			packs: credits.packs.map((pack) => ({
				displayDesc: pack.displayDesc,
				endTimeMs: pack.endTimeMs,
				...pack.creditsLimit === void 0 ? {} : { creditsLimit: pack.creditsLimit },
				...pack.consumed === void 0 ? {} : { consumed: pack.consumed }
			})),
			...credits.nearestExpiryMs === void 0 ? {} : { nearestExpiryMs: credits.nearestExpiryMs },
			...credits.expiringSoon === void 0 ? {} : { expiringSoon: credits.expiringSoon }
		} },
		...deps.creditsError === void 0 ? {} : { creditsError: deps.creditsError },
		...deps.checkin === void 0 ? {} : { checkin: deps.checkin },
		...deps.checkinError === void 0 ? {} : { checkinError: deps.checkinError },
		...deps.deviceSpent === true ? { deviceSpent: true } : {}
	};
}
/** 签到状态 → 卡片形状。 */
function toCheckin(status) {
	return {
		enabled: status.enabled,
		checkedIn: status.checkedIn,
		didCheckedIn: status.didCheckedIn,
		credits: status.credits,
		...status.extraCredits === void 0 ? {} : { extraCredits: status.extraCredits }
	};
}
/** 模型行 → 卡片形状。 */
function toWebModel(model, enabled) {
	return {
		id: model.id,
		name: model.name,
		...model.multiplier === void 0 ? {} : { multiplier: model.multiplier },
		enabled,
		supportsImages: model.supportsImages,
		contextWindow: model.contextWindow,
		nativeContextWindow: model.maxContextWindow ?? model.contextWindow,
		...model.maxOutputTokens === void 0 ? {} : { maxOutputTokens: model.maxOutputTokens },
		...model.supportedEfforts === void 0 ? {} : { supportedEfforts: model.supportedEfforts }
	};
}
/** 自动化 job 状态 → 卡片形状。 */
function toWebJob(state) {
	return {
		...state.lastRunDate === void 0 ? {} : { lastRunDate: state.lastRunDate },
		...state.lastRunAtMs === void 0 ? {} : { lastRunAtMs: state.lastRunAtMs },
		...state.firedSlots === void 0 ? {} : { firedSlots: [...state.firedSlots] },
		ok: state.ok,
		failed: state.failed,
		claimed: state.claimed,
		credit: state.credit,
		deviceSpent: state.deviceSpent,
		...state.message === void 0 ? {} : { message: state.message },
		...state.detail === void 0 ? {} : { detail: [...state.detail] }
	};
}
/** 无调度器时的空自动化块（卡片渲染同一个形状，而不是缺一块）。 */
function emptyAutomation() {
	return {
		enabled: false,
		running: false,
		checkinHours: [],
		jobs: { checkin: {
			ok: 0,
			failed: 0,
			claimed: 0,
			credit: 0,
			deviceSpent: 0
		} },
		earningsToday: {},
		runInProgress: false
	};
}
/** 读取保存的模型选择（分区键优先，legacy 平键兜底）。 */
function savedSelection(config, region) {
	const section = config[region === "cn" ? "modelSelectionCn" : "modelSelectionGlobal"];
	const source = typeof section === "object" && section !== null && !Array.isArray(section) ? section : {};
	const pick = (key, legacy) => {
		const value = source[key];
		if (Array.isArray(value)) return value;
		if (Array.isArray(legacy)) return legacy;
	};
	const enabled = pick("enabledModelIds", config["enabledModelIds"]);
	const images = pick("imageModelIds", config["imageModelIds"]);
	const rawBudgets = source["contextBudgets"] ?? config["contextBudgets"];
	const budgets = typeof rawBudgets === "object" && rawBudgets !== null && !Array.isArray(rawBudgets) ? rawBudgets : void 0;
	return {
		...enabled === void 0 ? {} : { enabledModelIds: enabled },
		...images === void 0 ? {} : { imageModelIds: images },
		...budgets === void 0 ? {} : { contextBudgets: budgets }
	};
}
/**
* 组装卡片状态文档。
*
* 逐账号组账：`credits` 与 `checkin` 都是异步 best-effort —— 一个账号积分读失败
* 只降级成该行的 `creditsError`，绝不让整份文档 500。这个取舍是刻意的：卡片最
* 需要的「谁在冷却、谁被关掉、模型倍率多少」都来自本地簿记，不能因为一个账号的
* 上游调用超时而一起消失。
*/
async function buildTraePoolWebStatus(deps, region, options = {}) {
	const probe = options.probe ?? true;
	const now = Date.now();
	const config = deps.config?.() ?? {};
	const accounts = deps.pool.list(region);
	const rows = [];
	const deviceId = deps.deviceId?.() ?? "";
	for (const account of accounts) {
		const disabled = deps.pool.isDisabled(account.id);
		const reserve = deps.pool.creditReserveOf(account.id);
		const request = {
			credential: account.credential,
			identity: void 0
		};
		let credits;
		let creditsError;
		let checkin;
		let checkinError;
		if (probe) {
			if (region === "cn") {
				credits = await deps.client.fetchCredits(request, AbortSignal.timeout(ACCOUNT_PROBE_TIMEOUT_MS)).catch((error) => {
					creditsError = safeMessage(error);
				});
				checkin = await deps.client.fetchCheckinStatus(request, deviceId, AbortSignal.timeout(ACCOUNT_PROBE_TIMEOUT_MS)).then((status) => toCheckin(status)).catch((error) => {
					checkinError = safeMessage(error);
				});
			}
		}
		const deviceSpent = checkin !== void 0 && checkin.didCheckedIn && !checkin.checkedIn;
		rows.push(toWebAccount(account, now, {
			disabled,
			reserve,
			reserved: deps.pool.isReserved(account.id) && reserve > 0,
			...credits === void 0 ? {} : { credits },
			...creditsError === void 0 ? {} : { creditsError },
			...checkin === void 0 ? {} : { checkin },
			...checkinError === void 0 ? {} : { checkinError },
			deviceSpent
		}));
	}
	const catalog = deps.catalogs[region];
	const selection = savedSelection(config, region);
	const enabled = new Set(selection.enabledModelIds ?? []);
	const schedulerStatus = deps.scheduler?.();
	const automation = schedulerStatus === void 0 ? emptyAutomation() : {
		enabled: schedulerStatus.enabled,
		running: schedulerStatus.running,
		checkinHours: [...schedulerStatus.checkinHours],
		jobs: { checkin: toWebJob(schedulerStatus.jobs.checkin) },
		earningsToday: Object.fromEntries(Object.entries(schedulerStatus.earningsToday).map(([id, entry]) => [id, toEarnings(entry)])),
		runInProgress: schedulerStatus.runInProgress,
		...schedulerStatus.lastPassAtMs === void 0 ? {} : { lastPassAtMs: schedulerStatus.lastPassAtMs }
	};
	return {
		ok: true,
		region,
		accounts: rows,
		...deps.pool.lastServedId() === void 0 ? {} : { activeAccountId: deps.pool.lastServedId() },
		...readPreferredAccountId(deps.pool) === void 0 ? {} : { preferredAccountId: readPreferredAccountId(deps.pool) },
		cooling: rows.filter((row) => row.cooling).length,
		models: catalog.visible().map((model) => toWebModel(model, enabled.size === 0 || enabled.has(model.id))),
		selection,
		distribution: deps.pool.currentDistribution(),
		shim: deps.shim?.(region) ?? { running: false },
		automation,
		creditReserves: deps.pool.creditReservesInOrder(),
		catalogSource: catalog.currentSource(),
		...catalog.catalogUpdatedAt() === void 0 ? {} : { catalogUpdatedAt: catalog.catalogUpdatedAt() },
		...catalog.lastFetchError() === void 0 ? {} : { catalogError: safeMessage(catalog.lastFetchError()) }
	};
}
/** 今日自动化所得 → 卡片形状。 */
function toEarnings(entry) {
	return {
		credit: entry.credit,
		checkinCredit: entry.checkinCredit,
		date: entry.date,
		...entry.deviceSpent === true ? { deviceSpent: true } : {}
	};
}
/** 校验模型选择载荷；任何畸形都返回 undefined 让路由答 400，而不是写半个选择。 */
function parseSelection(body) {
	const out = {};
	for (const key of ["enabledModelIds", "imageModelIds"]) {
		const value = body[key];
		if (value === void 0) continue;
		if (!Array.isArray(value)) return void 0;
		const ids = [];
		for (const entry of value) {
			if (typeof entry !== "string" || entry === "") return void 0;
			ids.push(entry);
		}
		out[key] = ids;
	}
	const budgets = body["contextBudgets"];
	if (budgets !== void 0) {
		if (typeof budgets !== "object" || budgets === null || Array.isArray(budgets)) return void 0;
		const map = {};
		for (const [id, raw] of Object.entries(budgets)) {
			if (id === "") return void 0;
			if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1e3) return void 0;
			map[id] = raw;
		}
		out.contextBudgets = map;
	}
	return out;
}
/** 校验账号开关载荷。 */
function parseAccountToggle(body, known) {
	const accountId = typeof body["accountId"] === "string" ? body["accountId"].trim() : "";
	const disabled = body["disabled"];
	if (accountId === "" || typeof disabled !== "boolean") return void 0;
	if (!known(accountId)) return void 0;
	return {
		accountId,
		disabled
	};
}
/** 校验手动运行载荷。未知 job 名答 400，而不是静默什么都不做。 */
function parseAutomationRun(body, knownJob) {
	const raw = body["job"];
	const force = body["force"];
	if (force !== void 0 && typeof force !== "boolean") return void 0;
	if (raw === void 0 || raw === null || raw === "") return { ...force === void 0 ? {} : { force } };
	if (typeof raw !== "string") return void 0;
	const job = raw.trim();
	if (!knownJob(job)) return void 0;
	return {
		job,
		...force === void 0 ? {} : { force }
	};
}
/**
* 在 `webServer` 可用的 context 上挂载路由。
*
* 调用方用 `ctx.inject(['webServer'], ...)`，让桌面端启动顺序无法让这次注册
* 凭空消失。
*/
function registerTraePoolStatusRoute(ctx, deps) {
	ctx.effect(() => {
		const disposers = [];
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: TRAE_POOL_STATUS_PATH,
			handler: async (req, res) => {
				if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				const region = requestRegion(req, res);
				if (region === void 0) return;
				try {
					json(res, 200, await buildTraePoolWebStatus(deps, region));
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		}));
		/**
		* 每日签到领取——本插件**唯一**会改上游账号状态的路由，因此守得比兄弟路由
		* 严得多：仅 POST、仅回环 origin，且状态读取**先跑**，让「该账号今天已经拿到
		* 奖励」的日子永远到不了上游的 claim。
		*
		* `alreadyCheckedIn` 与 `deviceCheckedIn` 刻意是两个独立答案，因为两个标志
		* 含义不同：`checkedIn` 是该账号今天的奖励已存在，`didCheckedIn` 是**这台
		* 机器**用掉了它的签到名额——很可能是为另一个账号用掉的。把后者当成「今天
		* 签过了」是一个已发布过的缺陷：切换账号后卡片显示「今日已签到」并禁用按钮，
		* 结论对但理由错，掩盖了新账号其实一分未得。
		*
		* 上游按北京自然日幂等（重复 claim 回 code 0 但额度不变），但把正确性建立在
		* 上游的宽容上，等于把闸门交到别人手里。
		*/
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: TRAE_POOL_CHECKIN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					return json(res, 400, { error: safeMessage(error) });
				}
				const region = requestRegion(req, res, body);
				if (region === void 0) return;
				if (region !== "cn") return json(res, 404, { error: "check-in is not available for the international region" });
				const accountId = typeof body["accountId"] === "string" ? body["accountId"].trim() : "";
				if (accountId === "") return json(res, 400, { error: "accountId is required" });
				const account = deps.pool.list("cn").find((entry) => entry.id === accountId);
				if (account === void 0) return json(res, 404, { error: "unknown account" });
				try {
					const request = {
						credential: account.credential,
						identity: void 0
					};
					const deviceId = deps.deviceId?.() ?? "";
					const current = await deps.client.fetchCheckinStatus(request, deviceId);
					if (!current.enabled) return json(res, 409, { error: "check-in is not enabled for this account" });
					if (current.checkedIn) return json(res, 200, {
						claimed: false,
						alreadyCheckedIn: true,
						deviceCheckedIn: current.didCheckedIn,
						checkin: toCheckin(current)
					});
					if (current.didCheckedIn) return json(res, 200, {
						claimed: false,
						alreadyCheckedIn: false,
						deviceCheckedIn: true,
						code: CHECKIN_DEVICE_ALREADY_CLAIMED,
						message: "this device already used today's check-in",
						checkin: toCheckin(current)
					});
					if (deviceId === "") return json(res, 409, { error: "this installation has no device id; check-in cannot be claimed" });
					const claim = await deps.client.claimCheckin(request, deviceId);
					const checkin = await deps.client.fetchCheckinStatus(request, deviceId).catch(() => current);
					const deviceClaimed = claim.code === CHECKIN_DEVICE_ALREADY_CLAIMED;
					json(res, 200, {
						claimed: claim.claimed,
						alreadyCheckedIn: false,
						...deviceClaimed ? { deviceCheckedIn: true } : {},
						code: claim.code,
						message: claim.message,
						checkin: toCheckin(checkin)
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		}));
		/**
		* 立即运行一次自动化。
		*
		* 后台启动并立即返回：一整轮要几十秒，把卡片请求挂那么久会让浏览器或宿主
		* web server 超时，用户看到一个卡住的按钮，而那一轮其实在正常跑。卡片随后
		* 轮询 status 的 `automation.runInProgress`。
		*/
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: TRAE_POOL_AUTOMATION_RUN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.runAutomation === void 0) return json(res, 503, { error: "automation is not available" });
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					return json(res, 400, { error: safeMessage(error) });
				}
				const schedule = deps.scheduler?.();
				const known = (job) => schedule !== void 0 && Object.prototype.hasOwnProperty.call(schedule.jobs, job);
				const parsed = parseAutomationRun(body, known);
				if (parsed === void 0) return json(res, 400, { error: "invalid automation run request" });
				try {
					json(res, 200, {
						ok: true,
						started: deps.runAutomation(parsed.job, parsed.force ?? false),
						...parsed.job === void 0 ? {} : { job: parsed.job }
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		}));
		/** 重扫本机凭据。 */
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: TRAE_POOL_RESCAN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.rescan === void 0) return json(res, 503, { error: "rescan is not available" });
				try {
					await deps.rescan();
					json(res, 200, { ok: true });
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		}));
		/** 清除全部冷却（429 自我修复的手动出口）。 */
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: TRAE_POOL_RESET_COOLDOWN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				try {
					if (deps.resetCooldowns !== void 0) await deps.resetCooldowns();
					else deps.pool.resetCooldowns();
					json(res, 200, { ok: true });
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		}));
		/** 开关一个账号。 */
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: TRAE_POOL_ACCOUNT_TOGGLE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.setAccountDisabled === void 0) return json(res, 503, { error: "account switching is not available" });
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					return json(res, 400, { error: safeMessage(error) });
				}
				const toggle = parseAccountToggle(body, (id) => deps.pool.list().some((account) => account.id === id));
				if (toggle === void 0) return json(res, 400, { error: "invalid account toggle" });
				try {
					await deps.setAccountDisabled(toggle.accountId, toggle.disabled);
					json(res, 200, {
						ok: true,
						accountId: toggle.accountId,
						disabled: toggle.disabled
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		}));
		/**
		* 钉选优先账号（对话栏「切换用户」）。
		*
		* 只改本机的派活顺序，不改上游状态、不写凭据。传空 accountId 表示取消钉选、
		* 回到普通轮转。账号必须存在于当前池里，否则拒绝——钉到一个不存在的账号会
		* 让请求无限等待一个永远不会被派活的号。
		*/
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: TRAE_POOL_ACCOUNT_SELECT_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					return json(res, 400, { error: safeMessage(error) });
				}
				const region = requestRegion(req, res, body);
				if (region === void 0) return;
				const raw = body["accountId"];
				const accountId = typeof raw === "string" ? raw.trim() : "";
				if (accountId !== "") {
					if (!deps.pool.list(region).some((account) => account.id === accountId)) return json(res, 404, { error: "account is not in the pool" });
				}
				try {
					deps.pool.prefer(accountId === "" ? void 0 : accountId);
					json(res, 200, {
						ok: true,
						region,
						accountId
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		}));
		/** 保存某区域的模型选择。 */
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: TRAE_POOL_MODELS_SAVE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.saveSelection === void 0) return json(res, 503, { error: "model selection cannot be saved" });
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					return json(res, 400, { error: safeMessage(error) });
				}
				const region = requestRegion(req, res, body);
				if (region === void 0) return;
				const selection = parseSelection(body);
				if (selection === void 0) return json(res, 400, { error: "invalid model selection" });
				try {
					await deps.saveSelection(region, selection);
					json(res, 200, {
						ok: true,
						region
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		}));
		return () => {
			for (const dispose of disposers) dispose();
		};
	});
}
/** 供宿主组装的便捷导出：解包 volatile 后的配置读取器工厂。 */
function configReader(read) {
	return () => {
		const live = unwrapVolatileDeep(read());
		return typeof live === "object" && live !== null && !Array.isArray(live) ? live : {};
	};
}
//#endregion
//#region src/index.ts
/** settings 分区命名空间（卡片与两个 provider 共用）。 */
const TRAE_POOL_SETTINGS_NS = "connect-trae-models";
/** 依赖注入：LLM seam（注册 provider/adapter）与 settings（挂卡片）。 */
const inject = ["llm", "settings"];
/**
* 把一个 schema 字段标记为 volatile。
*
* 0.1.7 线**要求**一个 entry 至少有一个 volatile 字段，否则 settings 写入闸门
* 直接拒绝（"Plugin entry ... has no volatile fields"）且 `describe()` 跳过它 ——
* 卡片既渲染不出也存不下。0.1.5 线上这个标记退化为恒等操作。
*/
function asVolatile(schema) {
	const candidate = schema;
	return typeof candidate.volatile === "function" ? candidate.volatile() : schema;
}
/**
* 剥掉一层 volatile 活引用。
*
* 0.1.7 把一个 volatile 字段以 `{ get(): T }` 交回而不是裸值，好让运行中的实例
* 无需重挂载就能观察设置改动。因此每次读标记字段都要解包：把引用往下一层传会
* 拿对象去和字符串比较，字段被当成未设置。0.1.5 上字段已是裸值，这里是恒等。
*/
function unwrapVolatile$1(value) {
	if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
	return value;
}
/**
* 深拷贝一个配置值，把里面每一个活 `{get(): T}` 引用换它解析出的值。
*
* {@link unwrapVolatile} 只剥普通读取需要的那一层。settings 服务不同：它要校验
* 并 `structuredClone` **整个**对象，所以任何残留引用都会让 schema 校验以
* 「点名字段但不点原因」的消息失败，于是命名空间注册不上、卡片静默消失 ——
* 这正是交给 `installSection` 的对象必须先过这里的原因。
*/
function unwrapVolatileDeep$1(value) {
	const peeled = unwrapVolatile$1(value);
	if (Array.isArray(peeled)) return peeled.map((entry) => unwrapVolatileDeep$1(entry));
	if (peeled !== null && typeof peeled === "object") {
		const out = {};
		for (const [key, entry] of Object.entries(peeled)) out[key] = unwrapVolatileDeep$1(entry);
		return out;
	}
	return peeled;
}
/**
* 一个区域的模型选择 schema。
*
* 每个字段都刻意可选：缺失字段保留其文档语义（「全部启用」/「跟随上游图片
* 标记」/「不设上限」），而从没保存过的区域保持缺失，让 applyConfigFromSource
* 能回退到 legacy 平键。
*/
const modelSelectionSchema = z.object({
	enabledModelIds: z.array(z.string()).description("该区域选择器中启用的模型 id（缺失 = 全部）"),
	imageModelIds: z.array(z.string()).description("该区域接受图片输入的模型 id（缺失 = 跟随上游）"),
	contextBudgets: z.dict(z.number().step(1).min(1)).description("该区域按模型的上下文窗口覆盖值")
});
/**
* 自动化 schema。
*
* `enabled` 带真实默认值 false：调度器每个 tick 都读它，字段缺失必须意味着
* 「关闭」而不是 undefined。小时列表本身在调度器里有兜底，所以这里保持可选。
*
* 目前 job 只有签到（RESEARCH.md §5 结论：Trae 唯一可自动的写操作就是签到
* claim）；`extraJobHours` 是上游将来开放新领取端点时的预留扩展点。
*/
const automationSchema = z.object({
	enabled: z.boolean().default(false).description("运行每日积分自动化（签到）"),
	checkinHours: z.array(z.number().step(1).min(0).max(23)).description("每日签到的本地小时列表"),
	extraJobHours: z.array(z.number().step(1).min(0).max(23)).description("预留：未来可自动任务的本地小时列表")
});
/**
* 插件配置 schema。字段形状与卡片保存的文档一一对应。
*
* 显式标注为 `z<TraePoolConfig>`：不标注时 tsdown 的 dts 生成器会因推导出的
* 类型引用了 peer 依赖内部的 cosmokit 路径而报 TS2742（"cannot be named without
* a reference to ... cosmokit"）—— 类型不可移植，声明文件生成失败，整个 build
* 挂掉。显式标注让导出的类型只指向本文件自己的接口。
*/
const Config = z.object({
	authFile: asVolatile(z.string().description("Trae 桌面存储文件（缺省走应用自有位置）")),
	cooldownMs: asVolatile(z.number().step(1).min(1e3).default(6e4).description("每账号限流冷却毫秒数")),
	distribution: asVolatile(z.union([
		"priority",
		"round-robin",
		"balanced",
		"sticky",
		"expiry"
	]).default("priority").description("请求如何分布：priority（抽干一个）、round-robin（依次）、balanced（空闲加权随机）、sticky（每对话一账号）、expiry（先花将到期的积分包）")),
	disabledAccountIds: asVolatile(z.array(z.string()).default([]).description("被排除出池的账号 id（空 = 全部发现的账号都参与）")),
	creditReserves: asVolatile(z.dict(z.number().step(1).min(0)).default({}).description("按账号的积分保留线：余额降到该值后停用该账号")),
	enabledModelIds: asVolatile(z.array(z.string()).default([]).description("legacy 共享模型 id 列表；用于尚无分区选择的区域")),
	imageModelIds: asVolatile(z.array(z.string()).default([]).description("legacy 共享图片 id 列表；用于尚无分区选择的区域")),
	contextBudgets: asVolatile(z.dict(z.number().step(1).min(1)).default({}).description("legacy 共享上下文预算；用于尚无分区选择的区域")),
	modelSelectionCn: asVolatile(modelSelectionSchema.description("国内网关的模型选择")),
	modelSelectionGlobal: asVolatile(modelSelectionSchema.description("国际网关的模型选择")),
	automation: asVolatile(automationSchema.description("每日积分自动化（签到）")),
	automationEarnings: asVolatile(z.any().description("自动化收益账本（由调度器写入）"))
});
/** 实时 API，供 CLI 使用。 */
let api;
/** 实时 API；插件尚未 apply 时为 undefined。 */
function currentApi() {
	return api;
}
/** 测试缝：不启动 cordis 也能装入一个 API 实例。 */
function setApi(next) {
	api = next;
}
/**
* 不注册任何东西地装配运行时对象。
*
* 每区域一个目录、一个 shim：CN 与国际网关的名册不同，共享目录会让选择器显示
* 「碰巧先抓到的那份」列表。
*/
function createCore(logger) {
	const client = new TraeUpstreamClient();
	const pool = new TraeAccountPool({
		...logger === void 0 ? {} : { logger },
		client: { refresh: (credential) => refreshTraeCredential(credential) }
	});
	return {
		client,
		pool,
		catalogs: {
			cn: new TraeCatalog("cn"),
			ai: new TraeCatalog("ai")
		},
		scheduler: new TraeScheduler(pool, client, { ...logger === void 0 ? {} : { logger } })
	};
}
/** provider id → 区域（注册与发现共用一份映射）。 */
function regionOfProvider(provider) {
	if (provider === POOL_PROVIDER_BY_REGION.cn) return "cn";
	if (provider === POOL_PROVIDER_BY_REGION.ai) return "ai";
}
/**
* 装配并注册。
*
* 时序：装配 core → 注册两个 provider/adapter → 挂 settings 卡片 → 应用一次已
* 保存的配置 → 后台播种目录 → 注入身份 → 起调度器。任何一步失败都只影响它
* 自己，绝不阻断其余部分：模型路由必须在离线上游下也能立起来。
*/
function apply(ctx, config = {}) {
	const core = createCore(ctx.logger);
	/** 本机身份；签到 claim 依赖它的 deviceId，未解析出来时调度器会主动跳过。 */
	let identity;
	let stopped = false;
	let adapter;
	let releaseProviders;
	/** 目录变化后重建 picker；注册完成前是空操作。 */
	let invalidateCatalog = () => {};
	const shims = {};
	for (const region of ["cn", "ai"]) shims[region] = createTraePoolShim({
		pool: core.pool,
		client: core.client,
		catalog: core.catalogs[region],
		region,
		logger: ctx.logger,
		identityOf: () => Promise.resolve(identity)
	});
	/**
	* 施加一个区域的模型选择。
	*
	* 分区字段缺失时回退到 legacy 平键：老设置文件只有平键，而「缺失 = 全部启用」
	* 若直接照做，会让升级用户的模型列表突然全部展开。两者都为空时才真的留空
	* （= 全部启用）。
	*/
	const applySelection = (region, selection) => {
		const live = unwrapVolatileDeep$1(config);
		const legacyEnabled = live.enabledModelIds;
		const legacyImages = live.imageModelIds;
		const legacyBudgets = live.contextBudgets;
		core.catalogs[region].applySelection({
			...selection?.enabledModelIds === void 0 || selection.enabledModelIds.length === 0 ? legacyEnabled === void 0 || legacyEnabled.length === 0 ? {} : { enabledModelIds: legacyEnabled } : { enabledModelIds: selection.enabledModelIds },
			...selection?.imageModelIds === void 0 || selection.imageModelIds.length === 0 ? legacyImages === void 0 || legacyImages.length === 0 ? {} : { imageModelIds: legacyImages } : { imageModelIds: selection.imageModelIds },
			...selection?.contextBudgets === void 0 ? legacyBudgets === void 0 || Object.keys(legacyBudgets).length === 0 ? {} : { contextBudgets: legacyBudgets } : { contextBudgets: selection.contextBudgets }
		});
		invalidateCatalog();
	};
	/**
	* 读回已保存的配置并施加到运行时。
	*
	* 0.1.7 上 `configure({auto})` 只注册呈现策略，既不读也不应用值，而编辑是通过
	* `loader/volatile-update` 事件广播的（监听器，启动时不触发）。0.1.5 则把初始
	* 文档经 `installSection` → `hooks.onChange` 推过来。没有启动时这一次应用，
	* 池、两个目录、调度器都会停在构造默认值上 —— 每次重启都静默回退掉分布、
	* 自动化开关与模型选择，尽管设置文件里还留着它们。
	*/
	const applyConfigFromSource = () => {
		const live = unwrapVolatileDeep$1(config);
		core.pool.applyConfig({
			...live.cooldownMs === void 0 ? {} : { cooldownMs: live.cooldownMs },
			...live.distribution === void 0 ? {} : { distribution: live.distribution },
			...live.disabledAccountIds === void 0 ? {} : { disabledAccountIds: live.disabledAccountIds },
			...live.creditReserves === void 0 ? {} : { creditReserves: live.creditReserves }
		});
		applySelection("cn", live.modelSelectionCn);
		applySelection("ai", live.modelSelectionGlobal);
		core.scheduler.applyConfig(live.automation ?? {});
	};
	const settingsService = ctx.settings;
	/**
	* `settings.update` 在运行线上期望的命名空间（见下）。
	*
	* 0.1.5 按插件经 `installSection` 注册的**命名空间**解析写入器；0.1.7 起改为
	* 按**宿主插件条目 id** 解析（`configEditor.entries().find(row =>
	* row.options.id === ns)`），而 profile patch 选的就是那个 id —— 桌面宿主
	* 把本插件挂成 `llm-connect-trae-models`，但市场安装可能包一层（`mkt-...`）或经
	* `include` 行挂载。唯一正确答案是问 fiber 要它自己的 entry id；硬猜自己的
	* namespace 会让每次保存都抛「No configurable plugin entry」——这正是
	* 「模型管理保存无效」的根因。此判断与 dsh-workbuddy-xdpool index.ts:836 一致。
	*/
	const settingsWriteNs = typeof settingsService?.installSection === "function" ? TRAE_POOL_SETTINGS_NS : (() => {
		try {
			const entryId = ctx.fiber?.entry?.options?.id;
			return entryId === void 0 || entryId === "" ? TRAE_POOL_SETTINGS_NS : entryId;
		} catch {
			return TRAE_POOL_SETTINGS_NS;
		}
	})();
	if (settingsService !== void 0) {
		if (typeof settingsService.installSection === "function") settingsService.installSection(ctx, TRAE_POOL_SETTINGS_NS, Config, unwrapVolatileDeep$1(config), { onChange() {
			applyConfigFromSource();
		} });
		if (typeof settingsService.configure === "function") ctx.effect(() => settingsService.configure?.({ auto: true }, ctx.fiber) ?? (() => {}));
		if (typeof settingsService.installSection !== "function" && typeof settingsService.configure !== "function") ctx.logger.warn?.("dsh-connect-trae-models: settings 服务既没有 installSection 也没有 configure；卡片不会挂载");
	}
	ctx.on("loader/volatile-update", () => {
		applyConfigFromSource();
	});
	applyConfigFromSource();
	const stopAll = () => {
		stopped = true;
		core.scheduler.stop();
		releaseProviders?.();
		shims.cn.close();
		shims.ai.close();
	};
	ctx.effect(() => stopAll);
	/** 解析本机身份；显式 `authFile` 优先，否则走真实四形态探测。 */
	const readIdentity = async () => {
		const authFile = unwrapVolatileDeep$1(config).authFile;
		return await resolveTraeIdentity(authFile === void 0 || authFile === "" ? traeStorageCandidates() : [{
			edition: "cn",
			path: authFile,
			source: "desktop"
		}], "cn");
	};
	/**
	* 播种某一区域的实时模型目录。
	*
	* 两个区域互相隔离且各自独立重试：它们是不同主机上的不同网关，一个不可达
	* 绝不能拖累另一个。静态回退名册保证上游离线时 provider 永不为空。
	*/
	const seedRegion = async (region, accounts) => {
		if (identity === void 0) {
			ctx.logger.warn?.(`dsh-connect-trae-models: 本机身份不可用，跳过 ${region} 目录播种（保持静态回退）`);
			return;
		}
		const account = accounts.find((candidate) => regionOfCredential(candidate.credential) === region);
		if (account === void 0) {
			ctx.logger.info?.(`dsh-connect-trae-models: 尚无 ${region} 账号；保留静态 ${region} 目录`);
			return;
		}
		const request = {
			credential: account.credential,
			identity
		};
		try {
			const wire = await core.client.fetchModels(request);
			const remote = await core.client.fetchRemoteCatalog(request);
			const merged = core.client.mergeCatalog(remote, wire);
			core.catalogs[region].updateFromUpstream(merged);
			ctx.logger.info?.(`dsh-connect-trae-models: ${region} 目录已播种 ${merged.length} 个模型`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			core.catalogs[region].noteFetchFailure(message);
			ctx.logger.warn(`dsh-connect-trae-models: ${region} 模型目录不可用；使用静态回退`, error);
		}
		applyConfigFromSource();
	};
	(async () => {
		try {
			await Promise.all([shims.cn.ready, shims.ai.ready]);
		} catch (error) {
			ctx.logger.error("dsh-connect-trae-models: shim 启动失败", error);
			return;
		}
		if (stopped) return;
		const adapterCn = createTraeAdapter({
			shim: shims.cn,
			catalog: core.catalogs.cn,
			ctx,
			providerId: POOL_PROVIDER_BY_REGION.cn,
			displayName: POOL_NAME_BY_REGION.cn
		});
		const adapterAi = createTraeAdapter({
			shim: shims.ai,
			catalog: core.catalogs.ai,
			ctx,
			providerId: POOL_PROVIDER_BY_REGION.ai,
			displayName: POOL_NAME_BY_REGION.ai
		});
		adapter = adapterCn;
		try {
			const releaseAdapterCn = ctx.llm.registerAdapter([POOL_PROVIDER_BY_REGION.cn], adapterCn.adapter);
			const releaseAdapterAi = ctx.llm.registerAdapter([POOL_PROVIDER_BY_REGION.ai], adapterAi.adapter);
			const releaseDirectory = ctx.llm.registerConfigurableProviders([{
				provider: POOL_PROVIDER_BY_REGION.cn,
				displayName: POOL_NAME_BY_REGION.cn,
				settingsNs: TRAE_POOL_SETTINGS_NS,
				settingsPath: [],
				declared: false
			}, {
				provider: POOL_PROVIDER_BY_REGION.ai,
				displayName: POOL_NAME_BY_REGION.ai,
				settingsNs: TRAE_POOL_SETTINGS_NS,
				settingsPath: [],
				declared: false
			}]);
			releaseProviders = () => {
				releaseAdapterCn?.();
				releaseAdapterAi?.();
				releaseDirectory?.();
			};
		} catch (error) {
			releaseProviders?.();
			releaseProviders = void 0;
			ctx.logger.error("dsh-connect-trae-models: provider 注册失败", error);
			return;
		}
		invalidateCatalog = () => {
			adapterCn.invalidate();
			adapterAi.invalidate();
		};
		ctx.llm.registerModelDiscovery(TRAE_POOL_SETTINGS_NS, async (request) => {
			const region = regionOfProvider(request.provider);
			if (region === void 0) return [];
			return core.catalogs[region].visible().map((model) => ({
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				maxTokens: model.maxOutputTokens,
				inputModalities: model.supportsImages ? ["text", "image"] : ["text"]
			}));
		});
		ctx.logger.info?.(`dsh-connect-trae-models: provider 已注册 cn=${shims.cn.baseUrl()} ai=${shims.ai.baseUrl()}`);
		if (stopped) return;
		try {
			identity = await readIdentity();
			core.scheduler.setIdentity(identity);
			ctx.logger.info?.("dsh-connect-trae-models: 本机身份已注入调度器（签到 x-device-id 可用）");
		} catch (error) {
			ctx.logger.warn("dsh-connect-trae-models: 本机身份解析失败；签到 claim 会被跳过（对话路由不受影响）", error);
		}
		let accounts = [];
		try {
			accounts = await core.pool.scan();
			ctx.logger.info?.(`dsh-connect-trae-models: ${accounts.length} 个 Trae 账号进入轮转`);
		} catch (error) {
			ctx.logger.warn("dsh-connect-trae-models: 账号发现失败", error);
		}
		if (stopped) return;
		await Promise.all(["cn", "ai"].map((region) => seedRegion(region, accounts)));
		if (stopped) return;
		core.scheduler.setEarningsPersistence((ledger) => {
			const writer = settingsService === void 0 ? void 0 : settingsService.update;
			if (typeof writer !== "function") return;
			Promise.resolve(writer(settingsWriteNs, { automationEarnings: ledger })).catch((error) => {
				ctx.logger.warn("dsh-connect-trae-models: 自动化账本写入失败", error);
			});
		});
		const stored = unwrapVolatileDeep$1(config).automationEarnings;
		if (stored !== void 0 && stored !== null) core.scheduler.applyEarningsLedger(stored);
		core.scheduler.start();
		ctx.logger.info?.("dsh-connect-trae-models: 签到调度器已启动（automation.enabled=false 时保持惰性）");
	})();
	const settingsWriter = settingsService === void 0 ? void 0 : settingsService.update;
	/**
	* 把一次卡片写入落到 settings。
	*
	* 每个写入都走「读当前文档 → 合并 → 整体 update」：`update` 是浅合并补丁，
	* 而这里要改的字段（`disabledAccountIds` 列表、某区域的选择分区）都是整体
	* 替换语义，先读后写才不会被上一次写入的残留覆盖。
	*/
	const writeSettings = async (patch) => {
		if (typeof settingsWriter !== "function") throw new Error("settings service is not available; the change was not saved");
		await settingsWriter(settingsWriteNs, patch);
		applyConfigFromSource();
	};
	ctx.inject(["webServer"], (webCtx) => registerTraePoolStatusRoute(webCtx, {
		pool: core.pool,
		catalogs: core.catalogs,
		client: core.client,
		shim: (region) => {
			try {
				return {
					running: true,
					baseUrl: shims[region].baseUrl()
				};
			} catch {
				return { running: false };
			}
		},
		scheduler: () => core.scheduler.status(),
		runAutomation: (job, force) => core.scheduler.startRunAll(job, force),
		config: configReader(() => config),
		deviceId: () => identity?.deviceId ?? "",
		logger: ctx.logger,
		saveSelection: async (region, selection) => {
			await writeSettings({ [region === "cn" ? "modelSelectionCn" : "modelSelectionGlobal"]: selection });
		},
		setAccountDisabled: async (accountId, disabled) => {
			const live = unwrapVolatileDeep$1(config);
			const current = new Set(live.disabledAccountIds ?? []);
			if (disabled) current.add(accountId);
			else current.delete(accountId);
			await writeSettings({ disabledAccountIds: [...current] });
		},
		rescan: async () => {
			await core.pool.scan();
		},
		resetCooldowns: () => {
			core.pool.resetCooldowns();
		}
	}));
	ctx.logger.info?.("dsh-connect-trae-models: 卡片路由已挂载（webServer 可用时）");
	api = {
		pool: core.pool,
		catalogs: core.catalogs,
		client: core.client,
		shims,
		adapter,
		scheduler: core.scheduler
	};
}
const name = "llm-connect-trae-models";
//#endregion
export { AUTOMATION_JOB_KINDS, AUTOMATION_TICK_MS, AUTOMATION_TIME_ZONE, CHECKIN_DEVICE_ALREADY_CLAIMED, Config, DEFAULT_CHECKIN_HOURS, EXPIRING_SOON_WINDOW_MS, FALLBACK_TRAE_MODELS, FALLBACK_TRAE_MODELS_AI, POOL_NAME_BY_REGION, POOL_PROVIDER_BY_REGION, REGION_GATEWAYS, SseDecoder, TRAE_AUTH_FILENAME, TRAE_AUTH_STORAGE_KEY, TRAE_CLI_TOKEN_FILENAME, TRAE_DEFAULT_CONTEXT_WINDOW, TRAE_DEFAULT_COOLDOWN_MS, TRAE_DIRECTORY_FUNCTIONS, TRAE_GLOBAL_POOL_PROVIDER, TRAE_HEARTBEAT_COMMENT, TRAE_KEEPALIVE_INTERVAL_MS, TRAE_POOL_ACCOUNT_TOGGLE_PATH, TRAE_POOL_AUTOMATION_RUN_PATH, TRAE_POOL_CHECKIN_PATH, TRAE_POOL_DEFAULT_REGION, TRAE_POOL_MODELS_SAVE_PATH, TRAE_POOL_PROVIDER, TRAE_POOL_RESCAN_PATH, TRAE_POOL_RESET_COOLDOWN_PATH, TRAE_POOL_ROUTE_PREFIX, TRAE_POOL_SETTINGS_NS, TRAE_POOL_STATUS_PATH, TRAE_PROGRESS_COMMENT, TRAE_QUEUE_COMMENT, TRAE_REASONING_EFFORTS, TRAE_SOLO_CHAT_PATH, TRAE_SOLO_FUNCTION, TRAE_SOLO_MODELS_PATH, TRAE_STREAM_IDLE_TIMEOUT_MS, TRAE_UPSTREAM_SILENCE_MS, TraeAccountPool, TraeCatalog, TraeCredentialStore, TraeScheduler, TraeUpstreamClient, apply, applyModelBudget, bridgeTraeSoloStream, bridgeTraeSoloStreamOrFail, buildTraeHeaders, buildTraePoolWebStatus, chatStream, claimCheckin, classifyTraeError, collectWireModels, compactMessages, compactWithSummary, configReader, contextOverflowMessage, conversationKeyOf, createCore, createTraeAdapter, createTraePoolShim, currentApi, dayKey, decodeTraeEvent, decryptTraeStorageValue, describeTraeFailure, estimateMessagesTokens, estimateTextTokens, fallbackModelsFor, fetchActivities, fetchCheckinStatus, fetchCredits, fetchModels, fetchRemoteCatalog, hardTruncate, identityHeaders, inject, isFireHour, mergeCatalog, mergeTraeModelSources, name, normalizeTraeCredential, normalizeTraeVersionCode, parseActivities, parseCheckinClaim, parseCheckinStatus, parseCreditsSnapshot, parseRateLimitReset, parseReasoningCapability, parseRegionParam, parseSelection, parseTraeAuthValue, parseTraeCliToken, parseTraeRemoteModel, parseTraeStorageDocument, pickTraeStorageIdentity, prepareSoloBody, readTraeCliIdentity, readTraeIdentity, refreshTraeCredential, regionOfCredential, regionOfEdition, regionOfHost, regionOfUserRegion, registerTraePoolStatusRoute, resolveTraeIdentity, safeMessage, setApi, slotKey, stampTraeWireTarget, traeAccountId, traeAccountRegion, traeCliCandidates, traeEndpoint, traeModelDisplayName, traePoolAccountId, traeStorageCandidates, traeWindowsAppNames, unwrapVolatile, unwrapVolatileDeep, wireCreditMultiplier };
