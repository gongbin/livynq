# @livynq/plugin-hue

Philips Hue bridges over the local CLIP v2 API. An official plugin for [Livynq](https://github.com/gongbin/livynq), the local-first smart home hub.

Most people enable it from the web UI (**Add device**); the single-file Livynq binary already includes some official plugins. To install it into a hub yourself:

```sh
livynq plugin add @livynq/plugin-hue
```

Philips Hue bridges (v2, square) over the local CLIP v2 API and its event stream.

```yaml
plugins:
  - module: "@livynq/plugin-hue"
    config:
      discovery: true          # list bridges found via mDNS (pairing needs the link button)
      bridges:                 # optional; bridges paired from the UI are stored in the plugin data dir
        - host: 192.168.1.20
          key: "…"             # application key ("username")
```

Lights, motion / temperature / light level / contact sensors, buttons and battery levels map
to Livynq devices. Hue rooms, zones and scenes are not imported (yet).

License: Apache-2.0
