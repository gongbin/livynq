# @livynq/plugin-zwave

Z-Wave for Livynq (zwave-js): S2, SmartStart, Long Range. An official plugin for [Livynq](https://github.com/gongbin/livynq), the local-first smart home hub.

Most people enable it from the web UI (**Add device**); the single-file Livynq binary already includes some official plugins. To install it into a hub yourself:

```sh
livynq plugin add @livynq/plugin-zwave
```

Z-Wave via zwave-js (S0/S2, SmartStart, Long Range).

```yaml
plugins:
  - module: "@livynq/plugin-zwave"
    config:
      port: /dev/serial/by-id/usb-Zooz_800_Z-Wave_Stick-if00   # or tcp://host:port (ser2net)
```

Network security keys are generated on first start and kept in the plugin's data directory
(keys.json, mode 0600) — back them up: without them secure devices must be re-included.

License: Apache-2.0
