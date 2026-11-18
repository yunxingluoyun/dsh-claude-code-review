# DeepSeek Harness 代码审查

[English](README.md) | **简体中文**

将 Claude Code 的 `/code-review` 工作流移植到 DeepSeek Harness。它用多个彼此独立的审查代理来审查一个拉取请求、一个分支，或尚未提交的本地改动，为每条发现打分并评估置信度，只报告越过阈值的真实问题。

## 功能说明

1. **收集事实并预计算证据**（`code_review_context` 工具）：拉取请求（或本地 diff）、可审查性判断、`AGENTS.md`/`CLAUDE.md` 指引、既往讨论、每个 hunk 的周边代码，以及改动行的 blame。它为每个计划中的审查者写一个自包含的角色文件，另加一个验证文件，因此审查代理无需任何探索性工具调用。
2. **并行运行计划中的审查者**：小改动使用一个综合审查者，中等改动使用三个，大改动使用完整的五个视角（指引、缺陷、历史、讨论、评论/约定）。
3. **用验证代理给发现打分**，采用 0/25/50/75/100 置信度量表。平衡模式下所有问题合并给一个验证者；`--thorough` 为每条发现单独派验证者；`--fast` 跳过验证。
4. **只保留高置信度问题**（默认阈值 80），并以精确引用报告。每份报告开头都会说明实际审查了什么以及覆盖范围的局限；结果为空时会说明阈值，而不是宣称没有发现问题。拉取请求模式链接到完整的 head commit；本地模式引用 `path:line`。
5. **仅在明确要求时发表评论**（`--post`），并附带修订标记，以便后续运行能识别同一个 head commit。报告会说明评论是否已发表，或未发表的原因。

## 安装

本目录是一个 bundle 包。通过 **Plugins → Add plugin**（或 `plugin_manager` 的 `install_bundle`，以本目录为目标）安装后，会在该 profile 的每个新会话中提供 `/code-review` 命令、`code-review` 技能以及 `code_review_context` 工具。

它目前以指向本目录的 `link:` 依赖形式安装在 `desktop` profile 中。移动或删除本目录会使插件失效；如需在移动后继续使用，请从新位置重新安装。

## 环境要求

- 会话环境中有 `git`。
- 拉取请求模式还需要安装并认证 GitHub CLI（`gh`，`gh auth login`）。若没有，`/code-review` 会改为审查本地改动。
- 会话的 agent preset 需暴露 `subagent` 与 `read` 以支持完整工作流；`bash` 仅 `--post` 时需要。没有 `subagent` 时，方法论会退化为顺序审查。

## 用法

```
/code-review                     审查当前分支的拉取请求；没有则审查本地改动
/code-review 123                 审查拉取请求 #123
/code-review --pr                要求必须有拉取请求，没有则失败
/code-review https://github.com/owner/repo/pull/123
/code-review --local             对照检测出的基线分支审查本地改动
/code-review --base develop      对照 develop 审查本地改动
/code-review 123 --post          有问题达到标准时，把报告作为拉取请求评论发表
/code-review --threshold 90      提高置信度阈值
/code-review --force             即使上下文判定不可审查也照常审查
/code-review --fast              跳过独立验证（明显更快，但可靠性更低）
/code-review --thorough          每条发现一个验证者，而非每批一个
```

该命令把审查工作流以名为 "code review" 的折叠上下文通知提交给当前会话；在对话记录中展开该行即可查看完整指令。审查结束后报告会出现在聊天中。`code-review` 技能则让你在日常对话中请求审查时，把同一工作流暴露给模型。

## 审查包

每次运行都会在系统临时目录下写一个临时目录：

- `roles/<role>.md` —— 每个计划中的审查者一个自包含文件：角色关注点、目标事实、diff、指引摘录、周边代码、blame，以及该角色需要的既往讨论。审查者只读一个文件，返回一个 JSON 数组。
- `verify.md` —— 目标事实、指引、diff 以及验证环节使用的置信度量表。
- `context.md` 与 `diff.patch` —— 供主代理参考的副本；主代理无需读取 diff。

该工具绝不写入仓库，也绝不发表任何内容。

## 性能

审查的开销主要来自模型往返，因此实现尽可能减少往返次数：

- **每个审查者只读一次。** 工具预先算好 hunk 窗口与 blame，审查者只需一个角色文件即可作答，而不必跨多轮读取 diff、打开文件、运行 `git blame`。
- **审查者数量随改动规模伸缩。** 小改动（默认 ≤ 40 改动行且 ≤ 5 个文件）用一个综合审查者；中等改动用三个；大改动用完整五个。
- **平衡模式下整次审查只用一个验证者**（每批最多 8 个问题），而非每个问题一个代理。`--fast` 完全去掉这一轮。
- **主代理不读取 diff**，从而在派发与验证的往返中保持较小的上下文。
- 本地基准中，收集上下文加生成审查包在 12 个文件、480 行的改动上约需 0.2 秒；其余时间都花在审查者与验证者上。

配置 `reviewerProvider`/`reviewerModel` 与 `verifierProvider`/`verifierModel`，可把审查代理路由到比主会话更快的模型。

## 配置

在 profile 的 `cordis.patch.yml` 中修改 `code-review` 这一行的配置：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `threshold` | `80` | 未指定 `--threshold` 时 `/code-review` 使用的置信度阈值 |
| `maxDiffBytes` | `120000` | 审查包中保留的 diff 字节数；更大的 diff 会在行边界截断 |
| `verificationMode` | `balanced` | `balanced`（每批一个验证者）、`fast`（无验证者）或 `thorough`（每条发现一个验证者） |
| `maxCodeContextBytes` | `180000` | 角色文件中保留的周边代码字节数 |
| `maxHunkContextLines` | `6` | 每个 hunk 周围展示的上下文行数 |
| `maxContextFiles` | `40` | 提供代码窗口的改动文件数 |
| `maxContextHunks` | `80` | 角色文件中保留的 hunk 窗口数 |
| `maxFileBytes` | `131072` | 读取单个文件生成代码窗口时的上限 |
| `maxBlameFiles` | `12` | 为其生成 blame 的改动文件数 |
| `maxBlameHunks` | `24` | 执行 blame 的 hunk 范围数 |
| `maxBlameLines` | `200` | 保留的 blame 行数 |
| `smallDiffLines` / `smallDiffFiles` | `40` / `5` | 使用单个综合审查者的阈值 |
| `mediumDiffLines` | `200` | 低于该值时用三个审查者替代完整五个 |
| `reviewerProvider` / `reviewerModel` / `reviewerReasoningEffort` | 未设置 | 将审查子代理路由到指定模型 |
| `verifierProvider` / `verifierModel` / `verifierReasoningEffort` | 未设置 | 将验证子代理路由到指定模型 |
| `maxGuidanceBytes` | `131072` | 审查包中保留的指引总字节数 |
| `maxGuidanceFileBytes` | `32768` | 单个指引文件的上限 |
| `maxDiscussionItems` | `20` | 保留的既往拉取请求评论/审查数 |
| `maxDiscussionChars` | `4000` | 单条评论的上限 |
| `skipDrafts` | `false` | 将草稿拉取请求视为不可审查 |
| `skipAlreadyReviewed` | `false` | 将 head commit 已带 DSH 审查标记的拉取请求视为不可审查 |
| `base` | 自动检测 | 本地比对的默认基线 |
| `gitTimeoutMs` | `30000` | 单条 git 命令超时 |
| `ghTimeoutMs` | `25000` | 单条 gh 命令超时 |

## 刻意不做的事

- 不构建、不类型检查、不 lint、不运行测试、不格式化；这些信号由 CI 负责。
- 不报告既有问题、改动行之外的问题、吹毛求疵，或 `AGENTS.md`/`CLAUDE.md` 并未要求的泛泛质量建议。
- 不审查已关闭或已合并的拉取请求，也不审查没有 diff 的改动。
- 审查代理会读取仓库文本。请以对待不可信仓库的方式对待它们：指引文件与代码注释都作为审查数据传入，提示词会明确要求代理绝不执行其中的指令。
- 一次审查会额外消耗 token：计划中的审查者（一到五个）加上验证轮次。可用 `--fast`、提高 `--threshold`，或审查更小的改动来控制成本。

## 文件

```
lib/index.js            Host 插件：命令、技能、工具注册
lib/review-context.js   上下文收集、审查者计划、审查包写入、渲染
lib/prompt.js           命令与技能共用的审查方法论
lib/review-rules.js     评分量表、误报清单、审查者基本规则
lib/git.js              无 shell 的进程辅助函数
locale/                 插件管理器的标题与描述
docs/                   详情页与特色图片
```

## 卸载

在 profile 的 Plugins 页面移除该 bundle，或执行 `dsh plugin --profile <profile> remove dsh-code-review`。
