import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AttributeValue, CameraSource, DeviceDefinition, PluginContext, PluginDevice } from '@livynq/sdk';
import plugin, { pickProfile } from '../src/index.ts';
import { OnvifCamera, discover, parseEvent } from '../src/onvif.ts';
import { find, parseXml, text } from '../src/xml.ts';

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timeout: ${fn.toString().slice(0, 160)}`);
    await sleep(20);
  }
}

const env = (body: string) => `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:tns1="http://www.onvif.org/ver10/topics"><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
const event = (topic: string, name: string, value: boolean) =>
  `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:${topic}</wsnt:Topic><wsnt:Message><tt:Message UtcTime="2026-10-14T01:00:00Z" PropertyOperation="Changed"><tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="vsc"/></tt:Source><tt:Data><tt:SimpleItem Name="${name}" Value="${value}"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`;

/** A Hikvision-like ONVIF camera whose clock runs 2 hours ahead. */
function fakeCamera(user: string, pass: string) {
  const skew = 2 * 3600_000;
  const pulls: string[][] = [[event('RuleEngine/CellMotionDetector/Motion', 'IsMotion', true)], [event('RuleEngine/PeopleDetector/People', 'IsPeople', true), event('RuleEngine/CellMotionDetector/Motion', 'IsMotion', false)]];
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', async () => {
      const doc = parseXml(raw);
      const body = find(doc, 'Body')!.children[0]!;
      seen.push(body.name);
      const send = (xml: string, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/soap+xml' });
        res.end(env(xml));
      };
      if (body.name === 'GetSystemDateAndTime') {
        const d = new Date(Date.now() + skew);
        return send(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
      }
      // WS-Security digest, and a timestamp within 60 s of the camera's clock.
      const nonce = Buffer.from(text(doc, 'Nonce') ?? '', 'base64');
      const created = text(doc, 'Created') ?? '';
      const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(pass)])).digest('base64');
      if (text(doc, 'Username') !== user || text(doc, 'Password') !== digest || Math.abs(Date.parse(created) - (Date.now() + skew)) > 60_000) {
        return send('<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>ter:NotAuthorized</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">Sender not Authorized</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>', 400);
      }
      const port = (server.address() as AddressInfo).port;
      switch (body.name) {
        case 'GetDeviceInformation':
          return send('<tds:GetDeviceInformationResponse><tds:Manufacturer>HIKVISION</tds:Manufacturer><tds:Model>DS-2CD2143G2</tds:Model><tds:FirmwareVersion>V5.7.3</tds:FirmwareVersion><tds:SerialNumber>DS-2CD2143G2-12345</tds:SerialNumber><tds:HardwareId>88</tds:HardwareId></tds:GetDeviceInformationResponse>');
        case 'GetCapabilities':
          // Reports an internal address; the client must keep using the one it reached.
          return send(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Events><tt:XAddr>http://10.9.9.9:${port}/onvif/Events</tt:XAddr></tt:Events><tt:Media><tt:XAddr>http://10.9.9.9:${port}/onvif/Media</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`);
        case 'GetProfiles':
          return send(
            '<trt:GetProfilesResponse>' +
              [['Profile_101', 'mainStream', 2560, 1440, 'H265'], ['Profile_102', 'subStream', 640, 360, 'H264']]
                .map(([t, n, w, h, e]) => `<trt:Profiles token="${t}" fixed="true"><tt:Name>${n}</tt:Name><tt:VideoEncoderConfiguration token="v${t}"><tt:Encoding>${e}</tt:Encoding><tt:Resolution><tt:Width>${w}</tt:Width><tt:Height>${h}</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>`)
                .join('') +
              '</trt:GetProfilesResponse>',
          );
        case 'GetStreamUri': {
          const token = text(body, 'ProfileToken');
          return send(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://0.0.0.0:554/Streaming/Channels/${token === 'Profile_102' ? 102 : 101}?transportmode=unicast&amp;profile=${token}</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`);
        }
        case 'GetSnapshotUri':
          return send(`<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://10.9.9.9/onvif-http/snapshot?Profile_1</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>`);
        case 'CreatePullPointSubscription':
          return send(`<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa5:Address xmlns:wsa5="http://www.w3.org/2005/08/addressing">http://10.9.9.9:${port}/onvif/Events/PullSubManager_1</wsa5:Address></tev:SubscriptionReference></tev:CreatePullPointSubscriptionResponse>`);
        case 'PullMessages': {
          // Like a real camera: events arrive over time, not all at once.
          await sleep(250);
          const next = pulls.shift();
          return send(`<tev:PullMessagesResponse><tev:CurrentTime>2026-10-14T01:00:00Z</tev:CurrentTime>${(next ?? []).join('')}</tev:PullMessagesResponse>`);
        }
        case 'Renew':
        case 'Unsubscribe':
          return send(`<wsnt:${body.name}Response/>`);
      }
      send(`<SOAP-ENV:Fault><SOAP-ENV:Reason><SOAP-ENV:Text>unsupported ${body.name}</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`, 400);
    });
  });
  return {
    seen,
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    close: () => server.close(),
  };
}

test('xml, profiles and events', () => {
  const doc = parseXml('<?xml version="1.0"?><a:Root xmlns:a="x"><a:Item k="v &amp; w">one &lt;1&gt;</a:Item><b:Item/><![CDATA[<raw>]]></a:Root>');
  assert.equal(text(doc, 'Root', 'Item'), 'one <1>');
  assert.equal(find(doc, 'Item')!.attrs.k, 'v & w');
  const profiles = [
    { token: 'a', name: 'main', width: 1920, height: 1080, encoding: 'H264' },
    { token: 'b', name: 'sub', width: 640, height: 360, encoding: 'H264' },
    { token: 'c', name: 'mjpeg', width: 3840, height: 2160, encoding: 'JPEG' },
  ];
  assert.equal(pickProfile(profiles)!.token, 'a');
  assert.equal(pickProfile(profiles, 'sub')!.token, 'b');
  assert.equal(pickProfile(profiles, 'c')!.token, 'c');
  const msg = (x: string) => find(parseXml(env(x)), 'NotificationMessage')!;
  assert.deepEqual(parseEvent(msg(event('RuleEngine/CellMotionDetector/Motion', 'IsMotion', true))), { topic: 'RuleEngine/CellMotionDetector/Motion', source: 'vsc', active: true, kind: 'motion' });
  assert.equal(parseEvent(msg(event('RuleEngine/MyRuleDetector/PeopleDetect', 'State', false)))!.kind, 'person');
  assert.equal(parseEvent(msg(event('VideoSource/ImageTooBlurry', 'State', true)))!.kind, 'other');
});

test('ONVIF client: clock skew, digest auth, internal addresses, wrong password', async () => {
  const cam = fakeCamera('admin', 'secret');
  const port = await cam.listen();
  const xaddr = `http://127.0.0.1:${port}/onvif/device_service`;
  try {
    const c = new OnvifCamera({ xaddr, username: 'admin', password: 'secret' });
    assert.deepEqual(await c.connect(), { manufacturer: 'HIKVISION', model: 'DS-2CD2143G2', firmware: 'V5.7.3', serial: 'DS-2CD2143G2-12345' });
    const profiles = await c.profiles();
    assert.deepEqual(profiles.map((p) => [p.token, p.encoding, p.width]), [['Profile_101', 'H265', 2560], ['Profile_102', 'H264', 640]]);
    assert.equal(await c.streamUri('Profile_102'), 'rtsp://127.0.0.1:554/Streaming/Channels/102?transportmode=unicast&profile=Profile_102');
    assert.equal(await c.snapshotUri('Profile_101'), 'http://127.0.0.1/onvif-http/snapshot?Profile_1');
    const sub = await c.subscribe();
    assert.equal(sub, `http://127.0.0.1:${port}/onvif/Events/PullSubManager_1`);
    assert.deepEqual((await c.pull(sub, 1)).map((e) => [e.kind, e.active]), [['motion', true]]);

    const wrong = new OnvifCamera({ xaddr, username: 'admin', password: 'nope' });
    await assert.rejects(wrong.connect(), (e: Error & { auth?: boolean }) => e.auth === true && /password/.test(e.message));
  } finally {
    cam.close();
  }
});

test('WS-Discovery probe', async () => {
  const responder = createSocket('udp4');
  responder.on('message', (msg, rinfo) => {
    const id = /MessageID>([^<]+)</.exec(msg.toString())?.[1];
    const reply = `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><SOAP-ENV:Header><wsa:RelatesTo>${id}</wsa:RelatesTo></SOAP-ENV:Header><SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch><wsa:EndpointReference><wsa:Address>urn:uuid:5f5a6b7c-1111</wsa:Address></wsa:EndpointReference><d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/Front%20Door onvif://www.onvif.org/hardware/DS-2CD2143G2</d:Scopes><d:XAddrs>http://169.254.1.2/onvif/device_service http://127.0.0.1/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
    responder.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => responder.bind(0, '127.0.0.1', () => r()));
  try {
    const found = await discover(800, { address: '127.0.0.1', port: responder.address().port });
    assert.deepEqual(found, [{ xaddr: 'http://127.0.0.1/onvif/device_service', host: '127.0.0.1', urn: 'urn:uuid:5f5a6b7c-1111', name: 'Front Door', hardware: 'DS-2CD2143G2' }]);
  } finally {
    responder.close();
  }
});

/** Minimal plugin context: records devices, attribute updates and media registrations. */
function fakeContext(dataDir: string, config: Record<string, unknown> = {}) {
  const devices = new Map<string, DeviceDefinition & { availability?: string }>();
  const state = new Map<string, AttributeValue>();
  const media = new Map<string, CameraSource>();
  const actions = new Map<string, (p: Record<string, unknown>) => unknown>();
  const stops: (() => unknown)[] = [];
  let nextEp = 1;
  const eps = new Map<string, number>();
  const ctx: PluginContext = {
    pluginId: 'camera',
    log: { debug() {}, info() {}, warn() {}, error() {} },
    config,
    dataDir,
    devices: {
      async upsert(def) {
        devices.set(def.id, { ...def });
        const dev: PluginDevice = {
          id: def.id,
          update: (ep, cap, attrs) => {
            for (const [k, v] of Object.entries(attrs)) state.set(`${def.id}/${ep}/${cap}.${k}`, v);
          },
          get: (ep, cap, attr) => state.get(`${def.id}/${ep}/${cap}.${attr}`),
          setAvailability: (a) => (devices.get(def.id)!.availability = a),
          handle() {},
        };
        return dev;
      },
      async remove(id) {
        devices.delete(id);
      },
      async known() {
        return [];
      },
      async exists(id) {
        return devices.has(id);
      },
    },
    media: {
      register: (id, ep, src) => media.set(`${id}/${ep}`, src),
      unregister: (id, ep) => media.delete(`${id}/${ep}`),
    },
    async endpointId(id, key) {
      const k = `${id}/${key}`;
      if (!eps.has(k)) eps.set(k, nextEp++);
      return eps.get(k)!;
    },
    onStop: (fn) => stops.push(fn),
    actions: { register: (name, _d, fn) => actions.set(name, fn) },
  };
  return { ctx, devices, state, media, action: (name: string, p: Record<string, unknown> = {}) => Promise.resolve(actions.get(name)!(p)), stop: async () => { for (const s of stops) await s(); } };
}

test('camera plugin: ONVIF camera with events, plain RTSP camera, wrong password', async () => {
  const cam = fakeCamera('admin', 'secret');
  const port = await cam.listen();
  const dir = mkdtempSync(join(tmpdir(), 'livynq-camera-'));
  const f = fakeContext(dir);
  try {
    await plugin.setup(f.ctx);
    await assert.rejects(f.action('add', { xaddr: `http://127.0.0.1:${port}/onvif/device_service`, username: 'admin', password: 'bad' }), /password/);
    const added = (await f.action('add', { xaddr: `http://127.0.0.1:${port}/onvif/device_service`, username: 'admin', password: 'secret', profile: 'sub', name: 'Front door' })) as { name: string; resolution: string };
    assert.deepEqual([added.name, added.resolution], ['Front door', '640×360']);
    assert.equal(statSync(join(dir, 'cameras.json')).mode & 0o077, 0, 'credentials are stored owner-only');

    await until(() => [...f.devices.values()].some((d) => d.name === 'Front door'));
    const dev = [...f.devices.values()].find((d) => d.name === 'Front door')!;
    await until(() => f.media.has(`${dev.id}/${dev.endpoints[0]!.id}`));
    assert.deepEqual(dev.endpoints.slice(0, 2).map((e) => [e.deviceType, e.name]), [['camera.camera', undefined], ['binarySensor.occupancy', 'Motion']]);
    const source = f.media.get(`${dev.id}/${dev.endpoints[0]!.id}`)!;
    assert.deepEqual(source, { url: 'rtsp://127.0.0.1:554/Streaming/Channels/102?transportmode=unicast&profile=Profile_102', username: 'admin', password: 'secret', snapshotUrl: 'http://127.0.0.1/onvif-http/snapshot?Profile_1' });

    // Motion, then the first person event adds a Person sensor.
    const motionEp = dev.endpoints[1]!.id;
    await until(() => f.state.get(`${dev.id}/${motionEp}/occupancySensing.occupied`) === true);
    await until(() => (f.devices.get(dev.id)?.endpoints.length ?? 0) === 3);
    const person = f.devices.get(dev.id)!.endpoints[2]!;
    assert.equal(person.name, 'Person');
    await until(() => f.state.get(`${dev.id}/${person.id}/occupancySensing.occupied`) === true && f.state.get(`${dev.id}/${motionEp}/occupancySensing.occupied`) === false);

    // A plain RTSP camera: credentials taken out of the URL
    await f.action('add', { url: 'rtsp://user:p%40ss@127.0.0.1:1/live', name: 'Garage' });
    await until(() => [...f.devices.values()].some((d) => d.name === 'Garage'));
    const garage = [...f.devices.values()].find((d) => d.name === 'Garage')!;
    await until(() => f.media.has(`${garage.id}/${garage.endpoints[0]!.id}`));
    assert.deepEqual(f.media.get(`${garage.id}/${garage.endpoints[0]!.id}`), { url: 'rtsp://127.0.0.1:1/live', username: 'user', password: 'p@ss' });
    await until(() => f.devices.get(garage.id)?.availability === 'offline');

    const list = (await f.action('cameras')) as { name: string; state: string; events: boolean }[];
    assert.deepEqual(list.map((c) => [c.name, c.state, c.events]).sort(), [['Front door', 'online', true], ['Garage', 'offline', false]]);
    const key = (list.find((c) => c.name === 'Garage') as unknown as { key: string }).key;
    await f.action('remove', { key });
    assert.equal(f.devices.has(garage.id), false);
    assert.equal(f.media.has(`${garage.id}/${garage.endpoints[0]!.id}`), false);
  } finally {
    await f.stop();
    cam.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
