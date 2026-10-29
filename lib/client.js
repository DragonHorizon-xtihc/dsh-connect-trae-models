window.__ModuleLoader__.load({
	id: "dsh-connect-trae-models",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom = require("react-dom");
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
		* 给一个状态路由加上区域参数。
		*
		* 两个区域是两套独立 provider 栈，每条卡片请求都必须说明自己问的是哪一侧，
		* 否则后端无从判断该读哪个账号列表。缺省按国内侧处理，与
		* {@link parseRegionParam} 的缺省一致。
		*/
		function withTraeRegion(path, region) {
			return `${path}?region=${region}`;
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* Trae Connect Models 卡片的客户端样式。
		*
		* 使用与内置插件卡片相同的深色主题 token 词汇（`--dsw-alias-*`），让账号池与
		* 模型目录自然地坐在其他配置行旁边，而不是像一块亮色 Material 面板压在 DSH
		* 的深色表面上。
		*
		* 页面纵向铺满、无折叠入口；内容切分为若干卡片：顶部操作行、状态卡（区域切换
		* + 池健康）、随后每个功能区一张卡。内部类名统一带 `dsm-connect-trae-models-` 前缀。
		*
		* @module dsh-connect-trae-models/client/styles
		*/
		/**
		* 对话栏工具行的样式。
		*
		* 与 {@link POOL_CARD_CSS} 分开、且**自带 `<style>` 注入**（见 ComposerCredits）
		* 是刻意的：对话栏这一行常驻，而插件设置卡片可能从未被打开、某些宿主上甚至
		* 根本不会挂载它——把对话栏样式寄放在卡片 CSS 里，等于「卡片不开就完全无样式」。
		*
		* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
		*   —— 触发器做成**无边框、透明底、label-tertiary 文字**，与外壳自己的
		*     ContextMeter 同级；显式指定字体与颜色而不是 `inherit`，因为对话栏那一行
		*     有它自己的字体与正文字色，`inherit` 会把两者搅在一起。
		*/
		const COMPOSER_CREDITS_CSS = `
.dsm-connect-trae-models-composer{display:inline-flex;align-items:center;min-width:0}
.dsm-connect-trae-models-composer-trigger{
  appearance:none;display:inline-flex;align-items:center;align-self:stretch;
  padding:2px 6px;border:0;border-radius:6px;background:transparent;
  font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,#9aa0a8);
  white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums;
}
.dsm-connect-trae-models-composer-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-connect-trae-models-composer-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
/* 面板被 portal 到 document.body 并从触发器定位，故用 fixed + 显式 z-index。 */
.dsm-connect-trae-models-composer-panel{
  position:fixed;z-index:1100;box-sizing:border-box;
  width:min(248px,calc(100vw - 24px));padding:12px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));
  border-radius:var(--dsw-radius-lg,14px);
  background:var(--dsw-specific-menu,Canvas);
  box-shadow:var(--dsw-elevation-prominent,0 8px 32px rgba(0,0,0,.22));
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#444);
}
.dsm-connect-trae-models-composer-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.dsm-connect-trae-models-composer-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,CanvasText)}
.dsm-connect-trae-models-composer-empty{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-connect-trae-models-composer-row{
  display:flex;align-items:center;gap:8px;width:100%;
  padding:5px 6px;border:0;border-radius:6px;background:transparent;
  color:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;
}
.dsm-connect-trae-models-composer-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-connect-trae-models-composer-row:disabled{cursor:default;opacity:.6}
.dsm-connect-trae-models-composer-row[aria-current='true']{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.2))}
.dsm-connect-trae-models-composer-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-connect-trae-models-composer-value{flex:none;font-variant-numeric:tabular-nums}
.dsm-connect-trae-models-composer-pin{flex:none;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-connect-trae-models-composer-foot{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28))}
.dsm-connect-trae-models-composer-reset{
  appearance:none;padding:3px 10px;border:0;border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px;cursor:pointer;
}
.dsm-connect-trae-models-composer-reset:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-connect-trae-models-composer-reset:disabled{cursor:default;opacity:.6}
`;
		const POOL_CARD_CSS = `
/*
 * 页面外壳。设置面板把本页渲染在它自己的可滚动内容列里，所以这里只提供节奏
 * 与卡片——不要外边框、不要额外外边距（列的边距由外壳自己给）。
 */
.dsm-connect-trae-models-page{max-width:860px;flex-direction:column;gap:16px;display:flex}
/* 顶部行：左边身份，右边主要操作。可换行，窄面板时按钮落到标题下方。 */
.dsm-connect-trae-models-page-head{align-items:center;gap:12px;flex-wrap:wrap;display:flex}
.dsm-connect-trae-models-page-copy{flex-direction:column;gap:4px;min-width:0;flex:1 1 220px;display:flex}
.dsm-connect-trae-models-page-title{color:var(--dsw-alias-label-primary,#e6e6e6);margin:0;font-size:16px;font-weight:600;line-height:1.4}
.dsm-connect-trae-models-page-desc{color:var(--dsw-alias-label-tertiary,#999);margin:0;font-size:13px;line-height:1.5}
.dsm-connect-trae-models-page-actions{align-items:center;gap:8px;flex-wrap:wrap;flex:none;display:flex}
/* 每个功能区一张卡。表面把各区块分开，与内置设置页的做法一致。 */
.dsm-connect-trae-models-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-2,#232529);border-radius:14px;flex-direction:column;gap:12px;padding:14px 16px;display:flex}

/* 按钮原语（卡片各处共用）。 */
.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-btn:disabled{opacity:.4;cursor:default}
.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}
.dsm-btn-primary{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-3,#202126)}
.dsm-btn-primary:hover:not(:disabled){opacity:.9}
.dsm-btn-sm{padding:3px 10px;font-size:12px;border-radius:7px}

/* 区域标签：两个互相独立的供应商，一次显示一个。 */
.dsm-connect-trae-models-tabs{display:flex;gap:6px;padding:4px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
.dsm-connect-trae-models-tab{appearance:none;font:inherit;cursor:pointer;border:none;border-radius:7px;padding:5px 14px;font-size:13px;background:transparent;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-connect-trae-models-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2,#232529);color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600}

/* 状态行：小圆点 + 一句话。 */
.dsm-connect-trae-models-status-line{align-items:center;gap:8px;flex-wrap:wrap;display:flex;font-size:13px;line-height:1.5}
.dsm-connect-trae-models-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--dsw-alias-label-dimmed,#6b7280)}
.dsm-connect-trae-models-dot-ok{background:#3fb950}
.dsm-connect-trae-models-dot-warn{background:#d29922}
.dsm-connect-trae-models-dot-bad{background:#f85149}
.dsm-connect-trae-models-muted{color:var(--dsw-alias-label-tertiary,#999)}
.dsm-connect-trae-models-secondary{color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-connect-trae-models-warn{color:#d29922}
.dsm-connect-trae-models-danger{color:#f85149}
.dsm-connect-trae-models-ok{color:#3fb950}

/* 区块标题。 */
.dsm-connect-trae-models-section-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-connect-trae-models-section-hint{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}

/* 模型批量勾选条：全选 / 取消全选 + 当前状态。 */
.dsm-connect-trae-models-model-bulk{align-items:center;gap:8px;flex-wrap:wrap;display:flex}
.dsm-connect-trae-models-model-bulk-state{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}

/* 账号行。 */
.dsm-connect-trae-models-account{border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dsm-connect-trae-models-account-head{align-items:center;gap:10px;flex-wrap:wrap;display:flex}
.dsm-connect-trae-models-account-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:600;line-height:1.4}
.dsm-connect-trae-models-account-meta{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:1.5;flex-wrap:wrap;gap:8px;display:flex}
.dsm-connect-trae-models-account-facts{color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;line-height:1.6;flex-wrap:wrap;gap:10px;display:flex}
.dsm-connect-trae-models-account-tags{gap:6px;flex-wrap:wrap;display:flex;align-items:center}

/* 徽标。 */
.dsm-connect-trae-models-tag{border-radius:6px;padding:1px 7px;font-size:11px;line-height:17px;border:1px solid transparent;white-space:nowrap}
.dsm-connect-trae-models-tag-neutral{color:var(--dsw-alias-label-secondary,#c6c9d0);border-color:var(--dsw-alias-border-l2,#3a3d45)}
.dsm-connect-trae-models-tag-warn{color:#d29922;border-color:rgba(210,153,34,.45)}
.dsm-connect-trae-models-tag-danger{color:#f85149;border-color:rgba(248,81,73,.45)}
.dsm-connect-trae-models-tag-ok{color:#3fb950;border-color:rgba(63,185,80,.45)}

/* 到期提醒：≤3 天橙色，已过期灰显。 */
.dsm-connect-trae-models-expiry{font-size:12px;line-height:1.5}
.dsm-connect-trae-models-expiry-soon{color:#d29922;font-weight:600}
.dsm-connect-trae-models-expiry-past{color:var(--dsw-alias-label-dimmed,#6b7280)}
.dsm-connect-trae-models-expiry-future{color:var(--dsw-alias-label-tertiary,#9aa0a8)}

/* 积分包明细表。 */
.dsm-connect-trae-models-packs{margin:0;border-collapse:collapse;font-size:12px;width:100%}
.dsm-connect-trae-models-packs th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,#9aa0a8);padding:2px 8px 2px 0}
.dsm-connect-trae-models-packs td{color:var(--dsw-alias-label-secondary,#c6c9d0);padding:2px 8px 2px 0;vertical-align:top}

/* 签到块。 */
.dsm-connect-trae-models-checkin{border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dsm-connect-trae-models-checkin-row{align-items:center;gap:10px;flex-wrap:wrap;display:flex}
.dsm-connect-trae-models-checkin-text{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-connect-trae-models-checkin-msg{font-size:12px;line-height:1.5}

/* 自动化面板。 */
.dsm-connect-trae-models-toggle{align-items:center;gap:8px;display:flex;font-size:13px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-connect-trae-models-toggle input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary,#5686fe);cursor:pointer;flex:none}
.dsm-connect-trae-models-toggle input:disabled{cursor:default}
.dsm-connect-trae-models-detail{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:1.5}
.dsm-connect-trae-models-earnings{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#c6c9d0)}

/* 模型行。 */
.dsm-connect-trae-models-model{border-bottom:1px solid var(--dsw-alias-border-l2,#2f3136);padding:8px 0;display:flex;flex-direction:column;gap:6px}
.dsm-connect-trae-models-model:last-of-type{border-bottom:none}
.dsm-connect-trae-models-model-head{align-items:center;gap:10px;flex-wrap:wrap;display:flex}
.dsm-connect-trae-models-model-name{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:1.4;min-width:0;word-break:break-word}
.dsm-connect-trae-models-model-facts{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:1.5;flex-wrap:wrap;gap:10px;display:flex}
.dsm-connect-trae-models-model-controls{align-items:center;gap:14px;flex-wrap:wrap;display:flex}
.dsm-connect-trae-models-budget{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-connect-trae-models-budget input{width:96px;background:var(--dsw-alias-bg-layer-3,#2a2c33);border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:6px;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px;padding:3px 8px}
.dsm-connect-trae-models-budget input:disabled{opacity:.5}

/* 空区域指引。 */
.dsm-connect-trae-models-empty{gap:10px}
.dsm-connect-trae-models-empty-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-connect-trae-models-empty-steps{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
.dsm-connect-trae-models-empty-steps-title{margin:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;font-weight:600;line-height:18px}
.dsm-connect-trae-models-empty-list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:5px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-connect-trae-models-empty-list li{min-width:0}
.dsm-connect-trae-models-empty-note{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:17px}

/* 错误行。 */
.dsm-connect-trae-models-error{margin:0;color:#f85149;font-size:12px;line-height:1.5}
`;
		//#endregion
		//#region src/client/TraePoolCard.tsx
		/**
		* Trae Connect Models 设置卡片。
		*
		* 信息架构（分区顺序照 workbuddy 卡片的已验证布局）：
		*   1. 顶部：标题 + shim 状态 + 「重新检测账号」「清除所有冷却」
		*   2. 区域 Tab：国内版 / 国际版（各自账号、积分、模型）
		*   3. 账号池：每账号一行（开关、冷却、登录被拒、积分、到期提醒、签到）
		*   4. 积分自动化面板（总开关 + 立即运行 + 各 job 状态 + 今日收益）
		*   5. 模型管理（启用/图片/上下文预算 + 保存）
		*   6. 池健康汇总（账号数 · 冷却数 · 下一个轮到谁）
		*
		* 组件是被测的真实实现：tests/card.test.tsx 直接渲染它，不从副本断言。
		*
		* @module dsh-connect-trae-models/client/TraePoolCard
		*/
		/** 卡片允许的最小上下文预算（token）。
		*
		* 必须与服务端 `parseSelection` 的下限 1000 一致：前端若允许更小的值，用户会
		* 看到「输入生效」却在保存时被 400 拒绝。低于这个量级的窗口 DSH 也会以
		* `INVALID_MODEL_CONTEXT` 拒绝，本来就没有意义。
		*/
		const MIN_CONTEXT_BUDGET = 1e3;
		/** 某个模型行的预算建议列表 id（`<input list>` 与 `<datalist id>` 共用）。 */
		function budgetListId(modelId) {
			return `trae-budget-options-${modelId}`;
		}
		/** 状态轮询间隔：5 秒。 */
		const TRAE_POOL_POLL_MS = 5e3;
		/** 「即将到期」窗口：3 天（与上游 `expiringSoonWindowMs` 语义一致）。 */
		const EXPIRING_SOON_MS = 2592e5;
		/** 卡片可选的五种账号使用方式，顺序即下拉框里的顺序。 */
		const DISTRIBUTIONS = [
			"priority",
			"round-robin",
			"balanced",
			"sticky",
			"expiry"
		];
		/** 取某个使用方式的名字。 */
		function distributionLabel(t, mode) {
			return t(`row.distribution.${mode}`);
		}
		/** 取某个使用方式的一句话说明。 */
		function distributionHint(t, mode) {
			return t(`row.distributionHint.${mode}`);
		}
		/** 恒等翻译兜底（宿主未接 locale 时键名可见，好过白屏）。 */
		const identityT = (key) => key;
		/** 格式化一个毫秒时刻；无效返回 undefined。 */
		function formatTime(ms) {
			if (ms === void 0 || !Number.isFinite(ms) || ms <= 0) return void 0;
			try {
				return new Date(ms).toLocaleString();
			} catch {
				return new Date(ms).toISOString();
			}
		}
		/** 解析 ISO 时间戳为毫秒；无效返回 undefined。 */
		function parseIso(value) {
			if (value === void 0 || value === "") return void 0;
			const parsed = Date.parse(value);
			return Number.isNaN(parsed) ? void 0 : parsed;
		}
		/** 计算一个积分包的到期展示；无有效到期时间返回 undefined。 */
		function expiryDisplayOf(pack, nowMs) {
			const atMs = pack.endTimeMs;
			if (!Number.isFinite(atMs) || atMs <= 0) return void 0;
			const remaining = Math.max(0, (pack.creditsLimit ?? 0) - (pack.consumed ?? 0));
			const left = atMs - nowMs;
			if (left <= 0) return {
				kind: "past",
				days: 0,
				atMs,
				remaining
			};
			const days = Math.floor(left / 864e5);
			return {
				kind: left <= EXPIRING_SOON_MS ? "soon" : "future",
				days,
				atMs,
				remaining
			};
		}
		/** 取一个积分总览里最近的一笔未过期到期；全部已过期或无到期则 undefined。 */
		function nearestUpcomingExpiry(credits, nowMs) {
			if (credits === void 0) return void 0;
			let best;
			for (const pack of credits.packs) {
				const display = expiryDisplayOf(pack, nowMs);
				if (display === void 0 || display.kind === "past") continue;
				if (best === void 0 || display.atMs < best.atMs) best = display;
			}
			return best;
		}
		/**
		* 判定一个账号的签到按钮状态。
		*
		* 顺序有意义：账号级已领 → 设备级已用 → 活动未开启 → 可领取。
		* 把 `didCheckedIn`（设备级）当成「今天签过了」是一个已发生过的缺陷——切换账号
		* 后按钮会变灰，而新账号其实一分未得，所以两者必须分开表达。
		*/
		function checkinStateOf(checkin, deviceSpent) {
			if (checkin === void 0) return "disabled";
			if (checkin.checkedIn) return "claimed";
			if (checkin.didCheckedIn || deviceSpent === true) return "deviceSpent";
			if (!checkin.enabled) return "disabled";
			return "available";
		}
		/** 判断一条请求是否可信地成功；返回解析后的 JSON 或抛错。 */
		async function requestJson(fetchImpl, url, init) {
			const response = await fetchImpl(url, init);
			let payload = {};
			try {
				payload = await response.json();
			} catch {
				payload = {};
			}
			if (!response.ok) {
				const message = typeof payload["error"] === "string" ? payload["error"] : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return payload;
		}
		/**
		* 服务卡片。
		*
		* 两个区域各自保留最后一次答案（不是单一槽位）：切换标签页时立刻显示另一侧的
		* 上一份结果，而不是一帧空白。
		*/
		function TraePoolCard(props) {
			const t = props.t ?? identityT;
			const fetchImpl = props.fetchImpl ?? (typeof fetch === "function" ? fetch : void 0);
			const settingsScope = props.settingsScope;
			/**
			* 模型设置是否可改。
			*
			* 只读**仅**当宿主明确报告作用域不可写时成立。作用域缺失（绑定探测失败、
			* 受限宿主）**不**等于只读：模型设置走 models/save HTTP 路由落盘，与 settings
			* 作用域无关，把「没绑定上作用域」当成只读会让这些宿主上根本无法编辑模型。
			*/
			const scopeSnapshot = settingsScope?.getSnapshot();
			const modelsEditable = scopeSnapshot === void 0 || scopeSnapshot.writable !== false;
			const [activeRegion, setActiveRegion] = (0, react.useState)("cn");
			const [statusByRegion, setStatusByRegion] = (0, react.useState)({});
			const [errorByRegion, setErrorByRegion] = (0, react.useState)({});
			const [busy, setBusy] = (0, react.useState)(void 0);
			const [notice, setNotice] = (0, react.useState)(void 0);
			const [checkinMessageByAccount, setCheckinMessageByAccount] = (0, react.useState)({});
			/** 模型草稿：undefined 表示跟随服务器值。 */
			const [modelDraft, setModelDraft] = (0, react.useState)({
				cn: void 0,
				ai: void 0
			});
			/** 样式只注入一次。 */
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return;
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-connect-trae-models";
				tag.dataset.pluginCss = "dsh-connect-trae-models/card";
				tag.textContent = POOL_CARD_CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, []);
			/** 拉取一个区域的状态。 */
			const refresh = (0, react.useCallback)(async (region) => {
				if (fetchImpl === void 0) return;
				try {
					const payload = await requestJson(fetchImpl, `${TRAE_POOL_STATUS_PATH}?region=${region}`, {
						method: "GET",
						headers: { Accept: "application/json" }
					});
					setStatusByRegion((current) => ({
						...current,
						[region]: payload
					}));
					setErrorByRegion((current) => ({
						...current,
						[region]: void 0
					}));
				} catch (error) {
					setErrorByRegion((current) => ({
						...current,
						[region]: error instanceof Error ? error.message : String(error)
					}));
				}
			}, [fetchImpl]);
			const refreshRef = (0, react.useRef)(refresh);
			refreshRef.current = refresh;
			(0, react.useEffect)(() => {
				refreshRef.current(activeRegion);
				const timer = setInterval(() => {
					refreshRef.current(activeRegion);
				}, TRAE_POOL_POLL_MS);
				return () => {
					clearInterval(timer);
				};
			}, [activeRegion]);
			const status = statusByRegion[activeRegion];
			const error = errorByRegion[activeRegion];
			/** 用当前活跃区域重新读取配置（模型草稿回退用）。 */
			const reloadConfig = (0, react.useCallback)(() => {
				setModelDraft((current) => ({
					...current,
					[activeRegion]: void 0
				}));
			}, [activeRegion]);
			/** 发一个 POST 并刷新。 */
			const post = (0, react.useCallback)(async (url, body, busyKey) => {
				if (fetchImpl === void 0) return void 0;
				setBusy(busyKey);
				setNotice(void 0);
				try {
					const payload = await requestJson(fetchImpl, url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body)
					});
					await refreshRef.current(activeRegion);
					return payload;
				} catch (err) {
					setNotice(err instanceof Error ? err.message : String(err));
					return;
				} finally {
					setBusy(void 0);
				}
			}, [fetchImpl, activeRegion]);
			const regionLabel = activeRegion === "cn" ? t("row.regionCn") : t("row.regionAi");
			/** 模型行（草稿优先）。 */
			const models = (0, react.useMemo)(() => status?.models ?? [], [status]);
			const draft = modelDraft[activeRegion];
			const effectiveDraft = (0, react.useMemo)(() => {
				if (draft !== void 0) return draft;
				const selection = status?.selection;
				const enabled = models.filter((model) => model.enabled).map((model) => model.id);
				const images = models.filter((model) => model.supportsImages).map((model) => model.id);
				const budgets = {};
				for (const model of models) if (model.contextWindow !== model.nativeContextWindow) budgets[model.id] = model.contextWindow;
				return {
					enabledModelIds: [...selection?.enabledModelIds ?? enabled],
					imageModelIds: [...selection?.imageModelIds ?? images],
					contextBudgets: { ...selection?.contextBudgets ?? budgets }
				};
			}, [
				draft,
				status,
				models
			]);
			/** 当前草稿里被启用的模型数（用于批量勾选条的三态文案）。 */
			const enabledCount = (0, react.useMemo)(() => {
				const ids = new Set(effectiveDraft.enabledModelIds);
				return models.filter((model) => ids.has(model.id)).length;
			}, [effectiveDraft, models]);
			/** 当前草稿里是否有任何一个模型被启用。 */
			const anyEnabled = enabledCount > 0;
			const setDraft = (0, react.useCallback)((next) => {
				setModelDraft((current) => ({
					...current,
					[activeRegion]: next
				}));
			}, [activeRegion]);
			/** 全选：把全量模型都写进启用列表（而不是留空表示「全部启用」）。 */
			const selectAllModels = (0, react.useCallback)(() => {
				setDraft({
					...effectiveDraft,
					enabledModelIds: models.map((model) => model.id)
				});
			}, [
				setDraft,
				effectiveDraft,
				models
			]);
			/**
			* 取消全选：落成**显式空数组**。
			*
			* `[]` 与「缺失」是两件事：缺失 = 全部启用，`[]` = 用户逐个停用。只有写空
			* 数组才能表达「一个都不要」，所以这里绝不能退化成删键。
			*/
			const selectNoModels = (0, react.useCallback)(() => {
				setDraft({
					...effectiveDraft,
					enabledModelIds: []
				});
			}, [setDraft, effectiveDraft]);
			const saveModels = (0, react.useCallback)(async () => {
				if (await post(TRAE_POOL_MODELS_SAVE_PATH, {
					region: activeRegion,
					enabledModelIds: effectiveDraft.enabledModelIds,
					imageModelIds: effectiveDraft.imageModelIds,
					contextBudgets: effectiveDraft.contextBudgets
				}, "models") !== void 0) {
					setNotice(t("row.modelsSaved"));
					reloadConfig();
				}
			}, [
				post,
				activeRegion,
				effectiveDraft,
				t,
				reloadConfig
			]);
			/**
			* 切换账号使用方式（写 settings，不走 HTTP 路由）。
			*
			* 与自动化开关一样按**顶层键**写：`distribution` 是设置文档里的一个顶层字段，
			* 用点号路径会被当成字面键名而永不生效。写完立即重读，好让卡片上的「当前方式」
			* 与真正派发用的值一致——读回来的文档才是事实。
			*/
			const setDistribution = (0, react.useCallback)(async (next) => {
				const write = settingsScope?.set;
				if (write === void 0) {
					setNotice(t("row.modelsSaveFailed", { message: "settings scope is unavailable" }));
					return;
				}
				setBusy("distribution");
				setNotice(void 0);
				try {
					await write.call(settingsScope, "distribution", next);
					await refreshRef.current(activeRegion);
				} catch (error) {
					setNotice(t("row.modelsSaveFailed", { message: error instanceof Error ? error.message : String(error) }));
				} finally {
					setBusy(void 0);
				}
			}, [
				settingsScope,
				activeRegion,
				t
			]);
			/**
			* 切换自动化总开关（写 settings，不走 HTTP 路由）。
			*
			* `automation` 必须作为**整个对象**写入：settings 文档按顶层键存它，用点号
			* 路径 `'automation.enabled'` 会被当成一个字面键名，真正的 automation 对象
			* 永不更新——这正是「复选框勾不动」的成因。
			*
			* 写入时要把小时列表一并带上：它们决定调度时刻，只写 `enabled` 会把已有
			* 配置丢成 schema 缺省；列表为空时回落到宿主的默认时刻，这样一份被写成
			* `[]` 的文档也会被下一次切换治愈，而不是存成一份跑不起来的日程。
			*/
			const toggleAutomation = (0, react.useCallback)(async (enabled) => {
				const write = settingsScope?.set;
				if (write === void 0) {
					setNotice(t("row.autoEnableFailed", { message: "settings scope is unavailable" }));
					return;
				}
				setBusy("automation");
				setNotice(void 0);
				try {
					const hours = (status?.automation)?.checkinHours ?? [];
					await write.call(settingsScope, "automation", {
						enabled,
						checkinHours: hours.length > 0 ? [...hours] : [...DEFAULT_CHECKIN_HOURS]
					});
					await refreshRef.current(activeRegion);
				} catch (error) {
					setNotice(t("row.autoEnableFailed", { message: error instanceof Error ? error.message : String(error) }));
				} finally {
					setBusy(void 0);
				}
			}, [
				settingsScope,
				activeRegion,
				t,
				status
			]);
			/** 手动签到一个账号。 */
			const claimCheckin = (0, react.useCallback)(async (account) => {
				const payload = await post(TRAE_POOL_CHECKIN_PATH, {
					accountId: account.id,
					region: activeRegion
				}, `checkin:${account.id}`);
				if (payload === void 0) return;
				const result = payload;
				const code = result.code;
				const credits = result.checkin?.credits;
				let message;
				if (result.claimed) message = t("row.checkinDone", { credits: credits ?? 0 });
				else if (result.alreadyCheckedIn) message = t("row.checkinAlready");
				else if (result.deviceCheckedIn) message = t("row.checkinDeviceDone");
				else message = t("row.checkinRefused");
				if (code !== void 0 && code !== 0) message = `${message} · ${t("row.checkinCode", { code })}`;
				setCheckinMessageByAccount((current) => ({
					...current,
					[account.id]: message
				}));
			}, [
				post,
				activeRegion,
				t
			]);
			const accounts = status?.accounts ?? [];
			const coolingCount = status?.cooling ?? 0;
			const activeAccount = accounts.find((account) => account.id === status?.activeAccountId);
			/** 今日自动化收益（按账号名展示，账号找不到时退回 id 前 8 位）。 */
			const earningsRows = (0, react.useMemo)(() => {
				const earnings = status?.automation?.earningsToday ?? {};
				return Object.entries(earnings).map(([accountId, entry]) => {
					return {
						accountId,
						name: accounts.find((candidate) => candidate.id === accountId)?.label ?? `${accountId.slice(0, 8)}#`,
						credit: entry.credit,
						deviceSpent: entry.deviceSpent === true
					};
				});
			}, [status, accounts]);
			const nowMs = Date.now();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsm-connect-trae-models-page",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-page-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsm-connect-trae-models-page-copy",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: "dsm-connect-trae-models-page-title",
								children: t("row.title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-page-desc",
								children: t("row.desc")
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsm-connect-trae-models-page-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsm-btn dsm-btn-outline",
								disabled: busy !== void 0,
								onClick: () => {
									(async () => {
										const payload = await post(TRAE_POOL_RESCAN_PATH, { region: activeRegion }, "rescan");
										if (payload !== void 0) {
											const count = typeof payload["count"] === "number" ? payload["count"] : accounts.length;
											setNotice(t("row.rescanDone", { count }));
										}
									})();
								},
								children: busy === "rescan" ? t("row.rescanning") : t("row.rescan")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsm-btn dsm-btn-outline",
								disabled: busy !== void 0,
								onClick: () => {
									(async () => {
										if (await post(TRAE_POOL_RESET_COOLDOWN_PATH, { region: activeRegion }, "reset") !== void 0) setNotice(t("row.resetDone"));
									})();
								},
								children: busy === "reset" ? t("row.resetting") : t("row.resetCooldowns")
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-connect-trae-models-status-line",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `dsm-connect-trae-models-dot ${status?.shim.running === true ? "dsm-connect-trae-models-dot-ok" : "dsm-connect-trae-models-dot-bad"}` }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-secondary",
										children: status?.shim.running === true ? t("row.shimRunning") : t("row.shimStopped")
									}),
									status?.shim.baseUrl !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-muted",
										children: status.shim.baseUrl
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-connect-trae-models-status-line",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `dsm-connect-trae-models-dot ${coolingCount > 0 ? "dsm-connect-trae-models-dot-warn" : accounts.length > 0 ? "dsm-connect-trae-models-dot-ok" : ""}` }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-secondary",
										children: t("row.healthSummary", {
											count: accounts.length,
											cooling: coolingCount
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-muted",
										children: activeAccount === void 0 ? t("row.activeAccountNone") : t("row.activeAccount", { name: activeAccount.label })
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-connect-trae-models-status-line",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-connect-trae-models-muted",
									children: accounts.length === 0 ? t("row.emptyReason") : coolingCount >= accounts.length && accounts.length > 0 ? t("row.allCooling") : t("row.ok")
								})
							}),
							status?.distribution !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-connect-trae-models-status-line",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "dsm-connect-trae-models-field",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-connect-trae-models-muted",
											children: t("row.distributionLabel")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
											"aria-label": t("row.distributionLabel"),
											value: status.distribution,
											disabled: !modelsEditable || busy !== void 0,
											onChange: (event) => {
												setDistribution(event.target.value);
											},
											children: DISTRIBUTIONS.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: option,
												children: distributionLabel(t, option)
											}, option))
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-muted",
										children: distributionHint(t, status.distribution)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-muted",
										children: status.catalogSource === "live" ? t("row.catalogSourceLive") : t("row.catalogSourceFallback")
									})
								]
							}),
							status?.catalogError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-error",
								children: t("row.catalogError", { message: status.catalogError })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-connect-trae-models-tabs",
								role: "tablist",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									className: "dsm-connect-trae-models-tab",
									"aria-selected": activeRegion === "cn",
									onClick: () => setActiveRegion("cn"),
									children: t("row.regionCn")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "tab",
									className: "dsm-connect-trae-models-tab",
									"aria-selected": activeRegion === "ai",
									onClick: () => setActiveRegion("ai"),
									children: t("row.regionAi")
								})]
							}),
							error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "dsm-connect-trae-models-error",
								children: [
									t("row.requestFailed"),
									": ",
									error
								]
							}),
							notice !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-muted",
								children: notice
							})
						]
					}),
					status !== void 0 && accounts.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-card dsm-connect-trae-models-empty",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: "dsm-connect-trae-models-empty-title",
							children: t("row.regionEmptyTitle", { region: regionLabel })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsm-connect-trae-models-empty-steps",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-connect-trae-models-empty-steps-title",
									children: t("row.regionHowToTitle", { region: regionLabel })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ol", {
									className: "dsm-connect-trae-models-empty-list",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("row.regionHowTo1") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("row.regionHowTo2") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: t("row.regionHowTo3") })
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsm-connect-trae-models-empty-note",
									children: t("row.regionHowToNote")
								})
							]
						})]
					}),
					accounts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-card",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: "dsm-connect-trae-models-section-title",
							children: t("row.accountsTitle")
						}), accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
							t,
							account,
							nowMs,
							isActive: account.id === status?.activeAccountId,
							busy,
							checkinMessage: checkinMessageByAccount[account.id],
							onToggle: (disabled) => {
								post(TRAE_POOL_ACCOUNT_TOGGLE_PATH, {
									accountId: account.id,
									disabled
								}, `toggle:${account.id}`);
							},
							onCheckin: () => {
								claimCheckin(account);
							}
						}, account.id))]
					}),
					status?.automation !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: "dsm-connect-trae-models-section-title",
								children: t("row.autoTitle")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "dsm-connect-trae-models-toggle",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									"aria-label": t("row.autoEnable"),
									checked: status.automation.enabled,
									disabled: busy !== void 0 || settingsScope?.set === void 0,
									onChange: (event) => {
										toggleAutomation(event.target.checked);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.autoEnable") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-section-hint",
								children: t("row.autoEnableHint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-section-hint",
								children: t("row.autoHours", { hours: status.automation.checkinHours.join(", ") })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsm-connect-trae-models-checkin-row",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-primary",
									disabled: busy !== void 0 || status.automation.runInProgress,
									onClick: () => {
										(async () => {
											const payload = await post(TRAE_POOL_AUTOMATION_RUN_PATH, { region: activeRegion }, "auto-run");
											if (payload === void 0) return;
											const started = payload["started"] === true;
											setNotice(started ? t("row.autoRunStarted") : t("row.autoAlreadyRunning"));
										})();
									},
									children: status.automation.runInProgress || busy === "auto-run" ? t("row.autoRunning") : t("row.autoRun")
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-connect-trae-models-status-line",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-connect-trae-models-secondary",
									children: t("row.autoJobTitle")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-connect-trae-models-muted",
									children: status.automation.jobs.checkin.lastRunAtMs === void 0 ? t("row.autoNeverRun") : t("row.autoLastRun", { time: formatTime(status.automation.jobs.checkin.lastRunAtMs) ?? "" })
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "dsm-connect-trae-models-section-hint",
								children: [
									t("row.autoCounts", {
										ok: status.automation.jobs.checkin.ok,
										failed: status.automation.jobs.checkin.failed,
										claimed: status.automation.jobs.checkin.claimed,
										deviceSpent: status.automation.jobs.checkin.deviceSpent
									}),
									" · ",
									t("row.autoCredit", { credit: status.automation.jobs.checkin.credit })
								]
							}),
							(status.automation.jobs.checkin.detail ?? []).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "dsm-connect-trae-models-detail",
								children: (status.automation.jobs.checkin.detail ?? []).map((line, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: line }, `${index}-${line}`))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								className: "dsm-connect-trae-models-section-title",
								children: t("row.autoTodayTitle")
							}),
							earningsRows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-section-hint",
								children: t("row.autoTodayNone")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "dsm-connect-trae-models-earnings",
								children: earningsRows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: row.deviceSpent ? t("row.autoDeviceSpentToday", { name: row.name }) : t("row.autoTodayAccount", {
									name: row.name,
									credit: row.credit
								}) }, row.accountId))
							})
						]
					}),
					models.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
								className: "dsm-connect-trae-models-section-title",
								children: [t("row.modelsTitle"), draft !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dsm-connect-trae-models-warn",
									children: [" · ", t("row.modelsDirty")]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-section-hint",
								children: t("row.modelsHint")
							}),
							!modelsEditable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-section-hint",
								children: t("row.modelsReadonly")
							}),
							models.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-connect-trae-models-model-bulk",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsm-btn dsm-btn-secondary",
										disabled: !modelsEditable || enabledCount === models.length,
										onClick: selectAllModels,
										children: t("row.modelsSelectAll")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsm-btn dsm-btn-secondary",
										disabled: !modelsEditable || !anyEnabled,
										onClick: selectNoModels,
										children: t("row.modelsSelectNone")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-model-bulk-state",
										children: enabledCount === 0 ? t("row.modelsAllDisabled") : enabledCount === models.length ? t("row.modelsAllEnabled") : t("row.modelsSomeEnabled", {
											enabled: enabledCount,
											total: models.length
										})
									})
								]
							}),
							models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelRow, {
								t,
								model,
								enabled: effectiveDraft.enabledModelIds.includes(model.id),
								images: effectiveDraft.imageModelIds.includes(model.id),
								budget: effectiveDraft.contextBudgets[model.id],
								disabled: !modelsEditable,
								onToggleEnabled: (next) => setDraft({
									...effectiveDraft,
									enabledModelIds: next ? [.../* @__PURE__ */ new Set([...effectiveDraft.enabledModelIds, model.id])] : effectiveDraft.enabledModelIds.filter((id) => id !== model.id)
								}),
								onToggleImages: (next) => setDraft({
									...effectiveDraft,
									imageModelIds: next ? [.../* @__PURE__ */ new Set([...effectiveDraft.imageModelIds, model.id])] : effectiveDraft.imageModelIds.filter((id) => id !== model.id)
								}),
								onBudgetChange: (next) => {
									const budgets = { ...effectiveDraft.contextBudgets };
									if (next === void 0) delete budgets[model.id];
									else budgets[model.id] = next;
									setDraft({
										...effectiveDraft,
										contextBudgets: budgets
									});
								}
							}, model.id)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-connect-trae-models-page-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-primary",
									disabled: busy !== void 0 || !modelsEditable,
									onClick: () => {
										saveModels();
									},
									children: busy === "models" ? t("row.modelsSaving") : t("row.modelsSave")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-outline",
									onClick: reloadConfig,
									children: t("row.refresh")
								})]
							})
						]
					})
				]
			});
		}
		/** 一个账号行。 */
		function AccountRow(props) {
			const { t, account, nowMs, isActive, busy, checkinMessage, onToggle, onCheckin } = props;
			const cooldownUntil = parseIso(account.cooldownUntil);
			const expiresAt = parseIso(account.expiresAt);
			const credentialDeadUntil = parseIso(account.credentialDeadUntil);
			const lastUsedAt = parseIso(account.lastUsedAt);
			const credits = account.credits;
			const upcoming = nearestUpcomingExpiry(credits, nowMs);
			const checkinState = checkinStateOf(account.checkin, account.deviceSpent);
			const claiming = busy === `checkin:${account.id}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsm-connect-trae-models-account",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-account-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-connect-trae-models-account-name",
								children: account.label
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsm-connect-trae-models-account-tags",
								children: [
									isActive && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-tag dsm-connect-trae-models-tag-ok",
										children: t("row.activeAccount", { name: account.label })
									}),
									account.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-tag dsm-connect-trae-models-tag-neutral",
										children: t("row.accountOffTag")
									}),
									account.credentialDead === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-tag dsm-connect-trae-models-tag-danger",
										children: t("row.credentialDead")
									}),
									account.cooling && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-tag dsm-connect-trae-models-tag-warn",
										children: t("row.cooling")
									}),
									account.reserved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-tag dsm-connect-trae-models-tag-warn",
										children: t("row.reserved")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "dsm-connect-trae-models-toggle",
								title: t("row.accountToggleHint"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									"aria-label": `${t("row.accountInRotation")} ${account.label}`,
									checked: !account.disabled,
									disabled: busy !== void 0,
									onChange: (event) => onToggle(!event.target.checked)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.disabled ? t("row.accountOff") : t("row.accountInRotation") })]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-account-meta",
						children: [
							expiresAt === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.tokenExpiryNone") }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.tokenExpiry", { time: formatTime(expiresAt) ?? "" }) }),
							cooldownUntil !== void 0 && account.cooling && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-connect-trae-models-warn",
								children: t("row.coolingUntil", { time: formatTime(cooldownUntil) ?? "" })
							}),
							credentialDeadUntil !== void 0 && account.credentialDead === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-connect-trae-models-danger",
								children: t("row.credentialDeadHint")
							}),
							account.rateLimitHits > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.rateLimitHits", { hits: account.rateLimitHits }) }),
							lastUsedAt === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.neverUsed") }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.lastUsed", { time: formatTime(lastUsedAt) ?? "" }) })
						]
					}),
					(account.modelCooldowns ?? []).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-account-facts",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsm-connect-trae-models-muted",
							children: [t("row.modelCoolingTitle"), ":"]
						}), (account.modelCooldowns ?? []).map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelCooling", {
							model: entry.modelId,
							time: formatTime(parseIso(entry.until)) ?? ""
						}) }, entry.modelId))]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-account-facts",
						children: [
							account.creditsError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-connect-trae-models-muted",
								children: t("row.creditsError")
							}),
							account.creditsError === void 0 && credits === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsm-connect-trae-models-muted",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-connect-trae-models-secondary",
										children: t("row.creditsTitle")
									}),
									" ",
									t("row.creditsLoading")
								]
							}),
							credits !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-connect-trae-models-muted",
									children: t("row.creditsTotal")
								}),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-connect-trae-models-secondary",
									children: credits.total
								}),
								" · ",
								t("row.creditsAvailable", { count: credits.available }),
								" · ",
								t("row.creditsConsumed", { count: credits.consumed })
							] }), credits.expiringSoon !== void 0 && credits.expiringSoon > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-connect-trae-models-tag dsm-connect-trae-models-tag-warn",
								children: t("row.creditsSoonBadge", { count: credits.expiringSoon })
							})] })
						]
					}),
					credits !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExpiryLine, {
						t,
						credits,
						upcoming,
						nowMs
					}),
					credits !== void 0 && credits.packs.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
						className: "dsm-connect-trae-models-packs",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("row.creditsPackages") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("row.creditsTotal") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("row.creditsExpiresAt", { time: "" }).split(" ")[0] })
						] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: credits.packs.map((pack, index) => {
							const display = expiryDisplayOf(pack, nowMs);
							const remaining = Math.max(0, (pack.creditsLimit ?? 0) - (pack.consumed ?? 0));
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: pack.displayDesc }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: pack.creditsLimit === void 0 ? t("row.creditsPackageNoQuota", { remain: remaining }) : t("row.creditsPackage", {
									remain: remaining,
									size: pack.creditsLimit
								}) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									className: display?.kind === "soon" ? "dsm-connect-trae-models-expiry-soon" : display?.kind === "past" ? "dsm-connect-trae-models-expiry-past" : void 0,
									children: display === void 0 ? "—" : formatTime(display.atMs)
								})
							] }, `${pack.displayDesc}-${index}`);
						}) })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-checkin",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-connect-trae-models-checkin-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dsm-connect-trae-models-checkin-text",
									children: [
										checkinState === "claimed" && t("row.checkinClaimed", { credits: account.checkin?.credits ?? 0 }),
										checkinState === "deviceSpent" && t("row.checkinDeviceSpent"),
										checkinState === "disabled" && t("row.checkinDisabled"),
										checkinState === "available" && t("row.checkinAvailable", { credits: account.checkin?.credits ?? 0 })
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsm-btn dsm-btn-primary dsm-btn-sm",
									disabled: checkinState !== "available" || claiming || busy !== void 0,
									onClick: onCheckin,
									children: claiming ? t("row.checkinClaiming") : t("row.checkinClaim")
								})]
							}),
							checkinState === "deviceSpent" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-section-hint",
								children: t("row.checkinDeviceSpentHint")
							}),
							checkinState === "disabled" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-section-hint",
								children: t("row.checkinDisabledHint")
							}),
							account.checkinError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-muted",
								children: t("row.checkinError")
							}),
							checkinMessage !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsm-connect-trae-models-checkin-msg dsm-connect-trae-models-secondary",
								children: checkinMessage
							})
						]
					})
				]
			});
		}
		/** 到期提醒行。 */
		function ExpiryLine(props) {
			const { t, credits, upcoming, nowMs } = props;
			if (upcoming !== void 0) {
				if (upcoming.kind === "soon") {
					const text = upcoming.days <= 0 ? t("row.creditsExpiresToday", { credits: upcoming.remaining }) : t("row.creditsExpiresInDays", {
						days: upcoming.days,
						credits: upcoming.remaining
					});
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "dsm-connect-trae-models-expiry dsm-connect-trae-models-expiry-soon",
						children: [
							t("row.creditsExpiresSoonTitle"),
							"：",
							text,
							"（",
							formatTime(upcoming.atMs),
							"）"
						]
					});
				}
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dsm-connect-trae-models-expiry dsm-connect-trae-models-expiry-future",
					children: t("row.creditsExpiresAt", { time: formatTime(upcoming.atMs) ?? "" })
				});
			}
			let latestPast;
			for (const pack of credits.packs) {
				const display = expiryDisplayOf(pack, nowMs);
				if (display === void 0 || display.kind !== "past") continue;
				if (latestPast === void 0 || display.atMs > latestPast.atMs) latestPast = display;
			}
			if (latestPast !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsm-connect-trae-models-expiry dsm-connect-trae-models-expiry-past",
				children: t("row.creditsExpired", {
					time: formatTime(latestPast.atMs) ?? "",
					credits: latestPast.remaining
				})
			});
			if (credits.packs.length > 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsm-connect-trae-models-expiry dsm-connect-trae-models-expiry-future",
				children: t("row.creditsNoExpiry")
			});
			return null;
		}
		/** 一个模型行。 */
		function ModelRow(props) {
			const { t, model, enabled, images, budget, disabled, onToggleEnabled, onToggleImages, onBudgetChange } = props;
			const hasBudgetOptions = model.budgetOptions !== void 0 && model.budgetOptions.length > 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsm-connect-trae-models-model",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-model-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-connect-trae-models-model-name",
							children: model.name
						}), model.multiplier !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsm-connect-trae-models-tag dsm-connect-trae-models-tag-neutral",
							children: model.multiplier === 0 ? t("row.modelFree") : t("row.modelCredits", { rate: model.multiplier.toFixed(2) })
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-model-facts",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelNativeWindow", { native: model.nativeContextWindow }) }), model.maxOutputTokens !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelMaxOutput", { count: model.maxOutputTokens }) })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-connect-trae-models-model-controls",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "dsm-connect-trae-models-toggle",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									"aria-label": `${t("row.modelEnabled")} ${model.name}`,
									checked: enabled,
									disabled,
									onChange: (event) => onToggleEnabled(event.target.checked)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelEnabled") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "dsm-connect-trae-models-toggle",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									"aria-label": `${t("row.modelImages")} ${model.name}`,
									checked: images,
									disabled,
									onChange: (event) => onToggleImages(event.target.checked)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelImages") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "dsm-connect-trae-models-budget",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.modelBudget") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "number",
										"aria-label": `${t("row.modelBudget")} ${model.name}`,
										...hasBudgetOptions ? { list: budgetListId(model.id) } : {},
										min: MIN_CONTEXT_BUDGET,
										max: model.nativeContextWindow,
										step: 1e3,
										placeholder: t("row.modelBudgetPlaceholder", { native: model.nativeContextWindow }),
										value: budget === void 0 ? "" : String(budget),
										disabled,
										onChange: (event) => {
											const raw = event.target.value.trim();
											if (raw === "") return onBudgetChange(void 0);
											const parsed = Number(raw);
											if (!Number.isFinite(parsed) || parsed <= 0) return;
											onBudgetChange(Math.max(MIN_CONTEXT_BUDGET, Math.min(Math.floor(parsed), model.nativeContextWindow)));
										}
									}),
									hasBudgetOptions && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("datalist", {
										id: budgetListId(model.id),
										children: model.budgetOptions.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", { value: option }, option))
									})
								]
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/popover.ts
		/**
		* 对话栏积分面板需要的两个外壳行为：把面板挂在触发器上，以及在点击外部时关闭。
		*
		* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
		*   —— 该项目的 `client/popover.ts`；它本身又沿用 dsh-connect-trae 的同一份
		*   判断：同样的上下放置、同样的视口收边、同样的 scroll(capture)/resize/自身
		*   尺寸变化重测、同样的「pointerdown 落在触发器与面板之外即关闭」。这些不是
		*   随手写的——那边 2.12.0/2.13.0 的客户端加载失败与面板位置错乱都留下了记录，
		*   这里直接采用其最终结论。
		*
		* 本地实现而不是从 `@deepseek-ai/dsh-client-ui-primitives` 引入：外壳确实为
		* 插件 bundle 注册了该包，引入是合法的，这是一个主动选择而不是绕路——两个
		* 行为只有几十行 DOM 几何，自己持有可以让组件在 Node 测试套件里直接渲染，
		* 不必去 mock 一个自身还要拉 `*.module.css` 和更多 DSH 依赖的包。
		*
		* 一个被记下来的误诊（保留是因为它总会被重新提起）：参照项目那次客户端加载
		* 失败最初被归因于引入 primitives 包，其实不是。真正的原因是
		* `import { createPortal } from 'react-dom'` 被**打包进去**而不是外部化——内联
		* 的开发版开头就是 `process.env.NODE_ENV`，在浏览器里抛
		* `ReferenceError: process is not defined`，且发生在模块求值期，于是整个客户端
		* 半端都 import 失败。修法见 `tsdown.config.ts` 的 `CLIENT_EXTERNALS`。
		*/
		/**
		* 距视口顶部要留出的余量。
		*
		* 外壳在窗口顶部为窗口边框保留了一条带（`--dsh-frame-top-clearance`），只看
		* `margin` 收边的话面板仍可能压在它下面。变量缺失或没有 `data-fullscreen` 区分
		* 时按外壳同样的方式处理：退回 `min`。
		*/
		function overlayTopMargin(min) {
			if (typeof document === "undefined") return min;
			const root = document.documentElement;
			const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue("--dsh-frame-top-clearance"));
			if (Number.isNaN(clearance)) return min;
			return Math.max(min, (root.hasAttribute("data-fullscreen") ? 0 : clearance) + 20);
		}
		/** 让一个 `position: fixed` 浮层锚定在触发器上。 */
		function useAnchoredPosition(options) {
			const { open, anchorRef, panelRef, side = "bottom", align = "start", gap, margin } = options;
			const [position, setPosition] = (0, react.useState)(null);
			(0, react.useLayoutEffect)(() => {
				if (!open) {
					setPosition(null);
					return;
				}
				const place = () => {
					const rect = anchorRef.current?.getBoundingClientRect();
					if (rect === void 0) return;
					const panel = panelRef.current;
					const width = panel?.offsetWidth ?? 0;
					const height = panel?.offsetHeight ?? 0;
					let left = align === "end" ? rect.right - width : rect.left;
					let top = side === "top" ? rect.top - gap - height : rect.bottom + gap;
					if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
					if (height > 0) top = Math.min(Math.max(top, overlayTopMargin(margin)), window.innerHeight - height - margin);
					setPosition({
						left,
						top
					});
				};
				place();
				window.addEventListener("scroll", place, true);
				window.addEventListener("resize", place);
				const panel = panelRef.current;
				let observer = null;
				if (typeof ResizeObserver !== "undefined" && panel !== null) {
					observer = new ResizeObserver(place);
					observer.observe(panel);
				}
				return () => {
					observer?.disconnect();
					window.removeEventListener("scroll", place, true);
					window.removeEventListener("resize", place);
				};
			}, [
				open,
				anchorRef,
				panelRef,
				side,
				align,
				gap,
				margin
			]);
			return position;
		}
		/**
		* 指针落在浮层之外时关闭它。
		*
		* `portal` 算「内部」：面板被 portal 到 `document.body`，并不是 root 的后代，
		* 否则点在面板自己身上也会被当成「外部」从而关掉用户正在用的浮层。
		*/
		function useDismissOnOutsidePointer(root, open, setOpen, portal) {
			(0, react.useEffect)(() => {
				if (!open) return void 0;
				const closeOutside = (event) => {
					if (event.target instanceof Node && root.current?.contains(event.target) !== true && portal?.current?.contains(event.target) !== true) setOpen(false);
				};
				document.addEventListener("pointerdown", closeOutside);
				return () => {
					document.removeEventListener("pointerdown", closeOutside);
				};
			}, [
				root,
				open,
				setOpen,
				portal
			]);
		}
		//#endregion
		//#region src/client/ComposerCredits.tsx
		/**
		* 对话栏（composer）工具行里的积分读数 + 切换用户面板。
		*
		* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
		*   —— 该项目的 `client/ComposerCredits.tsx`：同样的「触发器显示读数 → 点开面板
		*   列出账号 → 点一行切换」结构，同样的「非本插件模型时渲染空」门控，同样的
		*   「面板打开时才逐账号读余额」省额策略，以及 `set()` 成功不等于写入落盘的
		*   教训（这里改为显式路由写入，见 `switchTo`）。
		*
		* 与参照实现的一处刻意差异：切换账号走插件自己的
		* `/accounts/select` 路由（写 `pool.prefer`），而不是写 settings 槽位。原因
		* 是本插件的多账号是**同一个 provider 内部的轮转池**，不是「多套 provider 各绑
		* 一个账号」——把选择写进 settings 槽位不会改变任何派活行为，只会让界面上的
		* 选择与真正服务的账号脱节。
		*/
		/**
		* 注入本组件的样式，且只注入一次。
		*
		* 必须自包含：对话栏这一行常驻，而插件设置卡片可能从未被打开（某些宿主上甚至
		* 不会挂载它）——把对话栏样式寄放在卡片 CSS 里，等于「卡片不开就完全无样式」，
		* 用户会看到一个没有边框、没有排版的原生按钮。
		*/
		if (typeof document !== "undefined") {
			const cssId = "dsh-connect-trae-models/composer-credits.css";
			if (!document.querySelector(`style[data-plugin-css="${cssId}"]`)) {
				const styleTag = document.createElement("style");
				styleTag.dataset.pluginCss = cssId;
				styleTag.textContent = COMPOSER_CREDITS_CSS;
				document.head.appendChild(styleTag);
			}
		}
		/**
		* 刷新间隔：五分钟，与积分的实际变化速率匹配。
		*
		* 积分以「模型调用」为尺度变化，不是以秒；每次读都是一次只读上游调用，所以按
		* 分钟级刷新既够用又不产生可观的请求量。
		*/
		const COMPOSER_REFRESH_INTERVAL_MS = 3e5;
		/** provider id → 区域。非本插件的 provider 返回 undefined，门控据此渲染空。 */
		const COMPOSER_PROVIDERS = {
			"connect-trae-models": "cn",
			"connect-trae-models-global": "ai"
		};
		/** 积分格式化：整数不带小数，小数保留两位并去掉尾零。 */
		function formatCredits(value) {
			if (value === void 0 || !Number.isFinite(value)) return "—";
			if (Number.isInteger(value)) return String(value);
			return value.toFixed(2).replace(/\.?0+$/, "");
		}
		/**
		* 从状态文档挑出面板要显示的账号行。
		*
		* 只保留**参与轮转**的账号：已被停用的账号不出现在切换列表里——把它列出来再
		* 标一个「不可用」，等于邀请用户点一个注定不生效的行。
		*/
		function toComposerRows(status) {
			if (status === void 0) return [];
			return status.accounts.filter((account) => !account.disabled).map((account) => ({
				id: account.id,
				label: account.label,
				disabled: account.disabled,
				cooling: account.cooling,
				...account.credits === void 0 ? {} : { available: account.credits.available },
				preferred: status.preferredAccountId === account.id
			}));
		}
		function ComposerCredits(props) {
			const { t, provider, settingsScope } = props;
			if (t === void 0) throw new Error("Trae composer credits require a translation function");
			const region = provider === void 0 ? void 0 : COMPOSER_PROVIDERS[provider];
			const [status, setStatus] = (0, react.useState)(void 0);
			const [failed, setFailed] = (0, react.useState)(false);
			const [switchingId, setSwitchingId] = (0, react.useState)(void 0);
			const [open, setOpen] = (0, react.useState)(false);
			const inFlight = (0, react.useRef)(false);
			const mounted = (0, react.useRef)(true);
			const rootRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			const position = useAnchoredPosition({
				open: open && region !== void 0,
				anchorRef: rootRef,
				panelRef,
				side: "top",
				gap: 8,
				margin: 12
			});
			useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
			const refresh = (0, react.useCallback)(async (signal) => {
				if (inFlight.current || region === void 0) return;
				inFlight.current = true;
				try {
					const response = await fetch(withTraeRegion(TRAE_POOL_STATUS_PATH, region), {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const value = await response.json();
					if (!mounted.current || signal?.aborted === true) return;
					setStatus(value);
					setFailed(false);
				} catch {
					if (mounted.current && signal?.aborted !== true) setFailed(true);
				} finally {
					inFlight.current = false;
				}
			}, [region]);
			(0, react.useEffect)(() => {
				if (region === void 0) return void 0;
				const controller = new AbortController();
				refresh(controller.signal);
				const timer = setInterval(() => {
					refresh();
				}, COMPOSER_REFRESH_INTERVAL_MS);
				return () => {
					controller.abort();
					clearInterval(timer);
				};
			}, [region, refresh]);
			/**
			* 切到另一个账号，然后重新读一次状态文档，让读数与面板一起更新。
			*
			* 写入必须**回读校验**：网络往返成功不等于状态真的变了。服务端先应用钉选再
			* 回读文档，若文档里 `preferredAccountId` 仍不是目标账号，就明确报失败，
			* 而不是留下一个「标记跳到别的账号」的行。
			*/
			const switchTo = (0, react.useCallback)(async (accountId) => {
				if (region === void 0 || switchingId !== void 0) return;
				if (status?.preferredAccountId === accountId) return;
				setSwitchingId(accountId);
				setFailed(false);
				try {
					const response = await fetch(withTraeRegion(TRAE_POOL_ACCOUNT_SELECT_PATH, region), {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							accept: "application/json"
						},
						credentials: "same-origin",
						body: JSON.stringify({ accountId })
					});
					if (!response.ok) {
						const detail = await response.json().catch(() => void 0);
						throw new Error(detail?.error ?? `HTTP ${response.status}`);
					}
					const controller = new AbortController();
					await refresh(controller.signal);
					controller.abort();
				} catch (error) {
					if (mounted.current) setFailed(true);
				} finally {
					if (mounted.current) setSwitchingId(void 0);
				}
			}, [
				region,
				status?.preferredAccountId,
				switchingId,
				refresh
			]);
			if (region === void 0) return null;
			const rows = toComposerRows(status);
			const display = rows.find((row) => row.preferred)?.available ?? rows[0]?.available;
			const label = t(region === "cn" ? "composer.pointsCn" : "composer.pointsGlobal");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				ref: rootRef,
				className: "dsm-connect-trae-models-composer",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dsm-connect-trae-models-composer-trigger",
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						label,
						" · ",
						formatCredits(display)
					]
				}), open && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: panelRef,
					className: "dsm-connect-trae-models-composer-panel",
					style: position ?? {
						visibility: "hidden",
						left: 0,
						top: 0
					},
					role: "dialog",
					"aria-label": t("composer.panelTitle"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsm-connect-trae-models-composer-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-connect-trae-models-composer-title",
								children: t("composer.panelTitle")
							}), failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-connect-trae-models-warn",
								children: t("composer.failed")
							}) : null]
						}),
						rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsm-connect-trae-models-composer-empty",
							children: t("composer.noAccounts")
						}) : rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: "dsm-connect-trae-models-composer-row",
							"aria-current": row.preferred === true,
							disabled: switchingId !== void 0,
							onClick: () => {
								switchTo(row.id);
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-connect-trae-models-composer-name",
									children: row.label
								}),
								row.cooling === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-connect-trae-models-warn",
									children: t("composer.cooling")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-connect-trae-models-composer-value",
									children: formatCredits(row.available)
								}),
								row.preferred === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-connect-trae-models-composer-pin",
									children: t("composer.inUse")
								}) : null,
								switchingId === row.id ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsm-connect-trae-models-composer-value",
									children: t("composer.switching")
								}) : null
							]
						}, row.id)),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsm-connect-trae-models-composer-foot",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsm-connect-trae-models-composer-reset",
								disabled: status?.preferredAccountId === void 0 || switchingId !== void 0,
								onClick: () => {
									switchTo("");
								},
								children: t("composer.clearPin")
							})
						})
					]
				}), document.body)]
			});
		}
		//#endregion
		//#region src/client/ComposerCreditsGate.tsx
		/**
		* 决定本会话的对话栏要不要显示积分读数。
		*
		* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
		*   —— 该项目的 `client/ComposerCreditsGate.tsx`：读宿主自己的 `modelSelection`
		*   投影判断「本会话当前用哪个 provider」，只在属于本插件时渲染。
		*
		* 为什么用投影而不是插件自己的状态：投影是模型选择器写入、也是下一次请求真正
		* 要用的，读数因此不可能与实际生效的模型不一致。`next` 优先于 `lastUsed`，因为
		* 一个已选定但还没发出去的选择，仍应是 composer 展示给用户的——这与外壳自身
		* 的优先级一致。
		*
		* 与 ComposerCredits 分开（也与浏览器入口分开），是为了让这个「归属判定」可以
		* 在没有宿主的测试环境里单测：入口 import 的是浏览器专属 DSH 包，测试环境
		* 加载不了，而本模块只依赖 React 和一个窄投影形状。
		*/
		/**
		* 本会话当前指向的 provider 路由。
		*
		* `next` 优先于 `lastUsed`：一次已落地但还没发出的切换，仍是 composer 要展示
		* 的选择。
		*/
		function selectedProviderOf(projection) {
			const provider = (projection?.next ?? projection?.lastUsed)?.provider;
			return typeof provider === "string" && provider !== "" ? provider : void 0;
		}
		/**
		* 本会话该显示哪个区域的读数；不属于本插件返回 undefined。
		*
		* 归属测试与区域选择是**同一次查找**，这样就没有第二份会漂移的规则副本。
		*/
		function composerRegionOf(projection) {
			const provider = selectedProviderOf(projection);
			return provider === void 0 ? void 0 : COMPOSER_PROVIDERS[provider];
		}
		function ComposerCreditsGate(props) {
			const { t, useProjection, settingsScope } = props;
			const projection = useProjection === void 0 ? void 0 : useProjection("modelSelection");
			if (composerRegionOf(projection) === void 0) return null;
			const provider = selectedProviderOf(projection);
			return settingsScope === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ComposerCredits, {
				t,
				provider
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ComposerCredits, {
				t,
				provider,
				settingsScope
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* 卡片文案，注册在 `settings.connect-trae-models` 本地化命名空间下。
		* `en` 与 `zh` 的 key 保持 1:1（`zh` 以 `en` 的 key 集合定型）。
		*
		* 命名沿用 `row.*` 前缀习惯（与 workbuddy 卡片一致），便于跨卡片对照。
		*
		* @module dsh-connect-trae-models/client/locales
		*/
		const en = {
			"row.navLabel": "Trae Models",
			"row.title": "Trae Connect Models (dsh-connect-trae-models)",
			"row.desc": "Route every Trae sign-in on this machine into DSH as one auto-failing-over model pool.",
			"row.loading": "Loading…",
			"row.requestFailed": "Request failed",
			"row.poolEmpty": "No Trae account discovered yet.",
			"row.poolEmptyHint": "Sign in to one or more Trae accounts in the Trae desktop app, then click “Detect accounts again”. Every sign-in on this machine joins the pool automatically.",
			"row.regionEmptyTitle": "No {region} account is signed in yet.",
			"row.regionEmptyHint": "Sign in to a Trae account for this region in the desktop app, then choose “Detect accounts again”. The two versions keep separate accounts, so each needs its own sign-in.",
			"row.regionHowToTitle": "How to sign in to the {region} version",
			"row.regionCn": "Domestic build named “Trae CN” (trae.cn)",
			"row.regionAi": "International build named “Trae” (trae.ai)",
			"row.regionHowTo1": "Install the matching client for this region — the two builds are different apps with separate accounts.",
			"row.regionHowTo2": "Sign in inside the client; this plugin only reads sign-ins the client has already performed, and never asks for your password.",
			"row.regionHowTo3": "Come back here and press “Detect accounts again”. Each sign-in is absorbed into its own region.",
			"row.regionHowToNote": "The two regions talk to different gateways and cannot share accounts or credits. Both can run side by side.",
			"row.shimRunning": "Provider listening on loopback",
			"row.shimStopped": "Provider loopback is not running.",
			"row.rescan": "Detect accounts again",
			"row.rescanning": "Detecting…",
			"row.resetCooldowns": "Clear all cooldowns",
			"row.resetting": "Clearing…",
			"row.resetDone": "All cooldowns cleared.",
			"row.rescanDone": "{count} account(s) in the pool.",
			"row.refresh": "Refresh",
			"row.healthSummary": "{count} account(s) · {cooling} cooling",
			"row.activeAccount": "Next up: {name}",
			"row.activeAccountNone": "No account will serve the next request.",
			"row.ok": "Healthy — requests auto-rotate across accounts",
			"row.allCooling": "Every account is rate-limited right now; requests pause until a cooldown lifts.",
			"row.emptyReason": "No account is available for this region",
			"row.distributionLabel": "Account use",
			"row.distribution.priority": "Priority (drain one first)",
			"row.distribution.round-robin": "Round-robin (split evenly)",
			"row.distribution.balanced": "Balanced (idle-weighted)",
			"row.distribution.sticky": "Sticky (one account per chat)",
			"row.distribution.expiry": "Expiry first (spend soonest to expire)",
			"row.distributionHint.priority": "Requests keep hitting one account until it is rate-limited or out of credits, then move to the next.",
			"row.distributionHint.round-robin": "Consecutive requests rotate through every account, so the spend is split evenly.",
			"row.distributionHint.balanced": "Picks at random, weighted by how long an account has been idle — one unhealthy account cannot pin the pool to itself.",
			"row.distributionHint.sticky": "Each chat stays on one account, which keeps that account's prompt cache warm; a new chat moves to the next account.",
			"row.distributionHint.expiry": "Spends the credits that expire soonest first, so use-it-or-lose-it credits are not wasted.",
			"row.accountsTitle": "Accounts in the pool",
			"row.accountInRotation": "Enabled",
			"row.accountOff": "Disabled",
			"row.accountToggleHint": "Enable this account (uncheck to keep it out of the pool)",
			"row.accountToggleError": "Could not switch the account: {message}",
			"row.accountOffTag": "switched off",
			"row.cooling": "Cooling (rate-limited)",
			"row.coolingUntil": "until {time}",
			"row.cooldownHits": "{hits} hit(s)",
			"row.modelCooling": "{model} cooling until {time}",
			"row.modelCoolingTitle": "Per-model cooldowns",
			"row.tokenExpiry": "token {time}",
			"row.tokenExpiryNone": "token expiry unknown",
			"row.credentialDead": "Sign-in rejected",
			"row.credentialDeadHint": "The upstream no longer accepts this sign-in. Sign in again in the Trae desktop app to restore it.",
			"row.reserved": "Held by credit reserve",
			"row.reservedHint": "This account is resting to protect its remaining credits.",
			"row.rateLimitHits": "{hits} rate-limit hit(s)",
			"row.lastUsed": "last used {time}",
			"row.neverUsed": "not used yet",
			"row.accountUnknown": "Unknown account",
			"row.creditsTitle": "Credits",
			"row.creditsTotal": "Total",
			"row.creditsAvailable": "available {count}",
			"row.creditsConsumed": "used {count}",
			"row.creditsPackages": "Credit packages",
			"row.creditsPackage": "{remain} / {size}",
			"row.creditsPackageNoQuota": "remaining {remain}",
			"row.creditsPackageUsedUp": "used up",
			"row.creditsError": "credits unavailable",
			"row.creditsLoading": "reading credits…",
			"row.creditsExpiresSoonTitle": "Expiring within 3 days",
			"row.creditsSoonBadge": "{count} expiring soon",
			"row.creditsExpiresInDays": "{days} day(s) left · {credits} credits",
			"row.creditsExpiresToday": "Expires today · {credits} credits",
			"row.creditsExpiresAt": "Expires {time}",
			"row.creditsExpired": "Expired {time} · {credits} credits",
			"row.creditsNoExpiry": "No package with a deadline",
			"row.checkinTitle": "Daily check-in",
			"row.checkinClaim": "Check in now",
			"row.checkinClaiming": "Checking in…",
			"row.checkinClaimed": "Checked in today (+{credits})",
			"row.checkinAvailable": "Check in for {credits} credits",
			"row.checkinDeviceSpent": "This machine already checked in today",
			"row.checkinDeviceSpentHint": "One device can only check in for one account per day — another account on this machine already used today’s slot.",
			"row.checkinDisabled": "Check-in is not open",
			"row.checkinDisabledHint": "The upstream reports the daily check-in activity is currently closed.",
			"row.checkinError": "check-in status unavailable",
			"row.checkinDone": "Checked in: +{credits} credits",
			"row.checkinAlready": "Already checked in today.",
			"row.checkinDeviceDone": "Today’s slot for this machine is already used.",
			"row.checkinRefused": "The upstream refused the check-in.",
			"row.checkinCode": "Trae code {code}",
			"row.autoTitle": "Daily points automation",
			"row.autoEnable": "Run the daily check-in automatically",
			"row.autoEnableHint": "Only the check-in can be automated; every other Trae reward needs real activity in the client.",
			"row.autoHours": "Hours (Asia/Shanghai): {hours}",
			"row.autoRun": "Run now",
			"row.autoRunning": "Running…",
			"row.autoRunStarted": "Automation started; results appear in a few seconds.",
			"row.autoAlreadyRunning": "A run is already in progress.",
			"row.autoRunFailed": "Could not start the automation: {message}",
			"row.autoJobTitle": "Check-in job",
			"row.autoLastRun": "Last run {time}",
			"row.autoNeverRun": "Not run yet",
			"row.autoCounts": "{ok} ok · {failed} failed · {claimed} claimed · {deviceSpent} device-limited",
			"row.autoCredit": "+{credit} credits",
			"row.autoTodayTitle": "Earned today",
			"row.autoTodayNone": "Nothing earned yet today.",
			"row.autoTodayAccount": "{name}: +{credit}",
			"row.autoDeviceSpentToday": "{name}: used today’s slot",
			"row.autoFiredSlots": "Fired slots today: {count}",
			"row.autoDetail": "Details",
			"row.autoEnableFailed": "Could not save the switch: {message}",
			"row.modelsTitle": "Models",
			"row.modelsHint": "Changes apply to this region only; the other tab keeps its own list.",
			"row.modelEnabled": "Enabled",
			"row.modelImages": "Image input",
			"row.modelBudget": "Context budget",
			"row.modelBudgetPlaceholder": "native {native}",
			"row.modelNativeWindow": "native window {native}",
			"row.modelMaxOutput": "max output {count}",
			"row.modelFree": "free",
			"row.modelCredits": "x{rate}",
			"row.modelsSave": "Save model settings",
			"row.modelsSaving": "Saving…",
			"row.modelsSaved": "Model settings saved.",
			"row.modelsSaveFailed": "Could not save the model settings: {message}",
			"row.modelsEmpty": "No model is advertised for this region yet.",
			"row.modelsDirty": "Unsaved changes",
			"row.modelsSelectAll": "Select all",
			"row.modelsSelectNone": "Clear all",
			"row.modelsAllEnabled": "All models are enabled.",
			"row.modelsSomeEnabled": "{enabled} of {total} models are enabled.",
			"row.modelsAllDisabled": "All models are disabled — no model is offered to DSH.",
			"row.catalogSourceLive": "Model list from the gateway",
			"row.catalogSourceFallback": "Model list is the built-in fallback",
			"row.catalogError": "The model list could not be refreshed: {message}",
			"row.modelsReadonly": "This profile is read-only, so model settings cannot be changed.",
			"composer.pointsCn": "Trae CN",
			"composer.pointsGlobal": "Trae Global",
			"composer.panelTitle": "Trae accounts",
			"composer.failed": "Refresh failed — showing the last known value",
			"composer.noAccounts": "No account is currently in rotation.",
			"composer.cooling": "Rate-limited",
			"composer.inUse": "in use",
			"composer.switching": "switching…",
			"composer.clearPin": "Use automatic rotation"
		};
		/** Card copy in Chinese; key set mirrors {@link en} exactly. */
		const zh = {
			"row.navLabel": "Trae 模型",
			"row.title": "Trae Connect Models（dsh-connect-trae-models）",
			"row.desc": "把本机所有 Trae 登录聚合成一个自动容错换号的模型池接入 DSH。",
			"row.loading": "加载中…",
			"row.requestFailed": "请求失败",
			"row.poolEmpty": "还没有发现任何 Trae 账号。",
			"row.poolEmptyHint": "请先在 Trae 桌面端登录一个或多个账号，然后点「重新检测账号」。本机上的每一处登录都会被自动纳入账号池。",
			"row.regionEmptyTitle": "该区域（{region}）还没有登录任何账号。",
			"row.regionEmptyHint": "请在桌面端登录该区域的 Trae 账号，然后点「重新检测账号」。两个版本共用一台机器但账号体系独立，需分别登录。",
			"row.regionHowToTitle": "如何登录{region}版本",
			"row.regionCn": "国内版安装包名为「Trae CN」（trae.cn）",
			"row.regionAi": "国际版安装包名为「Trae」（trae.ai）",
			"row.regionHowTo1": "安装该区域对应的客户端——两个版本是不同的应用，账号互不相通。",
			"row.regionHowTo2": "在客户端内完成登录；本插件只读取客户端已经产生的登录态，绝不索取你的密码。",
			"row.regionHowTo3": "回到这里点「重新检测账号」，每一处登录会被归入各自区域。",
			"row.regionHowToNote": "两个区域连的是不同网关，账号与积分不能互通，但可以同时使用。",
			"row.shimRunning": "供应商回环端点运行中",
			"row.shimStopped": "供应商回环端点未运行。",
			"row.rescan": "重新检测账号",
			"row.rescanning": "检测中…",
			"row.resetCooldowns": "清除所有冷却",
			"row.resetting": "清除中…",
			"row.resetDone": "已清除全部冷却。",
			"row.rescanDone": "账号池现有 {count} 个账号。",
			"row.refresh": "刷新",
			"row.healthSummary": "{count} 个账号 · {cooling} 个冷却中",
			"row.activeAccount": "下一个轮到：{name}",
			"row.activeAccountNone": "当前没有账号能服务下一个请求。",
			"row.ok": "状态正常——请求会在账号间自动轮换",
			"row.allCooling": "所有账号都在限流中；冷却解除前请求会暂停。",
			"row.emptyReason": "该区域没有可用账号",
			"row.distributionLabel": "账号使用方式",
			"row.distribution.priority": "优先（先用完一个）",
			"row.distribution.round-robin": "轮转（均摊花销）",
			"row.distribution.balanced": "均衡（按闲置加权）",
			"row.distribution.sticky": "粘性（一个对话一个账号）",
			"row.distribution.expiry": "到期优先（先花快过期的）",
			"row.distributionHint.priority": "请求一直打同一个账号，直到它被限流或积分耗尽，才换下一个。",
			"row.distributionHint.round-robin": "连续请求在所有账号间轮换，花销均摊。",
			"row.distributionHint.balanced": "按闲置时长加权随机挑选——一个不健康的账号无法把池子钉死在自己身上。",
			"row.distributionHint.sticky": "每个对话固定在一个账号，保持该账号的提示缓存不失效；新对话才换到下一个。",
			"row.distributionHint.expiry": "优先花掉最快到期的积分包，避免「到期即作废」的积分白白浪费。",
			"row.accountsTitle": "账号池",
			"row.accountInRotation": "已启用",
			"row.accountOff": "已停用",
			"row.accountToggleHint": "启用该账号（取消勾选则不让它参与轮转）",
			"row.accountToggleError": "切换账号失败：{message}",
			"row.accountOffTag": "已停用",
			"row.cooling": "冷却中（被限流）",
			"row.coolingUntil": "解冻于 {time}",
			"row.cooldownHits": "命中 {hits} 次",
			"row.modelCooling": "{model} 冷却至 {time}",
			"row.modelCoolingTitle": "按模型冷却",
			"row.tokenExpiry": "token {time}",
			"row.tokenExpiryNone": "token 到期时间未知",
			"row.credentialDead": "登录被拒",
			"row.credentialDeadHint": "上游已不再接受该登录态。请到 Trae 桌面端重新登录以恢复。",
			"row.reserved": "因保留积分停用",
			"row.reservedHint": "该账号正在休息，以保住剩余积分。",
			"row.rateLimitHits": "累计限流 {hits} 次",
			"row.lastUsed": "最近使用 {time}",
			"row.neverUsed": "尚未使用",
			"row.accountUnknown": "未知账号",
			"row.creditsTitle": "积分",
			"row.creditsTotal": "合计",
			"row.creditsAvailable": "可用 {count}",
			"row.creditsConsumed": "已用 {count}",
			"row.creditsPackages": "积分包明细",
			"row.creditsPackage": "{remain} / {size}",
			"row.creditsPackageNoQuota": "剩余 {remain}",
			"row.creditsPackageUsedUp": "已用完",
			"row.creditsError": "积分读取失败",
			"row.creditsLoading": "正在读取积分…",
			"row.creditsExpiresSoonTitle": "3 天内到期",
			"row.creditsSoonBadge": "{count} 即将到期",
			"row.creditsExpiresInDays": "{days} 天后到期 · 剩 {credits} 积分",
			"row.creditsExpiresToday": "今天到期 · 剩 {credits} 积分",
			"row.creditsExpiresAt": "到期于 {time}",
			"row.creditsExpired": "已于 {time} 过期 · {credits} 积分",
			"row.creditsNoExpiry": "没有带截止时间的积分包",
			"row.checkinTitle": "每日签到",
			"row.checkinClaim": "立即签到",
			"row.checkinClaiming": "签到中…",
			"row.checkinClaimed": "今日已领（+{credits}）",
			"row.checkinAvailable": "可领取 {credits} 积分",
			"row.checkinDeviceSpent": "本机今日名额已用",
			"row.checkinDeviceSpentHint": "同一台设备每天只能为一个账号签到——本机上的另一个账号已经用掉了今天的名额。",
			"row.checkinDisabled": "签到活动未开启",
			"row.checkinDisabledHint": "上游报告每日签到活动当前未开放。",
			"row.checkinError": "签到状态读取失败",
			"row.checkinDone": "签到成功：+{credits} 积分",
			"row.checkinAlready": "今日已经签过了。",
			"row.checkinDeviceDone": "本机今日的名额已经被用掉了。",
			"row.checkinRefused": "上游拒绝了这次签到。",
			"row.checkinCode": "Trae 业务码 {code}",
			"row.autoTitle": "积分自动化",
			"row.autoEnable": "自动执行每日签到",
			"row.autoEnableHint": "只有签到可以自动化；Trae 其余奖励都需要在客户端里产生真实行为。",
			"row.autoHours": "执行时段（北京时区）：{hours}",
			"row.autoRun": "立即运行",
			"row.autoRunning": "运行中…",
			"row.autoRunStarted": "自动化已启动，几秒后出现结果。",
			"row.autoAlreadyRunning": "已有一次执行正在进行。",
			"row.autoRunFailed": "启动自动化失败：{message}",
			"row.autoJobTitle": "签到任务",
			"row.autoLastRun": "上次运行 {time}",
			"row.autoNeverRun": "尚未运行",
			"row.autoCounts": "{ok} 成功 · {failed} 失败 · {claimed} 已领取 · {deviceSpent} 设备受限",
			"row.autoCredit": "+{credit} 积分",
			"row.autoTodayTitle": "今日所得",
			"row.autoTodayNone": "今天还没有获得积分。",
			"row.autoTodayAccount": "{name}：+{credit}",
			"row.autoDeviceSpentToday": "{name}：已用掉今日名额",
			"row.autoFiredSlots": "今日已执行时段：{count}",
			"row.autoDetail": "明细",
			"row.autoEnableFailed": "保存开关失败：{message}",
			"row.modelsTitle": "模型管理",
			"row.modelsHint": "改动只作用于当前区域，另一个标签页保持自己的列表。",
			"row.modelEnabled": "启用",
			"row.modelImages": "图片输入",
			"row.modelBudget": "上下文预算",
			"row.modelBudgetPlaceholder": "原生 {native}",
			"row.modelNativeWindow": "原生窗口 {native}",
			"row.modelMaxOutput": "输出上限 {count}",
			"row.modelFree": "免费",
			"row.modelCredits": "x{rate}",
			"row.modelsSave": "保存模型设置",
			"row.modelsSaving": "保存中…",
			"row.modelsSaved": "模型设置已保存。",
			"row.modelsSaveFailed": "保存模型设置失败：{message}",
			"row.modelsEmpty": "该区域还没有任何模型。",
			"row.modelsDirty": "有未保存的改动",
			"row.modelsSelectAll": "全选",
			"row.modelsSelectNone": "取消全选",
			"row.modelsAllEnabled": "全部模型已启用。",
			"row.modelsSomeEnabled": "已启用 {enabled} / {total} 个模型。",
			"row.modelsAllDisabled": "全部模型已停用——不会再向 DSH 提供任何模型。",
			"row.catalogSourceLive": "模型列表来自网关",
			"row.catalogSourceFallback": "模型列表为内置回退表",
			"row.catalogError": "模型列表刷新失败：{message}",
			"row.modelsReadonly": "当前配置为只读，无法修改模型设置。",
			"composer.pointsCn": "Trae 国内",
			"composer.pointsGlobal": "Trae 国际",
			"composer.panelTitle": "Trae 账号",
			"composer.failed": "刷新失败——显示的是上次读到的数值",
			"composer.noAccounts": "当前没有参与轮转的账号。",
			"composer.cooling": "限流中",
			"composer.inUse": "使用中",
			"composer.switching": "切换中…",
			"composer.clearPin": "恢复自动轮转"
		};
		//#endregion
		//#region src/client/index.tsx
		/** 稳定的浏览器插件名。 */
		const name = "dsh-connect-trae-models-client";
		/**
		* 设置页需要的客户端服务。
		*
		* 刻意只列两条宿主线都提供的服务。设置面按线而异：0.1.5 提供 `settingsScope`，
		* 0.1.7 用 `configForms` 取代它，而 cordis 的依赖闸门是硬的：任何运行线不提供
		* 的 inject 条目都会让 `apply` 永不执行。用 `ctx.get()` 探测实际存在的那一个
		* （服务缺失时返回 undefined，绝不抛错）是「一份构建服务两条线」的关键。
		*/
		const inject = ["slots", "locale"];
		/** 宿主侧分区注册的 settings 命名空间（与宿主入口共用）。 */
		const TRAE_POOL_SETTINGS_NS = "connect-trae-models";
		/**
		* `cordis.patch.yml` 里挂载本 bundle 的宿主插件条目 id。
		*
		* 0.1.7 线上 `configForms` 以这个 id 寻址。
		*/
		const TRAE_POOL_ENTRY_ID = "llm-connect-trae-models";
		/** 注册卡片文案与设置面板下的账号池页。 */
		function apply(ctx) {
			try {
				const namespace = "settings.connect-trae-models";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-connect-trae-models: settings copy");
				const t = ctx.locale.bind(namespace);
				const softGet = (serviceName) => ctx.get(serviceName);
				const settingsScope = resolveSettingsScope(softGet);
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "connect-trae-models",
					order: 441,
					label: () => t("row.navLabel"),
					inject: () => settingsScope === void 0 ? { t } : {
						t,
						settingsScope
					}
				}, TraePoolCard));
				const conversationSlot = "conversation.input.left";
				if (ctx.slots.inject !== void 0) try {
					ctx.slots.inject(conversationSlot, () => ctx.slots.register({
						name: conversationSlot,
						id: "connect-trae-models-composer",
						order: 4,
						locale: namespace,
						inject: () => settingsScope === void 0 ? { t } : {
							t,
							settingsScope
						}
					}, ComposerCreditsGate));
				} catch (error) {
					console.error("[dsh-connect-trae-models] composer 插槽注册失败（宿主 provider 不受影响）：", error);
				}
			} catch (error) {
				console.error("[dsh-connect-trae-models] 客户端页面加载失败（宿主 provider 不受影响）：", error);
			}
		}
		/**
		* 绑定卡片读写所用的设置表单，取运行线上实际存在的那一条。
		*
		* 0.1.7 暴露 `configForms.get(entryId)`，以**宿主插件条目 id** 为键 —— 即
		* `cordis.patch.yml` 里注册的 id，而不是 settings 命名空间。0.1.5 暴露
		* `settingsScope.bind({ namespace })`，以宿主侧 `installSection` 注册的命名空间
		* 为键。两个控制器回答同一对方法（`getSnapshot()`、`set(field, value)`），所以
		* 卡片自身不需要按线分支。
		*
		* 两者都不存在时返回 undefined（受限宿主）：卡片退化为只读，这是文档化的降级。
		*/
		function resolveSettingsScope(softGet) {
			const forms = softGet("configForms");
			if (forms !== void 0) {
				let entryId = TRAE_POOL_ENTRY_ID;
				try {
					const namespaces = forms.describe().getSnapshot().view?.namespaces ?? [];
					const served = namespaces.find((entry) => entry.ns === TRAE_POOL_ENTRY_ID) ?? namespaces.find((entry) => /connect-trae-models/.test(entry.ns));
					if (served !== void 0) entryId = served.ns;
				} catch {}
				return forms.get(entryId);
			}
			const scope = softGet("settingsScope");
			if (scope !== void 0) return scope.bind({ namespace: TRAE_POOL_SETTINGS_NS });
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
