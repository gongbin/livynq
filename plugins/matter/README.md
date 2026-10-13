# @livynq/plugin-matter

Matter controller for Livynq: commission and control Matter devices (matter.js). An official plugin for [Livynq](https://github.com/gongbin/livynq), the local-first smart home hub.

Most people enable it from the web UI (**Add device**); the single-file Livynq binary already includes some official plugins. To install it into a hub yourself:

```sh
livynq plugin add @livynq/plugin-matter
```

Matter controller: commission Matter devices (Wi-Fi, Thread via an existing border router,
or devices already in Apple/Google Home through multi-admin) and control them from Livynq.

```yaml
plugins:
  - module: "@livynq/plugin-matter"
    config: { networkInterface: eth0 }   # optional: limit Matter discovery to one interface

livynq plugin action matter commission --params '{"code":"3497-011-2332"}'   # manual or "MT:…" QR code
livynq plugin action matter nodes
livynq plugin action matter remove --params '{"nodeId":"123"}'
```

Commissioning fabric credentials live in the plugin data directory (included in backups).

License: Apache-2.0
