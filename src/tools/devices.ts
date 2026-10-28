/**
 * tools/devices.ts — Phase 4a: list_devices (read-only).
 */
import { z } from 'zod';
import { getDb, callerStoreIds, callerStores } from '../db.js';
import type { AuthContext } from '../auth.js';

export const listDevicesSchema = {
  store_name: z
    .string()
    .optional()
    .describe('Filter to one store by name (fuzzy match). Omit for all your stores.'),
};

export async function listDevices(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof listDevicesSchema>>,
) {
  const storeIds = await callerStoreIds(auth.sub);
  const stores = await callerStores(auth.sub);

  let ids = storeIds;
  if (args.store_name) {
    const q = args.store_name.toLowerCase();
    ids = [...stores.entries()]
      .filter(([, s]) => s.name.toLowerCase().includes(q))
      .map(([id]) => id);
    if (ids.length === 0) {
      return { devices: [], note: `No store matches "${args.store_name}".` };
    }
  }

  const db = getDb();
  const { data, error } = await db
    .from('devices')
    .select(
      'id, name, store_id, enrollment_status, assigned_playlist_id, last_seen_at, current_media_id, current_playlist_id, current_item_started_at',
    )
    .in('store_id', ids)
    .order('name');
  if (error) throw new Error(`list_devices failed: ${error.message}`);

  const playlistIds = [...new Set((data ?? []).map((d) => d.assigned_playlist_id).filter(Boolean))];
  let playlistNames = new Map<string, string>();
  if (playlistIds.length > 0) {
    const { data: pls } = await db.from('playlists').select('id, name').in('id', playlistIds);
    playlistNames = new Map((pls ?? []).map((p) => [p.id, p.name]));
  }

  return {
    devices: (data ?? []).map((d) => ({
      name: d.name,
      store: stores.get(d.store_id)?.name ?? '(unknown store)',
      status: d.enrollment_status,
      assigned_playlist: d.assigned_playlist_id
        ? (playlistNames.get(d.assigned_playlist_id) ?? d.assigned_playlist_id)
        : null,
      last_seen_at: d.last_seen_at,
      now_playing: d.current_media_id
        ? { media_id: d.current_media_id, started_at: d.current_item_started_at }
        : d.current_playlist_id
          ? { playlist_id: d.current_playlist_id, started_at: d.current_item_started_at }
          : null,
    })),
  };
}
