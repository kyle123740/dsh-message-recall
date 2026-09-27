# dsh-message-recall

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 会话里的**每一条消息**加上「撤回 / 删除」：鼠标悬停到任意一条消息上，右上角浮出一组小按钮。

[English](./README.en.md) | 中文

```
你的提问      [ 撤回 ]  [ 删除 ]  [ 删除此处及之后 ]
AI 的回复                [ 删除 ]  [ 删除此处及之后 ]
工具调用行               [ 删除 ]  [ 删除此处及之后 ]
```

- **就地生效**：不 fork、不新建会话、不换窗口。
- **真删**：被删内容同时从**模型上下文**和**界面**消失，刷新、重启之后仍然不在。
- **不破坏日志**：DSH 的会话日志是 append-only，本插件用的是官方 compaction 的同一套机制（见「工作原理」）。

## 三个动作

| 动作 | 适用范围 | 行为 |
| --- | --- | --- |
| **撤回** | 只限**你自己发出**的消息（含运行中插话 steering） | 该消息从模型上下文与界面移除，**原文自动回填输入框**，改好可直接重发。原位留一行「你撤回了一条消息 · 原文预览」，带「重新编辑 / 复制原文」。 |
| **删除** | 任意一条消息（AI 回复、工具行都能删） | 删 AI 回复时**连带它这一步的工具结果**一起删 —— 一个 step = 一次模型调用 + 它请求的工具执行；只删一半会让下一次请求因 call/result 配不上对而报错。点工具行会反查到它所属的那条回复，一起删。属危险动作，需**点两下**确认。 |
| **删除此处及之后** | 任意一条消息 | 从这条起截断到会话末尾，就地清空后半段。 |

## 适配版本

| | |
| --- | --- |
| **实测通过** | DSH **0.1.7** 线 —— 桌面版 core `@deepseek-ai/dsh-base 0.1.7-rc.2`，插件解析到的 peer 包 `0.1.7-alpha.2`，Node 22.23 |
| **声明下限** | `dsh >= 0.1.7-alpha.1`（写在 `package.json` 的 `dsh.engines.dsh`，宿主安装时会拿它做兼容性拦截） |
| **未验证** | 0.1.6 及更早。不是「已知会坏」，是没测过，所以不放行 |

查你自己的版本：

```bash
dsh --version
```

本插件依赖的宿主接口，升级 DSH 后若功能异常，先对照这几处：

| 接口 | 用途 | 可用性 |
| --- | --- | --- |
| `Session.append("user/message", …, { surfaceOp: { op: "replace", … }, sourceEventSeqs })` | 写墓碑 | dsh-session 0.1.x 起（与官方 compaction 同源机制） |
| `isReplacementSurfaceEvent`，子路径 `@deepseek-ai/dsh-session/surface` | 区分替换事件 | 同上 |
| `agent.runMaintenance` | 与正在执行的 step 抢锁 | dsh-agent 0.1.x |
| `webServer.register({ kind: "exact" })` | HTTP 路由 | dsh-host-webserver |
| 座位 `conversation.input.overlay` | 客户端无头挂载点 | dsh-client-ui-conversation 0.1.7 |
| DOM 标记 `data-chat-flow` / `-key` / `-kind` / `data-chat-turn` | 行装饰与遮蔽 | 0.1.x（`data-chat-turn` 自 rc.6 起就被社区插件依赖） |
| `ctx.sessions.binding(id).eventSource` | 读墓碑 | 0.1.7 面；代码保留 `sessions.get(id)` 回退到旧面 |

一个真实的跨实例事实：插件的 peer 包与宿主 core **可能不是同一份模块实例**（本机就是 0.1.7-rc.2 的 core 在跑 0.1.7-alpha.2 的包）。之所以安全，是因为本插件只碰**结构化数据** —— `createUserMessage` 产出的是普通冻结对象，surface 校验走 JSON 而不是 `instanceof`。如果你的环境报 peer 不兼容，别去硬改 `engines`，先跑一遍 `npm test` 看接口还在不在。

## 安装

在 DSH 内置终端（或任意能跑 `dsh` 的终端）里：

```bash
# 桌面版
dsh plugin --profile desktop add github:kyle123740/dsh-message-recall

# 网页版
dsh plugin --profile web add github:kyle123740/dsh-message-recall
```

想固定版本（可复现安装）就带上 tag 或 commit：

```bash
dsh plugin --profile desktop add github:kyle123740/dsh-message-recall#v0.1.0
```

安装后**重启该 profile 一次**（Host 半边要重新 import），界面刷新一次（Client 半边要重新取 bundle）。开关也可以随时在「设置 → 插件」里拨动：

```bash
dsh plugin --profile desktop disable dsh-message-recall
dsh plugin --profile desktop enable  dsh-message-recall
```

> 插件以当前 DSH 进程的权限运行，安装时可能执行代码。装之前请先看源码与许可。

### 卸载

```bash
dsh plugin --profile desktop remove dsh-message-recall
```

拔除不残留状态：墓碑只是普通日志事件，卸载后那些位置不再显示占位行，会话照常可读。

## 工作原理

1. 定位这条消息在当前 **surface**（模型可见上下文）里的位置；
2. 追加一条**空的 `user/message` 墓碑事件**，带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 与 `sourceEventSeqs: [被遮蔽的 seq]`；
3. surface 是派生模型历史的唯一来源（`Session.deriveMessages`），所以被遮蔽的内容**下一次请求就不会再发给模型**；
4. 原始事件仍留在日志里；重新打开会话时靠重放 `foldSurface(events)` 得到完全一致的 surface —— 删掉的东西不会「复活」。

两个关键细节，都是这个插件踩过之后才写明白的：

**空内容的 `user/message` 不会进入请求。** `dsh-llm-deepseek` 编码层有 `if (message.role === "user" && content.length === 0) continue;`，所以墓碑本身不占上下文，也不会给模型留下「（此消息已删除）」这类噪音。

**surface 不是转录本。** `dsh-session` 的注释写得很清楚：surface 刻意遮蔽被替换的区间，那是**模型视图**；人类转录本要的是 append-origin 事件，否则一次替换就把用户已经读过的对话凭空抹掉。所以「从模型上下文里删掉」**不会**自动让界面行消失。行的隐藏由客户端从墓碑的 `source.removed` 推导：

- 单条撤回/删除 → 只隐藏那段 span（含交错在段内的日志行）；
- 删除此处及之后 → 隐藏从目标起、到那条墓碑事件为止的区间（`turn-error`、`已重试模型请求`、轮次操作栏这些 log-only 行一并消失），**墓碑之后新发的内容不受影响**；
- 状态完全从日志推导，所以刷新、重启、以及安装插件之前就已存在的墓碑，都会一致生效。被隐藏的行带 `data-mcr-hidden` 标记，只还原我们自己隐的，绝不碰官方自己的 `hidden`。

界面侧不 shadow 任何官方渲染器：它挂在 `conversation.input.overlay`（一个 session 作用域的无头座位）上，按官方 DOM 标记 `[data-chat-flow]` / `data-chat-flow-key` / `data-chat-flow-kind` 给行加按钮。**只有能在本会话 Chat store 里解析到持久消息的行才会被装饰** —— 所以侧栏里另一条会话的对话流不会被误加按钮，也不可能误操作别的会话。

## 边界与注意

- **Agent 正在跑时不能改**：按钮不出现；即使绕过界面直接打接口，Host 也走 `agent.runMaintenance`，忙时立刻回 `423 AGENT_BUSY`，而不是悄悄排队。
- 删完整轮后，那一轮可能只剩 `turn/start`/`turn/end` 投影出来的空操作栏（它们是日志事件，不在 surface 里）；插件会把这种孤栏 `hidden` 掉，占位说明留在原位。那一轮若还有别的内容，操作栏保持不动。
- 被**压缩**过的历史（compaction 之后的旧轮次）其 surface 节点已被折叠，无法单独删除；插件会明确报「这一步与其它内容交错（可能已被压缩）」，而不是悄悄做一半。
- 系统提示（surface node 0）永远不能撤回或删除。
- **撤回/删除不可撤销**：日志里原文还在（必要时可读会话日志手工找回），但界面与模型上下文里不会再出现。
- 只处理当前会话的行。子 Agent 会话窗口同样会显示按钮，但操作对象就是那条被打开的会话。

## HTTP 接口

给二次开发用。注册在 `webServer` 上的精确路由，无需 Typert：

```
POST /dsh-message-recall
Content-Type: application/json

{ "sessionId": "session-…", "action": "recall" | "delete" | "deleteFrom",
  "seq": 42 }            // 或 "messageId": "…"
```

响应统一是 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。

| code | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | 参数缺失或 action 未知 |
| `AGENT_BUSY` | 423 | 该会话的 Agent 正在干活 |
| `SESSION_NOT_LIVE` | 409 | 会话当前没有活着的 Agent（先在界面打开它） |
| `TARGET_NOT_FOUND` | 409 | 目标不在当前 surface（已删/已压缩/尚未落盘） |
| `NOT_A_USER_MESSAGE` | 409 | 试图撤回非本人消息 |
| `NOT_DELETABLE` | 409 | 目标是系统提示 |
| `SPAN_NOT_CONTIGUOUS` | 409 | 该步与其它内容交错，无法原子删除 |

## 开发

```bash
npm install            # 拉 peerDependencies（dsh-session / dsh-llm）
node scripts/verify.mjs          # Host：真实 dsh-session 上的墓碑、整步展开、截断、守卫 + HTTP 端到端
node scripts/verify-client.mjs   # Client：最小 DOM 桩跑通行装饰、两下确认、错误本地化、占位行、语言切换
```

`verify.mjs` 里最值钱的两条断言：

- `foldSurface(events).nodes === session.surface.nodes` —— 日志重放与实时 surface 完全一致（保证「重启后不会复活」）；
- 用真实 `Session` 对象打 `handleRecallRequest`，核对 200/405/409/415/423 信封。

改完客户端代码要注意：**Host 在插件挂载那一刻就把 `lib/client.js` 的字节读进内存**，光改文件不会让页面拿到新版；需要 disable + enable 插件（或重启），再刷新界面。仓库里为此埋了版本戳，加载时会在 Console 打一行 `[message-recall] client bundle <BUILD>`。

### 服务器到底在发哪一版

界面跑的是哪份 bundle 容易争。Host 用 combo 形态 serve 插件客户端：

```
GET /plugins/??dsh-message-recall/client.js&rev=<rev>
```

`rev` 是 `sha1("plugin-artifact" \0 len:mtimeMs len:ctimeMs len:size)` 的前 12 位（`dsh-client-modules` 的 `artifactRevision`），只取 `lib/client.js` 的文件元数据，不哈希内容。所以「改了文件但页面没变」有两种完全不同的原因 —— Host 没重读（rev 还是旧的），或页面没重载（rev 是新的但浏览器拿着旧的）。用文件 mtime/ctime/size 自己算出 rev 打这个 URL，返回体里的 `const BUILD = "…"` 就是服务器正在发的版本；和页面 Console 里那行版本戳一比就分清了。

### 出问题时先看这个

界面 Console 里跑：

```js
JSON.stringify(window.__MCR_DEBUG__, null, 1)
```

这是每次同步后留下的快照，直接回答三个问题：墓碑事件有没有从日志读回来（`notes`，含 `startSeq/endSeq/removed`）、每行解析到的持久 seq 是多少（`rows[].anchor`）、它有没有被判成遮蔽（`shadowed`）。提 issue 时把这段贴上来，基本一眼定位。

**遮蔽的权威来源是墓碑事件自己的 `surfaceOp.startSeq/endSeq`**，不是插件写在 `source` 上的自定义字段 —— 历史分页是日志的再编码投影，自定义字段属于「可能被动到」的那一类。早期版本只信 `source.removed`，于是出现了「点完当场生效、重启后内容又回来」这种**只在重载路径上发作**的现象（v0.1.1 修掉，并加了回归用例）。

### 目录

```
lib/main.js            Host：路由 + 墓碑写入
lib/client.js          Client：手写 window.__ModuleLoader__ bundle，无需构建
cordis.patch.yml       注册 message-recall 行
scripts/verify*.mjs    离线自检
```

## 致谢

设计时参考了社区里几件相邻的活儿：[dsh-turn-hard-delete](https://github.com/shuanzhe/dsh-turn-hard-delete)（整轮硬删，同样走 `surfaceOp` 替换）、[dsh-rewind](https://github.com/SiriLee/dsh-rewind)（同窗口回退 + 工作区还原）、`dsh-plugin-session-delete`（会话级删除）。本插件的差异点是**逐条消息**粒度、按 step 自动展开保持 provider 配对、以及从日志推导的界面遮蔽层。

## 许可

MIT
