# 编写 Livynq 插件

插件把一种协议或一类设备接入 Livynq 的统一能力模型（Matter 对齐）。插件**不需要**关心 HomeKit、Matter、MCP、自动化或界面——设备一旦注册，这些都由 Livynq 自动完成。

## 最小示例

```ts
// my-plugin/src/index.ts
import { defineAdapter, DeviceTypes } from '@livynq/sdk';

export default defineAdapter({
  async setup(ctx) {
    const api = await connectToMyLamp(ctx.config.host as string);
    const id = `acme:${api.serial}`;
    const lamp = await ctx.devices.upsert({
      id,                                   // "<协议>:<设备唯一 ID>"，必须稳定
      name: 'Desk Lamp',
      protocol: 'lan',
      info: { manufacturer: 'Acme', model: api.model },
      endpoints: [{ id: 1, deviceType: DeviceTypes.DimmableLight.id, capabilities: ['onOff', 'levelControl'] }],
    });

    // 命令：来自 Apple Home、Web、自动化或 Agent
    lamp.handle(1, 'onOff', { on: () => api.on(), off: () => api.off(), toggle: () => api.toggle() });
    lamp.handle(1, 'levelControl', { moveToLevel: ({ level }) => api.brightness(Math.round((Number(level) / 254) * 100)) });

    // 状态：以设备上报为准（不要在命令处理里"假设"成功）
    api.on('change', (s) => {
      lamp.update(1, 'onOff', { onOff: s.on });
      lamp.update(1, 'levelControl', { currentLevel: Math.max(1, Math.round((s.brightness / 100) * 254)) });
    });
    api.on('disconnect', () => lamp.setAvailability('offline'));
    lamp.setAvailability('online');

    ctx.onStop(() => api.close());
  },
});
```

`package.json` 需要 `"type": "module"`，并通过 `exports`（或 `main`）指向入口文件。

## 启用

```yaml
# ~/.livynq/livynq.yaml
plugins:
  - path: ./my-plugin            # 本地开发：目录或文件（相对配置文件）
    config: { host: 192.168.1.50 }
  - module: livynq-plugin-acme   # npm 包：livynq plugin add livynq-plugin-acme
```

```bash
livynq plugin add ./my-plugin          # 或 npm 包名；写入 livynq.yaml
livynq plugin list                     # 状态、PID、重启次数、最近错误
livynq plugin restart my-plugin        # 修改代码后热重启（只重启该插件进程）
```

## 运行模型

- 每个插件默认运行在**独立子进程**中（`isolation: process`）。插件崩溃时它的设备显示"无响应"，Livynq 按 1 s → 60 s 退避自动重启；10 分钟内崩溃 5 次后停用，修复后用 `livynq plugin restart` 恢复。
- 官方插件可用 `isolation: in-process` 在主进程运行，节省约 30–50 MB 内存（低内存设备）。
- `ctx.dataDir` 是插件私有的持久目录，会被备份。
- `ctx.endpointId(deviceId, key)` 为协议侧的键（如多路开关的通道号）分配**永久不变**的端点 ID——HomeKit 配件 ID 依赖它保持稳定。
- 设备 ID 一旦发布就不要改变：Apple Home 中的房间、场景和自动化都绑定在它上面。

## 能力与设备类型

见 `packages/model/src/capabilities.ts` 与 `device-types.ts`。数值遵循 Matter 语义：亮度 1–254、色相/饱和度 0–254、色温单位为 mired。需要新的能力或设备类型时请提交 RFC（Issue）。

## 参考

- 官方示例：[`plugins/virtual`](../plugins/virtual/src/index.ts)（虚拟开关 / 可被 Siri 触发的瞬时按钮）
- 测试夹具：[`packages/plugin-host/test/fixtures/lamp-plugin.ts`](../packages/plugin-host/test/fixtures/lamp-plugin.ts)
