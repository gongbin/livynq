# @livynq/plugin-camera

IP cameras for [Livynq](https://github.com/gongbin/livynq), the local-first smart home hub.

- **ONVIF** (Hikvision, Dahua, Reolink, TP-Link Tapo/VIGI, Uniview, Amcrest, …): found on the LAN via WS-Discovery; enter the camera's user name and password and Livynq reads its streams (main / sub), snapshot URL and subscribes to **motion and person detection**, which become occupancy sensors you can use in automations.
- **Plain RTSP**: any camera that offers an `rtsp://` URL.
- The hub pulls the video itself, only while someone watches, and shows it in the web UI — no cloud, no ffmpeg. Credentials are stored owner-only in the plugin data directory and never sent to browsers or AI agents.

```yaml
plugins:
  - module: "@livynq/plugin-camera"
    config:
      cameras:                       # cameras added in the UI are stored in the plugin data dir
        - xaddr: http://192.168.1.64/onvif/device_service   # or host: 192.168.1.64
          username: admin
          password: "…"
          profile: sub               # main (default), sub, or a profile token
        - url: rtsp://192.168.1.70:554/stream1               # no ONVIF
          username: admin
          password: "…"
          name: Garage
```

Tips: many cameras need ONVIF enabled and an ONVIF user created in their own web UI or app (e.g. Tapo: Camera Settings → Advanced → Camera Account). Xiaomi cameras do not offer RTSP or ONVIF with stock firmware.

License: Apache-2.0
