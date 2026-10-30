# Quickstart (Mac / Linux)

Every command below was run in order on a fresh Linux box (2026-10-29: Node 22.21, Python 3.13, uv, dsh 0.2.1-rc.2, workswarm 0.2.7) and produced a real reply. Mac variants are noted inline.

## 0. Prerequisites

| Dependency | Version | Check |
|---|---|---|
| Node.js | **≥ 22** | `node --version` |
| Python | **3.11–3.14** (JiuwenSwarm) | `python3 --version` |
| uv (recommended) or pip | any | `uv --version` |
| git | any | `git --version` |

```bash
# macOS
brew install node@22 python@3.13 uv git
# Debian/Ubuntu
sudo apt-get install -y python3 python3-venv git && curl -LsSf https://astral.sh/uv/install.sh | sh
# Node 22: https://nodejs.org or `nvm install 22`
```

## 1. Install and start JiuwenSwarm (the agent brain)

```bash
uv venv ~/jiuwenswarm-venv --python 3.13
source ~/jiuwenswarm-venv/bin/activate
uv pip install workswarm            # China mirror: -i https://pypi.tuna.tsinghua.edu.cn/simple
jiuwenswarm-init                    # first run: creates ~/.jiuwenswarm/
```

Without uv: `python3 -m venv ~/jiuwenswarm-venv && source ~/jiuwenswarm-venv/bin/activate && pip install workswarm`. From source: clone `openJiuwen-ai/jiuwenswarm` and `uv pip install -e .`.

### Model config: `~/.jiuwenswarm/config/.env`

```dotenv
# Required (OpenAI-compatible example)
API_BASE=https://api.deepseek.com
API_KEY=sk-xxxxxxxxxxxxxxxx                # never commit
MODEL_NAME=deepseek-chat
MODEL_PROVIDER=OpenAI                      # OpenAI (compat) or Anthropic
ENDPOINT_PROFILE=deepseek                  # openai / deepseek / openrouter / siliconflow / dashscope / openai_compatible / ollama / lmstudio / vllm / sglang
```

You can also set the default model in `~/.jiuwenswarm/config/config.yaml` or the JiuwenSwarm web UI (More → Configuration).

### Start (backend only — no Jiuwen frontend required)

```bash
jiuwenswarm-start app                 # Gateway ws://127.0.0.1:19000/ws + AgentServer
ss -ltn | grep 19000                  # Mac: lsof -iTCP:19000 -sTCP:LISTEN
```

Stop: `jiuwenswarm-stop` (or kill the gateway/agentserver PIDs). Logs: follow the process stdout or your install’s log dir.

## 2. Install dsh (the Cordis host shell)

```bash
npm install -g @deepseek-ai/dsh       # or: brew install dsh  (needs ≥ 0.2)
dsh --version
```

## 3. Add this adapter

```bash
git clone https://github.com/Birfy/dsh-jiuwen-adapter.git && cd dsh-jiuwen-adapter
dsh plugin --profile web add "$PWD"
dsh plugin --profile headless add "$PWD"
# Pin the default model to jiuwen for both profiles:
for p in web headless; do
  printf -- '- id: agent-default-model\n  config:\n    provider: jiuwen\n    model: jiuwen-default\n' \
    > ~/.dsh/profiles/$p/cordis.patch.yml
done
```

One-shot alternative: `npm run bare-dsh` — see [bare-dsh.md](./bare-dsh.md).

## 4. Chat

```bash
dsh --profile headless "Say hello and end with QUICKSTART-OK"
dsh --profile web --no-open --port 3291    # open the printed http://127.0.0.1:3291/?token=… URL
```

Useful slash commands once chatting: `/jiuwen status`, `/jiuwen models`, `/jiuwen help`. Destructive actions need a trailing `confirm` (e.g. `/jiuwen delete confirm`).

## 5. Verify

```bash
cd /path/to/dsh-jiuwen-adapter
npm test                  # unit + mock host
npm run smoke:live        # against the real Gateway on :19000 (SKIP if offline)
```

## Next

- Every config key: [configuration.md](./configuration.md)
- Gateway wire + events: [gateway.md](./gateway.md)
- dsh plugin cooperation: [dsh-integration.md](./dsh-integration.md)
- Known Gateway limits: [known-issues.md](./known-issues.md)
- FAQ: [troubleshooting.md](./troubleshooting.md)
