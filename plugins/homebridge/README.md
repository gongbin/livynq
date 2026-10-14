# @livynq/plugin-homebridge

Homebridge compatibility for [Livynq](https://github.com/gongbin/livynq), the local-first smart home hub: run existing **Homebridge plugins** inside Livynq and use their accessories as Livynq devices — in automations, the web UI, Apple Home (through Livynq's HomeKit bridge), Google / Alexa / SmartThings (through Livynq's Matter bridge) and AI agents.

- Implements the Homebridge plugin API (1.8, plus the 2.0 checks plugins make) on the same hap-nodejs Homebridge uses: dynamic platforms with cached accessories (`configureAccessory`), static platforms, accessory plugins, `onGet`/`onSet` and legacy `get`/`set` callbacks, `updateValue` pushes.
- Plugins are installed from npm by Livynq's own installer — no npm needed, **install scripts are never run**, every download is integrity-checked. Plugins that must compile native code at install time will not work.
- Config uses Homebridge's own `platforms` / `accessories` blocks, so the README of any Homebridge plugin applies.
- Import an existing Homebridge (`~/.homebridge`): plugins, config blocks and cached accessories; bridge settings are left behind (pair Livynq's bridges instead).

Mapped services: Lightbulb, Switch, Outlet, Fan / Fanv2 / Air Purifier, Window Covering / Door / Window, Garage Door, Lock, Thermostat, Heater Cooler, temperature / humidity / light / motion / occupancy / contact / leak sensors, Battery, Stateless Programmable Switch and Doorbell. Other services (TVs, cameras, …) are reported as unsupported.

```yaml
plugins:
  - module: "@livynq/plugin-homebridge"
    config:
      pollSeconds: 30        # how often plugins' get handlers are read
```

Actions (UI / `livynq plugin action homebridge <name>`): `preview`, `install`, `uninstall`, `plugins`, `schema`, `config`, `accessories`, `import`, `importApply`. Changes apply after restarting this plugin, as in Homebridge.

License: Apache-2.0
