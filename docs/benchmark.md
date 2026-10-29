# 基准测试：dsh + 本适配器 vs dsh 原生 vs JiuwenSwarm 直连

2026-10-29 在测试机上实测，三条路径都用**同一个模型**：doubao-seed-2.0-mini（火山方舟 Coding Plan，`https://ark.cn-beijing.volces.com/api/coding/v3`）。

| 路径 | 说明 |
|---|---|
| **A** | 裸 dsh 0.2.1-rc.2 `headless --json` + 本适配器 gateway 模式 → JiuwenSwarm gateway :19000 |
| **A0** | 同 A，但关闭本次两个修复（`JIUWEN_TERMINAL_FINAL_GRACE_MS=-1 JIUWEN_POST_CANCEL_SETTLE_MS=0`） |
| **B** | 裸 dsh，原生 `dsh-llm-pi-ai` OpenAI 兼容 provider 直连同一模型端点（不经 Jiuwen） |
| **C** | 直接走 JiuwenSwarm gateway WebSocket（不经 dsh），作为基线 |

## 质量（公开基准，自动判分）

| 基准 | 样本 | A | B | C |
|---|---|---|---|---|
| GSM8K test（openai/grade-school-math），数值精确匹配 | 30 题，seed 42 | **30/30** | 29/30 | 30/30 |
| HumanEval（openai/human-eval），执行官方 `check()` | 20 题，seed 42 | 19/20 | **20/20** | **20/20** |

- 抽样：mulberry32(42) 洗牌后取前 n 个；题目见 `bench/data/`。
- A 在 HumanEval/149 上失败：输出的代码块缺了结尾的三引号。这是模型输出问题，不是适配器问题。
- B 在 gsm8k-test-306 上答错（答 5，正确答案 10）。

## 性能（中位数，单位 ms）

| 指标 | A0 | A | B | C |
|---|---|---|---|---|
| 单轮 "pong"，端到端（含 dsh 进程启动） | 6985 | 7249 | 3965 | 4526 |
| 首 token（A 由适配器 trace 测得；C 直接测得） | 4348 | 5436 | — | 3193 |
| 首个 headless 内容块 | 5472 | 5987 | 3223 | 3193 |
| dsh 启动 → 适配器收到请求 | 1139 | 1184 | — | 0 |
| 输入 token | 23081 | 23084 | 5873 | 23084 |
| GSM8K 每题延迟（并发 3） | — | 9374 | 6502 | 6297 |
| GSM8K 平均输入/输出 token | — | 23179 / 319 | 2552 / 263 | 23179 / 300 |
| HumanEval 每题延迟 | — | 13845 | 11537 | 10746 |
| 多轮（4 轮）每轮延迟 | 6.8/6.1/6.2/7.0 s | 5.5/6.2/5.9/6.4 s | 4.1/3.8/3.5/3.6 s | 4.8/4.9/3.4/4.4 s |
| 多轮记忆（3 次 × 4 轮，17→22→44→17） | 3/3 | 3/3 | 3/3 | 3/3 |
| 5 路并发，总耗时 / 正确数 | 7820 / 5 | 8139 / 5 | 6077 / 5 | 12282 / 5 |
| 取消：从发出到进程退出 / 中断确认 | 179 | 180 | 41 | 3 |
| 取消后立即续聊 | 3/3 | 3/3 | 3/3 | **0/3（卡死 90 s）** |

**结论：**
- 质量：三条路径基本一致，都在 29–30/30 和 19–20/20 之间。
- 延迟：A 比 C 多约 2–3 s，其中约 1.2 s 是 dsh 进程启动，其余是 dsh/适配器的编排开销。
- 输入 token：JiuwenSwarm 每轮带约 23k 的系统提示和工具 schema，是 B 的约 4 倍。这是 Jiuwen 本身的成本，不是适配器造成的。

## UX 检查（6 项，各路径全部通过）

六项是：中文回答、英文回答、bash 工具、文件写读、身份、精确 JSON。没有发现状态字段泄漏或文本重复。

注意以下几点：
- 经 Jiuwen 的路径（A/C），英文问题的 reasoning 是中文。原因是 Jiuwen 的系统提示是中文。
- A/C 被问"你是谁"时，用中文自称"JiuwenSwarm 个人智能体"，即使问题是英文。

## 发现并修复的问题（commit b2b6916）

1. **取消后立即续聊会卡死**。这是 JiuwenSwarm 的竞态：同一会话在 `chat.interrupt` 后约 300 ms 内收到的 `chat.send` 会被接受，但永远不执行（实测卡了 150 s）。
   - 修复：适配器记录每个会话的取消时间（内存中，并持久化到 mapping 文件的 `lastCancelAt`，跨进程也生效）。下一次发送前，等到取消后满 `postCancelSettleMs`（默认 1000 ms）。
   - 回归测试：mock gateway 模拟了这个竞态，测试覆盖开启和关闭两种情况。
2. **回合结束慢约 0.7 s**。JiuwenSwarm 先发送一个空内容、带 request_id、没有 `final_mode` 的终止 `chat.final`，约 0.7 s 后才发 `processing_status.is_complete`。
   - 修复：适配器在收到终止 final 后等 `terminalFinalGraceMs`（250 ms），期间没有新事件就结束回合。
   - 回归测试：mock 加了一个延迟 3 s 才发送的 status。
   - 这次的 n=5 样本里，A 与 A0 的差别被 Jiuwen 首 token 的 ±2 s 抖动掩盖了，统计上看不出来。

## 局限

- 每个指标样本量小（n=3–5），网络和模型抖动是秒级的。
- dsh `headless --json` 只在块结束时输出内容，所以 B 测不到 token 级首 token。A 的首 token 来自适配器 trace。
- 上下文百分比的准确性没有测。
- OpenAI 模式（D）没有测。

## 复现

```bash
# 前置条件：裸 dsh 安装在一个 prefix 下；headless profile 已 plugin add 本适配器；
# 另建 native profile，内容见 bench/native-profile.patch.yml：
# llm-pi-ai 下声明 providers.ark，api: openai-completions，baseURL，apiKeyEnv: ARK_API_KEY；
# agent-default-model 设为 ark / doubao-seed-2.0-mini。
export DSH_HOME=... PATH=<prefix>/bin:$PATH   # 若没设 ARK_API_KEY，会从 ~/.jiuwenswarm/config/.env 读取，不会打印
BENCH_SUITES=perf,ux BENCH_PATHS=A0,A,B,C npm run bench
BENCH_SUITES=gsm8k,humaneval BENCH_PATHS=A BENCH_OUT=bench/results/qA npm run bench   # B、C 同理，可以并行跑
```

结果会增量写入 `$BENCH_OUT/results.json`，中断后可以续跑；`runs.csv` 记录每一次运行。本次的原始结果在 `bench/results/`。

## 延迟拆解：A 为什么比 C 慢（commit 见 git log）

测法：打开 `JIUWEN_TRACE_FILE`，trace 记录 `up`（进程启动后的毫秒数），以及适配器各阶段的标记：
`plugin-apply`、`turn-start`、`ws-connect/open/ack`、`chat-send`、`first-frame`、`first-reasoning`、`final`、`terminal-final`、`finish`。
另外记录 dsh stdout 输出 final 的时刻和进程退出的时刻。
C 用同样的 prompt、全新会话，交替各跑 6 次（脚本 `scripts/latency-breakdown.mjs`，结果在 `bench/results/latency-breakdown.json`）。

| 阶段（中位数 ms） | A 修复前 | A 修复后 | C |
|---|---|---|---|
| 进程启动 → 插件 apply（dsh/cordis 加载） | 719 | 714 | — |
| apply → 适配器 stream()（dsh 会话/回合准备） | 482 | 490 | — |
| WS 连接 + connection.ack | 13 | 13 | 4 |
| chat.send → 首个网关帧 | 3 | 3 | — |
| chat.send → 首 token（Jiuwen 与模型） | 2696 | 3844 | 3089–3915 |
| 首 token → 终止 chat.final | 426 | 599 | 428–524 |
| 终止 final → 回合结束 | 250（宽限） | 101 | 703（等 processing_status） |
| 回合结束 → dsh 退出 | **1404** | **41** | — |
| **结构性开销（不含 Jiuwen 与模型时间）** | 约 2.9 s | 约 1.37 s | 约 0.7 s |

根因：
1. **适配器的空闲定时器没有清除（已修复）。** `_consume` 的等待循环每次都留下一个最长 1 s 的 `setTimeout`，回合结束后它仍挂在事件循环上，让 dsh headless 进程晚约 1.0–1.4 s 才退出。
   - 修复：每次唤醒后 `clearTimeout`，进程退出从约 1404 ms 降到约 41 ms。
   - 回归测试：检查回合结束后没有残留的 Timeout。
2. **终止 final 的宽限时间从 250 ms 降到 100 ms。** 同时适配器不再等约 0.7 s 后才到的 `processing_status`。直连 C 要付这 0.7 s，A 不用。
3. **dsh 冷启动约 1.2 s，在适配器控制之外。** 其中模块加载到插件 apply 约 0.7 s，会话准备约 0.5 s；B 路径同样要付。
   - 推测：长驻的 `dsh web` 或 ACP 进程只付一次启动成本（未实测）。

排除的嫌疑：
- 每回合新建 WS + ack 只要 13 ms，复用连接收益可以忽略。
- chat.send 之前没有额外 RPC，dsh 的标题请求在本地回答，不打到 Jiuwen。
- 请求参数与 C 一致（只多了 user_id）。
- 按 user_id 分别测（dsh-adapter / bench / 全新），Jiuwen 首 token 的差别都在噪声范围内。
- Jiuwen 与模型的首 token 本身有 2.2–4 s 的抖动（偶尔 13 s），它掩盖了小于 0.5 s 的差异。

修复后单轮 pong 的端到端延迟：A 4.2–5.7 s，C 4.4–5.0 s，两者已经基本持平。
