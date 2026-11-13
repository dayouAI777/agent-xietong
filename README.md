# agent-xietong · 多 Agent 协作工作台

一个本地跑的多 agent 工作台：任务派单 → 执行 → 结果回流，带实时看板和指挥指令台。

## 目录

```
agent-console/
  bin/agentctl.js        CLI 入口（demo / dispatch / status / doctor / complete …）
  lib/
    server.js            HTTP + SSE 服务，REST 接口
    runner.js            调度器：取任务、跑 agent、写状态
    adapters.js          agent 适配器（内置 + 外部 CLI）
    router.js            自然语言命令 → agent 的路由规则
    store.js             任务/状态持久化（data/tasks/*.json）
    bus.js               事件总线（SSE 推送）
    control.js           人工干预：暂停/取消/完成/删除
    doctor.js            环境体检（依赖、网络出口、代理、凭证）
  web/                   前端（原生 JS，无构建）
  config/agents.json     agent 注册表
  gen/gen_image.py       生图脚本（朽木通道）
```

## 启动

```bash
cd agent-console
node bin/agentctl.js doctor          # 先体检，看哪条链路不通
node bin/agentctl.js demo --port 7788
```

浏览器打开 `http://127.0.0.1:7788`（只绑 127.0.0.1，不对外）。

Windows 下工作区根目录有 `launch-console.bat`，双击即启动并打开浏览器。

## 派任务

**看板上的「任务指令」框**，用前缀指定 agent：

| 写法 | 路由到 |
| --- | --- |
| `跑 node -v` / `$ ls` | shell（本地命令，零成本） |
| `生图 一只白色猫` | imagegen（朽木通道） |
| `codex 写个快排` / 直接说人话 | codex-http（本地 codex 凭证 + HTTP responses） |
| `豆包 写文案` | doubao（需 ARK key） |
| `DSH 列一下目录` / `@dsh xxx` | dsh（DSH 桌面运行时的本地端点，免 key，能跑工具） |
| `deepseek xxx` | deepseek（DeepSeek 官方 API，需 key） |
| `@analyst 推演风险` | analyst（本地规则推演） |

未匹配任何规则的句子会交给 codex-http 理解执行（它比规则更懂人话）。

**输入框下方的快捷键**：点 chip 直接在行首插 `@alias`（`shell` / `codex` / `dsh` / `生图` / `推演` / `node` / `py`），再点同一个取消点名；输入框首词是 `@xxx` 时对应 chip 高亮；当前不可用的 agent 置灰。

## DSH 本地端点

DSH 自己起的 HTTP 服务，工作台通过它派单，不需要 key：

| 项 | 值 |
| --- | --- |
| 地址 | `http://127.0.0.1:7789`（只绑本机） |
| 端点文件 | `~/.dsh/endpoint.json` → `{port,pid,started_at}` |
| 启动 | `cmd /c "%USERPROFILE%\.dsh\endpoint\start.cmd"`（幂等） |
| 接口 | `GET /v1/health`、`POST /v1/run`、`GET /v1/version` |
| 免费额度 | 用 DSH 桌面登录凭据（`~/.dsh/.credentials.yaml`），无额外计费 |

限制：单并发（第二个请求 429）；无鉴权，本机任何进程可调；执行在 DSH 自己的 workspace-write 沙箱里，cwd 不是本项目目录；不开机自启，关会话即停。端点没起时工作台会自动拉起一次，失败则在任务错误里给出启动命令。

**右侧「指挥指令」小面板**：同样走路由，能派就当场派单，结果回写到指令下面；派不了的挂成待办。

## CLI

```bash
node bin/agentctl.js status                       # 任务状态一览
node bin/agentctl.js dispatch --agent shell --title "x" --prompt "echo hi"
node bin/agentctl.js doctor [--apply]             # 体检 / 自动写入探测到的代理
```

## 凭证放哪（不入库）

代码只从本机读，仓库里不放任何 key：

| Agent | 读取位置 |
| --- | --- |
| codex-http | `~/.codex/auth.json`（本机 `codex login` 生成） |
| deepseek | 环境变量 `DEEPSEEK_API_KEY`，或 `~/.dsh/.api-key` |
| doubao | 环境变量 `ARK_API_KEY` + `DOUBAO_MODEL`（接入点 ID） |
| imagegen | 环境变量 `UMAPIS_KEY`，或 `Desktop/生图API/密匙.txt` |

## 两台电脑同步注意

`config/agents.json` 里的路径用占位符，换机器不用改：

- `${PROJECT}` → 仓库当前目录
- `${APPDATA}` / `${USERPROFILE}` → 系统环境变量

不要把以下内容提交：`agent-console/data`（任务与指令记录）、`agent-console/runs`（产物）、`gen/out`（图片）、任何 `auth.json` / `.api-key` / `密匙.txt`。

新机器首次启动：跑 `doctor` 看缺什么，按提示装 CLI 或配 key；没有的 agent 在看板上显示 ✘，不影响其他 agent。

## 同步到仓库

GitHub 在本机需要走代理，而且必须用 openssl 后端（Windows 默认 schannel 会 TLS 握手失败）：

```bash
git config http.sslBackend openssl
HTTPS_PROXY=http://127.0.0.1:10090 git push
```

代理端口按本机实际的改（`netstat -ano | findstr LISTENING` 找代理客户端）。

另一台电脑克隆后，先跑 `node bin/agentctl.js doctor`，按提示补 CLI / 配 key。

## 已知状态

- `codex` / `codex-run`（CLI 直调）：本机 websocket 通道不通，已停用，改走 `codex-http`
- `claude-code`：需要 cc-studio 中转 `127.0.0.1:18100` 在跑
- `gemini-cli` / `opencode`：未安装
