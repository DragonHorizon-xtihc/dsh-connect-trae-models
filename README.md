# DSH Connect Trae Models

多账号 Trae 模型池插件：把本机所有 Trae 登录态聚合成 DeepSeek Harness 里的**一个模型供应商**，
请求在账号池内自动容错换号，并配套手动/自动签到、模型倍率显示、账号使用方式切换（自动轮转 +
手动钉号）与可选模型配置页面。

装上之后，模型选择器里会出现两个分组：**Trae Connect Models（国内版）** 和
**Trae Connect Models（国际版）**（provider id `connect-trae-models` / `connect-trae-models-global`）。

> **和单账号连接插件的区别**：`dsh-connect-trae` 是「一次一个账号」。本插件把**多账号当默认情况**
> —— 不挑号、不手动导入，本机 Trae 所有历史登录快照全部收进一个共享池，对外用一个 provider 分组，
> 池内自动容错。

---

## 功能

### 一、多账号池：自动换号，也手动钉号

池子走**自动发现**：Trae 桌面端每次登录都会在本机留下一个带令牌的快照，本插件扫描
**四个 Trae edition × 三个平台 + CLI home** 的候选路径，把每个账号都收进池。所以
**多账号 = 在 Trae 客户端里换着登几次**，之后点卡片上的「重新检测账号」或重启 DSH，新号就自动进池。

探测的客户端（凭据只读，插件从不索要你的密码）：

| Edition | macOS / Linux | Windows（取自 `product.json` 的 `win32DirName`） |
| --- | --- | --- |
| 国内 | `Trae CN` | `Trae CN` / `trae-cn` |
| 国际 | `Trae` | `Trae` |
| SOLO 国内 | `TRAE SOLO CN` | `TRAE SOLO CN` / `trae-solo-cn` |
| SOLO 国际 | `TRAE SOLO` | `TRAE SOLO` |

另加 CLI 令牌文件（`$HOME/.trae-cn/trae-jwt-token`、`$HOME/.trae/trae-jwt-token`）作为兜底候选。

**账号使用方式（自动）** —— 卡片上「账号使用方式」下拉，五种：

| 方式 | 行为 | 适合 |
| --- | --- | --- |
| 优先（默认） | 一直打同一个号，直到被限流或积分耗尽才换下一个 | 单号额度大、想尽快用完一个 |
| 轮换 | 连续请求依次轮过每个号，花费均摊 | 多个号额度差不多，想均匀消耗 |
| 均衡 | 随机，按闲置时长加权 | 有一个号不稳定时，不让它把整池拖住 |
| 粘性 | 一个对话固定一个账号，新对话才换 | **想保住 prompt 缓存命中率**（上游缓存按账号隔离，对话中途换号会整段作废） |
| 到期优先 | 先花快要过期的积分 | 有临期积分包，别让它作废 |

**账号使用方式（手动）** —— 对话栏积分面板里点「切换用户」钉住某个账号，或点
「使用自动轮转」取消钉选。钉选只改本机派活顺序，不改上游状态、不写凭据；钉到一个
不在池里的账号会被拒绝（否则请求会一直等一个永远不会被派活的号）。

**自动与手动的关系**：手动钉号只影响「下一次该谁上」，**不关掉自动容错**。钉住的号一旦
被限流、欠费或登录失效，`shim` 会在**同一个请求内**换号重试，429 不会以「对话失败」的形式
到达用户。

### 二、签到：手动与自动

**手动签到**：卡片每个账号行一个「立即签到」按钮，四态区分得很死：

| 状态 | 按钮 | 含义 |
| --- | --- | --- |
| 可领取 | 可点 | 「可签到领 N 积分」 |
| 账号级已领 | 禁用 | 这个账号今天的奖励已到账 |
| 设备级已用 | 禁用 | **这台机器**用掉了今天的名额（很可能是为别的账号用的） |
| 活动未开启 | 禁用 | 上游当前关闭签到活动 |

> 账号级与设备级刻意分开。`didCheckedIn`（设备级）当成「今天签过了」是一个已发生过的缺陷——
> 切换账号后按钮变灰，而新账号其实一分未得。

**自动签到**：卡片「积分自动化」区一个总开关（写进 settings，改完立即生效）+「立即运行」。
默认**关闭**；开启后按北京时区的小时表跑（默认 `9`，可改成多个小时）。

- 只自动**签到**这一件事。其它 Trae 奖励需要客户端里的真实活动，插件不假装能做。
- 不跳过冷却中的账号：签到走独立的 `pay/ug` 端点，不该被对话路由的 429 连坐。只跳过
  用户手动禁用和 `ai` 区域的账号。
- 每日收益有账本：今日赚到多少、逐账号明细、触发过的时段数，都会写进 `automationEarnings`。

### 三、模型与倍率

- **模型名册**优先取上游网关的实时列表；上游离线时回退内置静态名册，保证 provider
  永不为空（国内 4 个 + 国际 7 个模型）。卡片上会标明当前名册是「来自网关」还是「内置回退」。
- **倍率画进模型名**：`DeepSeek-V4-Pro · x0.08` 这种写法，和 Trae 自家选择器一致。
  卡片「模型管理」区逐模型显示 `x{倍率}`，`multiplier === 0` 的显示「免费」。
- **模型管理**：逐模型开关「启用」、打开「图像输入」、设「上下文预算」（上限只能是上游
  宣告的原生窗口，**绝不虚构更大的数**）。保存只影响当前区域，另一个标签页各自一份。
- **上下文窗口**每个模型都必有值——缺了会让 DSH 以 `INVALID_MODEL_CONTEXT` 拖垮整条路由。

### 四、积分包到期提醒

三种状态刻意分开，**不把「还没看」当成「马上到期」**：

| 情况 | 展示 |
| --- | --- |
| 有包 ≤3 天到期 | 橙色「N 天后到期 · 剩 M 积分」，合计旁另加汇总徽标 |
| 有包 3 天以后到期 | 弱色只报到期时间（不告警） |
| 所有包都已过期 | 灰显最近一笔「已于 … 过期」 |
| 没有任何带 `end_time` 的包 | 明说「没有带截止时间的积分包」，绝不误报 |

---

## 安装

前置条件：装好 **Trae 客户端**并登录（插件复用它存在本机的登录态，从不索要密码）。
多账号 = 在客户端里换着登几次。

**方式一：从 npm 安装（发布后可用）**

```sh
# dsh 不在 PATH 时，用 node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js 代替 dsh
dsh plugin --profile desktop add dsh-connect-trae-models
```

> 推荐 npm：需要拉取的依赖只有插件自己（**1 个包，几秒搞定**）。从 GitHub 源码装会连带装
> 开发依赖（构建器、测试框架等几百个包），慢得多。

**方式二：从本地源码安装（开发者）**

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-connect-trae-models
```

> 本地路径必须是**绝对路径**（宿主会拒绝相对路径）；`file:` 与 `link:` 前缀都等价于绝对路径。
> 这种装法是软链到工作目录，改完 `pnpm build` 再重启 DSH 就生效，不需要反复重装。
> **`dsh plugin add` 用的是包名，不是目录名。**

**方式三：从 Git 仓库安装**

```sh
dsh plugin --profile desktop add github:<owner>/dsh-connect-trae-models
```

也接受 `gitlab:` / `bitbucket:` / `gist:` 简写、完整 git URL、`https://` 仓库地址，
以及 `.tgz` / `.tar.gz` tarball。**注意**：插件的 `.gitignore` 故意**不忽略 `lib/`**，
构建产物随源码提交，所以从仓库装不需要任何安装期脚本，也不会弹 pnpm 那句「构建脚本被拦截」。

**手动注册 bundle**（一般用不到）

`dsh plugin add` 会自动把带 `dsh.bundle.patch` 的包装进 profile 的 `bundles`。
只有在你手工编辑过 profile、或装的是一个不带 bundle 元数据的包装时才需要手动补：

```sh
# 编辑 ~/.dsh/profiles/desktop/package.json，
# 在 "dsh" → "profile" → "bundles" 数组末尾加上 "dsh-connect-trae-models"，然后重启 DSH
```

Web / TUI profile 同样可用（`--profile web` / `--profile dsh-tui`）。

**本地构建**

```sh
npx pnpm@11 install --config.confirmModulesPurge=false --config.minimumReleaseAge=0
pnpm build        # tsdown：lib/index.js（宿主 ESM）+ lib/client.js（浏览器 CJS）
pnpm typecheck    # 宿主侧 + 客户端侧 tsc --noEmit
pnpm test         # vitest run，322 项
```

> **改了 `src/` 记得重新 `pnpm build`**——`lib/` 是提交物，用户拿到的是构建产物，不是源码。

**装完之后**

- 模型选择器里出现 **Trae Connect Models（国内版）** 与 **Trae Connect Models（国际版）** 两个分组。
- 设置面板：从**侧边栏的设置入口**打开（宿主自有入口，位置随 DSH 版本而定），导航里选
  **Trae Models** 那一栏（`row.navLabel`）。能看到池健康、每个账号的令牌/积分/签到/冷却状态，
  还有「重新检测账号」「清除所有冷却」按钮。
- 对话栏积分面板：显示当前账号可用积分，点开可钉号。

---

## 配置

配置走插件设置节（命名空间 `connect-trae-models`），在设置面板里改完**立即生效、不用重启**。

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `authFile` | 覆盖 Trae 凭据文件路径（自动探测失灵时救急） | 自动探测 |
| `cooldownMs` | 单账号 429 冷却时长（毫秒） | `60000` |
| `distribution` | 账号使用方式：`priority` / `round-robin` / `balanced` / `sticky` / `expiry` | `priority` |
| `disabledAccountIds` | 不参与轮转的账号（等同卡片上的启用开关） | 空 |
| `creditReserves` | 每账号保留积分（用完就停派活，留给手动签到） | 空 |
| `modelSelectionCn` / `modelSelectionGlobal` | 逐区域的模型选择（启用 / 图像 / 上下文预算） | 全部启用 |
| `automation.enabled` | 自动签到总开关 | `false` |
| `automation.checkinHours` | 自动签到的北京时区小时表 | `[9]` |

也可以直接写进 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "connect-trae-models": {
    "cooldownMs": 120000,
    "distribution": "sticky",
    "automation": { "enabled": true, "checkinHours": [9, 20] }
  }
}
```

> **两个区域绝不开花**：国内版与国际版走**不同的网关**，账号和积分都不通用。两个 provider
> 各服务各的名册，`ai` 账号绝不会被国内名册播种。一个区域没登录时，另一侧照常工作。

---

## 架构

五件套，数据流为「发现 → 分桶 → 换号 → 路由 → 自动化」：

```
Trae 桌面 / CLI 凭据
      │  auth.ts · paths.ts · decrypt.ts · identity.ts · refresh.ts   ← 发现层
      ▼
   pool.ts   多账号池（每区域一份冷却 / 积分 / 绑定账本）
      │  acquire(modelId, region, conversationKey) → 一个健康账号
      ▼
   shim.ts   回环 OpenAI 端点（同一请求内换号重试）
      │  POST /v1/chat/completions → 上游 chatStream
      ▼
  adapter.ts  pi-ai 路由（两个 provider 各一）
      │
      ▼
  DSH LLM seam  →  模型选择器（catalog.ts）
```

| 模块 | 职责 | 关键不变量 |
| --- | --- | --- |
| `pool.ts` | 收集全部 Trae 账号，按区域（`cn` / `ai`）分桶，维护冷却与积分账本，按 5 种方式派发账号 | 冷却分「整账号」（欠费/登录被拒）与「模型级」（429）两类；region 绝不串区 |
| `shim.ts` | 本机回环 HTTP 端点，把 pi-ai 的 OpenAI 请求转发到上游；**在同一请求内**换号重试 | 随机端口 + 进程内 secret（常量时间比较）+ Host/Origin 回环校验；池空时给可操作的错误而非笼统 401 |
| `adapter.ts` | 把 shim 装配成两个 pi-ai provider | 每模型 `contextWindow` 必有值；显示名带倍率后缀**仅供展示**，不影响路由与 wire 解析 |
| `catalog.ts` | 模型目录：上游实时名册 + 静态回退 + 用户选择/预算 | 上游离线时回退名册；窗口绝不虚构（预算只能抬到上游宣告的 Max） |
| `scheduler.ts` | 签到自动化（**唯一**的可自动写操作） | 默认关闭；不跳过冷却账号；只跳过用户禁用与 `ai` 区域账号 |
| `web-status.ts` | 卡片后端：状态、重扫账号、清冷却、签到、模型保存、启停账号、钉号、立即跑自动化 | 每个写端点都校验回环 Origin；钉到不存在的账号返回 404 |

装配入口是 `src/index.ts` 的 `apply()`：`inject = ['llm', 'settings']`，装配 core →
注册两个 provider/adapter → 挂 settings 卡片 → 应用一次已保存配置 → 后台播种目录 →
注入本机身份（`deviceId` 是签到 `x-device-id` 的判定量）→ 启动调度器。每一步失败都只影响
它自己，绝不阻断其余部分：**模型路由必须在离线上游下也能立起来**。

设置卡片兼容两条宿主线路：0.1.5 的 `settings.installSection` 与 0.1.7 的
`settings.configure({auto})`（后者把编辑广播成 `loader/volatile-update` 事件）。两条都探测，
只认一条会让另一个版本上线卡片静默消失。

---

## 已知限制

- **国内版与国际版是两套完全独立的账号体系**，不能共享账号或积分，也不能交叉派活。
- **只有签到能自动化**。Trae 的其它奖励需要客户端里的真实活动，插件不伪造。
- **SOLO edition 的 Windows 目录拼写**依据是随包发布物的 `product.json`；`Trae CN` /
  `trae-cn` 这两个拼写在真机上的命中情况只在本机验证过，装了对应版本的用户欢迎回报。
- **凭据只驻内存**。`src/` 里对文件系统的操作只有 `readFile`（读 Trae 快照）与 `readFile`（读
  应用自身 storage 取设备身份），**没有任何写入**：不写 Trae 的凭据文件，也不落盘自己的 token 副本。
  刷新得到的新 token 只活在进程内，退出即丢（下次启动重新从 Trae 快照读 + 刷新）。
- 上游的排队长度不可控：实测热门模型晚高峰排队 300+ 位、`request_wait_in_queue` 持续
  6~10 分钟，所以流读取挂起的空闲上限放宽到 15 分钟，避免「快排到了却被本地误杀」。

## 免责声明

本插件是你自己账号的自动化工具，不提供任何账号、额度或付费服务。请遵守 Trae 的服务条款，
仅在你有权访问的账号上使用。风险自担。

## 许可证

MIT（见 [LICENSE](./LICENSE)）。