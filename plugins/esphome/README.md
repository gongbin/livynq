# @livynq/plugin-esphome

ESPHome native API adapter for Livynq. An official plugin for [Livynq](https://github.com/gongbin/livynq), the local-first smart home hub.

Most people enable it from the web UI (**Add device**); the single-file Livynq binary already includes some official plugins. To install it into a hub yourself:

```sh
livynq plugin add @livynq/plugin-esphome
```

ESPHome native API adapter.

```yaml
plugins:
  - module: "@livynq/plugin-esphome"
    config:
      discovery: true                   # find devices via mDNS (_esphomelib._tcp)
      encryptionKey: "base64…"          # default key for discovered devices (api: encryption: key)
      devices:
        - host: kitchen.local
          encryptionKey: "base64…"
```

License: Apache-2.0
