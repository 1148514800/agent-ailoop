# 接入飞书私聊和审批

飞书私聊使用本机控制台内的 AI Router。Router 返回文字时，机器人在原消息下回复。Router 派发任务时，中台按现有规则生成轮次，Worker 执行，控制台根据中台状态回复回执、审批等待、重试和结果。轮次的审批仍由飞书通道发送和核验卡片。浏览器继续使用原有本机访问和会话检查。

## 准备飞书应用

1. 在飞书开放平台打开已有企业自建应用，开启机器人能力，确保应用可见范围包含授权用户。使用官方 `lark-cli`，在运行控制台与中台的同一个系统账号下配置同一应用。命令和事件格式已用 1.0.100 核对。安装和已有应用配置见 [官方 CLI 指南](https://github.com/larksuite/cli#installation--quick-start)。
2. 应用开通 `im:message.p2p_msg:readonly`（接收机器人私聊消息）和 `im:message:send_as_bot`（机器人发送及回复消息）。在「事件与回调 → 事件配置」选长连接，添加 `im.message.receive_v1`。 [私聊事件文档](https://github.com/larksuite/cli/blob/main/skills/lark-event/references/lark-event-im.md)
3. 使用审批时，保留卡片通知发送权限并加上 `im:message:readonly`，用于 CLI 读取原交互卡片。在「事件与回调 → 回调配置」选长连接，添加 `card.action.trigger`，发布应用版本。 [卡片回调文档](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-card-action-reply.md)
4. 用 `lark-cli auth status` 检查本机 CLI 配置和身份。机器人命令使用 `--as bot`。确认授权用户的 OpenID 属于同一个应用。控制台和审批通道在同一机器、同一系统账号、同一 CLI 配置下使用共享事件总线，每个 EventKey 各有一个消费者。 [长连接与共享总线](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md)

## 启用聊天入口

在中台数据目录（`AGENT_AUTOLOOP_HOME`，默认 `~/.agent-autoloop`）新建 `feishu-chat.json`。macOS/Linux 可运行 `chmod 600 ~/.agent-autoloop/feishu-chat.json`。以下是示例，替换示例 OpenID 和项目 ID 后保存。

```json
{
  "enabled": true,
  "maxLength": 2000,
  "maxConcurrent": 3,
  "users": {
    "ou_example": { "projects": ["demo"], "defaultProject": "demo" },
    "ou_chat_only": { "projects": [] }
  }
}
```

`program` 可选填 `lark-cli` 的绝对路径，省略时使用控制台进程的 PATH。每个白名单用户可在其机器人私聊中发送普通文本，只有 `projects` 允许的项目能派发任务。省略 `defaultProject` 时先用 `/use <projectId>` 选择。最大长度为 4000 字，并发限制为 1 至 20。配置启动后一处监听，启用、禁用或更换程序路径后重启控制台。进程在接收和派发前重新核验白名单。

- `/help` 显示命令。
- `/projects` 列出当前可用的授权项目。
- `/use demo` 切换至项目 `demo`。
- `/current` 查看当前选择。

入口接受顶层私聊文本。群聊、机器人消息、引用回复、线程和 `merge_forward` 等非文本事件会忽略。CLI 只提供转换后的消息字段，未标记的单条转发或手工粘贴可能与普通文本相同。真实单条转发的事件行为待验收。聊天里的“同意”不构成审批，审批通过原有卡片操作。

## 配置原有审批通道

已配置飞书审批时沿用现有配置。首次配置时，用 `npm run hub -- key new channel feishu` 为本机通道生成密钥。将下列片段**合并**进对应文件的 `channels`，保留其它通道和字段。

`rules.json` 的片段如下。

```json
{ "channels": { "feishu": { "name": "飞书", "answerers": ["ou_example"] } } }
```

`config.json` 的片段如下。

```json
{ "channels": { "feishu": { "key": "填本机通道密钥", "user": "ou_example" } } }
```

如果 CLI 未加入中台服务的 PATH，在 `channels.feishu.lark` 中设置与聊天入口相同的可执行文件绝对路径。按现有规则设置卡片通知范围。需要飞书审批的规则可以使用 `"channels": ["feishu"]`。重启中台服务后，卡片仍由配置中的审批接收人处理。私聊发送者名单不改变卡片的接收人或审批权限。 [中台通道协议](../agent-autoloop/docs/protocol.md)

## 核对连接和恢复

在「运行设置 → 飞书」可以查看审批通道、聊天监听、实际接收验证和最近错误。只出现监听就绪时，接收授权仍显示待验证。使用本人已授权私聊发送 `/help` 来确认事件已经实际送达。若 CLI 未授权、应用未发布权限或未开启事件订阅，先完成上面的应用配置。

私有数据库 `feishu-chat.sqlite` 保存消息编号、选定项目、关联轮次和待发回复。重复消息不再调用模型。重启后继续跟踪已有事件。若进程在分类尚未留下可查事件时退出，控制台提示未确认，并保留去重记录。回复每阶段最多尝试五次，发送失败不会重跑任务。网络中断期间飞书是否补送事件取决于其长连接服务。对已处理任务如需复核，使用控制台中的 Run ID。摘要只取简短文字并脱敏，详细日志留在本机。

若两路消费没有共享同一总线，先核对中台与控制台所用系统账号、应用配置和 CLI 版本。可使用 `lark-cli event status --json` 查看总线。保留现有的卡片监听，每个应用只运行一个控制台聊天入口。
