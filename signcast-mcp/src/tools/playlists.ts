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

export const addMediaToPlaylistSchema = {
  media_name: z.string().describe('Media item name (fuzzy match, must resolve to one item in your stores).'),
  playlist_name: z.string().describe('Playlist name (fuzzy match, must resolve to one playlist in the same store).'),
};

export async function addMediaToPlaylist(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof addMediaToPlaylistSchema>>,
) {
  const storeIds = await callerStoreIds(auth.sub);
  const db = getDb();

  const mq = args.media_name.toLowerCase();
  const { data: media, error: medErr } = await db
    .from('media')
    .select('id, name, store_id')
    .in('store_id', storeIds)
    .is('archived_at', null);
  if (medErr) throw new Error(`media lookup failed: ${medErr.message}`);
  const mMatches = (media ?? []).filter((m) => m.name.toLowerCase().includes(mq));
  if (mMatches.length === 0) throw new Error(`No media matches "${args.media_name}".`);
  if (mMatches.length > 1) {
    throw new Error(`Ambiguous media — matches: ${mMatches.map((m) => m.name).join(', ')}.`);
  }
  const item = mMatches[0];

  const pq = args.playlist_name.toLowerCase();
  const { data: pls, error: plErr } = await db
    .from('playlists')
    .select('id, name')
    .eq('store_id', item.store_id)
    .is('archived_at', null);
  if (plErr) throw new Error(`playlist lookup failed: ${plErr.message}`);
  const pMatches = (pls ?? []).filter((p) => p.name.toLowerCase().includes(pq));
  if (pMatches.length === 0) throw new Error(`No playlist matches "${args.playlist_name}" in this media's store.`);
  if (pMatches.length > 1) {
    throw new Error(`Ambiguous playlist — matches: ${pMatches.map((p) => p.name).join(', ')}.`);
  }
  const playlist = pMatches[0];

  const { data: existing } = await db
    .from('playlist_items')
    .select('id')
    .eq('playlist_id', playlist.id)
    .eq('media_id', item.id)
    .limit(1);
  if (existing && existing.length > 0) {
    return { added: false, media: item.name, playlist: playlist.name, message: `"${item.name}" is already in the "${playlist.name}" playlist.` };
  }

  const { data: items } = await db
    .from('playlist_items')
    .select('position')
    .eq('playlist_id', playlist.id)
    .order('position', { ascending: false })
    .limit(1);
  const nextPos = (items && items.length ? items[0].position : 0) + 1;
  const { error: insErr } = await db
    .from('playlist_items')
    .insert({ playlist_id: playlist.id, media_id: item.id, position: nextPos });
  if (insErr) throw new Error(`playlist add failed: ${insErr.message}`);

  return {
    added: true,
    media: item.name,
    playlist: playlist.name,
    message: `"${item.name}" was added to the "${playlist.name}" playlist.`,
  };
}

export const createPlaylistSchema = {
  playlist_name: z.string().describe('Name for the new playlist (slideshow).'),
  store_name: z.string().optional().describe('Store to create it in (fuzzy match). Required when the account has several stores.'),
};

export async function createPlaylist(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof createPlaylistSchema>>,
) {
  const db = getDb();
  const storeIds = await callerStoreIds(auth.sub);
  const { data: stores, error: stErr } = await db
    .from('stores')
    .select('id, name, client_id')
    .in('id', storeIds);
  if (stErr) throw new Error(`store lookup failed: ${stErr.message}`);
  const list = stores ?? [];
  let store: { id: string; name: string; client_id: string };
  if (args.store_name) {
    const q = args.store_name.toLowerCase();
    const m = list.filter((s) => s.name.toLowerCase().includes(q));
    if (m.length === 0) throw new Error(`No store matches "${args.store_name}".`);
    if (m.length > 1) throw new Error(`Ambiguous store — matches: ${m.map((s) => s.name).join(', ')}.`);
    store = m[0];
  } else {
    if (list.length === 0) throw new Error('No stores found for this account.');
    if (list.length > 1) throw new Error('Multiple stores — name the store to create the playlist in.');
    store = list[0];
  }

  const { data: existing } = await db
    .from('playlists')
    .select('id, name')
    .eq('store_id', store.id)
    .is('archived_at', null);
  const dup = (existing ?? []).find((p) => p.name.toLowerCase() === args.playlist_name.toLowerCase());
  if (dup) {
    return {
      created: false,
      playlist: dup.name,
      store: store.name,
      message: `A playlist named "${dup.name}" already exists in ${store.name} — use that one.`,
    };
  }

  const { data: created, error: insErr } = await db
    .from('playlists')
    .insert({ store_id: store.id, client_id: store.client_id, name: args.playlist_name })
    .select('id, name')
    .single();
  if (insErr || !created) throw new Error(`playlist create failed: ${insErr?.message ?? 'no row'}`);

  return {
    created: true,
    playlist: created.name,
    store: store.name,
    message: `Playlist "${created.name}" created in ${store.name}. Add images to it, then assign or schedule it.`,
  };
}

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
