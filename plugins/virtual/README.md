# @livynq/plugin-virtual

Virtual switches and momentary buttons (e.g. Siri-triggerable scenes) for Livynq. An official plugin for [Livynq](https://github.com/gongbin/livynq), the local-first smart home hub.

Most people enable it from the web UI (**Add device**); the single-file Livynq binary already includes some official plugins. To install it into a hub yourself:

```sh
livynq plugin add @livynq/plugin-virtual
```

Virtual switches, persisted across restarts. Expose them to Apple Home and use them as
Siri-triggerable scenes ("Hey Siri, good night") that start Livynq automations.

```yaml
plugins:
  - module: "@livynq/plugin-virtual"
    config:
      switches:
        - { id: guest-mode, name: Guest Mode }
        - { id: good-night, name: Good Night, momentary: true }   # turns itself off after 1 s
```

License: Apache-2.0
