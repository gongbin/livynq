# @livynq/plugin-shelly

Shelly Gen2+ devices (Plus, Pro, Gen3, Gen4) over the local RPC API. An official plugin for [Livynq](https://github.com/gongbin/livynq), the local-first smart home hub.

Most people enable it from the web UI (**Add device**); the single-file Livynq binary already includes some official plugins. To install it into a hub yourself:

```sh
livynq plugin add @livynq/plugin-shelly
```

Shelly Gen2+ (Plus, Pro, Gen3, Gen4, Wave Pro excluded) over the local WebSocket RPC API.

```yaml
plugins:
  - module: "@livynq/plugin-shelly"
    config:
      discovery: true            # find devices via mDNS (_shelly._tcp) and add them
      password: "…"              # default password for devices with authentication enabled
      devices:
        - host: 192.168.1.50
          password: "…"
```

Battery devices (H&T, door/window) sleep and are not reachable this way yet.

License: Apache-2.0
