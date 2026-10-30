# Benchmark

Measured 2026-10-29 on the test box. All three paths use the **same model**: doubao-seed-2.0-mini (Volcengine Ark Coding Plan, `https://ark.cn-beijing.volces.com/api/coding/v3`).

| Path | Notes |
|---|---|
| **A** | Bare dsh 0.2.1-rc.2 `headless --json` + this adapter in gateway mode → JiuwenSwarm gateway :19000 |
| **A0** | Same as A with the two latency fixes off (`JIUWEN_TERMINAL_FINAL_GRACE_MS=-1 JIUWEN_POST_CANCEL_SETTLE_MS=0`) |
| **B** | Bare dsh, native `dsh-llm-pi-ai` OpenAI-compatible provider straight to the same model endpoint (no Jiuwen) |
| **C** | Direct JiuwenSwarm gateway WebSocket (no dsh) — baseline |

## Post-fix performance (2026-10-29, commit e18176c)

After clearing leftover timers. Model still doubao-seed-2.0-mini. Single-turn pong ×8, multi-turn ×3, cancel+continue ×3, 5-way concurrency, UX ×6; GSM8K recheck of seed42 first 10. Raw: `bench/results/post-fix-20261029*.json`.

| Metric (median) | A dsh+adapter | B dsh native | C Jiuwen direct | A−C |
|---|---|---|---|---|
| Single-turn pong e2e | **4,729 ms** | 4,177 ms | 4,442 ms | **+287 ms** |
| First token (A from trace) | 3,982 ms | — (block-level 3,418) | 3,310 ms | +672 ms |
| dsh start → adapter request | **1,133 ms** | (in total) | 0 | +1,133 ms |
| Turn end → dsh exit | **42 ms** | — | — | (~1,404 ms before the fix) |
| Input / output tokens | 23,084 / 36 | 5,869 / 70 | 23,084 / 42 | — |
| Multi-turn memory (3×4 turns) | 3/3 | 3/3 | 3/3 | — |
| Multi-turn per-turn latency | 5.7/5.5/5.2/4.8 s | 4.6/3.9/6.3/3.7 s | 4.2/4.7/4.0/3.9 s | — |
| Cancel ack / continue after cancel | 184 ms / **3/3** | 42 ms / 2/3 | 4 ms / **0/3** | C has no settle |
| 5-way concurrency wall (correct) | 7,536 ms (5) | 5,430 ms (5) | 7,158 ms (5) | — |
| GSM8K n10 (seed42 first 10) | 9/10 | 9/10 | 9/10 | same miss #306 |
| UX 6 items | 6/6 | 6/6 | 6/6 | — |

**Conclusions (after fix):**

- A and C e2e medians are close (4.7 s vs 4.4 s, +0.3 s) — well under Jiuwen first-token jitter (2–4 s).
- A still pays ~**1.13 s dsh cold start** (process load + session prep). Long-lived `dsh web` pays once; headless CLI pays every invocation.
- A ends ~0.7 s sooner than C on `processing_status` wait (adapter finishes 100 ms after the terminal final), partly offsetting startup.
- Continue-after-cancel: A reaches 3/3 via `postCancelSettleMs`; C direct stays 0/3 (Jiuwen race).
- Before the fix, A’s single-turn median was **7.2 s** (~1.4 s leftover timer holding exit) — see the historical table below.

Stage breakdown (`scripts/latency-breakdown.mjs` ×8, median):

| Stage | A | C |
|---|---|---|
| Process start → plugin apply | 680 ms | — |
| apply → stream() | 471 ms | — |
| WS + ack | 14 ms | 4 ms |
| send → first token | 3,659 ms | 3,452 ms |
| Terminal final → end | 101 ms | 703 ms |
| End → process exit | 42 ms | — |

## Hard suite (2026-10-29)

Script: `npm run bench:hard` (`scripts/bench-hard.mjs`). Data: `bench/data/gsm8k-hard-q1-seed7-n20.jsonl`, `humaneval-hard-seed11-n10.jsonl`, `hard-suite.json`. Results: `bench/results/hard-{A,B,C}/`, `bench/results/hard-summary.json`.

| Subset | Notes | A | B | C |
|---|---|---|---|---|
| GSM8K hardest quartile | Top 25% by solution length, seed7 sample 20, exact numeric match | **20/20** | **20/20** | 19/20 |
| Multi-step tool chain | Write file → bash transform → read-back check, 5 items | **5/5** | **5/5** | **5/5** |
| Multi-turn memory + distractors | 5–7 turns with distractors, 3 scenarios | **3/3** | **3/3** | 2/3 |
| Harder HumanEval | Untested longest-solution quartile, seed11 sample 10 | 9/10 | **10/10** | **10/10** |
| Complex format constraints | Nested JSON / CSV / bilingual blocks / lists / XML, 5 | **5/5** | 4/5 | **5/5** |
| Multi-constraint reasoning | Paragraph + multiple output constraints, 5 | **5/5** | **5/5** | **5/5** |
| **Total** | 48 items | **47/48** | **47/48** | **46/48** |
| Per-item latency median | (excludes multi-turn scenario totals) | 9.6 s | 8.7 s | 9.7 s |

Failures:

- **A** HumanEval/140: generated code failed official `check()` (assertion).
- **B** fmt-csv-header: model wrote a file and explained in Chinese instead of emitting CSV only.
- **C** gsm8k-hard-854: answered 96, correct 144.
- **C** mem-code-distractors: remembered codeword and room, but answered fruit as Chinese for pear instead of required `pear`.

Conclusions: on the hard suite A (dsh+adapter) ties B (dsh native) at 47/48 and slightly beats C (46/48). Tool-chain and multi-constraint pass on all three paths; A’s only miss is model code quality, not adapter protocol.

## Quality (public benchmarks, auto-graded)

| Benchmark | Sample | A | B | C |
|---|---|---|---|---|
| GSM8K test (openai/grade-school-math), exact numeric | 30 items, seed 42 | **30/30** | 29/30 | 30/30 |
| HumanEval (openai/human-eval), official `check()` | 20 items, seed 42 | 19/20 | **20/20** | **20/20** |

- Sampling: mulberry32(42) shuffle, take first n; prompts in `bench/data/`.
- A failed HumanEval/149: missing closing triple-quotes on a code fence — model output, not adapter.
- B missed gsm8k-test-306 (answered 5, correct 10).

## Historical (pre-fix, for reference)

Before leftover-timer + terminal-final grace fixes, A’s single-turn median was ~7.2 s. See `bench/results/` for the older JSON dumps. Do not compare those numbers to the post-fix table without adjusting for the exit hang.

## How to reproduce

```bash
# Needs a live Gateway on :19000 and model credentials in ~/.jiuwenswarm
npm run bench            # scripts/bench.mjs
npm run bench:hard       # scripts/bench-hard.mjs
node scripts/latency-breakdown.mjs
```

PNG bar charts under `bench/results/` are local artifacts and stay uncommitted.
