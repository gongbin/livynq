import type { Device, DeviceDTO } from '@livynq/model';
import type { Home } from './home.ts';

export function toDeviceDTO(home: Home, device: Device): DeviceDTO {
  const entities: Record<number, string> = {};
  for (const ep of device.endpoints) {
    const entityId = home.registry.entityIdFor(device.id, ep.id);
    if (entityId) entities[ep.id] = entityId;
  }
  return {
    ...device,
    roomName: device.roomId ? home.registry.getRoom(device.roomId)?.name ?? null : null,
    entities,
    state: home.registry.getState(device.id),
  };
}
