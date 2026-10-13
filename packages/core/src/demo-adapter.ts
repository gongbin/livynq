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
  {
    def: {
      id: 'demo:living-curtain',
      name: 'Living Room Curtain',
      protocol: 'virtual',
      suggestedRoom: 'Living Room',
      info: { manufacturer: 'Livynq', model: 'Demo Curtain Motor' },
      endpoints: [{ id: 1, deviceType: DeviceTypes.WindowCovering.id, capabilities: ['windowCovering'] }],
    },
    initial: { 1: { windowCovering: { currentPosition: 100, targetPosition: 100, operationalStatus: 'stopped' } } },
  },
  {
    def: {
      id: 'demo:bedroom-ac',
      name: 'Bedroom AC',
      protocol: 'virtual',
      suggestedRoom: 'Bedroom',
      info: { manufacturer: 'Livynq', model: 'Demo Air Conditioner' },
      endpoints: [{ id: 1, deviceType: DeviceTypes.AirConditioner.id, capabilities: ['thermostat', 'fanControl'] }],
    },
    initial: {
      1: {
        thermostat: { localTemperature: 26.5, targetTemperature: 24, systemMode: 'off', supportedModes: 'off,heat,cool,auto,dry,fan_only', runningState: 'idle', minSetpoint: 16, maxSetpoint: 30 },
        fanControl: { fanMode: 'auto', percentCurrent: 0 },
      },
    },
  },
  {
    def: {
      id: 'demo:office-fan',
      name: 'Desk Fan',
      protocol: 'virtual',
      suggestedRoom: 'Living Room',
      info: { manufacturer: 'Livynq', model: 'Demo Fan' },
      endpoints: [{ id: 1, deviceType: DeviceTypes.Fan.id, capabilities: ['onOff', 'fanControl'] }],
    },
    initial: { 1: { onOff: { onOff: false }, fanControl: { percentCurrent: 40, fanMode: 'medium' } } },
  },
  {
    def: {
      id: 'demo:front-lock',
      name: 'Front Door Lock',
      protocol: 'virtual',
      suggestedRoom: 'Hallway',
      info: { manufacturer: 'Livynq', model: 'Demo Smart Lock' },
      endpoints: [{ id: 1, deviceType: DeviceTypes.DoorLock.id, capabilities: ['doorLock'] }, { id: 2, name: 'Battery', deviceType: DeviceTypes.BatterySensor.id, capabilities: ['powerSource'] }],
    },
    initial: { 1: { doorLock: { lockState: 'locked' } }, 2: { powerSource: { batPercentRemaining: 64, batChargeLevelLow: false } } },
  },
  {
    def: {
      id: 'demo:bedside-button',
      name: 'Bedside Button',
      protocol: 'virtual',
      suggestedRoom: 'Bedroom',
      info: { manufacturer: 'Livynq', model: 'Demo Wireless Button' },
      endpoints: [{ id: 1, deviceType: DeviceTypes.GenericSwitch.id, capabilities: ['genericSwitch'] }],
    },
    initial: {},
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

    // Curtain: moves 10 % every 300 ms towards the target, reporting progress like a real motor.
    const curtain = handles.get('demo:living-curtain')!;
    let motion: NodeJS.Timeout | undefined;
    const moveTo = (target: number) => {
      clearInterval(motion);
      const from = Number(stateOf(curtain, 'windowCovering', 'currentPosition') ?? 0);
      if (from === target) return curtain.update(1, 'windowCovering', { targetPosition: target, operationalStatus: 'stopped' });
      curtain.update(1, 'windowCovering', { targetPosition: target, operationalStatus: target > from ? 'opening' : 'closing' });
      motion = setInterval(() => {
        const pos = Number(stateOf(curtain, 'windowCovering', 'currentPosition') ?? 0);
        const next = target > pos ? Math.min(target, pos + 10) : Math.max(target, pos - 10);
        curtain.update(1, 'windowCovering', { currentPosition: next, ...(next === target ? { operationalStatus: 'stopped' } : {}) });
        if (next === target) clearInterval(motion);
      }, 300);
      this.#timers.push(motion);
    };
    curtain.handle(1, 'windowCovering', {
      open: () => ack(() => moveTo(100)),
      close: () => ack(() => moveTo(0)),
      stop: () =>
        ack(() => {
          clearInterval(motion);
          const pos = Number(stateOf(curtain, 'windowCovering', 'currentPosition') ?? 0);
          curtain.update(1, 'windowCovering', { targetPosition: pos, operationalStatus: 'stopped' });
        }),
      goToPosition: (p) => ack(() => moveTo(Number(p.position))),
      goToTilt: () => Promise.reject(new Error('this curtain has no tilt')),
    });

    // Air conditioner: running state follows mode vs. room temperature.
    const ac = handles.get('demo:bedroom-ac')!;
    const acRunning = () => {
      const mode = stateOf(ac, 'thermostat', 'systemMode');
      const temp = Number(stateOf(ac, 'thermostat', 'localTemperature') ?? 24);
      const target = Number(stateOf(ac, 'thermostat', 'targetTemperature') ?? 24);
      const runningState = mode === 'cool' || (mode === 'auto' && temp > target + 0.5) ? (temp > target ? 'cooling' : 'idle')
        : mode === 'heat' || (mode === 'auto' && temp < target - 0.5) ? (temp < target ? 'heating' : 'idle')
        : mode === 'dry' ? 'drying' : mode === 'fan_only' ? 'fan' : 'idle';
      ac.update(1, 'thermostat', { runningState });
    };
    ac.handle(1, 'thermostat', {
      setSystemMode: (p) => ack(() => (ac.update(1, 'thermostat', { systemMode: p.mode as string }), acRunning())),
      setTargetTemperature: (p) => ack(() => (ac.update(1, 'thermostat', { targetTemperature: Number(p.temperature) }), acRunning())),
      setTemperatureRange: (p) => ack(() => ac.update(1, 'thermostat', { targetTemperatureLow: Number(p.low), targetTemperatureHigh: Number(p.high) })),
    });
    ac.handle(1, 'fanControl', {
      setPercent: (p) => ack(() => ac.update(1, 'fanControl', { percentCurrent: Number(p.percent) })),
      setMode: (p) => ack(() => ac.update(1, 'fanControl', { fanMode: p.mode as string })),
    });

    const fan = handles.get('demo:office-fan')!;
    fan.handle(1, 'onOff', {
      on: () => ack(() => fan.update(1, 'onOff', { onOff: true })),
      off: () => ack(() => fan.update(1, 'onOff', { onOff: false })),
      toggle: () => ack(() => fan.update(1, 'onOff', { onOff: !stateOf(fan, 'onOff', 'onOff') })),
    });
    fan.handle(1, 'fanControl', {
      setPercent: (p) => ack(() => fan.update(1, 'fanControl', { percentCurrent: Number(p.percent), fanMode: Number(p.percent) < 34 ? 'low' : Number(p.percent) < 67 ? 'medium' : 'high' })),
      setMode: (p) => ack(() => fan.update(1, 'fanControl', { fanMode: p.mode as string, percentCurrent: ({ low: 33, medium: 66, high: 100 } as Record<string, number>)[p.mode as string] ?? 50 })),
    });

    // Lock: takes a moment to turn the bolt.
    const lock = handles.get('demo:front-lock')!;
    lock.handle(1, 'doorLock', {
      lock: () => new Promise<void>((r) => setTimeout(() => (lock.update(1, 'doorLock', { lockState: 'locked' }), r()), 400)),
      unlock: () => new Promise<void>((r) => setTimeout(() => (lock.update(1, 'doorLock', { lockState: 'unlocked' }), r()), 400)),
    });

    if (this.#simulateSensors) {
      const button = handles.get('demo:bedside-button')!;
      this.#timers.push(
        setInterval(() => {
          if (Math.random() < 0.25) {
            const event = (['single', 'double', 'long'] as const)[Math.floor(Math.random() * 3)]!;
            button.update(1, 'genericSwitch', { lastEvent: event, lastEventAt: Date.now(), lastAction: event });
          }
        }, 60_000).unref(),
      );
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
