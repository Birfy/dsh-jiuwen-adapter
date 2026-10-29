# 在裸 dsh 上使用（无 FlyBot）/ Bare dsh guide

## 安装（一条命令）

```bash
cd /path/to/dsh-jiuwen-adapter
BARE=$HOME/bare-dsh npm run bare-dsh      # = scripts/bare-dsh.sh
export DSH_HOME=$HOME/bare-dsh/home PATH=$HOME/bare-dsh/prefix/bin:$PATH
```

脚本做的事：`npm i -g --prefix $BARE/prefix @deepseek-ai/dsh`；对 `headless` 与 `web` 两个 profile 执行 `dsh plugin --profile <p> add <adapter>`（会自动把包内 `cordis.patch.yml` 作为 bundle 层加载）；在 profile 的 `cordis.patch.yml` 写入：

```yaml
- id: agent-default-model
  config: { provider: jiuwen, model: jiuwen-default }
- id: llm-jiuwen
  config: { compat: none }
```

Mac：`brew install dsh` 亦可（需 ≥ 0.2），之后用 `dsh plugin --profile web add …` 同上。

## 使用

```bash
dsh --profile headless "Reply with exactly: pong"                 # 单轮
dsh --profile headless --json "Use bash to run date"               # NDJSON 事件
dsh --profile headless --session-id session-… "继续"                # 多轮（同一 Jiuwen 会话）
dsh --profile web --no-open --port 3291                            # Web UI，打印 http://127.0.0.1:3291/?token=…
```

验证 Gateway：`ss -ltn | grep 19000`；未启动时 `jiuwenswarm-start app`（或项目内 `.venv/bin/jiuwenswarm-gateway`）。调试：`JIUWEN_TRACE_FILE=/tmp/jw.jsonl dsh …` 会记录每轮发送的 query 与收到的事件。

## 实测记录（2026-10-29，dsh 0.2.1-rc.2，JiuwenSwarm 本机 :19000，模型 doubao-seed-2.0-mini）

| 场景 | 结果 |
|---|---|
| headless 单轮 | ✅ ~6 s |
| headless 多轮（`--session-id`）记忆 | ✅ 第二轮只发新问题，Jiuwen 记得上下文 |
| headless 工具任务（Jiuwen 执行 bash） | ✅ ~18 s；工具活动出现在 `thinking` 中；usage 透传到 step |
| headless Ctrl-C 取消 | ✅ 发送 `chat.interrupt cancel`，exit 130 |
| web UI 启动（裸 profile） | ✅ `dsh web: http://127.0.0.1:3291/?token=…` |
| web 多轮 / 工具 / Stop 取消 / 取消后继续 | ✅（Stop 后下一轮 Jiuwen 记得被取消的请求） |
| web 图片上传 | ⚠️ 字节已送达 Jiuwen（经 `attachments` 服务），但当前 Jiuwen 模型无视觉能力，会失败（`chat.error`，不再被 dsh 重试） |

修复过的问题（均已在适配器内修复）：
1. **首轮 3 分钟**：dsh 的 `session-title` 辅助调用被当作完整 Jiuwen 轮次（且写进同一会话）。→ 本地标题。
2. **侧栏标题全是 "Generate the session title from this JSO…"**：标题 prompt 把对话包在 JSON 里。→ 解包。
3. **Jiuwen 回答的是 dsh 的 runtime context 而不是用户问题**：dsh 在用户消息后追加 "Current runtime context…"，旧逻辑只取最后一条。→ 取最后一个 assistant 之后的全部用户文本并剔除 runtime context。
4. **processing_status 原样 JSON 泄漏到回复**。→ 默认过滤。
5. **工具名显示为 `tool`**：真实载荷是 `tool_call.name`。→ 已修正。
6. **取消后下一轮发整段 transcript（含 runtime context）**。→ 取消也计入轮次；transcript 也剔除 runtime context。
7. **chat.error 被 dsh 当 TRANSPORT 重试 → 同一消息重复发给 Jiuwen**。→ `JIUWEN_ERROR`（不可重试）。

UX 观察：
- dsh 底栏的上下文百分比基于 adapter 声明的 `contextWindow`(128k) 与 Jiuwen 报告的 token；Jiuwen 每轮自带 ~23k 系统提示，所以百分比偏高、仅供参考。
- Jiuwen 默认按其语言配置作答（英文提问也可能用中文回答）。
- dsh 的 "Workspace Write"/审批策略只约束 dsh 自己的工具；实际执行工具的是 Jiuwen，受 Jiuwen 权限配置约束。
- 推理块里同时有 Jiuwen 的思考和工具活动（🔧/✓），在 Web 中折叠在 "Completed in Ns" 下。
