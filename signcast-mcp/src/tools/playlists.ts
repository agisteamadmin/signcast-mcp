/**
 * tools/playlists.ts — Phase 4b: assign_playlist (write).
 */
import { z } from 'zod';
import { getDb, callerStoreIds } from '../db.js';
import type { AuthContext } from '../auth.js';

export const assignPlaylistSchema = {
  device_name: z.string().describe('Device name (fuzzy match).'),
  playlist_name: z.string().describe('Playlist name (fuzzy match, must resolve to one playlist).'),
};

export async function assignPlaylist(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof assignPlaylistSchema>>,
) {
  const storeIds = await callerStoreIds(auth.sub);
  const db = getDb();

  const dq = args.device_name.toLowerCase();
  const { data: devs, error: devErr } = await db
    .from('devices')
    .select('id, name, store_id')
    .in('store_id', storeIds);
  if (devErr) throw new Error(`device lookup failed: ${devErr.message}`);
  const dMatches = (devs ?? []).filter((d) => d.name.toLowerCase().includes(dq));
  if (dMatches.length === 0) throw new Error(`No device matches "${args.device_name}".`);
  if (dMatches.length > 1) {
    throw new Error(`Ambiguous device — matches: ${dMatches.map((d) => d.name).join(', ')}.`);
  }
  const device = dMatches[0];

  const pq = args.playlist_name.toLowerCase();
  const { data: pls, error: plErr } = await db
    .from('playlists')
    .select('id, name, store_id')
    .eq('store_id', device.store_id)
    .is('archived_at', null);
  if (plErr) throw new Error(`playlist lookup failed: ${plErr.message}`);
  const pMatches = (pls ?? []).filter((p) => p.name.toLowerCase().includes(pq));
  if (pMatches.length === 0) throw new Error(`No playlist matches "${args.playlist_name}" in this device's store.`);
  if (pMatches.length > 1) {
    throw new Error(`Ambiguous playlist — matches: ${pMatches.map((p) => p.name).join(', ')}.`);
  }
  const playlist = pMatches[0];

  const { error: updErr } = await db
    .from('devices')
    .update({ assigned_playlist_id: playlist.id })
    .eq('id', device.id);
  if (updErr) throw new Error(`assign_playlist failed: ${updErr.message}`);

  // Keep the targeting table in sync (playlist editor checkboxes read it).
  const { error: linkErr } = await db
    .from('playlist_devices')
    .upsert({ playlist_id: playlist.id, device_id: device.id }, { onConflict: 'playlist_id,device_id' });
  if (linkErr) throw new Error(`playlist_devices upsert failed: ${linkErr.message}`);

  return {
    assigned: true,
    device: device.name,
    playlist: playlist.name,
    message: `"${device.name}" is now playing the "${playlist.name}" playlist.`,
  };
}
