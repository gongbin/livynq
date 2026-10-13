# Livynq add-on

Livynq runs next to Home Assistant and bridges your Home Assistant entities to:

- **Apple Home** — as native HomeKit accessories (scan the QR code in Livynq → Ecosystems)
- **AI agents** — via MCP (`http://<home-assistant-host>:8581/mcp`, token from Livynq → Agents)
- Livynq automations, wall panels and (soon) 3D floor plans

## First start

1. Start the add-on and open the **Log** tab: on first start Livynq prints a login link
   `http://<host>:8581/#token=lvq_…`. Open it once; the browser remembers the token.
2. Home Assistant entities appear automatically (lights, switches, covers, climate, fans, locks,
   sensors, binary sensors, event entities). Devices that Livynq integrates directly — e.g. the
   same Zigbee2MQTT device via MQTT — are not duplicated.
3. To limit what is bridged, edit `/addon_configs/<slug>_livynq/livynq.yaml`:

   ```yaml
   plugins:
     - module: "@livynq/plugin-homeassistant"
       config:
         include: ["light.*", "climate.*", "lock.front_door"]
         exclude: ["sensor.*_battery"]
   ```

## Network

The add-on uses the host network (required for HomeKit/Matter mDNS). Port 8581 serves the web UI,
API and MCP endpoint; the HomeKit bridge uses 51826.

## Backups

All Livynq data (HomeKit pairing, automations, tokens) lives in the add-on config folder and is
part of Home Assistant backups.
