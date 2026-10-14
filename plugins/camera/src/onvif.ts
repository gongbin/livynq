import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { escapeXml, find, findAll, parseXml, text, type XmlNode } from './xml.ts';

/**
 * ONVIF Profile S/T client: WS-Discovery, device information, media profiles with their RTSP
 * and snapshot URIs, and motion / person events via a PullPoint subscription.
 * Authentication is WS-Security UsernameToken (password digest), corrected for the camera's clock.
 */

// ---------------------------------------------------------------- discovery

export interface Discovered {
  /** Device service URL, e.g. http://192.168.1.64/onvif/device_service */
  xaddr: string;
  host: string;
  /** urn:uuid:… endpoint reference, stable per camera */
  urn?: string;
  name?: string;
  hardware?: string;
}

const PROBE = (id: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:${id}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;

export function parseProbeMatch(xml: string, from: string): Discovered | undefined {
  const doc = parseXml(xml);
  const xaddrs = text(doc, 'ProbeMatch', 'XAddrs')?.split(/\s+/) ?? [];
  // Prefer an address on the interface that answered (cameras often list several).
  const xaddr = xaddrs.find((x) => x.includes(`//${from}`)) ?? xaddrs.find((x) => /^http:\/\/\d/.test(x)) ?? xaddrs[0];
  if (!xaddr) return undefined;
  const scopes = text(doc, 'ProbeMatch', 'Scopes')?.split(/\s+/) ?? [];
  const scope = (kind: string) => {
    const s = scopes.find((x) => x.includes(`/${kind}/`));
    return s ? decodeURIComponent(s.slice(s.indexOf(`/${kind}/`) + kind.length + 2)) : undefined;
  };
  return { xaddr, host: new URL(xaddr).hostname, urn: text(doc, 'EndpointReference', 'Address'), name: scope('name'), hardware: scope('hardware') };
}

/** Multicast probe (or a unicast one to `target`, used by tests). */
export function discover(timeoutMs = 3000, target: { address: string; port: number } = { address: '239.255.255.250', port: 3702 }): Promise<Discovered[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Discovered>();
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg, rinfo) => {
      const d = parseProbeMatch(msg.toString('utf8'), rinfo.address);
      if (d) found.set(d.urn ?? d.xaddr, d);
    });
    socket.on('error', () => {});
    socket.bind(0, () => {
      const probe = Buffer.from(PROBE(randomUUID()));
      socket.send(probe, target.port, target.address);
      // UDP may drop the first probe.
      setTimeout(() => socket.send(probe, target.port, target.address), 500).unref();
    });
    setTimeout(() => {
      socket.close();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------- SOAP client

export class OnvifError extends Error {
  readonly status?: number;
  readonly auth: boolean;
  constructor(message: string, status?: number, auth = false) {
    super(message);
    this.status = status;
    this.auth = auth;
  }
}

export interface Profile {
  token: string;
  name: string;
  encoding?: string;
  width?: number;
  height?: number;
}

export interface CameraEvent {
  topic: string;
  /** Video source / rule the event belongs to */
  source?: string;
  active: boolean;
  kind: 'motion' | 'person' | 'other';
}

const NS =
  'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa="http://www.w3.org/2005/08/addressing"';

export class OnvifCamera {
  readonly xaddr: string;
  readonly username?: string;
  readonly #password?: string;
  readonly #fetch: typeof fetch;
  #clockOffset = 0;
  #services: { media?: string; events?: string } = {};

  constructor(options: { xaddr: string; username?: string; password?: string; fetch?: typeof fetch }) {
    this.xaddr = options.xaddr;
    this.username = options.username;
    this.#password = options.password;
    this.#fetch = options.fetch ?? fetch;
  }

  #security(): string {
    if (!this.username) return '';
    const nonce = randomBytes(16);
    const created = new Date(Date.now() + this.#clockOffset).toISOString().replace(/\.\d+Z$/, 'Z');
    const digest = createHash('sha1')
      .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(this.#password ?? '')]))
      .digest('base64');
    return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${escapeXml(this.username)}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created></UsernameToken></Security></s:Header>`;
  }

  async request(url: string, body: string, options: { auth?: boolean; timeoutMs?: number; header?: string } = {}): Promise<XmlNode> {
    const security = options.auth === false ? '' : this.#security();
    const header = options.header ? (security ? security.replace('</s:Header>', `${options.header}</s:Header>`) : `<s:Header>${options.header}</s:Header>`) : security;
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}>${header}<s:Body>${body}</s:Body></s:Envelope>`;
    let res: Response;
    try {
      res = await this.#fetch(url, { method: 'POST', headers: { 'content-type': 'application/soap+xml; charset=utf-8' }, body: envelope, signal: AbortSignal.timeout(options.timeoutMs ?? 8000) });
    } catch (err) {
      throw new OnvifError(`${new URL(url).host}: ${(err as Error).message}`);
    }
    const xml = await res.text();
    const doc = parseXml(xml);
    const fault = find(doc, 'Fault');
    if (!res.ok || fault) {
      const reason = text(fault, 'Reason', 'Text') ?? text(fault, 'faultstring') ?? `HTTP ${res.status}`;
      const subcode = findAll(fault, 'Value').map((v) => v.text.trim()).join(' ');
      const auth = res.status === 401 || /NotAuthorized|FailedAuthentication|Sender.*Authority|not ?authori/i.test(`${subcode} ${reason}`);
      throw new OnvifError(auth ? 'wrong user name or password' : reason, res.status, auth);
    }
    return doc;
  }

  /** Reads the camera clock (no auth needed) so the WS-Security timestamp matches it. */
  async syncClock(): Promise<void> {
    try {
      const doc = await this.request(this.xaddr, '<tds:GetSystemDateAndTime/>', { auth: false });
      const utc = find(doc, 'UTCDateTime');
      const n = (p: string) => Number(text(utc, p) ?? NaN);
      const t = Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second'));
      if (Number.isFinite(t)) this.#clockOffset = t - Date.now();
    } catch {
      // some cameras want auth even for this; keep our clock
    }
  }

  async connect(): Promise<{ manufacturer?: string; model?: string; firmware?: string; serial?: string }> {
    await this.syncClock();
    const info = await this.request(this.xaddr, '<tds:GetDeviceInformation/>');
    try {
      const caps = await this.request(this.xaddr, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
      this.#services = { media: text(caps, 'Media', 'XAddr'), events: text(caps, 'Events', 'XAddr') };
    } catch {
      // GetCapabilities is deprecated on some Profile T devices; assume the device URL serves all
    }
    this.#services.media ??= this.xaddr;
    // Cameras behind NAT / with several interfaces report their own idea of the address.
    const host = new URL(this.xaddr).host;
    for (const k of ['media', 'events'] as const) {
      const v = this.#services[k];
      if (v) this.#services[k] = v.replace(/^(https?:\/\/)[^/]+/, `$1${host}`);
    }
    return {
      manufacturer: text(info, 'Manufacturer'),
      model: text(info, 'Model'),
      firmware: text(info, 'FirmwareVersion'),
      serial: text(info, 'SerialNumber'),
    };
  }

  get hasEvents(): boolean {
    return Boolean(this.#services.events);
  }

  async profiles(): Promise<Profile[]> {
    const doc = await this.request(this.#services.media ?? this.xaddr, '<trt:GetProfiles/>');
    return findAll(doc, 'Profiles').map((p) => {
      const enc = find(p, 'VideoEncoderConfiguration');
      const res = find(enc, 'Resolution');
      return {
        token: p.attrs.token ?? '',
        name: text(p, 'Name') ?? p.attrs.token ?? '',
        encoding: text(enc, 'Encoding'),
        width: Number(text(res, 'Width') ?? 0) || undefined,
        height: Number(text(res, 'Height') ?? 0) || undefined,
      };
    });
  }

  async streamUri(profile: string): Promise<string> {
    const doc = await this.request(
      this.#services.media ?? this.xaddr,
      `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${escapeXml(profile)}</trt:ProfileToken></trt:GetStreamUri>`,
    );
    const uri = text(doc, 'MediaUri', 'Uri');
    if (!uri) throw new OnvifError('the camera returned no stream URI');
    return this.#fixHost(uri);
  }

  async snapshotUri(profile: string): Promise<string | undefined> {
    try {
      const doc = await this.request(this.#services.media ?? this.xaddr, `<trt:GetSnapshotUri><trt:ProfileToken>${escapeXml(profile)}</trt:ProfileToken></trt:GetSnapshotUri>`);
      const uri = text(doc, 'MediaUri', 'Uri');
      return uri ? this.#fixHost(uri) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Same host as the device service (cameras often report an internal or 0.0.0.0 address). */
  #fixHost(uri: string): string {
    const u = new URL(uri);
    const host = new URL(this.xaddr).hostname;
    // IP literals other than the one we reached the camera at are usually an internal or
    // unroutable address; DNS names are kept.
    const ipLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname === 'localhost';
    if (u.hostname !== host && ipLiteral) u.hostname = host;
    // Credentials never travel in the URL; the hub authenticates with the stored ones.
    u.username = '';
    u.password = '';
    return u.toString();
  }

  // ---------------------------------------------------------------- events

  /** Pull-point subscription; resolves the subscription URL. */
  async subscribe(): Promise<string> {
    if (!this.#services.events) throw new OnvifError('the camera does not offer ONVIF events');
    const doc = await this.request(this.#services.events, '<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT120S</tev:InitialTerminationTime></tev:CreatePullPointSubscription>');
    const address = text(doc, 'SubscriptionReference', 'Address');
    if (!address) throw new OnvifError('no pull-point address');
    const host = new URL(this.xaddr).host;
    return address.replace(/^(https?:\/\/)[^/]+/, `$1${host}`);
  }

  async pull(subscription: string, waitSeconds = 10): Promise<CameraEvent[]> {
    const doc = await this.request(
      subscription,
      `<tev:PullMessages><tev:Timeout>PT${waitSeconds}S</tev:Timeout><tev:MessageLimit>32</tev:MessageLimit></tev:PullMessages>`,
      { timeoutMs: (waitSeconds + 10) * 1000, header: `<wsa:To>${escapeXml(subscription)}</wsa:To><wsa:Action>http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest</wsa:Action>` },
    );
    return findAll(doc, 'NotificationMessage').flatMap((m) => {
      const e = parseEvent(m);
      return e ? [e] : [];
    });
  }

  async renew(subscription: string): Promise<void> {
    await this.request(subscription, '<wsnt:Renew><wsnt:TerminationTime>PT120S</wsnt:TerminationTime></wsnt:Renew>', {
      header: `<wsa:To>${escapeXml(subscription)}</wsa:To><wsa:Action>http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest</wsa:Action>`,
    });
  }

  async unsubscribe(subscription: string): Promise<void> {
    await this.request(subscription, '<wsnt:Unsubscribe/>', { timeoutMs: 3000 }).catch(() => {});
  }
}

const ACTIVE_ITEMS = ['IsMotion', 'State', 'IsPeople', 'IsPerson', 'IsHuman', 'Motion', 'IsInside', 'IsTamper'];

/** One NotificationMessage → a motion / person event (other topics are reported as "other"). */
export function parseEvent(m: XmlNode): CameraEvent | undefined {
  const topic = text(m, 'Topic') ?? '';
  const data = find(m, 'Data');
  const items = findAll(data, 'SimpleItem');
  const item = items.find((i) => ACTIVE_ITEMS.includes(i.attrs.Name ?? '')) ?? items[0];
  if (!item) return undefined;
  const active = /^(true|1|active)$/i.test(item.attrs.Value ?? '');
  const source = findAll(find(m, 'Source'), 'SimpleItem').map((i) => i.attrs.Value).filter(Boolean).join('/') || undefined;
  const t = `${topic} ${item.attrs.Name}`;
  const kind = /people|person|human|body/i.test(t) ? 'person' : /motion|cellmotion|pir/i.test(t) ? 'motion' : 'other';
  return { topic: topic.replace(/^[a-z0-9]+:/i, ''), ...(source ? { source } : {}), active, kind };
}
