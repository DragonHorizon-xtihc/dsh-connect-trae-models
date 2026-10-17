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
export const COMPOSER_CREDITS_CSS = `
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
`

export const POOL_CARD_CSS = `
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
`
