# @livynq/plugin-zigbee

Built-in Zigbee coordinator support for Livynq (zigbee-herdsman). An official plugin for [Livynq](https://github.com/gongbin/livynq), the local-first smart home hub.

Most people enable it from the web UI (**Add device**); the single-file Livynq binary already includes some official plugins. To install it into a hub yourself:

```sh
livynq plugin add @livynq/plugin-zigbee
```

Built-in Zigbee: drives a USB/network coordinator directly with zigbee-herdsman and uses
zigbee-herdsman-converters (the Zigbee2MQTT device database).

```yaml
plugins:
  - module: "@livynq/plugin-zigbee"
    config:
      serialPort: /dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus-if00-port0   # or tcp://192.168.1.20:6638
      adapter: ember            # zstack | ember | deconz | zigate | zboss (optional: auto-detect)
      channel: 11               # only used when creating a new network
      takeOverZigbee2mqtt: /opt/zigbee2mqtt/data   # optional, first start only: keep pairings
```

Stop Zigbee2MQTT before taking over its coordinator: only one program may drive it.

License: Apache-2.0
