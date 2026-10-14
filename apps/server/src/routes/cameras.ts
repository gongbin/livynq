import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { LivynqError, canSeeDevice, redactUrl, type Home } from '@livynq/core';
import { SnapshotCache, SnapshotError, StreamHub, type Viewer } from '@livynq/media';

/**
 * Camera live view and snapshots. Plugins register stream sources (ctx.media.register); the hub
 * pulls RTSP itself and sends fragmented MP4 over a WebSocket:
 *
 *   GET /api/v1/cameras/:deviceId/:endpointId/live          (WebSocket)
 *     → {type:'init', mime, codec, width, height, hasAudio}, then binary init segment + fragments
 *     → {type:'status', state:'reconnecting', error} / {type:'error', message}
 *   GET /api/v1/cameras/:deviceId/:endpointId/snapshot.jpg
 *
 * Stream URLs and credentials never leave the hub.
 */

const key = (deviceId: string, endpointId: number) => `${deviceId}/${endpointId}`;

export function createCameraHub(home: Home): StreamHub {
  const split = (k: string) => {
    const i = k.lastIndexOf('/');
    return { deviceId: k.slice(0, i), endpointId: Number(k.slice(i + 1)) };
  };
  const hub = new StreamHub({
    source: (k) => {
      const { deviceId, endpointId } = split(k);
      return home.media.get(deviceId, endpointId)?.source;
    },
    onState: (k, state) => {
      const { deviceId, endpointId } = split(k);
      const device = home.registry.getDevice(deviceId);
      if (!device?.endpoints.some((e) => e.id === endpointId && e.capabilities.includes('camera'))) return;
      home.registry.updateState(deviceId, endpointId, 'camera', state as Record<string, string | number | boolean>, 'media');
    },
    log: {
      info: (msg, data) => home.log.info({ ...data, ...(typeof data?.url === 'string' ? { url: redactUrl(data.url) } : {}) }, msg),
      warn: (msg, data) => home.log.warn(data ?? {}, msg),
    },
  });
  // A changed or removed source restarts (or ends) live streams.
  home.media.onChange((deviceId, endpointId) => hub.invalidate(key(deviceId, endpointId)));
  return hub;
}

export function registerCameraRoutes(app: FastifyInstance, home: Home, hub: StreamHub, guards: { read: { preHandler: preHandlerAsyncHookHandler } }): void {
  const snapshots = new SnapshotCache();
  app.addHook('onClose', async () => hub.close());

  const camera = (req: FastifyRequest) => {
    const { deviceId, endpointId } = req.params as { deviceId: string; endpointId: string };
    const ep = Number(endpointId);
    const device = home.registry.getDevice(deviceId);
    // Cameras in rooms an account can't see don't exist for it.
    if (!device || !device.endpoints.some((e) => e.id === ep && e.capabilities.includes('camera')) || (req.access && !canSeeDevice(req.access, device))) {
      throw new LivynqError('NOT_FOUND', `No camera ${deviceId}/${endpointId}`);
    }
    return { deviceId, endpointId: ep, k: key(deviceId, ep) };
  };

  app.get('/api/v1/cameras/:deviceId/:endpointId/snapshot.jpg', guards.read, async (req, reply) => {
    const { deviceId, endpointId, k } = camera(req);
    try {
      const snap = await snapshots.get(k, home.media.get(deviceId, endpointId)?.source);
      return reply.header('cache-control', 'no-store').type(snap.contentType).send(snap.data);
    } catch (err) {
      if (err instanceof SnapshotError) return reply.status(err.status).send({ error: { code: err.status === 404 ? 'NOT_FOUND' : 'DEVICE_OFFLINE', message: err.message } });
      throw err;
    }
  });

  app.get('/api/v1/cameras/:deviceId/:endpointId/live', { websocket: true, preHandler: guards.read.preHandler }, (socket, req) => {
    let target: { k: string };
    try {
      target = camera(req);
    } catch (err) {
      socket.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
      socket.close(4404, 'not found');
      return;
    }
    const viewer: Viewer = {
      sendJson: (msg) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg)),
      sendBinary: (data) => socket.readyState === socket.OPEN && socket.send(data, { binary: true }),
      buffered: () => socket.bufferedAmount,
    };
    const stop = hub.watch(target.k, viewer);
    socket.on('close', stop);
    socket.on('error', stop);
  });
}
