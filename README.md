# @rdfoe/dsh-workflow

RDFOE 本地工作流插件，运行在 DeepSeek Harness（DSH）上，已在 `0.1.5-rc.2` 和 `0.1.7-alpha.2` 上验证。在某个 DSH 会话里用 `/rdfoe-workflow` 或 `wf_start`，就为这个会话开启一条工作流。节点的做法借鉴 project-harness（PH）的开发流程（见下文「两种模板」）。

```
完整流程（默认）：R 需求录入 → C 需求澄清 → D 设计 ⇄ DR 设计审查 → 【H1 设计批准】→ T 任务规划 → V 验证计划 → 【H2 授权实施】→ X 实施 ⇄ Y 验证 → 【H3 用户验收】→ A 归档
小改动（--small）：S 小改动 → 【H2 授权实施】→ X 实施 ⇄ Y 验证 → 【H3 用户验收】→ A 归档
```

- 节点由插件创建的子代理执行，只能使用插件工具（`wf_read/list/search/write/edit/exec/git/ask/message/report`），看不到 DSH 原生的 bash 与写文件工具。验证子代理（Y）只能写自己的 `verification.md` 和往 `tasks.md` 追加修复任务，设计审查（DR）和归档（A）只能写自己的 `review.md` / `archive.md`，写其他路径会被拒绝。
- 【】里的三道审核只能由人拍板；AI 设计审查（DR）有阻断时只会让设计自动重做，不能代替设计批准。
- 子代理的问题、消息，编排器的审核项、防空转询问，都进入**跨会话统一收件箱**（侧边栏「收件箱」），也可以在会话「工作流」视图的收件箱页签处理；支持键盘操作。
- 右侧栏也有入口（0.1.0-beta.5 起）：顶部工具栏在「分栏 / 全屏 / 收起」左边多了「工作流」「收件箱」两个图标（收件箱带待处理数），「开始」页多了「工作流」「收件箱」两张卡片；点它们在右侧栏打开本会话的工作流（还没有工作流时是开启页）或收件箱，可以边聊边看。
- 状态存在 `$DSH_HOME/rdfoe-workflow/state.db`（node:sqlite）；git 仓库里每条工作流一个 worktree + 分支 `rdfoe/<runId>`，编排器负责提交，从不 push、从不合并。
- DSH 重启后，运行中的节点标为「已中断」，在工作流视图点「继续」即可从断点恢复。

截图见 `docs/screenshots/v2/`（旧版在 `docs/screenshots/`）。


## 快速安装（使用者）

前提：Node ≥ 22.19，本机装有 pnpm（DSH 的 `plugin` 命令靠它安装插件）。插件已在 DSH `0.1.5-rc.2` 和 `0.1.7-alpha.2` 上验证，平时用的 `npx @deepseek-ai/dsh web` 直接可用。

一行命令，把插件装进平时用的 profile `web`：

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @rdfoe/dsh-workflow@beta
```

然后重启 DSH（`npx -y @deepseek-ai/dsh web`）。启动日志里出现 `[rdfoe-workflow] loaded` 即已加载，侧边栏会多一个「收件箱」。

- **更新**：重跑上面这条命令，然后重启 DSH。工作流数据在 `~/.dsh/rdfoe-workflow/`，更新不会丢。
- **卸载**：`npx -y @deepseek-ai/dsh plugin --profile web remove @rdfoe/dsh-workflow`，然后重启 DSH。

### 怎么开启工作流

在 DSH 里选一个 git 仓库作为工作区，新建会话，然后任选一种方式：

1. **斜杠命令（推荐）**：在输入框输入 `/rdfoe-workflow <需求>` 并发送，例如 `/rdfoe-workflow 给 utils 增加一个 slugify 函数，并补上单元测试`。小改动加 `--small`：`/rdfoe-workflow --small 修正登录按钮的提示文案`（`--small` 必须紧跟在命令后面）。命令会以你的名义往会话里发一条消息（「【工作流】<需求>」加一句给模型的说明），由模型调用一次 `wf_start` 开启工作流并用一句话回复；这一轮结束后，回复下面会出现工作流卡片，点击卡片或「打开工作流」切到「工作流」视图。这样开启的会话是普通会话：会话标题由 DSH 按这条消息生成，会话留在左侧列表里，有「对话 / 轨迹 / 工作流」标签。代价是一次模型调用（外加 DSH 生成标题的一次）。`wf_start` 用的需求原文和模板取自你输入的命令，不取模型的转述。会话已经绑定了工作流时，这条命令只显示状态、不再发消息；开启过程中重复发送也不会重复开启。只输入 `/rdfoe-workflow` 不带需求：有工作流就显示状态并打开，没有就显示用法。
2. **对话里说**：「用工作流实现：给 utils 增加一个 slugify 函数」（小改动就说「用小改动工作流……」）。模型会调用 `wf_start`（参数 `template` 为 `full` 或 `small`，默认 `full`），会话里出现工作流卡片。这种方式依赖模型理解你的意图。
3. **工作流视图里的按钮**：会话发过至少一条消息后，顶部会出现「工作流」标签；还没有工作流时，这个标签页可以选「完整流程 / 小改动」、填需求，一键开启。

三种方式效果相同：一个会话只绑定一条工作流，git 仓库里会新建 worktree 和分支 `rdfoe/<runId>`。模板在开启时确定，之后不能切换；小改动节点判断不适合小改动时，会在「授权实施」审核里建议改走完整流程，这时取消这条工作流，在新会话里不带 `--small` 重新开启。

### 两种模板

节点链照搬 project-harness（PH）的流程形态：一个 PH 技能对应一个节点，人工审核设在 PH 要求用户批准的地方。节点提示词由各技能的中文说明（`SKILL.zh.md`）和共同约定（`process.zh.md`）改写而来，PH 的产物模板（`runtime/templates/sdd/*.md`）内置在插件里（`src/host/prompts/ph/`），节点写哪个文件就把哪个模板附在提示词后面。插件机制不变：worktree 与分支、`.rdfoe/runs/<runId>/<节点>/v<版本>/` 产物目录、SQLite 状态、自动提交、收件箱人审、`wf_ask`。不依赖目标仓库里的 `.agents/`，也不调用 PH 的脚本；项目里有 `AGENTS.md`、`CLAUDE.md` 或规范文档时，子代理会读取并遵守。

| 节点 | PH 技能 | 做什么 | 产物 |
|---|---|---|---|
| R 需求录入 | ph-require | 记录目标、范围、非目标、FR/NFR/AC | `requirement.md` |
| C 需求澄清 | ph-clarify | 经 `wf_ask` 逐个问清阻断决定，写澄清稿；仍有阻断时节点变为「已阻断」并在收件箱提示：回复提示消息会带着回复重新澄清，或点「按当前需求继续」 | `requirement.md`（澄清稿） |
| D 设计 | ph-design | 产品体验与实现方案 | `design.md` |
| DR 设计审查 | ph-design-review | AI 只读审查；有阻断发现就自动回到 D 重做（连续 3 次仍有阻断会暂停，问你「再改一轮 / 带着阻断交给我审核 / 终止」） | `review.md` |
| **H1 设计批准** | — | 人审需求、设计与审查；打回到 D（或 C） | — |
| T 任务规划 | ph-tasks | 稳定 T 编号的任务，单测写在任务内 | `tasks.md` |
| V 验证计划 | ph-verify-plan | 读 tasks.md 后写智能体自测计划与用户验收指引 | `verify-plan.md`、`acceptance.md` |
| **H2 授权实施** | — | 人审任务与计划（小改动审 S 的四个文件）；打回到 T 或 V | — |
| X 实施 | ph-implement | 按 tasks.md 改代码、写单测、跑检查、勾选任务；H3 打回时先把意见追加成修复任务 | 代码、`verification.md` |
| Y 验证 | ph-verify 第 1~3 步 | 智能体自测与意图核对，不改应用代码；失败时往 tasks.md 追加修复任务并回到 X | `verification.md`、`acceptance-report.md`（工作流生成） |
| **H3 用户验收** | ph-verify 第 4 步 | 审核卡片置顶展示 acceptance.md；打回回到 X，修复后重跑 Y 再请你验收 | — |
| A 归档 | ph-archive（归档摘要部分） | 交付范围、证据、用户结论（据审核记录回填）、已知限制、建议沉淀的项目事实与用例；不改项目文档，不合并 | `archive.md` |
| S 小改动（--small） | ph-small-change | 精简的需求与方案、任务、验证计划、验收指引 | `change.md`、`tasks.md`、`verify-plan.md`、`acceptance.md` |

配置迁移：`review.aiPreReview` 和 `plan.split` 已废弃（设计审查由 DR 节点承担，T 与 V 串行），写着也会被忽略。`nodes` 的模型路由按新节点 ID 配置（`R`、`C`、`D`、`DR`、`T`、`V`、`X`、`Y`、`A`、`S`）；旧 key 仍然生效：`D` → R/C/D，`P` → T/V，`X1` → X，`X2` → Y，`prereview` → DR（新 key 优先）。`personas` 只认新节点 ID。

旧版工作流（0.1.0-beta.4 之前创建）在插件启动时转为只读：工作流视图按旧节点链显示、标注「只读」，收件箱里它的待处理条目会撤回，不能继续推进。

## 在你自己的 DSH 里试用（真实模型）

插件以 DSH `0.1.7-alpha.2` 开发，也已在 `0.1.5-rc.2` 上验证。下面的步骤会新建一个独立的 profile `rdfoe`，不影响现有的 `web` profile，模型配置沿用你现在的 `~/.dsh/settings.yaml`。

**准备**：Node ≥ 22.19（推荐 24）、pnpm ≥ 10、git；启动 DSH 的终端里要有你平时用的模型密钥环境变量（和你平时运行 `npx @deepseek-ai/dsh web` 时一样）。

```sh
# 1. 构建插件（首次约 2~3 分钟，会安装 DSH 0.1.7-alpha.2 作为开发依赖）
cd ~/workspace/rdfoe-dsh-plugin
pnpm install
pnpm build

# 2. 用 0.1.7-alpha.2 从 web 模板建 profile「rdfoe」，并把插件装进去
npx -y @deepseek-ai/dsh@0.1.7-alpha.2 rdfoe --from-default-profile web --dump-config > /dev/null
npx -y @deepseek-ai/dsh@0.1.7-alpha.2 plugin --profile rdfoe add ~/workspace/rdfoe-dsh-plugin

# 3. 确认插件已经进入配置（应能看到 rdfoe-workflow 这一行）
npx -y @deepseek-ai/dsh@0.1.7-alpha.2 --profile rdfoe --dump-config | grep -A2 rdfoe-workflow

# 4. 启动（用 3090 端口，避免和正在用的 3080 冲突），浏览器会自动打开
npx -y @deepseek-ai/dsh@0.1.7-alpha.2 rdfoe --port 3090
```

启动日志里出现 `[rdfoe-workflow] loaded; db=…` 就说明插件已加载；侧边栏会多一个「收件箱」入口。

**试一次**

1. 在侧边栏「添加工作区」，选一个 **git 仓库**（建议先用一个小仓库或新建的练习仓库），在里面新建会话。
2. 在输入框里输入 `/rdfoe-workflow 给 utils 增加一个 slugify 函数，并补上单元测试` 并发送（或者说「用工作流实现：……」，由模型调用 `wf_start`），见上文「怎么开启工作流」。
3. 点卡片上的「打开工作流」（或切到会话顶部的「工作流」标签；会话里还没有工作流时，这个标签页也可以直接输入需求一键开启）：流程图显示各环节状态，运行中的节点边框会呼吸；点节点看结果摘要、产物（可在版本之间对比）、活动时间线，并能就地处理该节点的收件箱条目；「在右侧打开子代理会话」查看完整对话（DSH 0.1.5 没有右侧子代理面板，会在主区打开）。
   也可以打开右侧栏，点顶部工具栏的「工作流」图标或「开始」页的「工作流」卡片，在右侧栏里对照着对话看。
4. 侧边栏「收件箱」（或右侧栏工具栏的收件箱图标）出现数字时去处理：回答问题、回复消息、审核（通过，或写意见打回）、处理防空转询问。键盘：j/k 或 ↑↓ 切换，1–9 选选项，Tab 去输入框，Enter 或 ⌘/Ctrl+Enter 提交，提交后自动跳到下一条。
5. 三道人工审核都通过、归档节点写完 `archive.md` 后工作流完成。代码在分支 `rdfoe/<runId>` 上（worktree 在 `~/.dsh/rdfoe-workflow/worktrees/<runId>`），产物在 `.rdfoe/runs/<runId>/`。要合并时在原仓库执行 `git merge rdfoe/<runId>`（或先 `git log main..rdfoe/<runId>` 看看）。

**可选配置**：写在 `~/.dsh/profiles/rdfoe/cordis.patch.yml`，修改后重启 DSH。patch 会整体替换这一行的 config，只写你要改的字段即可，其余用默认值：

```yaml
- id: rdfoe-workflow
  config:
    nodes:                       # 按节点指定模型；不写则沿用主会话当前模型
      D:  { provider: deepseek-official, model: deepseek-v4-pro }   # 也用于 R、C（旧 key 兼容）
      DR: { provider: deepseek-official, model: deepseek-v4-pro }
      T:  { provider: deepseek-official, model: deepseek-v4-pro }
      V:  { provider: deepseek-official, model: deepseek-v4-pro }
      X:  { provider: deepseek-official, model: deepseek-flash }
      Y:  { provider: deepseek-official, model: deepseek-flash }
    loop: { stallRounds: 3, remindAt: 10 } # 防空转：设计连续 3 次被审查挡回、实施⇄验证连续 3 轮不收敛或累计 10 轮时暂停问你
    exec: { timeoutMs: 600000 }            # wf_exec 超时
    # personas: { X: "……" }                # 覆盖某个节点的系统提示词（默认见 src/host/prompts/personas.ts）
```

provider/model 的写法与会话里模型选择器中的一致（`~/.dsh/settings.yaml` 里配置的 provider 名和模型 id）。

**常见问题**

- 看不到「工作流」标签或「收件箱」：确认第 3 步能看到 `rdfoe-workflow`；刷新浏览器。
- 节点失败并提示 `no model route`：主会话还没选过模型且没有默认模型，按上面的 `nodes` 配置模型，或先在会话里选一个模型。
- 改了插件代码：`pnpm build` 后重启 DSH（浏览器端会自动热更新，Host 端不会）。
- 停用/卸载：`npx -y @deepseek-ai/dsh@0.1.7-alpha.2 plugin --profile rdfoe remove @rdfoe/dsh-workflow`；工作流数据在 `~/.dsh/rdfoe-workflow/`，worktree 可用 `git worktree remove` 清理。

**注意**：子代理的 `wf_exec` 在 DSH 沙箱之外、以你的用户身份执行任意 shell 命令（首版为了体验放开了限制），请只在你信任的仓库和需求上使用。

## 开发

```sh
pnpm install          # pnpm-workspace.yaml 放行了 node-pty/koffi 等构建脚本
pnpm build            # tsdown：lib/index.js（Host ESM）+ lib/client.js（浏览器 CJS 工厂，React 等走 DSH 壳层）
pnpm typecheck
pnpm test             # vitest 单测
pnpm e2e              # 端到端（假模型，自动起停 DSH）：a 完整流程（C 提问、DR 阻断回 D、H1 打回、Y 失败回 X、H3 打回、A 归档）、b 消息回复、c 多会话、d 重启恢复、n 非 git 目录、s 斜杠命令（发消息 → 模型调用一次 wf_start → 简短回复）、m 小改动、k 澄清阻断、q 设计循环防空转、v 斜杠命令开启的会话是普通会话（有标题、留在会话列表，含旧会话自愈、DSH 重启后）、u 界面冒烟（无头 Chrome、全新浏览器配置：左侧「工作区」区块和插件的「收件箱」入口都在，没有插槽崩溃；Chrome 不在默认位置时用 E2E_CHROME 指定）
                      # 可用 PORT / FAKE_LLM_PORT 换端口，例如 PORT=3187 FAKE_LLM_PORT=18337 pnpm e2e m

# 首次：隔离的 DSH_HOME（仓库内 .dsh-dev/，已 gitignore）里建 profile 并安装
export DSH_HOME=$PWD/.dsh-dev
npx dsh rdfoe-dev --from-default-profile web --dump-config >/dev/null
npx dsh plugin --profile rdfoe-dev add $PWD

# 手动运行：假模型 + DSH（端口 3181，不开浏览器，带 scripts/dev.patch.yml 打开 /dev 路由）
pnpm fake-llm &
pnpm dev:web
pnpm dev:stop

# 浏览器演示（假模型剧本覆盖四类收件箱条目 / 重启恢复），Ctrl-C 结束
node test/e2e/ui-demo.mjs
node test/e2e/ui-restart.mjs
```

Host 端不热重载：改完代码 `pnpm build` 后重启 DSH。

### 目录

```
src/host/
  index.ts            插件入口（apply / Config / inject）
  config.ts           Config schema（§4.3 开关、节点模型、persona 覆盖）
  workflow/           machine.ts 转移表 · template.ts 模板 · service.ts 编排器 · prompt.ts 节点输入
  runner/             node-runner.ts 子代理创建/冷恢复 · hub.ts 事件总线
  inbox/broker.ts     收件箱条目与挂起等待
  tools/              节点工具、路径守卫（限制在 worktree 内）、主会话工具 wf_start / wf_status、斜杠命令 /rdfoe-workflow（发开启消息）、会话补标题与第一轮（session-engage.ts，供视图开启与旧会话自愈）
  git/git.ts          worktree / 提交 / diff（execFile，不经 shell）
  store/store.ts      node:sqlite 表与 transition()
  routes/routes.ts    /api/rdfoe-wf/*（含 NDJSON 推送）
  prompts/personas.ts R / C / D / DR / T / V / X / Y / A / S 的中文系统提示词（各由一个 PH 技能改写）
  prompts/ph/         内置的 PH 产物模板（templates/*.md，构建时以文本打包进 lib）
src/client/           工作流视图、流程图、节点详情与版本对比、收件箱面板与侧边栏入口、右侧栏标签页与工具栏图标（views/Aside.tsx）、wf_start 与 /rdfoe-workflow 卡片、开启工作流那一轮末尾的卡片（turnTail）、空白会话的工作流面板
test/                 单测；fake-llm/ 假模型；e2e/ 端到端与演示脚本
docs/                 M0-notes.md、screenshots/
```

### 假模型

`test/fake-llm/server.mjs` 模拟 DeepSeek Messages 接口（以及 0.1.5 用的 `/chat/completions`）。它从普通提示词内容识别节点，不需要隐藏标记：角色看 persona 里的「（节点 R）」「（节点 DR）」等，工作流与标题看「需求原文（工作流 …）」，节点与版本看「本节点：…（D），第 N 版」，模板看「流程模板：…（full）」，轮次看「循环第 N 轮」。假模型按剧本规则（`POST /scenario`）或内置的顺利路径执行工具调用；普通会话里用 `@call <tool> <json>` / `@say` / `@title` 指令；认出 `/rdfoe-workflow` 发出的开启消息（「【工作流】<需求>」）时，按消息里的需求和模板调用一次 `wf_start`，再回一句「工作流已启动…」，标题请求答「工作流 · <需求开头>」。`GET /debug/requests` 查看每次请求的节点标记、提示词、工具列表与工具结果。

### 路由（均在 /api 下，需浏览器登录 cookie）

| 路由 | 用途 |
|---|---|
| `GET /api/rdfoe-wf/run?sessionId=` · `GET /events?sessionId=` | 会话绑定的工作流快照 / NDJSON 推送 |
| `GET /inbox?status=open\|all\|done` · `GET /inbox/events` | 统一收件箱 / NDJSON 推送 |
| `POST /inbox/respond` | `{id, action, …}`：question `answer\|skip`、message `read\|reply`、review `approve\|reject`（`comment` 必填、`rollbackTo`）、loop_stall `continue\|back_to_plan\|terminate`（设计循环为 `continue\|to_review\|terminate`） |
| `POST /run/start` | `{sessionId, requirement, title?, template?}`：工作流视图空状态的开启入口（`template` 为 `full` 或 `small`） |
| `POST /run/continue\|pause\|cancel` · `POST /node/retry` · `POST /node/accept` | 运行控制（`/node/accept`：已阻断的需求澄清按当前需求继续） |
| `GET /artifact?runId&path` · `GET /diff?runId` | 审核用的产物与分支 diff |
| `POST /session/engage` | `{sessionId}`：给绑定了工作流、但 DSH 仍当作空白会话的会话补标题和第一轮（旧版本斜杠命令留下的会话；打开会话时由浏览器自动调用），已有的不重复做 |
| `GET /runs` | 本机全部工作流及所在会话（「本机的工作流」列表） |
| `POST /dev/session` · `POST /dev/prompt` · `POST /dev/command` · `POST /dev/bind` · `GET /dev/sessions` | 仅 `devRoutes: true` 时注册，供 e2e 使用（`/dev/command` 经 DSH 命令注册表执行一行斜杠命令；`/dev/bind` 只绑定工作流、不补会话，模拟旧版本留下的会话） |

## 已知限制

- 节点工具在 DSH 沙箱之外执行：`wf_exec` 可以跑任意 shell 命令（可联网），文件工具只限制在 worktree 内。
- DSH 把「还没有过对话回合（`turn/start`）」的会话当作空白的「新会话」：左侧列表只显示当前选中的那一个空白会话，也不显示「对话 / 轨迹 / 工作流」标签。0.1.0-beta.4 及以前 `/rdfoe-workflow` 不经过模型、直接开启工作流，而斜杠命令只记 `command/run`/`command/done`、不算回合，这样开启的会话一切到别的会话就从列表消失。0.1.0-beta.5 起命令改为发一条真实的用户消息、由模型调用 `wf_start`（见「怎么开启工作流」）。工作流视图里的「开启工作流」按钮仍不经过模型：开启后插件用 `sessionTitle.rename` 把会话标题设为「工作流 · <需求摘要>」（已有标题时不改），再用 `agent.followup` 投一条占位消息唤起一轮、在 `agent/pre-step` 里清掉它，这一轮在任何请求前以 `completed` 结束，只写 DSH 自己的事件；代价是「对话」里多一行「用时 1 秒」的空回合。
- DSH 在一轮结束后会把工具调用折进「用时 …」里，`wf_start` 的工具卡片也在其中；回复下面那张常显的卡片挂在 `conversation.chat.turnTail`（0.1.7 是列表席位，0.1.5 是选择链席位，同一轮里如果还有 DSH 的交付文件卡片，0.1.5 只显示先匹配的一张），由插件登记的会话事件定义（只读取 `turn/start` 与 `wf_start` 的 `tool/call`）判断哪一轮开启了工作流。
- 旧版本留下、被隐藏的会话：在收件箱点「打开会话」，或在右侧栏「工作流」标签（当前会话没有工作流时）底部的「本机的工作流」列表里点「打开会话」，插件会补上标题和第一轮，这个会话此后回到左侧列表。
- 「打开工作流」按钮和收件箱跳转依赖 DSH 内部实现（会话视图偏好的 localStorage 键、标签页 DOM），升级 DSH 需要回归。
- 右侧栏的「工作流」「收件箱」标签页和「开始」页卡片走 DSH 的官方扩展点（`sidebarRightTabs` + `sidebar.right.pane.tab`）；但工具栏图标没有扩展点，是插件插进 DSH 右侧栏标签条 DOM 的（按 `data-sidebar-right-toggle` 等属性定位），DSH 改了这段标记后图标可能不出现（不影响其他入口），升级 DSH 需要回归。
- 同一个端口（浏览器里的同一个 origin）先后跑过不同版本的 DSH，左侧整个「工作区」区块可能不见（只剩「新会话」「收件箱」「设置」），控制台报 `slot entry crashed in 'sidebar.workspaces': TypeError: Cannot convert undefined or null to object`。这是 DSH 自己的问题，与插件无关：0.1.7 与 0.1.5-rc.3 都把侧栏视图状态存在 localStorage 的 `dsh.workspace.view.v5`，但字段不同（0.1.7 去掉了 `sessionUpdatedAtByAccount`），0.1.5-rc.3 读到 0.1.7 写下的值就崩。注意在本仓库目录里执行 `npx @deepseek-ai/dsh` 会用仓库 devDependency 里的 0.1.7。解决：在该页面的开发者工具控制台执行 `localStorage.removeItem('dsh.workspace.view.v5'); location.reload()`，或者不同 DSH 版本用不同端口。
- 升级前已经在跑的工作流会变成只读，不能继续；建议升级前让进行中的工作流先走完。
- 会话删除后的只读处理（ORPHANED）、全局工作流总览、排队中节点的展示留到 M3。
