import { DeviceTypes, type AttributeValue, type DeviceDefinition } from '@livynq/model';
import type { Adapter, AdapterContext, DeviceHandle } from './adapter.ts';

interface DemoDevice {
  def: DeviceDefinition;
  initial: Record<number, Record<string, Record<string, AttributeValue>>>;
}

const demoDevices: DemoDevice[] = [
  {
    def: {
      id: 'demo:living-ceiling',
      name: 'Living Room Ceiling',
      protocol: 'virtual',
      suggestedRoom: 'Living Room',
      info: { manufacturer: 'Livynq', model: 'Demo Color Bulb' },
      endpoints: [{ id: 1, deviceType: DeviceTypes.ExtendedColorLight.id, capabilities: ['onOff', 'levelControl', 'colorControl'] }],
    },
    initial: {
      1: {
        onOff: { onOff: true },
        levelControl: { currentLevel: 180 },
        colorControl: { colorMode: 'ct', colorTemperatureMireds: 300, currentHue: 30, currentSaturation: 120, colorTempPhysicalMinMireds: 153, colorTempPhysicalMaxMireds: 500 },
      },
    },
  },
  {
    def: {
      id: 'demo:bedroom-lamp',
      name: 'Bedroom Lamp',
      protocol: 'virtual',
      suggestedRoom: 'Bedroom',
      info: { manufacturer: 'Livynq', model: 'Demo Dimmable' },
      endpoints: [{ id: 1, deviceType: DeviceTypes.DimmableLight.id, capabilities: ['onOff', 'levelControl'] }],
    },
    initial: { 1: { onOff: { onOff: false }, levelControl: { currentLevel: 100 } } },
  },
  {
    def: {
      id: 'demo:coffee-plug',
      name: 'Coffee Machine',
      protocol: 'virtual',
      suggestedRoom: 'Kitchen',
      info: { manufacturer: 'Livynq', model: 'Demo Plug' },
      endpoints: [{ id: 1, deviceType: DeviceTypes.OnOffPlugInUnit.id, capabilities: ['onOff', 'electricalPowerMeasurement'] }],
    },
    initial: { 1: { onOff: { onOff: false }, electricalPowerMeasurement: { activePower: 0 } } },
  },
  {
    def: {
      id: 'demo:bedroom-climate',
      name: 'Bedroom Climate',
      protocol: 'virtual',
      suggestedRoom: 'Bedroom',
      info: { manufacturer: 'Livynq', model: 'Demo TH Sensor' },
      endpoints: [
        { id: 1, name: 'Temperature', deviceType: DeviceTypes.TemperatureSensor.id, capabilities: ['temperatureMeasurement'] },
        { id: 2, name: 'Humidity', deviceType: DeviceTypes.HumiditySensor.id, capabilities: ['relativeHumidityMeasurement'] },
        { id: 3, name: 'Battery', deviceType: DeviceTypes.BatterySensor.id, capabilities: ['powerSource'] },
      ],
    },
    initial: {
      1: { temperatureMeasurement: { measuredValue: 22.4 } },
      2: { relativeHumidityMeasurement: { measuredValue: 48 } },
      3: { powerSource: { batPercentRemaining: 87, batChargeLevelLow: false } },
    },
  },
  {
    def: {
      id: 'demo:hallway-motion',
      name: 'Hallway Motion',
      protocol: 'virtual',
      suggestedRoom: 'Hallway',
      info: { manufacturer: 'Livynq', model: 'Demo PIR' },
      endpoints: [{ id: 1, deviceType: DeviceTypes.OccupancySensor.id, capabilities: ['occupancySensing'] }],
    },
    initial: { 1: { occupancySensing: { occupied: false } } },
  },
  {
    def: {
      id: 'demo:front-door',
      name: 'Front Door',
      protocol: 'virtual',
      suggestedRoom: 'Hallway',
      info: { manufacturer: 'Livynq', model: 'Demo Contact' },
      endpoints: [{ id: 1, deviceType: DeviceTypes.ContactSensor.id, capabilities: ['booleanState'] }],
    },
    initial: { 1: { booleanState: { stateValue: true } } },
  },
];

/**
 * Simulated devices so the UI, HomeKit bridge and MCP tools can be tried without hardware.
 * Commands are "acknowledged by the device" after a short delay, like a real adapter.
 */
export class DemoAdapter implements Adapter {
  readonly id = 'demo';
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #simulateSensors: boolean;

  constructor(options: { simulateSensors?: boolean } = {}) {
    this.#simulateSensors = options.simulateSensors ?? true;
  }

  async start(ctx: AdapterContext): Promise<void> {
    const handles = new Map<string, DeviceHandle>();
    for (const { def, initial } of demoDevices) {
      const handle = ctx.upsertDevice(def);
      handles.set(def.id, handle);
      for (const [ep, caps] of Object.entries(initial)) {
        for (const [cap, attrs] of Object.entries(caps)) {
          // Keep state from the previous run so the demo feels persistent.
          const missing = Object.fromEntries(Object.entries(attrs).filter(([a]) => handle.get(Number(ep), cap, a) === undefined));
          if (Object.keys(missing).length) handle.update(Number(ep), cap, missing);
        }
      }
      handle.setAvailability('online');
    }

    const ack = (fn: () => void) => new Promise<void>((resolve) => setTimeout(() => (fn(), resolve()), 30));
    for (const id of ['demo:living-ceiling', 'demo:bedroom-lamp', 'demo:coffee-plug']) {
      const h = handles.get(id)!;
      const isPlug = id === 'demo:coffee-plug';
      const setOn = (on: boolean) => {
        h.update(1, 'onOff', { onOff: on });
        if (isPlug) h.update(1, 'electricalPowerMeasurement', { activePower: on ? 1180 : 0 });
      };
      h.handle(1, 'onOff', {
        on: () => ack(() => setOn(true)),
        off: () => ack(() => setOn(false)),
        toggle: () => ack(() => setOn(!stateOf(h, 'onOff', 'onOff'))),
      });
      if (!isPlug) {
        h.handle(1, 'levelControl', {
          moveToLevel: (p) => ack(() => h.update(1, 'levelControl', { currentLevel: p.level as number })),
        });
      }
    }
    const ceiling = handles.get('demo:living-ceiling')!;
    ceiling.handle(1, 'colorControl', {
      moveToColorTemperature: (p) => ack(() => ceiling.update(1, 'colorControl', { colorTemperatureMireds: p.colorTemperatureMireds as number, colorMode: 'ct' })),
      moveToHueAndSaturation: (p) => ack(() => ceiling.update(1, 'colorControl', { currentHue: p.hue as number, currentSaturation: p.saturation as number, colorMode: 'hs' })),
    });

    if (this.#simulateSensors) {
      const climate = handles.get('demo:bedroom-climate')!;
      const motion = handles.get('demo:hallway-motion')!;
      this.#timers.push(
        setInterval(() => {
          const temp = Number(stateOf(climate, 'temperatureMeasurement', 'measuredValue', 1) ?? 22);
          const hum = Number(stateOf(climate, 'relativeHumidityMeasurement', 'measuredValue', 2) ?? 48);
          climate.update(1, 'temperatureMeasurement', { measuredValue: round1(clampDrift(temp, 19, 26)) });
          climate.update(2, 'relativeHumidityMeasurement', { measuredValue: Math.round(clampDrift(hum, 35, 65)) });
        }, 30_000).unref(),
        setInterval(() => {
          if (Math.random() < 0.3) {
            motion.update(1, 'occupancySensing', { occupied: true });
            setTimeout(() => motion.update(1, 'occupancySensing', { occupied: false }), 15_000).unref();
          }
        }, 45_000).unref(),
      );
    }
  }

  async stop(): Promise<void> {
    for (const t of this.#timers) clearInterval(t);
    this.#timers.length = 0;
  }
}

function stateOf(handle: DeviceHandle, cap: string, attr: string, ep = 1): AttributeValue | undefined {
  return handle.get(ep, cap, attr);
}

const clampDrift = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v + (Math.random() - 0.5) * 0.6));
const round1 = (v: number) => Math.round(v * 10) / 10;
