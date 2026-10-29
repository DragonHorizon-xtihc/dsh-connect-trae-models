# `pi-ai detected context overflow for model` 根因报告

> 调查对象：`dsh-connect-trae-models` 插件
> 参考实现：`dsh-connect-trae` 插件
> 证据会话：`session-a83a843a-3c1d-4261-a742-47e96e8d594f`（cwd `D:\WiNEX\winning-code\TechMiniSvr`，`agentPreset: standard`）
> 结论日期：2026-10-28

---

## 0. 一句话结论

**报错不是「上下文真的超了」，而是插件向 DSH 申报的 `contextWindow = 200000` 远低于模型真实窗口（1,000,000），
导致 pi-ai 在模型**正常返回**后用 `usage.input > contextWindow` 做了一次事后判定，把成功响应当成溢出丢掉。**

会话里有直接的 A/B 证据：**同一个模型 `deepseek-v4.1-flash` 在同一个会话里被两个插件申报成两个不同的窗口** ——
`connect-trae-models` 报 `200000`，`workbuddy-models` 报 `1000000`。切换到 1M 申报后会话立刻恢复正常。

---

## 1. 证据链（可复现）

### 1.1 报错文本的来源

| 位置 | 内容 |
|---|---|
| `dsh-llm-pi-ai/lib/index.js:1470-1476` | `mapStopReason()` → `message.errorMessage ?? \`pi-ai detected context overflow for model "${message.model}"\``，`code = CONTEXT_WINDOW_EXCEEDED` |
| `dsh-compaction-basic/lib/index.js:861-862` | 自动恢复入口 `ctx.on("agent/request-error", ...)`，只处理 `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE` |

### 1.2 判定逻辑是「事后 silent overflow」，不是上游报错

`@earendil-works/pi-ai/dist/utils/overflow.js:152-157`：

```js
// Case 2: Silent overflow (z.ai style) - successful but usage exceeds context
if (contextWindow && message.stopReason === "stop") {
    const inputTokens = message.usage.input + message.usage.cacheRead;
    if (inputTokens > contextWindow) return true;   // ← 模型已成功返回，仍判超限
}
```

**关键**：`stopReason === "stop"` 表示上游**正常完成**。这条分支纯粹是「拿真实 usage 去比一个我们自己申报的窗口」。

### 1.3 用户会话实测：5 个 turn 全部是「上游成功 → 被判溢出」

`session.v4.jsonl` 的 `turn/end`（seq 774 / 1014 / 1228 / 1380 / 1411）全部为：

```
{"kind":"error","error":{"message":"pi-ai detected context overflow for model \"deepseek-v4.1-flash\"","code":"CONTEXT_WINDOW_EXCEEDED"}}
```

而对应 `assistant/attempt.finish.replayState.response.stopReason` **全部是 `"stop"`**（上游成功）。

| turn | model | 实测 inputTokens | 上游 stopReason | turn 结局 |
|---:|---|---:|---|---|
| 1 | deepseek-v4.1-flash | 242,013 | `stop` | CONTEXT_WINDOW_EXCEEDED |
| 2 | deepseek-v4.1-flash | 282,690 | `stop` | CONTEXT_WINDOW_EXCEEDED |
| 3 | deepseek-v4.1-flash | 315,655 | `stop` | CONTEXT_WINDOW_EXCEEDED |
| 4 | deepseek-v4.1-flash | 344,107 | `stop` | CONTEXT_WINDOW_EXCEEDED |
| 5 | minimax-m3.1-flash | 327,009 | `stop` | CONTEXT_WINDOW_EXCEEDED |

### 1.4 决定性 A/B：同一会话内，同一模型被申报成两个窗口

`request/context` 事件（同一份会话日志内）：

```
connect-trae-models/deepseek-v4.1-flash  = 200000     ← 本插件
connect-trae-models/minimax-m3.1-flash   = 200000     ← 本插件
workbuddy-models/deepseek-v4.1-flash     = 1000000    ← 兄弟插件
workbuddy-global/deepseek-v4.1-flash     = 1000000    ← 兄弟插件
```

- 走 `connect-trae-models`（申报 20 万）：**133 次请求 input > 200000，5 个 turn 被杀**
- 切到 `workbuddy-models`（申报 100 万）：会话继续跑到 **turn 8**，输入降到 772 tokens，**再没有一次溢出错误**

**这是「200000 是插件自己编的低值、不是模型真实上限」的硬证据。**

### 1.5 上游真实能力（同一份 profile 里另一处记录）

`C:\Users\user\.dsh\profiles\web\cordis.patch.yml:1321-1324`：

```yaml
- id: deepseek-v4.1-flash
  name: Deepseek-V4.1-Flash
  contextWindow: 1000000        # ← 1M
  maxTokens: 128000
  descriptionZh: 已更新至 V4.1-Flash-1017最新版，支持1M上下文窗口，原生多模态
```

---

## 2. 缺陷定位（插件侧代码）

### 2.1 硬编码 20 万兜底，且 Max 档被丢弃

| 文件:行 | 代码 | 问题 |
|---|---|---|
| `src/catalog.ts:52` | `export const TRAE_DEFAULT_CONTEXT_WINDOW = 200_000` | 兜底值就是 20 万 |
| `src/model-metadata.ts:72` | `const max = raw.max_mode === true ? finitePositive(context?.['max']) : undefined` | **`max_mode !== true` 时 Max 窗口直接丢弃** |
| `src/catalog.ts:61-81` | CN/AI 回退名册全部 `contextWindow: 200_000`（gpt 系 272,000） | 静态名册也钉死 20 万 |
| `src/catalog.ts:155-161` | `const window = model.contextWindow ?? wireModel?.contextWindow; contextWindow: window ?? TRAE_DEFAULT_CONTEXT_WINDOW` | 上游只报 dev 档时永远取 dev |

### 2.2 预算只能下调，不能上调 —— 缺逃生口

`src/catalog.ts:195-201`：

```ts
export function applyModelBudget(model: TraeModelInfo, budget: number | undefined): TraeModelInfo {
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return model
  const ceiling = model.maxContextWindow ?? model.contextWindow   // ← Max 缺失时 ceiling = dev
  const window = Math.max(1, Math.min(Math.floor(budget), ceiling))
  ...
}
```

因为 `maxContextWindow` 在 `max_mode !== true` 时恒为 `undefined`，`ceiling` 就退化成 `contextWindow`（20 万），
**用户无论如何都无法把窗口抬到 20 万以上**。

### 2.3 adapter 申报链路（确认无二次修正）

`src/adapter.ts:170-189` `toPiModel()`：

```ts
const contextWindow = Number.isFinite(info.contextWindow) && info.contextWindow > 0
  ? info.contextWindow
  : TRAE_DEFAULT_CONTEXT_WINDOW     // ← 唯一兜底，仍是 20 万
```

→ 20 万一路原样传给 DSH，成为 `request/context.contextWindow`，再成为 pi-ai 的判定基准。

---

## 3. 为什么「没有触发会话压缩」（第二层问题）

用户观察到的现象是「报错总是出现，压缩却从不救场」。实测确认：

### 3.1 目标会话压缩事件为 0

| 指标 | 值 |
|---|---|
| `turn/end` | 8 |
| `compaction/start` | **0** |
| `compaction/end` | **0** |
| 以 `CONTEXT_WINDOW_EXCEEDED` 结束的 turn | 5 / 8 |
| 输入 > 200000 的请求数 | 133 |
| 最大 inputTokens | 343,135 |

### 3.2 但阈值早就该被越过了 —— 排除「阈值没到」

按 `dsh-compaction-basic/lib/index.js:124-134` 的 `resolveCompactSpec()` 实算：

| 量 | 值 | 推导 |
|---|---:|---|
| `contextWindow` | 200,000 | 插件申报值 |
| `reservedCompletionTokens` | 0 | 本插件 `configuredMaxTokens: new Map()`（`src/adapter.ts:231`）恒空 → `info.defaultMaxTokens` 为 undefined → `?? 0` |
| `messageBudgetTokens` | 200,000 | `200000 - 0` |
| `headroomTokens` | 65,536 | 默认值 |
| `pressureBudgetTokens` | 134,464 | `200000 - 65536` |
| **`thresholdTokens`** | **134,464** | `min(200000 × 0.8, 134464)` |
| `retainTokens` | 32,000 | `floor(200000 × 0.16)` |

逐点重算 199 条 `assistant/message` 的 token-meter 估算（脚本见 §6）：
**估算值首次越过 134,464 出现在 step 34；真实 usage 首次越过出现在 step 32。**
此后 170+ 个 step 一直在阈值之上。

### 3.3 排除「selectCompactableRange 返回 null」

用真实 surface 逐点模拟 `selectCompactableRange()`（`dsh-compaction-basic/lib/index.js:410-433`）：
在 135 个越线探测点上，**返回 null 的次数为 0**，每次都得到合法区间（例：`seq=1401` 时 `range 10..1397`）。

- `retainTokens = 32000` 而 tools schema 固定成本 = **39,728 tokens**（190 个工具，`JSON.stringify` 158,895 字符 ÷ 4）
- 但 `retainTokens` 只决定「尾部保留多少节点」，不阻断区间选择 → **不是这里的锅**

### 3.4 排除「token-meter 中文低估导致永不越线」

实测「估算 / 真实」比值分布（199 点）：

| 统计量 | 值 |
|---|---|
| min | 0.748 |
| median | 0.869 |
| p75 | 0.891 |
| max | 1.236 |
| mean | 0.881 |

`CHARS_PER_TOKEN = 4`（`dsh-token-meter/lib/index.js:16`）确实系统性低估约 12%（中文只占全会话 7.1%），
**但低估幅度不足以让总量停在阈值之下**。且 `measure()` 的 baseline 分支会用真实 usage
（`dsh-token-meter/lib/index.js:731-743`，`usageTokens(usage) >= estimatedAnchorTokens` 成立时 `kind: 'usage'`），
本会话最后一条 usage 求和 = 326,478 ≫ 134,464。

→ **三项排查全部排除后，结论是：压缩触发条件成立，但 `agent/pre-step` / `agent/request-error` 两条恢复路径都没能留下事务记录。**

### 3.5 剩余的候选路径（需在修复中一并加固）

按 `dsh-compaction-basic/lib/index.js` 的执行顺序，能让「零 compaction 事件」成立的只有以下几种：

| 候选 | 代码位置 | 说明 |
|---|---|---|
| **A. `signal.aborted` 早退** | `:862` `if (... \|\| signal.aborted) return next();` | turn 已因错误进入收尾，信号可能已 abort → 恢复路径直接放行 |
| **B. `maxOverflowRetries` 用尽** | `:867-868` `if (retries >= policy.maxOverflowRetries) return next();` | 默认 1；同一 turn 内二次溢出即放弃 |
| **C. 压力路径被 warn 吞掉** | `:843-850` `ctx.logger.warn("step compaction failed: ...")` | 异常不外抛、不写事件、turn 继续 → 现象与实测完全一致 |
| **D. preset 未挂载 compaction** | `dump-web-config.yml:468-473` | host 平面 `compaction-basic` 为 `disabled: true`，只有 preset 内那一份生效 |

**注**：全机 670 个会话逐帧解码后，**37 个会话确实出现过 compaction 事件**（最多 1641 次），
说明 compaction-basic 本身在本环境是可用的 → **候选 D 被排除**，问题集中在该会话所处 preset 的运行时路径（A/B/C）。

---

## 4. 参考插件 `dsh-connect-trae` 对照

### 4.1 它有同一个缺陷

`src/model-metadata.ts:109`（与本次插件逐字相同）：

```ts
const max = raw.max_mode === true ? finitePositive(context?.['max']) : undefined
```

→ 同样会在 `max_mode` 为 false 时丢掉 Max 窗口。

### 4.2 但它有逃生口：UI 可选多档窗口

`src/context-budget.ts`（全文 60 行）：

```ts
export const TRAE_CONTEXT_BUDGET_MID = 500_000

export function contextBudgetOptions(model: TraeContextWindows): number[] {
  const dev = model.contextWindow
  const max = model.maxContextWindow
  const options: number[] = []
  const push = (value?: number) => { if (value === undefined || value < 1) return; if (!options.includes(value)) options.push(value) }
  push(dev)
  if (max !== undefined && max >= TRAE_CONTEXT_BUDGET_MID && (dev === undefined || TRAE_CONTEXT_BUDGET_MID > dev)) push(TRAE_CONTEXT_BUDGET_MID)
  push(max)
  return options.sort((left, right) => left - right)
}
```

`src/catalog.ts:693-704` 应用时严格校验：

```ts
...(budget !== undefined && contextBudgetOptions(model).includes(budget) ? { contextWindow: budget } : {})
```

→ **只能在模型真实提供的档位内切换，绝不伪造、绝不越过 Max；Max 缺失时只有 dev 一个选项（卡片只读）。**

### 4.3 差异结论

| 维度 | `dsh-connect-trae`（参考） | `dsh-connect-trae-models`（本插件） |
|---|---|---|
| Max 窗口解析 | ❌ 同样丢弃（`max_mode` 门槛） | ❌ 同样丢弃 |
| 用户可抬升窗口 | ✅ UI 三档（dev / 500K / Max） | ❌ **只能下调，20 万是硬顶** |
| 后果 | 用户可自救 | **必死** |

**因此：参考插件存在同类缺陷，但它靠「可选多档预算」绕过去了；本插件缺的正是这个逃生口。**

---

## 5. 修复清单（给实现者的具体动作）

### 5.1 必修（消除误判）

1. **`src/model-metadata.ts:72`** —— 不再因 `max_mode` 丢弃 `max`。
   建议：始终解析 `context_window_tokens.max` 到 `maxContextWindow`；`max_mode` 只作为「该档是否可计费使用」的独立标记保留。

2. **`src/catalog.ts:195-201` `applyModelBudget`** —— 引入 `contextBudgetOptions` 语义（照抄参考插件），
   允许在 `[dev, 500K(若 max≥500K 且 dev<500K), max]` 内选择，**绝不产生超过 Max 的数值**。

3. **`src/catalog.ts` 新增 `contextBudgets: Record<modelId, number>` 配置** ——
   与既有 config 风格一致；未设置时按「有更宽 Max 就用更宽（保守可取 max 或 500K），无 Max 才用 dev」的默认策略。

4. **`src/adapter.ts:170-189`** —— 申报 `contextWindow` 时取「合法预算 → 否则默认策略」，不再落到 20 万常量。

### 5.2 应修（让压缩真正有机会救场）

5. **`src/adapter.ts:231`** —— `configuredMaxTokens: new Map()` 恒空，导致 `compaction-basic` 的
   `reservedCompletionTokens = 0`。目录有 `maxOutputTokens` 时应写入该 map，
   使阈值计算包含输出预留（注意：这会把 `thresholdTokens` **往下拉**，属预期行为，需在测试里覆盖新算术）。

6. **`src/model-metadata.ts` / `src/catalog.ts`** —— 把 `maxOutputTokens` 从 wire 的 `max_tokens` 稳定带出，
   保证第 5 条有值可写。

### 5.3 建议（提升可观测性）

7. 当申报窗口与上游 `context_window_tokens.max` 差异超过 2 倍时，在插件状态里暴露一条告警字段，
   让配置页面能提示「该模型真实窗口是 1M，当前只申报了 200K」—— 本次事故本可以在 UI 上被一眼看出。

---

## 6. 复现脚本

analysis 期间产出的只读脚本（位于 `.dsh-file-drop/`）：

| 脚本 | 作用 |
|---|---|
| `analyze-overflow.mjs` | 逐点重建 token-meter 估算 vs 真实 usage，输出比值分布与越线点 |
| `simulate-range.mjs` | 在真实 surface 上模拟 `selectCompactableRange`，判定 null/合法区间 |
| `check-fold.mjs` | 校验 token-meter `_foldEvent` 的三条硬约束（step 配对） |
| `scan-frames.mjs` | **逐帧**解码全机 670 个 `.zstd` 会话（Node 的 `zstdDecompressSync` 只解第一帧，必须按 magic 拆帧） |
| `analyze-final.mjs` | 单会话 compaction 事务追踪 + usage 曲线 + request/context 对比 |

> ⚠️ 踩坑记录：`session.v4.jsonl.zstd` 是**追加式多帧**格式（670 个文件共 161,114 帧）。
> 直接 `zstdDecompressSync()` 只解出第一帧（会话头 ~250 字符），会得出「全机零 compaction」的错误结论。
> 必须按 `28 b5 2f fd` magic 拆帧后逐帧解压。

---

## 7. 一句话给用户的解释

> 你看到的报错不是「模型装不下」，而是**插件把 1M 窗口的模型报成了 200K**。
> 模型照常在 34 万 token 上正常工作并返回结果，pi-ai 拿我们自己报的 200K 去比，判成溢出把结果丢了。
> 同一个会话里换成申报 1M 的兄弟插件就一切正常 —— 这就是证据。
