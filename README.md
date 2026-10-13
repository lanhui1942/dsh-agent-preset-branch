# dsh-agent-preset-branch

从**任意已完成轮次**把会话分支到一个**新模式**。

> **DSH cannot change a session's Agent preset once a turn has run**, and its built-in fork always inherits the parent's mode. This plugin closes that gap: the title-bar mode label becomes a menu, and a **Branch mode** pill sits beside the product's own branch button under every completed reply. Pick a mode and it creates a session composed in that mode, migrating the conversation up to **the turn you chose**; a session that has not run yet switches in place. It copies the event log (not a summary) and never modifies the source session.

把会话标题栏上的 Agent 预设标签变成菜单：选一个模式，就以该模式 **新建一个会话**，并把当前会话到**你选的那一轮**为止的对话**迁移**过去。

同时，在**每轮完成对话下方的操作行里、产品自带的分支按钮旁边**多出一个**模式胶囊**：展开后列出可选模式，**点某个模式就直接以该模式建立分支会话**（一次点击，一次提交，沿用同一套迁移逻辑）。

> 说明：本插件**不做分叉（fork）**。DSH 自带的分叉必然继承父会话的模式（`SessionForkRequest` 根本没有 `agentPreset` 这个字段），而"换个模式继续"需要的是新模式 + 旧内容，所以走的是"新建 + 迁移"这条路。

和它的前身 `dsh-agent-preset-select` 的区别只有一处，但正是你要的那处：

| | 前身 | 本插件 |
|---|---|---|
| 已开始的任务 | 以该模式**新建一个空会话** | 以该模式**新建会话并迁移已有对话** |
| 未开始的任务 | 就地切换模式 | 就地切换模式（不变） |

## 两个入口

| 入口 | 位置 | 交互 |
|---|---|---|
| 标题栏模式菜单 | `conversation.session.header.actions` 的 `agent-preset` 格子 | 先选模式，再点卡片底部那一行提交（未开始的会话是就地切换） |
| 回合底模式胶囊 | `conversation.chat.assistant-actions` 的 `branch-mode` 格子，紧挨产品自带的分支按钮 | 展开即列模式，**点模式就建立分支会话**，没有第二步 |

两者用的是同一个引擎、同一条路由、同一套成功与失败的文案。

## 为什么不能走"分叉 + 改模式"

DSH 自身的两道结构约束决定了这条路走不通：

1. **模式在第一次 turn 之后就锁死。** `agent-preset-registry` 的 `select()` 会检查 `turnBoundary` 投影，只要 `openTurnStartSeq !== null || lastTurn > 0` 就抛 `agent-preset/locked`，而 `lastTurn` 永不回退。
2. **分叉必然继承父会话的模式。** 会话控制器的 `fork` 命令是这样组装子会话的：

   ```js
   const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
   ```

   `SessionForkRequest` 只有 `{ sessionId, atSeq }`，**没有 `agentPreset`**；而 `turnBoundary` 投影会把**继承来的** turn 也算进去，所以"先分叉、再切成新模式"同样被第 1 条拒绝。

结论：模式必须在**会话被组装的同一刻**定好，而内容必须以**种子**的形式同时交给那次组装。宿主自己的 `session.create({ agentPreset })` 已经能做前半句，缺的只是把对话灌进去——本插件把这两半合并成一次调用。

## 它怎么做到的

宿主端顺序（`core.js`，可单测）：

1. `agentPresets.resolve(目标模式)` —— 先把模式解析出来，写错了就不会留下半个会话；
2. `sessionQuery.observeSession(源会话)` —— 读出源会话的头与完整事件日志。这是一份**只读租约**，结束时会释放，源会话全程不被写入；
3. 计算迁移切点：**最后一个完成的回合**，外加它之后任何独立事件（`turn/end` 之后遇到新的 `turn/start`／追加的 `user/message`／inbox splice 就停）。没有完成过的回合 → 直接拒绝，并告诉用户"先跑完一轮"；
4. `buildForkSeed(events, 切点)` —— 宿主的种子构造：复制这段前缀 + 打上继承标记。
   **它不是静态 import**：插件目录在 Node 解析不到 `node_modules` 的位置（profile 通过目录联接指过来），静态裸包名会在加载期抛错；所以它是**动态加载**，解析不到时用同形状的本地实现兜底；
5. **一次 `ctx.agents.create`** 同时给出：`seed`（迁移的对话）、`inheritedEventCount`、`meta: { cwd, parentSession, isSeeded: true, agentPreset: 目标模式 }`、`agentOptions`（沿用源会话的模型），以及 `setup: (agentCtx) => agentPresets.mount(agentCtx, 目标模式)`。子会话因此是**以选中的模式组装出来之后**才发布的——工具层与提示词段落都按该模式构造，**不是发布后再换**（发布后再换对这两者无效，这正是之前"分了但模式还是标准"的原因）；
6. `workspace.attachSession(新会话)`（用 `workspaceRegistry.list()` 找源会话所属的 Workspace，subagent 则沿血缘上溯），把新会话放在原会话旁边；
7. `sessionController.rename(...)` 套上原标题；改名失败**不会**丢掉已建好的会话，只在响应里如实报告；
8. 收尾核对新会话实际跑的模式（`agentPresets.composedPreset(agentCtx)`），不一致就写进宿主日志 —— "新建出来了但模式不对"是这功能唯一会藏起来的故障，所以它被记下来而不是被假设掉。

## 交互

标题栏模式菜单：

- 点标题栏的模式胶囊 → 平铺的模式列表（名称 + 该模式自己的说明），选中项在名称行行尾打勾；
- **点某一行只改变选择，不提交任何东西**（也不会动这个会话）；选中项的勾与底部那一行的文案就跟着变，卡片保持打开；
- 底部那一行是唯一的动作，且随会话状态变：
  - **任务还没开始**（一次都没跑）→ 「切换为「某某模式」」，就地切换，走注册表官方的切换路径；
  - **已经跑过至少一轮** → 「以「某某模式」新建会话」，新建一个该模式的会话、把对话迁移过去、沿用原标题、落到同一个 Workspace，然后跳过去；
- 任何拒绝都在 Toast 里原样给出宿主或本插件的理由。

回合底模式胶囊：

- 位置：完成回合的操作行里、**产品自带的分支按钮左侧**（操作行是「复制 / …扩展项 / 分支」的顺序，`assistant-actions` 槽位就是产品留给扩展项的 `extraActions` 座位，本插件在里面加一格 `branch-mode`，不占用、不替换 `feedback` 等任何已有格子）；
- **每一轮完成的对话都有自己的胶囊**，而且**从这一轮切开**：胶囊把自己那一轮的 `turn/end` 事件序号随请求发给宿主（`atSeq`），所以第 2 轮那颗胶囊建出来的新会话只继承到第 2 轮结束为止，第 3 轮之后的内容不会跟过去。历史轮与最后一轮走同一条代码路径，只是切点不同；
- 只在**该轮的收尾助手消息**那一行出现（与产品自带分支按钮的可用性一致）；没有完成回合、或该轮没有可作切点的收尾消息（例如被打断的尾巴）时那一行没有胶囊——因为没有闭合的边界可切；
- 点胶囊 → 展开模式列表：卡片**与胶囊左边缘对齐、向右展开**（与标题栏那个菜单一致；靠右时会自动收进视口）。列表里当前模式在最上面作为上下文标签，**切点也单独标一行**（「切点：第 N 轮末尾」，历史轮一眼能看出会从哪切），其余是可选项；
- **点某个模式 → 立刻以该模式建立分支会话**并跳过去：新会话以该模式组装、继承到该切点为止的对话、沿用同一个 Workspace；没有第二步确认，卡片随选择关闭；
- 提交期间胶囊变为「正在以「某某模式」新建会话…」并禁用，防止连点建出两个会话；
- 胶囊与标题栏菜单共用成功/失败文案：成功了说清新会话**实际报告的模式**（记录/组合不一致会明说），切在历史轮时还会说明是从哪一轮迁移的；失败了照抄宿主或本插件给出的理由。

## 外观

控件不是照截图仿的，而是用产品自己的零件画的：标题栏锚点沿用被替换掉的那个标签的形状与配色（22px 高、12px 字号、tertiary 文字色、hover 才吃 `--dsw-alias-interactive-bg-hover`）；回合底胶囊是同一套尺寸、胶囊圆角、`--dsw-alias-bg-layer-2` 底、内嵌模式图标 + 「分支模式」+ 下拉箭头；弹出卡片都是内置 `Menu` 原语（同一张卡面、行高、键盘走位、点外关闭），提示是内置 `Toast`，颜色圆角阴影全部是设计系统 token，明暗主题自动跟随。依赖随 DSH 分发的 `@deepseek-ai/dsh-client-ui-primitives`，声明在 `dsh.client.external`。

## 组成

| 文件 | 作用 |
|---|---|
| `host.js` | 宿主端：在 `ctx.webServer` 上挂同源路由，把拒绝映射成 HTTP 状态 |
| `core.js` | 迁移引擎：整条新建+装配顺序，协作方注入，可脱离宿主单测 |
| `client.js` | 浏览器端 bundle：标题栏控件、回合底模式胶囊与文案表 |
| `cordis.patch.yml` | bundle 挂载声明 |

路由（`branch` 这个名字是历史沿用，它的实际行为是"新建会话并迁移对话"）：

```
GET  /dsh-agent-preset-branch/list     可选模式名册 + 默认模式
GET  /dsh-agent-preset-branch/inspect  ?sessionId=…  会话记录的模式 与 实际组合的模式 对照
POST /dsh-agent-preset-branch/branch   { sessionId, agentPreset, title?, atSeq? } → { sessionId, agentPreset, currentPreset, recordedPreset, titleApplied, atSeq, atLatest, inheritedEventCount }
POST /dsh-agent-preset-branch/switch   { sessionId, agentPreset }                 → { agentPreset }
```

`branch` 的 `atSeq` 是**可选**的：给一个完成回合的 `turn/end` 事件序号，就从那一轮切开（回合底胶囊走的就是这条路）；不给、或给的值不是日志里某个 `turn/end`（不是整数、越界、落在半轮里），就退回**最后一个完成回合**这个默认切点，并在响应里用 `atSeq` / `atLatest` 说明实际切在哪里——不会切在半轮里，也不会因为一个坏参数整单失败。

`switch` 是**未开始**会话的就地切换，走注册表官方的 `select()`；已开始的会话会被它拒绝（`agent-preset/locked`），并把用户引到 `branch`。这条路由由本插件自己提供，因此不依赖任何兄弟插件。

`inspect` 是自检口：它把**会话记录里的模式**（`recordedPreset`，来自会话日志里的 `agent-preset/selected` 事件或头部 —— 这正是模式徽标和以后恢复会话所读的东西）与**当前实际组合的模式**（`composedPreset`，决定下一轮的工具与提示词）分别报出来，并给出 `agrees`。"新建出来了但模式看起来没换"这类问题，一眼就能定位是哪一侧不对。新建会话时这两侧都会被写：`agentPresets.recompose()` 负责实时组合（它还会发出 `tools/change`），随后把选中的模式作为 `agent-preset/selected` 追加进会话日志，让**持久记录**与实时组合一致。

失败码与状态：`bad-request` 400、`agent-preset/not-found` 404、`nothing-to-branch`／`branch-failed`／`branch-incomplete`／`agent-preset/unavailable`／`agent-preset/locked`／`agent-preset/refused` 409、`unavailable` 503。

## 安装

三种方式，任选其一。装完 **宿主端插件需要重启 DSH**（浏览器端 bundle 会热更新，`host.js` / `core.js` 不会）。

**1. 从打包好的 tarball 安装**（推荐分发给别人时用）：

```bash
dsh plugin --profile <profile> add <dsh-agent-preset-branch-1.1.0.tgz 的绝对路径>
```

也可以把同一个 `.tgz` 路径粘进「设置 → 插件」的安装输入框。

**2. 直接指向本目录**：

```bash
dsh plugin --profile <profile> add <本目录绝对路径>
```

**3. 手工登记一条本地依赖**（本机的安装方式）：在 profile 的 `package.json` 里

```json
"dsh-agent-preset-branch": "link:<本目录绝对路径>"
```

并把它加进 `dsh.profile.bundles`，然后重启 DSH。**`link:` 而不是版本号**很关键：版本号会让 pnpm 去 registry 找这个包（本地自建插件不在 registry 上），从而卡死所有插件的更新。

### 打包

```bash
npm pack        # 生成 dsh-agent-preset-branch-<version>.tgz
```

`package.json` 的 `files` 已列全运行所需的 6 个文件（`host.js`、`core.js`、`client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`），没有构建步骤，也没有 `dependencies` —— 它只把随 DSH 分发的 `@deepseek-ai/dsh-client-ui-primitives` 声明为 `dsh.client.external`。

## 与其它模式插件的冲突

标题栏那个格子是 `conversation.session.header.actions` 里 id 为 `agent-preset` 的一项，列表槽位按 id 选出一个赢家、`priority` 最小的胜出。本插件用 priority -1 顶掉产品自带的只读标签；**任何同样抢这个格子的第三方插件（例如它自己的前身 `dsh-agent-preset-select`）都只会显示其中一个**，而且赢家不一定是你要的那个。装本插件时请把前身从 profile 的依赖与 `dsh.profile.bundles` 里一起摘掉。

回合底那个格子是**新增**的：`conversation.chat.assistant-actions` 里 id 为 `branch-mode`、`order` 20，不会顶掉产品自带的复制/分支图标，也不会顶掉别的插件（例如消息反馈的 `feedback`，order 10）——列表槽位按 id 各自成格，新的 id 就是加一格。

## 验证

`../verify-agent-preset-branch.mjs`：迁移引擎的正常路径（调用顺序、切点、种子形状、meta、Workspace 归属、模型沿用、没有走 `fork`）、可选切点（历史轮切在哪里、不可用切点如何退回默认）与全部拒绝路径、拒绝→HTTP 状态映射、客户端契约（含模式胶囊这一格的槽位注册与切点解析）。跑法：

```bash
node ../verify-agent-preset-branch.mjs
```

## 已知边界

- 迁移切点是**一个完成回合的末尾**：标题栏菜单固定用最后一个完成回合，回合底胶囊用它自己那一轮的 `turn/end`。整段对话一轮都没跑完时没有可迁移的内容：本插件拒绝并提示"先跑完一轮"，未开始的会话则降级成就地切换模式。
- 切点**只认完成回合的 `turn/end`**：`atSeq` 给的任何其它序号都会退回默认切点，因为种子不带补尾事件，切在半轮里会把一个没写完的回合交给新会话。
- 切在历史轮时，**那一轮之后的独立事件**（例如 `turn/end` 之后、下一轮之前的记账类事件）不会跟过去——它们描述的是后面发生的事。
- 迁移的是**对话事件前缀**（用户/助手消息、工具调用与结果），不是整个会话对象：旧会话不会被改动，新会话从切点之后独立发展，两者此后互不影响。
- 宿主端用到的接缝有：`ctx.agents.create`（公开服务方法）、`agentPresets.mount`（注册表公开方法，独立插件 `dsh-webhook` 有同样用法）、`sessionQuery.observeSession`、`workspaceRegistry`、以及 `tools/change` 信号。它们都不是"生成式 Remote 目录"里承诺的跨版本 API：DSH 大版本升级后若签名变化，宿主端需要跟着改；客户端与路由契约不受影响。
- `@deepseek-ai/dsh-session/fork` 是**动态**加载的：插件目录位于 Node 解析不到 `node_modules` 的位置（profile 通过目录联接指过来），静态裸包名会在加载期抛错；解析不到时用同形状的本地实现兜底，功能不受影响。

## 它对你做了什么 / 不会做什么

装插件就是把代码交给 DSH 主进程运行（本插件也不例外），所以这里把边界写清楚，你可以自己核对源码：

**它会做的**

- 在 `ctx.webServer` 上挂 4 条同源路由（`list` / `branch` / `switch` / `inspect`），都做同源校验、请求体上限 8 KB；
- 读源会话的事件日志（`sessionQuery.observeSession` 的**只读租约**，读完立刻释放）；
- 调 `agents.create` 建**一个新会话**，并把它挂回源会话所在的 Workspace；
- 把新会话的标题改成源会话的标题（仅此一次 `rename`）。

**它不会做的**

- **不改源会话**：全程只读，没有对源会话的 `append` / `rename` / 删除，旧会话一个字节都不动；
- **不删任何东西**：插件没有任何删除会话/工作区的代码路径；
- **不切在半轮里**：切点只认完成回合的 `turn/end`，给别的序号一律退回默认切点，绝不会把没写完的回合交给新会话；
- **不建跑不动的会话**：读不出该用哪个模型就直接拒绝并给出可读理由，而不是建一个第一轮必炸的会话；
- **不联网**：没有对外请求，没有遥测，只监听你自己这个页面（同源校验）；
- **一次点击只建一个会话**：提交期间胶囊禁用，防连点。

**两个真实副作用**（不是错误，但你应该知道）

- 每次分支都会给新会话**复制一份事件日志前缀**，所以会话磁盘占用会随分支次数增长；
- 新会话**沿用源会话的标题**，所以侧栏里可能出现同名会话（可以自行改名）。

## 许可

[MIT](LICENSE) © 2026 lanhui1942

仓库：<https://github.com/lanhui1942/dsh-agent-preset-branch> · 问题反馈：<https://github.com/lanhui1942/dsh-agent-preset-branch/issues>

