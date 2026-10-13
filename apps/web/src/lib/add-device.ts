import type { DeviceDTO } from '@livynq/model';
import type { OnboardingMethodId } from './api.ts';
import { createStore, useStore } from './store.ts';

/** The "Add device" wizard is a global overlay so any page (or empty state) can open it. */
interface AddDeviceState {
  open: boolean;
  method: OnboardingMethodId | null;
}

export const addDevice = createStore<AddDeviceState>({ open: false, method: null });
export const useAddDevice = () => useStore(addDevice);

export function openAddDevice(method: OnboardingMethodId | null = null): void {
  addDevice.set({ open: true, method });
}

export function closeAddDevice(): void {
  addDevice.set({ open: false, method: null });
}

export function chooseMethod(method: OnboardingMethodId | null): void {
  addDevice.set((s) => ({ ...s, method }));
}

/** Which devices a method produces (adapter id first, protocol as a fallback). */
const sources: Record<OnboardingMethodId, { adapter: string; protocol: string }> = {
  matter: { adapter: 'matter', protocol: 'matter' },
  zigbee: { adapter: 'zigbee', protocol: 'zigbee' },
  zwave: { adapter: 'zwave', protocol: 'zwave' },
  esphome: { adapter: 'esphome', protocol: 'esphome' },
  shelly: { adapter: 'shelly', protocol: 'shelly' },
  homeassistant: { adapter: 'homeassistant', protocol: 'ha' },
  virtual: { adapter: 'virtual', protocol: 'virtual' },
  mqtt: { adapter: 'mqtt', protocol: 'mqtt' },
};

/** Helper devices the integrations create themselves; not something the user "added". */
const internal = new Set(['zigbee:permit-join']);

export function fromMethod(d: DeviceDTO, method: OnboardingMethodId): boolean {
  const s = sources[method];
  return !internal.has(d.id) && (d.adapter === s.adapter || d.protocol === s.protocol);
}

// ---------------------------------------------------------------- Matter pairing codes

const GROUPS = [4, 3, 4, 5, 5];

/**
 * Formats a manual pairing code while typing: `XXXX-XXX-XXXX` (11 digits) or
 * `XXXX-XXX-XXXX-XXXXX-XXXXX` (21 digits). QR payload text (`MT:…`) passes through.
 */
export function formatPairingCode(input: string): string {
  const raw = input.trim();
  // Starts with a letter: the user is typing or pasting "MT:…" (base38: 0-9, A-Z, '-', '.').
  if (/^[a-z]/i.test(raw)) return raw.toUpperCase().replace(/\s+/g, '');
  const digits = raw.replace(/\D/g, '').slice(0, 21);
  const out: string[] = [];
  let i = 0;
  for (const g of GROUPS) {
    if (i >= digits.length) break;
    out.push(digits.slice(i, i + g));
    i += g;
  }
  return out.join('-');
}

export function isPairingCodeComplete(code: string): boolean {
  if (/^MT:[0-9A-Z.\-]{10,}$/.test(code)) return true;
  const n = code.replace(/\D/g, '').length;
  return !/^[a-z]/i.test(code) && (n === 11 || n === 21);
}

// ---------------------------------------------------------------- Z-Wave

/** SmartStart QR codes are 52+ digits starting with "90". */
export function isZwaveQr(text: string): boolean {
  return /^90\d{50,}$/.test(text.trim());
}

/**
 * zwave-js hands over the DSK without its first five digits (the PIN on the label):
 * "-34567-…" → ["", "34567", …]. Returns the groups after the PIN.
 */
export function dskRest(dsk: string): string[] {
  return dsk.split('-').filter(Boolean).slice(dsk.startsWith('-') ? 0 : 1);
}

export type CommissionError = 'code' | 'notFound' | 'network' | 'timeout' | 'other';

/** Turns controller errors into something a person can act on. The raw message is shown too. */
export function classifyCommissionError(message: string, code?: string): CommissionError {
  const m = message.toLowerCase();
  if (code === 'TIMEOUT' || /timed? ?out|timeout/.test(m)) return 'timeout';
  // PASE worked but the device could not be reached on its operational address afterwards.
  if (/operative|operational|peer-unreachable|reconnect/.test(m)) return 'network';
  if (/checksum|invalid|pairing ?code|passcode|qr|manual|decode|base38|verhoeff|parse/.test(m)) return 'code';
  if (/discover|not found|no device|unreachable|operational|pase|commissionable|could not find/.test(m)) return 'notFound';
  return 'other';
}

// ---------------------------------------------------------------- QR scanning

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

function detectorCtor(): BarcodeDetectorCtor | undefined {
  return (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
}

/**
 * Native QR scanning (Chrome / Android). Needs `BarcodeDetector` with QR support and a camera,
 * which browsers only grant on https or localhost; otherwise the scan button stays hidden.
 */
export async function canScanQr(): Promise<boolean> {
  const Ctor = detectorCtor();
  if (!Ctor || !navigator.mediaDevices?.getUserMedia) return false;
  try {
    const formats = (await Ctor.getSupportedFormats?.()) ?? ['qr_code'];
    return formats.includes('qr_code');
  } catch {
    return false;
  }
}

export function createQrDetector(): BarcodeDetectorLike | null {
  const Ctor = detectorCtor();
  return Ctor ? new Ctor({ formats: ['qr_code'] }) : null;
}

/** "Living room plug" → "living-room-plug"; non-latin names fall back to a random id. */
export function slugId(name: string, taken: Iterable<string> = []): string {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `switch-${Math.random().toString(36).slice(2, 7)}`;
  const used = new Set(taken);
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  return id;
}
