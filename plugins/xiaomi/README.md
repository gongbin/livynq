# @livynq/plugin-xiaomi

Xiaomi / Mijia devices for [Livynq](https://github.com/gongbin/livynq), the local-first smart home hub.

- **Sign in once** by scanning a QR code with the Mi Home app (Add device → Xiaomi / Mijia). Livynq reads your device list with each device's LAN token; your password never passes through Livynq.
- **Local control**: Wi-Fi devices are then controlled over the LAN (miIO / MIoT, UDP 54321) and keep working without internet.
- **Optional cloud**: Bluetooth and Zigbee sub-devices of a Xiaomi gateway are not reachable on the LAN; with `cloud: true` they are read and controlled through the Mi Home cloud.
- **Capabilities** come from the public MIoT spec (miot-spec.org), fetched once per model and cached: lights (brightness, color temperature, color), plugs and wall switches (with power), curtains, fans and air purifiers, air conditioners and heaters, temperature / humidity sensors, battery levels.

```yaml
plugins:
  - module: "@livynq/plugin-xiaomi"
    config:
      country: cn              # Mi Home server region: cn, de, us, ru, sg, i2
      cloud: false             # also use the cloud for devices the LAN cannot reach
      pollSeconds: 15
      devices:                 # optional: devices with known tokens (no account needed)
        - host: 192.168.1.40
          token: "0123456789abcdef0123456789abcdef"
```

Not supported (yet): older miIO-only models without a MIoT spec, cameras, robot vacuums' maps, BLE sensors without a gateway (needs Bluetooth support in Livynq).

License: Apache-2.0
