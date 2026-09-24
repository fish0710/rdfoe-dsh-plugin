# M0 实测笔记（DSH 0.1.7-alpha.2）

给 M1/M2 实施者的事实与坑，均为 2026-09-23 在本仓库实测。

## 节点子代理（ctx.agents.create）

- 不调用 `agentPresets.composeFrom/mount` 时，代理的工具表为空，只有在 `setup(agentCtx)` 里 `agentCtx.tools.register` 的工具，外加进程级全局工具（如本插件的 `wf_start`），后者用 `agentCtx.tools.restrict({ deny })` 去掉。实测模型收到的工具只有 `wf_ask, wf_read, wf_write`。
- `agentOptions` 必须带 provider/model：默认 persona 模板插值 `{{model}}`，为空时第一轮即报错 `prompt variable "{{model}}" has no value`（turn/end reason=error）。M0 用 `parentAgentOptionsForDelegation(mainAgent)`；M1 应在 Config 里配置节点模型，不依赖主会话。
- 根代理（不传 parentAgent）会作为普通会话出现在侧边栏（按 cwd 分组，例如「未分组」），会打扰用户的会话列表。以子代理形式创建（`parentAgent` + `meta.parentSession/origin:'subagent'/delegationDepth`）并追加 `subagent/descriptor` 事件后，右侧栏 `dsh-resource://subagentchat/...` 可以正常打开；不加 descriptor 会显示「subagent descriptor is corrupt」。
- 但 `parentAgent` 需要主会话的 Agent 在线：`ctx.agents.get(sessionId)` 只在该会话被加载（浏览器打开过）时有值，DSH 重启后为 undefined。M1 需要"主会话不在线"时的方案：先 `ctx.agents.resume` 主会话，或建根代理但写 `meta.parentSession`（未验证 UI 行为）。
- 权限：根代理按用户默认预设写入 `workspace-write + approval ask`；`appendDelegatedPolicyOverrides` 可改成 workspace-write/read-only + never。四种组合下插件工具都未触发审批（会话日志无 approval/asked）。read-only 沙箱下 `wf_write` 仍能写文件，说明插件工具完全绕过 DSH 沙箱，边界只靠 path-guard。
- 会话日志是多帧 zstd（`session.v4.jsonl.zstd`），`zlib.zstdDecompressSync` 只解第一帧，需要按帧拆开；运行中数据可能尚未落盘。

## 前端

- `lib/client.js` 必须是 `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => {...} })` 形式，React 等只能 `require('react')` 取壳层的一份（见 tsdown.config.ts 的 PLATFORM_MODULES）。
- cordis 的 `inject` 只有"必需"语义；可选服务（uiWorkspace、sidebarRight）用 `ctx.get(name)` 在回调里取。
- 组件拿不到 ctx，要通过 `slots.register({ inject })` 传回调。
- 切换 conversation.view 只有 View 自己的 `openView` 和 header 的 `selectView`，没有对外 API；wf_start 卡片目前点击 `[data-conversation-tabs] [role=tab]` 里文字为「工作流」的按钮。DSH 升级改 DOM 会失效。
- 「工作流」标签对子代理会话、节点会话也会出现（conversation.view 是全局注册）。

## 全局收件箱（H9）

- `sidebar.panellist` 的 `id` 与 `main` 的 `key` 相同即可，侧边栏自己负责按钮、文字和选中；图标组件拿到 `{size, active}`，可以自绘徽标。程序化打开用 `ctx.get("layout").selectPanel(id)`：工作流视图里的「打开收件箱」按钮已实测，侧边栏入口同步标为 aria-current=page。
- 会话标题：浏览器端组件的标准 props 有 `useSessions`，`byId[sessionId].displayTitle` 对没打开过的会话也有值；Host 端 `ctx.sessionController.list({}, signal)` 返回 `projections.values.title`，不会 resume agent。
- 跳到某会话并切「工作流」：`uiWorkspace.openSession(id)` 打开；视图选择在该会话首次绑定时读取 `localStorage['dsh.conversation.<id>'].view`，预写 `rdfoe-workflow` 即可（实测）；本页已绑定过的会话以内存为准，需再点 tab 兜底。两者都依赖 DSH 内部实现。
- 节点显式传 `agentOptions`（如 deepseek-official/deepseek-flash）时，主会话不在线也能建根节点代理（实测）。

## 路由

- `ctx.connection.fetch.register` 的 path 需包含 `/api` 前缀，只支持精确路径（参数走 query/body），方法限 GET/HEAD/POST。
- 鉴权 cookie 在 DSH 重启后仍有效。
- 流式响应用 `ReadableStream` 即可逐行推送，监听 `request.signal` 清理订阅。

## 其它

- 隔离的 `DSH_HOME` 可以完全工作（profile、sessions、settings 都在 .dsh-dev），但 Web 默认工作区会在 `~/Documents/deepseek-harness/默认工作区` 建目录，不在 DSH_HOME 下。
- `node:sqlite` 会打印 ExperimentalWarning，不影响功能。

## 斜杠命令（/rdfoe-workflow，0.1.5-rc.2 与 0.1.7-alpha.2 均已实测）

- 正式扩展点是 Host 端 `ctx.commands.register({ name, description, input: { hint }, handler })`（包 `@deepseek-ai/dsh-commands`，两个版本 API 相同）。handler 直接在 Host 执行，不开 turn、不调用模型；结果 `{ kind: 'success' | 'error', text }` 由 DSH 自己写入 `command/run`、`command/done` 事件（已登记类型）。`commands` 是可选服务，用 `ctx.inject(['commands'], …)` 注册。
- 命令出现在 `/` 菜单里，描述即 `description`；带 `input.hint` 的命令在输入框里成为高亮 token，后面的文本作为 `rawInput` 传给 handler。
- Web 端 `conversation.chat.commandview`（keyed，key 为命令名）可以替换命令结果行的渲染。
- 坑：空白会话（还没有 `turn/start`）里，DSH 不渲染对话记录（命令结果行不可见）、不显示 View 标签、View 区域为空；成功结果也不回显到输入框。可见反馈只能自己做：浏览器端监听 `command/executed`（仅发起命令的那个页面收到），用 `sessions.scope(id).get('conversation').input.for(actx).notify(level, text)` 发输入框提示；`conversation.input.dock` 在空白会话的英雄区也会渲染，可放常驻入口；`main` 面板（`layout.selectPanel`）不依赖会话状态，可以承载工作流视图。
- 浏览器自动化实测时观察到两次：命令刚执行完立刻再输入 `/rdfoe-workflow ` 与需求，token 被输入框吞掉、只剩需求文本（此时发送会变成普通消息）。原因未查明，疑似 composer 的 consume-token 时序；清空后重新输入即正常。
