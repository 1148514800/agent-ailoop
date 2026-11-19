# Agent Autoloop Console

Agent Autoloop 的独立本地管理控制台。在浏览器里查看任务、控制规则、回复卡片并跟踪中台事件。

![运行总览，临时测试中台](docs/screenshots/overview.png)

## 启动

需要 Node.js 24 或更新版本、npm，以及已经安装并配置本人密钥的 [Agent Autoloop](https://github.com/KKKKhazix/agent-autoloop)。控制台默认连接当前账号的中台。中台的安装方式见 [原项目安装说明](https://github.com/KKKKhazix/agent-autoloop/blob/main/INSTALL.md)。

### macOS 双击启动

在 Finder 双击项目根目录的 [启动控制台.command](启动控制台.command)。它会启动尚未运行的本机中台和 Web 控制台，等待两者就绪，再打开默认浏览器。第一次启动控制台会安装依赖并构建页面。已运行的服务直接复用，关闭启动终端后服务仍在后台运行。

浏览器需要登录时，输入启动窗口显示的控制台登录码。由此脚本启动的控制台会把登录码保留在本人的私有日志目录 `~/Library/Logs/Agent Autoloop Console`，重复双击时可以再次看到。通过其他方式启动的控制台继续使用它原先显示的登录码。

如果 Finder 提示没有执行权限，在项目目录运行 `chmod +x ./启动控制台.command`。启动器使用固定端口，默认 `4175`。如果端口被其他程序占用，可以用 `AUTOLOOP_CONSOLE_PORT` 指定另一个端口。

### 命令行启动

在本项目目录运行：

```sh
npm ci
npm run build
npm start
```

打开终端显示的本机地址，默认是 [http://127.0.0.1:4175](http://127.0.0.1:4175)。输入同一终端显示的**控制台登录码**。登录后可在「运行设置」检查中台状态。控制台登录码每次启动重新生成，浏览器会话最长 12 小时。终端可以保持打开，按 Ctrl+C 退出控制台。

| 系统 | 中台运行方式 | 默认读取的配置 |
| --- | --- | --- |
| Windows | 原安装器通常配置登录后启动。手动运行时在 PowerShell 执行 `agent-autoloop up`。 | `%USERPROFILE%\.agent-autoloop\config.json` |
| macOS | 原安装器通常用 launchd。手动运行时在终端执行 `agent-autoloop up`。 | `~/.agent-autoloop/config.json` |
| Linux | 原安装器通常用 systemd 用户服务。手动运行时在终端执行 `agent-autoloop up`。 | `~/.agent-autoloop/config.json` |

只有在中台尚未运行时才执行 `agent-autoloop up`。`npm run dev` 用同一个本地代理启动开发模式，Vite 自动重建前端，改动后刷新网页即可。

### 自定义本机配置

- `AGENT_AUTOLOOP_HOME` 指向中台配置目录。
- `AUTOLOOP_CONSOLE_PORT` 指定控制台监听端口，默认 `4175`。
- `AUTOLOOP_HUB_URL` 显式指定中台的回环地址，例如 `http://127.0.0.1:3350`。默认使用本机配置的 `url`，如果它是公网地址，会尝试使用配置里的 `hub.listen` 回环入口。

macOS 或 Linux 示例：

```sh
AGENT_AUTOLOOP_HOME="/path/to/hub" AUTOLOOP_CONSOLE_PORT=4180 npm start
```

Windows PowerShell 示例：

```powershell
$env:AGENT_AUTOLOOP_HOME = "C:\path\to\hub"
$env:AUTOLOOP_CONSOLE_PORT = "4180"
npm start
```

## 数据与操作

| 页面 | 中台接口及口径 |
| --- | --- |
| 运行总览 | `GET /v1/state` 和 `GET /healthz`。进行中按已领取统计，排队数扣除重试，今天和最近七天按中台的完成时间用量统计。条形图按各自的七天已报 Token 或费用总量缩放。缺失轮次单列。 |
| 任务轮次 | `GET /v1/state?before=<nextBefore>` 翻页。筛选覆盖已加载的页面，活跃轮次取最新快照。用 `GET /v1/runs/:id/why` 读日志并展示时间线，用 `POST /v1/runs/:id/cancel` 请求停止。正在跑的轮次等 Worker 确认停止。 |
| 自动化规则 | `state.lines` 提供触发类型、统计与暂停状态。用 `POST /v1/rules/:name/{run,pause,resume,replay}` 操作。补跑起始时间来自恢复响应，或手动输入带时区的 ISO 时间。 |
| Agent | `state.agents` 提供 Agent 类型、Worker、心跳和统计。共享 Worker 的 Agent 共用在线信号。 |
| 审批中心 | `state.cards` 和 `state.recentCards`。选项按原顺序提交从 0 开始的 `choice`，自由回复提交 `text`。通知结案提交 `reason` 到 `POST /v1/cards/:id/resolve`。 |
| 事件动态 | 先读 `state.seq`，再订阅 `GET /v1/stream?after=<seq>`。重连从最后处理的序号续读，浏览器保留本次会话最新 200 条。快照随事件刷新，并定期检查连接与心跳。 |
| 运行设置 | `GET /healthz` 返回运行提交，`state` 提供时区、Agent、规则和通道信息。最近一次读取失败只保留在当前网页会话。 |

协议基线为 Agent Autoloop 提交 `ca5c0ffe2c92be17502c4f1a75cdb71823eeafef`。可参考原项目的 [本人 API 和暂停补跑协议](https://github.com/KKKKhazix/agent-autoloop/blob/ca5c0ffe2c92be17502c4f1a75cdb71823eeafef/docs/protocol.md#本人看全局回答结案停止)。

## 本地安全边界

浏览器只访问控制台的同源 API。Node 从本机 `config.json` 获取本人密钥，只随固定白名单请求发送给回环中台，禁止上游重定向。控制台用短期内存会话、HttpOnly 和 SameSite=Strict Cookie、精确 Host 和 Origin 校验及写操作 CSRF 校验保护本机访问。代理只读配置文件，事实只转发展示用字段。浏览器只在本地存储主题偏好。

控制台面向可信本机环境，默认只监听 `127.0.0.1`。局域网或远程部署需要单独实现 HTTPS、真正的用户身份验证和授权，并按新域名重设 Host、Origin 和 Cookie 策略。应保护可读取中台配置的系统账户，以及可能与该回环主机共享浏览器 Cookie 的本地服务。

## 验证

```sh
npm run typecheck
npm run build
npm test
npx playwright install chromium
npm run test:browser -- --screenshots
```

浏览器测试默认从同级的 `agent-autoloop` 源码启动临时中台。可用 `AUTOLOOP_SOURCE` 指定源码路径，也可用 `AUTOLOOP_BROWSER_CHANNEL=chrome` 选择已安装的 Chrome。测试使用临时目录、随机端口和测试 Worker 请求，结束后退出进程并清理目录。截图只包含临时中台中的虚构资料。

已在 macOS 上使用 Node.js 24.22.3 和 Chrome 验证。类型检查、生产构建、5 项自动化测试（含 macOS 启动与复用）和真实 HTTP 浏览器验收均通过。浏览器验收覆盖零号审批选项、手机文字回复、通知结案、规则控制、轮次停止确认、历史分页及筛选、断线期间事件续读和中台离线状态。开发模式通过启动和认证拦截检查。测试 Worker 用协议上报领取与停止确认。

- [运行总览](docs/screenshots/overview.png)
- [桌面审批](docs/screenshots/approvals.png)
- [手机审批](docs/screenshots/mobile-approval.png)
- [规则详情](docs/screenshots/rules.png)
- [轮次时间线](docs/screenshots/run-detail.png)
- [浅色主题](docs/screenshots/settings-light.png)

## 已知限制

- 审批历史受中台快照限制，最多显示最近 20 张已处理卡片。暂停详情最多显示最近 20 条待补跑事件，实际补跑范围由中台按起始时间计算。
- 时间线展示中台日志。当前协议没有 Agent 实时输出流、模型和凭据管理或规则文件编辑接口。
- 外部定时任务只展示计划。中台规则的暂停、运行和补跑操作只针对中台可控制的规则。
- 上游版本较旧时，可能缺少用量、规则控制或其他扩展字段。浏览器验收在 macOS 上执行，Windows 与 Linux 的本地启动流程尚未实机验证。
