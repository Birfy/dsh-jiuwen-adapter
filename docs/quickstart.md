# Quickstart（从零开始，Mac / Linux）

本文每条命令都在一台全新的 Linux 环境中按顺序跑过（2026-10-29：Node 22.21、Python 3.13、uv、dsh 0.2.1-rc.2、workswarm 0.2.7），最后拿到了真实回复。Mac 的命令写在对应位置。

## 0. 准备

| 依赖 | 版本 | 检查 |
|---|---|---|
| Node.js | **≥ 22** | `node --version` |
| Python | **3.11–3.14**（JiuwenSwarm） | `python3 --version` |
| uv（推荐）或 pip | 任意 | `uv --version` |
| git | 任意 | `git --version` |

```bash
# macOS
brew install node@22 python@3.13 uv git
# Debian/Ubuntu
sudo apt-get install -y python3 python3-venv git && curl -LsSf https://astral.sh/uv/install.sh | sh
# Node 22：https://nodejs.org 或 nvm install 22
```

## 1. 安装并启动 JiuwenSwarm（Agent 脑）

```bash
uv venv ~/jiuwenswarm-venv --python 3.13
source ~/jiuwenswarm-venv/bin/activate
uv pip install workswarm            # 国内镜像：uv pip install workswarm -i https://pypi.tuna.tsinghua.edu.cn/simple
jiuwenswarm-init                    # 首次：生成 ~/.jiuwenswarm/
```

（不用 uv 也可以：`python3 -m venv ~/jiuwenswarm-venv && source ~/jiuwenswarm-venv/bin/activate && pip install workswarm`。从源码装：`git clone https://github.com/openJiuwen-ai/jiuwenswarm.git && cd jiuwenswarm && uv venv && uv pip install -e .`。）

### 配置模型：`~/.jiuwenswarm/config/.env`

```dotenv
# 必填（OpenAI 兼容接口示例）
API_BASE=https://api.deepseek.com          # 模型服务地址
API_KEY=sk-xxxxxxxxxxxxxxxx                # 你的 key（不要提交到 git）
MODEL_NAME=deepseek-chat                   # 模型名
MODEL_PROVIDER=OpenAI                      # 协议：OpenAI（兼容）或 Anthropic
ENDPOINT_PROFILE=deepseek                  # openai / deepseek / openrouter / siliconflow / dashscope / openai_compatible / ollama / lmstudio / vllm / sglang
# 可选
# CUSTOM_HEADERS=
# EMBED_API_BASE= / EMBED_API_KEY= / EMBED_MODEL=          # 记忆向量
# VIDEO_API_BASE= / VIDEO_API_KEY= / VIDEO_MODEL_NAME= / VIDEO_PROVIDER=
```

也可以在 `~/.jiuwenswarm/config/config.yaml` 或 JiuwenSwarm Web 界面（More → Configuration）里设置默认模型。

### 启动（只要后端，不需要 Jiuwen 前端）

```bash
jiuwenswarm-start app               # 前台运行，Ctrl-C 停止；`jiuwenswarm-start` 不带参数 = all（含前端 :5173）
```

`app` 模式会拉起 AgentServer + Gateway。等价的手动方式（验证环境里就是这样常驻运行的）：两个终端分别执行 `jiuwenswarm-agentserver` 和 `jiuwenswarm-gateway`（Gateway 端口可用 `WEB_PORT` 或 `--port` 改，默认 19000）。

另开一个终端确认 Gateway 在监听：

```bash
ss -ltn | grep 19000                        # Linux
lsof -nP -iTCP:19000 -sTCP:LISTEN           # macOS
# 期望：127.0.0.1:19000 LISTEN  （WebSocket 地址 ws://127.0.0.1:19000/ws）
```

## 2. 安装 dsh（宿主，≥ 0.2）

```bash
npm install -g @deepseek-ai/dsh     # 或 macOS：brew install dsh
dsh --version                       # 例：0.2.1-rc.2；0.1.x 不兼容（permissionPresets.catalog 缺失）
```

> 全局目录无写权限时：`npm install -g --prefix ~/.local @deepseek-ai/dsh` 并把 `~/.local/bin` 加进 `PATH`。

## 3. 安装本适配器

```bash
git clone https://github.com/Birfy/dsh-jiuwen-adapter.git
cd dsh-jiuwen-adapter
dsh plugin --profile web add "$PWD"         # Web UI profile
dsh plugin --profile headless add "$PWD"    # 命令行 profile
```

`plugin add` 会把包里的 `cordis.patch.yml`（注册 `llm-jiuwen`、模型 `jiuwen-default` / `jiuwen-swarm`）作为 bundle 层自动加载。

### 让 dsh 默认用 Jiuwen

写入（或合并进）profile 的用户补丁 `~/.dsh/profiles/<profile>/cordis.patch.yml`（设置了 `DSH_HOME` 则为 `$DSH_HOME/profiles/...`）：

```bash
for p in web headless; do
cat > ~/.dsh/profiles/$p/cordis.patch.yml <<'YML'
- id: agent-default-model
  config:
    provider: jiuwen
    model: jiuwen-default
# 可选：覆盖适配器配置
# - id: llm-jiuwen
#   config:
#     gatewayURL: ws://127.0.0.1:19000/ws
YML
done
```

检查：`dsh --profile headless --dump-config | grep -A3 "id: llm-jiuwen"`。

## 4. 第一次对话

### 命令行

```bash
dsh --profile headless "用一句话介绍你自己，并以 QUICKSTART-OK 结尾"
```

实测输出（约 7 秒）：

```
我是由JiuwenSwarm创建的个人智能体，能理解你的目标并完成各类任务，QUICKSTART-OK
```

多轮：`dsh --profile headless --json "记住：我喜欢榴莲"` 的第一行给出 `sessionId`，然后 `dsh --profile headless --session-id <sessionId> "我喜欢什么？"`。

### Web UI

```bash
dsh --profile web --no-open --port 3291
# 输出：dsh web: http://127.0.0.1:3291/?token=xxxxxxxx
```

在浏览器打开打印出的**带 `?token=` 的完整地址**（它会设置登录 cookie 后 303 跳到 `/`；直接开 `/` 会没有权限）。点 Continue → New Session，底部模型显示 **Jiuwen Default**，输入：

```
Say hello in one short sentence and end with WEB-QUICKSTART-OK
```

实测回复（Completed in 4s）：`Hello! Ready for the quick start. WEB-QUICKSTART-OK`。Jiuwen 的思考和工具活动折叠在 "Completed in Ns" 里。

远程机器：`ssh -L 3291:127.0.0.1:3291 <host>` 后本地打开同一地址。

## 5. 停止 / 重启

| 组件 | 停止 | 重启 |
|---|---|---|
| dsh web（前台） | Ctrl-C | 重新运行 `dsh --profile web --no-open --port 3291`（每次 token 不同） |
| dsh web（后台） | `pkill -f "dsh --profile web"` | 同上 |
| JiuwenSwarm | 启动它的终端 Ctrl-C（`jiuwenswarm-stop` 只管 `jiuwenswarm-start debug`） | `jiuwenswarm-start app` |
| 改了适配器代码 / 配置 | — | 重启 dsh（插件是 link 安装，`git pull` 后重启即可） |

## 6. 常见错误

| 现象 | 原因 / 处理 |
|---|---|
| `dsh: TRANSPORT: Jiuwen Gateway WebSocket failed: ws://127.0.0.1:19000/ws?...` | Gateway 没启动或端口不对 → `jiuwenswarm-start app`，`ss -ltn \| grep 19000`；自定义地址用 `JIUWEN_GATEWAY_URL=ws://host:port/ws` |
| 回复「还没有配置可用的模型…」 | 填好 `.env` 的 `API_BASE/API_KEY/MODEL_NAME/MODEL_PROVIDER` 后重启 JiuwenSwarm |
| 401 / WS 立刻断开 | Gateway 开了鉴权 → `export JIUWEN_ACCESS_TOKEN=...` 或 `JIUWEN_COOKIE='access_token=...'` |
| `permissionPresets.catalog is not a function` | dsh 太旧（0.1.x）→ 升级到 ≥ 0.2 |
| Web 打开 `/` 提示未授权 | 必须用打印的 `?token=` 地址 |
| 底部模型不是 Jiuwen Default | profile 的 `cordis.patch.yml` 没写 `agent-default-model`，或改完没重启 dsh |
| `npm install -g` 报 `ENOSPC` 但磁盘有空间 | inode 用尽（`df -i`）→ `npm cache clean --force` 或清理大目录 |
| 图片发了但模型看不到 | Jiuwen 的模型需支持视觉 |

更多：[troubleshooting.md](./troubleshooting.md) · 配置大全：[configuration.md](./configuration.md) · Gateway 能力：[gateway.md](./gateway.md)。
