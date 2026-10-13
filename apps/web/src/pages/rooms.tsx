import { useState } from 'react';
import type { Room } from '@livynq/model';
import { Icon } from '../components/icons.tsx';
import { toast } from '../components/toast.tsx';
import { Button, Card, ConfirmButton, EmptyState, IconButton, PageHeader, Spinner } from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';
import { useLive } from '../lib/live.ts';
import { useCan } from '../lib/session.ts';

export function RoomsPage() {
  const t = useT();
  const { rooms, devices, ready } = useLive();
  const canAdmin = useCan('admin');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const counts = new Map<string, number>();
  for (const d of Object.values(devices)) if (d.roomId) counts.set(d.roomId, (counts.get(d.roomId) ?? 0) + 1);

  const guard = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  // Swap with the neighbour and renumber everything so sortOrder stays dense and unique.
  const move = (index: number, delta: -1 | 1) =>
    guard(rooms[index]!.id, async () => {
      const order = [...rooms];
      const [item] = order.splice(index, 1);
      order.splice(index + delta, 0, item!);
      await Promise.all(order.map((r, i) => (r.sortOrder === i ? undefined : api.updateRoom(r.id, { sortOrder: i }))));
    });

  return (
    <>
      <PageHeader title={t('rooms.title')} subtitle={t('rooms.subtitle')} />
      {canAdmin && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (!n) return;
            setCreating(true);
            api.createRoom(n).then(
              () => {
                setName('');
                setCreating(false);
              },
              (err: unknown) => {
                setCreating(false);
                toast(errorMessage(err), 'error');
              },
            );
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('rooms.new')}
            aria-label={t('rooms.new')}
            maxLength={60}
            className="min-h-11 min-w-0 flex-1 rounded-ctl border border-line bg-surface px-3.5 text-sm text-ink shadow-card outline-none placeholder:text-muted focus:border-amber-ink"
          />
          <Button type="submit" variant="primary" icon="plus" busy={creating} disabled={!name.trim()}>
            {t('rooms.add')}
          </Button>
        </form>
      )}
      <Card className="p-1.5! md:p-2!">
        {!ready ? (
          <div className="grid place-items-center py-12 text-muted">
            <Spinner size={20} />
          </div>
        ) : rooms.length === 0 ? (
          <EmptyState icon="layers" title={t('rooms.empty')} />
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {rooms.map((r, i) => (
              <RoomRow
                key={r.id}
                room={r}
                count={counts.get(r.id) ?? 0}
                first={i === 0}
                last={i === rooms.length - 1}
                busy={busy === r.id}
                canAdmin={canAdmin}
                onMove={(d) => void move(i, d)}
                onRename={(n) => guard(r.id, () => api.updateRoom(r.id, { name: n }))}
                onDelete={() => void guard(r.id, () => api.deleteRoom(r.id))}
              />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function RoomRow({
  room,
  count,
  first,
  last,
  busy,
  canAdmin,
  onMove,
  onRename,
  onDelete,
}: {
  room: Room;
  count: number;
  first: boolean;
  last: boolean;
  busy: boolean;
  canAdmin: boolean;
  onMove: (delta: -1 | 1) => void;
  onRename: (name: string) => Promise<void>;
  onDelete: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(room.name);
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line p-3 last:border-b-0">
      <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-chip text-muted">
        <Icon name="layers" size={16} />
      </span>
      {editing ? (
        <form
          className="flex min-w-[180px] flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (!n || n === room.name) return setEditing(false);
            void onRename(n).then(() => setEditing(false));
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={t('common.rename')}
            maxLength={60}
            onKeyDown={(e) => e.key === 'Escape' && (setName(room.name), setEditing(false))}
            className="min-h-10 min-w-0 flex-1 rounded-ctl border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-amber-ink"
          />
          <Button size="sm" type="submit" variant="primary" busy={busy}>
            {t('common.save')}
          </Button>
        </form>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-bold">{room.name}</div>
          <div className="text-[12.5px] text-muted">{t('rooms.deviceCount', { n: count })}</div>
        </div>
      )}
      {canAdmin && !editing && (
        <div className="flex items-center gap-1.5">
          {busy && <Spinner size={14} className="text-muted" />}
          <IconButton icon="chevronUp" label={t('common.moveUp')} disabled={first || busy} onClick={() => onMove(-1)} className="size-9" />
          <IconButton icon="chevronDown" label={t('common.moveDown')} disabled={last || busy} onClick={() => onMove(1)} className="size-9" />
          <IconButton
            icon="pencil"
            label={t('common.rename')}
            onClick={() => {
              setName(room.name);
              setEditing(true);
            }}
            className="size-9"
          />
          <ConfirmButton size="sm" label={t('common.delete')} confirmLabel={t('common.confirmDelete')} onConfirm={onDelete} />
        </div>
      )}
      {canAdmin && !editing && count > 0 && <span className="sr-only">{t('rooms.deleteBody')}</span>}
    </li>
  );
}
