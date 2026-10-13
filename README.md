# Livynq

> 轻量、本地优先、Agent 原生的开源智能家居中枢 · A lightweight, local-first, agent-native smart home hub.

- **HomeKit 一等公民**：所有设备经 HAP 桥进入 Apple Home，配件 ID 永久稳定（重启、隐藏再显示都不丢房间与自动化）。
- **兼容 Home Assistant 生态**：原生支持 HA MQTT Discovery（Zigbee2MQTT、Tasmota、ESPHome-MQTT…），设备自带 HA 风格实体 ID（`light.living_room`）。
- **Agent 原生**：内置 MCP Server（HTTP + stdio）、带 `--json` 的 CLI、REST/WebSocket API，令牌分级授权、全量审计。
- **依赖极少**：Node.js 24 直接运行 TypeScript，内置 SQLite，无需 Python / Docker / 数据库 / MQTT Broker。

完整设计见 [docs/technical-design.md](docs/technical-design.md)，当前进度见 [docs/m0.md](docs/m0.md)。

> 状态：**M0 原型**。接口可能变化，暂不建议用于生产环境。

## 快速开始

需要 Node.js ≥ 24.6 与 pnpm。

```bash
pnpm install
pnpm build:web                # 构建 Web 界面（可选，未构建时只有 API）
pnpm start --demo          # 启动，并加入 6 个模拟设备
```

首次启动会在日志中打印登录链接：`http://<ip>:8581/#token=lvq_...`。之后可在本机运行 `pnpm livynq login-url` 重新获取。

接入真实设备（任何发布 HA MQTT Discovery 的设备）：

```bash
pnpm start --mqtt mqtt://192.168.1.10        # 连接已有 Broker（如 Zigbee2MQTT 使用的 Mosquitto）
pnpm start --builtin-broker                  # 或启用内置 Broker（:1883），让设备直接连 Livynq
```

**Apple Home**：启动后在 Web 界面「Apple Home」页扫码，或在「家庭」App → 添加配件 → 输入日志中的 8 位配对码。

## CLI

CLI 与运行中的实例通信；本机自动使用 `~/.livynq/secrets/cli.token`，远程用 `--url` / `--token`（或 `LIVYNQ_URL` / `LIVYNQ_TOKEN`）。

```bash
pnpm livynq status
pnpm livynq devices list --room 卧室
pnpm livynq devices get light.living_room_ceiling --json
pnpm livynq call light.living_room_ceiling set_brightness --brightness 40
pnpm livynq call "Coffee Machine" turn_on
pnpm livynq tokens create claude --scope control
```

目标可以是实体 ID、设备 ID、设备名或别名。所有命令支持 `--json`，退出码稳定（3 不可达、4 无权限、5 未找到）。

## 让 AI Agent 控制家

在 Web 界面「Agent」页或用 CLI 创建令牌（`read` 只读 / `control` 可控制 / `admin` 可管理），然后配置 MCP 客户端：

```jsonc
// 通过 HTTP（推荐，局域网内任意机器）
{ "mcpServers": { "livynq": { "type": "http", "url": "http://livynq.local:8581/mcp",
  "headers": { "Authorization": "Bearer lvq_xxx" } } } }

// 通过 stdio（本机已安装 livynq 命令时）
{ "mcpServers": { "livynq": { "command": "livynq", "args": ["mcp"], "env": { "LIVYNQ_TOKEN": "lvq_xxx" } } } }
```

工具：`home_overview`、`list_devices`、`get_device`、`get_history`，以及仅对 `control` 令牌开放的 `control_device`。每台设备可设置对 Agent「可见 / 只读 / 隐藏」；所有调用以 `agent:<令牌名>` 记入审计日志。

## 配置

数据目录默认 `~/.livynq`（`--data` 或 `LIVYNQ_DATA_DIR` 修改），可选配置文件 `~/.livynq/livynq.yaml`：

```yaml
server: { port: 8581 }
homekit: { enabled: true, name: Livynq Bridge, port: 51826 }
mqtt:
  url: mqtt://192.168.1.10
  username: livynq
  password: secret
  broker: { builtin: false, port: 1883 }
```

优先级：默认值 < `livynq.yaml` < 环境变量 < 命令行参数。**请备份整个数据目录**，其中 `secrets/hap/` 保存 HomeKit 配对信息，丢失后需在 Apple Home 中重新添加。

## Docker

HomeKit 依赖 mDNS，必须使用 host 网络：

```bash
docker build -t livynq .
docker run -d --network host -v livynq:/data livynq --demo
```

## 开发

```bash
pnpm dev          # 后端热重载（含模拟设备）
pnpm dev:web      # 前端开发服务器，代理到 :8581
pnpm test         # node:test，无额外测试框架
pnpm typecheck
```

```
apps/server            livynq 命令：HTTP/WS API、MCP 端点、CLI
apps/web               Web 界面（React + Tailwind）
packages/model         能力模型（Matter 对齐）、设备类型、实体 ID、接口类型
packages/core          注册表、状态、事件总线、命令路由、SQLite、令牌
packages/adapter-mqtt  HA MQTT Discovery 适配器 + 内置 Broker
packages/exporter-homekit  HAP 桥（HAP-NodeJS）
packages/agent         MCP 工具与 Agent 友好的设备摘要
```

## 许可证

[Apache-2.0](LICENSE)
