# Livynq

> 轻量、本地优先、Agent 原生的开源智能家居中枢 · A lightweight, local-first, agent-native smart home hub.

- **HomeKit 一等公民**：所有设备经 HAP 桥进入 Apple Home，配件 ID 永久稳定（重启、隐藏再显示都不丢房间与自动化）。
- **兼容 Home Assistant 生态**：原生支持 HA MQTT Discovery（Zigbee2MQTT、Tasmota、ESPHome-MQTT…），设备自带 HA 风格实体 ID（`light.living_room`）。
- **Agent 原生**：内置 MCP Server（HTTP + stdio）、带 `--json` 的 CLI、REST/WebSocket API，令牌分级授权、全量审计。
- **依赖极少**：Node.js 24 直接运行 TypeScript，内置 SQLite，无需 Python / Docker / 数据库 / MQTT Broker。

- **从 Home Assistant 迁移**：导入区域、设备、实体 ID 与自动化（先预演、可撤销）；接管 Zigbee2MQTT 网络无需重新配对。
- **自动化**：与 HA 相同的 YAML 结构，带运行追踪与版本历史；Agent 只能提交"禁用草稿"。
- **单文件安装**：一个可执行文件即包含运行时、界面与核心插件。

完整设计见 [docs/technical-design.md](docs/technical-design.md)；进度见 [M0](docs/m0.md)、[M1](docs/m1.md)；插件开发见 [docs/plugins.md](docs/plugins.md)。

> 状态：**M1 Alpha**。接口可能变化，暂不建议用于生产环境。

## 安装（Linux / macOS）

```bash
curl -fsSL https://raw.githubusercontent.com/gongbin/livynq/main/installers/install.sh | sh
```

下载单文件程序到 `/opt/livynq`，创建 `livynq` 服务用户（含串口权限）并注册 systemd / launchd 服务。之后运行 `livynq login-url` 获取登录链接。也可以从 Releases 页面直接下载 `livynq-<系统>-<架构>` 运行：`./livynq start`。

## 从源码运行

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
pnpm livynq doctor          # 检查安装：配置、权限、端口、网络、串口、插件
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

## 自动化

```yaml
# night.yaml —— 与 Home Assistant 的 automations.yaml 写法相同
- alias: Hallway night light
  mode: restart
  triggers:
    - trigger: state
      entity_id: binary_sensor.hallway_motion
      to: "on"
  conditions:
    - condition: sun
      after: sunset
      before: sunrise
  actions:
    - action: light.turn_on
      target: { area_id: hallway }
      data: { brightness_pct: 30 }
    - wait_for_trigger:
        - trigger: state
          entity_id: binary_sensor.hallway_motion
          to: "off"
          for: "00:02:00"
    - action: light.turn_off
      target: { area_id: hallway }
```

```bash
pnpm livynq automations apply night.yaml --dry-run   # 校验
pnpm livynq automations apply night.yaml
pnpm livynq automations traces hallway_night_light   # 每次运行的触发原因、条件结果与步骤
```

日出日落需要在 `livynq.yaml` 中设置 `location: { latitude, longitude }`。暂不支持 Jinja 模板。

### 手机通知

自动化里用 `notify.notify`（HA 的 `notify.mobile_app_xxx` 写法也能用）发消息：

```yaml
    - action: notify.notify
      data: { title: 前门, message: 门开了, data: { url: "/#/devices" } }
```

消息会推送到在“设置 → 通知”里开启了通知的手机和电脑（Web Push，不经过 Livynq 云）；Agent 请求审批时也会推送给管理员。脚本可以调用 `POST /api/v1/notify`。

浏览器只在 https 下允许推送和把网页添加到主屏幕（iPhone 需要先“添加到主屏幕”）。给 Livynq 配一张证书，例如用 Tailscale 的 `tailscale cert`，或自己域名的证书：

```yaml
# livynq.yaml
server:
  https: { port: 8582, cert: certs/home.crt, key: certs/home.key }   # 相对数据目录
```

原来的 http 端口继续保留给 CLI 和局域网访问；`livynq doctor` 会检查证书有效期。

## 内置助手（大模型）

在“设置 → 助手”里选择服务商并填写 API 地址、Key 和模型名：Claude，或任何 OpenAI 兼容接口（OpenAI、DeepSeek、通义千问、Kimi、智谱 GLM，以及本机 Ollama / LM Studio，可完全离线）。Key 只保存在主机上（`secrets/assistant.json`，仅所有者可读）。

- “助手”页面：用自然语言查询和控制设备，权限与当前令牌一致，开锁等高风险操作仍需人工审批。
- 说“每天日落时打开客厅灯”会生成自动化草稿卡片；自动化编辑器顶部也可以“用一句话描述”。生成结果都会先校验，保存与否由你决定。

## 摄像头

“添加设备 → 摄像头”：局域网自动发现 ONVIF 摄像头（海康、大华、TP-Link、Reolink 等），或填写 RTSP 地址。Livynq 只在有人观看时直接从摄像头拉流并转给浏览器播放，不经过云端、不需要 ffmpeg；移动 / 人形侦测会变成可用于自动化的传感器。

## 从 Home Assistant 迁移

```bash
pnpm livynq import ha /path/to/homeassistant/config --dry-run   # 或 HA 备份 .tar（未加密）
pnpm livynq import ha /path/to/homeassistant/config            # 自动化默认以禁用状态导入
pnpm livynq imports revert <id>                                 # 撤销
```

Livynq 先通过 MQTT 发现设备（与 HA 连接同一个 Broker），导入器再把 HA 的区域、名称、别名和**实体 ID** 应用到对应设备上，HA 自动化无需修改即可使用。其他集成（Hue、ZHA 等）会列在报告中并给出迁移建议。

## 备份

```bash
pnpm livynq backup create --password '至少 8 位'      # 数据库、HomeKit 配对、密钥、配置
pnpm livynq backup restore livynq-backup-….lvqbak --password '…'   # 需先停止 Livynq
```

另有每日自动备份（`<数据目录>/backups`，保留 7 份）。恢复后 Apple Home 与 Zigbee 设备无需重新配对。

## 插件与协议

```yaml
# livynq.yaml
plugins:
  - module: "@livynq/plugin-virtual"        # 虚拟开关 / 可被 Siri 触发的场景按钮
    config: { switches: [{ id: good-night, name: Good Night, momentary: true }] }
  - module: "@livynq/plugin-esphome"        # ESPHome 原生 API，mDNS 自动发现
    config: { encryptionKey: "…" }
  - module: "@livynq/plugin-zigbee"         # 直接驱动 Zigbee 协调器（Z2M 设备库）
    config:
      serialPort: /dev/serial/by-id/usb-…
      takeOverZigbee2mqtt: /opt/zigbee2mqtt/data   # 可选：接管现有网络
  - module: "@livynq/plugin-zwave"          # 直接驱动 Z-Wave 控制棒（S2、SmartStart）
    config: { port: /dev/serial/by-id/usb-… }
  - module: "@livynq/plugin-shelly"         # Shelly 二代及以上，本地 RPC，mDNS 自动发现
  - module: "@livynq/plugin-hue"            # Philips Hue 桥（本地 CLIP v2 + 事件流）
  - module: "@livynq/plugin-xiaomi"         # 米家：扫码登录一次，Wi-Fi 设备局域网直连（miIO / MIoT）
  - module: "@livynq/plugin-camera"         # 摄像头：ONVIF 自动发现 / RTSP，移动与人形侦测
  - module: "@livynq/plugin-homebridge"     # 直接运行 Homebridge 插件（含从 ~/.homebridge 迁移）
  - module: "@livynq/plugin-matter"         # Matter 控制器（配对码 / 二维码）
```

以上插件都可以在网页的“添加设备”里一键启用，不必手动编辑配置。

第三方插件在网页“插件”页里安装（npm 包名或上传 `.tgz`）、升级、配置、停用和卸载，立即生效、无需重启；也可以用命令行：

```bash
livynq plugin add livynq-plugin-acme      # 或 ./plugin.tgz、./本地目录
livynq plugin upgrade acme
livynq plugin remove acme                 # 同时删除文件
```

安装器内置在 Livynq 里，单文件程序和 HA 加载项不需要 npm；会校验每个包的哈希，**不会运行任何安装脚本**。插件拥有与 Livynq 相同的权限，只安装你信任的插件。

每个插件运行在独立进程中，崩溃会自动重启，不影响其他设备与 HomeKit 桥。`livynq plugin list` 查看状态。

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
pnpm build:sea    # 构建当前平台的单文件程序到 dist/
```

```
apps/server            livynq 命令：HTTP/WS API、MCP 端点、CLI
apps/web               Web 界面（React + Tailwind）
packages/model         能力模型（Matter 对齐）、设备类型、实体 ID、接口类型
packages/core          注册表、状态、事件总线、命令路由、SQLite、令牌
packages/adapter-mqtt  HA MQTT Discovery 适配器 + 内置 Broker
packages/exporter-homekit  HAP 桥（HAP-NodeJS）
packages/agent         MCP 工具与 Agent 友好的设备摘要
packages/automation    自动化引擎（HA 结构）
packages/importer-homeassistant  HA 导入器
packages/sdk, plugin-host        插件 SDK 与进程隔离宿主
plugins/                官方插件：virtual、esphome、zigbee、zwave、matter、shelly、hue、xiaomi、camera、homebridge、homeassistant
installers/            安装脚本
```

## 许可证

[Apache-2.0](LICENSE)
