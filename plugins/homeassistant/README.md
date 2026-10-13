# @livynq/plugin-homeassistant

Live bridge to a running Home Assistant (WebSocket API) for Livynq. An official plugin for [Livynq](https://github.com/gongbin/livynq), the local-first smart home hub.

Most people enable it from the web UI (**Add device**); the single-file Livynq binary already includes some official plugins. To install it into a hub yourself:

```sh
livynq plugin add @livynq/plugin-homeassistant
```

Live bridge to a running Home Assistant: its entities appear in Livynq (Apple Home, Matter,
automations, agents, 3D) while Home Assistant keeps running the integrations Livynq lacks.

```yaml
plugins:
  - module: "@livynq/plugin-homeassistant"
    config:
      url: http://homeassistant.local:8123
      token: !secret ha_token          # long-lived access token (HA profile → Security)
      include: ["light.*", "climate.living_room"]   # optional globs
      exclude: ["sensor.*_battery"]                 # optional globs
```

Inside the Livynq Home Assistant add-on, url/token default to the Supervisor proxy.
Devices Livynq already integrates directly (e.g. the same Zigbee2MQTT device) are skipped.

License: Apache-2.0
