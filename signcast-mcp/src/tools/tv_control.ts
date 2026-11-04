/**
 * tools/tv_control.ts — Chat TV Control (2026-10-29).
 *
 * show_on_tv: build (or reuse) a playlist from library media and assign it to
 *   a device immediately. Follows the C2-style confirmation rule: when the
 *   device is already playing a DIFFERENT playlist, it returns
 *   needs_confirmation:true and writes nothing; the chat asks the user
 *   "Replace it?" and only re-calls with replace_existing:true on yes.
 * now_playing: what a device is assigned / actually playing + its schedule
 *   blocks, so the chat can prompt the override question accurately.
 * YouTube: a media row with media_type 'youtube' (migration 014) whose
 *   content holds { youtube_url, video_id, embed_url }. The receiver renders
 *   it as an iframe embed. Duplicate YouTube links reuse the existing row.
 */
import { z } from 'zod';
import { getDb, callerStoreIds, callerStores } from '../db.js';
import type { AuthContext } from '../auth.js';

// ---------- shared resolvers (same fuzzy/ambiguity conventions as elsewhere) ----------

export interface StoreRow {
  id: string;
  name: string;
  client_id: string;
}

export async function resolveStore(auth: AuthContext, storeName?: string): Promise<StoreRow> {
  const stores = await callerStores(auth.sub);
  const list: StoreRow[] = [...stores.entries()].map(([id, s]) => ({ id, ...s }));
  if (storeName) {
    const q = storeName.toLowerCase();
    const m = list.filter((s) => s.name.toLowerCase().includes(q));
    if (m.length === 0) throw new Error(`No store matches "${storeName}".`);
    if (m.length > 1) throw new Error(`Ambiguous store — matches: ${m.map((s) => s.name).join(', ')}.`);
    return m[0];
  }
  if (list.length === 0) throw new Error('No stores found for this account.');
  if (list.length > 1) throw new Error('Multiple stores — name the store.');
  return list[0];
}

export async function findOrCreatePlaylist(
  db: ReturnType<typeof getDb>,
  store: StoreRow,
  name: string,
): Promise<{ id: string; name: string }> {
  const { data } = await db
    .from('playlists')
    .select('id, name')
    .eq('store_id', store.id)
    .is('archived_at', null);
  const exact = (data ?? []).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  const { data: created, error } = await db
    .from('playlists')
    .insert({ store_id: store.id, client_id: store.client_id, name })
    .select('id, name')
    .single();
  if (error || !created) throw new Error(`playlist create failed: ${error?.message ?? 'no row'}`);
  return created;
}

interface DeviceRow {
  id: string;
  name: string;
  store_id: string;
  enrollment_status: string;
  assigned_playlist_id: string | null;
  current_playlist_id: string | null;
  current_media_id: string | null;
  last_seen_at: string | null;
}

/** Resolve one enrolled device in a store (by name, or the only one). */
async function resolveDevice(db: ReturnType<typeof getDb>, storeId: string, deviceName?: string): Promise<DeviceRow> {
  const { data, error } = await db
    .from('devices')
    .select('id, name, store_id, enrollment_status, assigned_playlist_id, current_playlist_id, current_media_id, last_seen_at')
    .eq('store_id', storeId)
    .eq('enrollment_status', 'enrolled');
  if (error) throw new Error(`device lookup failed: ${error.message}`);
  const list = (data ?? []) as DeviceRow[];
  if (deviceName) {
    const q = deviceName.toLowerCase();
    const m = list.filter((d) => d.name.toLowerCase().includes(q));
    if (m.length === 0) throw new Error(`No enrolled device matches "${deviceName}" in this store.`);
    if (m.length > 1) throw new Error(`Ambiguous device — matches: ${m.map((d) => d.name).join(', ')}.`);
    return m[0];
  }
  if (list.length === 0) throw new Error('No enrolled device in this store.');
  if (list.length > 1) throw new Error('Multiple devices — name the device.');
  return list[0];
}

async function resolveMediaInStore(
  db: ReturnType<typeof getDb>,
  storeId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const q = name.toLowerCase();
  const { data, error } = await db
    .from('media')
    .select('id, name')
    .eq('store_id', storeId)
    .is('archived_at', null);
  if (error) throw new Error(`media lookup failed: ${error.message}`);
  const m = (data ?? []).filter((x) => x.name.toLowerCase().includes(q));
  if (m.length === 0) throw new Error(`No media matches "${name}" in this store.`);
  if (m.length > 1) throw new Error(`Ambiguous media "${name}" — matches: ${m.map((x) => x.name).join(', ')}.`);
  return m[0];
}

// ---------- YouTube ----------

/** Extract the 11-char video id from watch / youtu.be / embed / Shorts URLs. */
export function parseYoutubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** Reuse the existing youtube row for this video, or create it (migration 014). */
export async function resolveOrCreateYoutube(
  db: ReturnType<typeof getDb>,
  store: StoreRow,
  url: string,
  sub: string,
): Promise<{ id: string; name: string }> {
  const id = parseYoutubeId(url);
  if (!id) throw new Error(`Could not read a YouTube video id from "${url}" (use a watch, youtu.be, embed, or Shorts link).`);
  const { data } = await db
    .from('media')
    .select('id, name, content')
    .eq('store_id', store.id)
    .eq('media_type', 'youtube')
    .is('archived_at', null);
  const existing = (data ?? []).find((r) => (r.content as { video_id?: string } | null)?.video_id === id);
  if (existing) return { id: existing.id, name: existing.name };
  const { data: created, error } = await db
    .from('media')
    .insert({
      store_id: store.id,
      client_id: store.client_id,
      name: `YouTube ${id}`,
      media_type: 'youtube',
      source: 'upload',
      storage_path: null,
      content: { youtube_url: url, video_id: id, embed_url: `https://www.youtube.com/embed/${id}` },
      created_by: sub,
    })
    .select('id, name')
    .single();
  if (error) throw new Error(`YouTube item create failed: ${error.message} (if this mentions media_type, run migration 014 first).`);
  return created;
}

// ---------- show_on_tv ----------

export const showOnTvSchema = {
  media_names: z.array(z.string()).default([]).describe('Library media names to show (images/video, fuzzy match each).'),
  device_name: z.string().optional().describe('Device to show on (fuzzy match). Omit when the store has exactly one enrolled device.'),
  store_name: z.string().optional().describe('Store (fuzzy match). Required when the account has several stores.'),
  playlist_name: z.string().optional().describe('Playlist to fill (defaults to "Chat TV", reused per store).'),
  youtube_url: z.string().optional().describe('YouTube link to play (creates a youtube library item; needs migration 014).'),
  replace_existing: z.boolean().default(false).describe('When true, switch the device even if it is playing another playlist. When false (default), a different current playlist returns needs_confirmation and nothing is written.'),
};

export async function showOnTv(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof showOnTvSchema>>,
) {
  const db = getDb();
  const store = await resolveStore(auth, args.store_name);

  const items: { id: string; name: string }[] = [];
  if (args.youtube_url) items.push(await resolveOrCreateYoutube(db, store, args.youtube_url, auth.sub));
  for (const n of args.media_names ?? []) items.push(await resolveMediaInStore(db, store.id, n));
  if (items.length === 0) throw new Error('Name at least one image/video, or pass a YouTube link.');

  const device = await resolveDevice(db, store.id, args.device_name);

  let playlist: { id: string; name: string };
  if (args.playlist_name) {
    const { data } = await db
      .from('playlists')
      .select('id, name')
      .eq('store_id', store.id)
      .is('archived_at', null);
    const q = args.playlist_name.toLowerCase();
    const exact = (data ?? []).find((p) => p.name.toLowerCase() === q);
    if (exact) {
      playlist = exact;
    } else {
      const fuzzy = (data ?? []).filter((p) => p.name.toLowerCase().includes(q));
      if (fuzzy.length > 1) throw new Error(`Ambiguous playlist "${args.playlist_name}" — matches: ${fuzzy.map((p) => p.name).join(', ')}.`);
      playlist = fuzzy[0] ?? (await findOrCreatePlaylist(db, store, args.playlist_name));
    }
  } else {
    playlist = await findOrCreatePlaylist(db, store, 'Chat TV');
  }

  // Override gate: a DIFFERENT assigned playlist is playing — ask first.
  if (device.assigned_playlist_id && device.assigned_playlist_id !== playlist.id && !args.replace_existing) {
    const { data: cur } = await db
      .from('playlists')
      .select('name')
      .eq('id', device.assigned_playlist_id)
      .maybeSingle();
    return {
      shown: false,
      needs_confirmation: true,
      device: device.name,
      current_playlist: cur?.name ?? 'a playlist',
      target_playlist: playlist.name,
      message: `"${device.name}" is currently playing "${cur?.name ?? 'a playlist'}". Reply "Replace it" to switch it to "${playlist.name}", or "keep it" to leave the TV alone.`,
    };
  }

  // Replace the playlist contents (same playlist-replacement pattern as menus).
  const { error: delErr } = await db.from('playlist_items').delete().eq('playlist_id', playlist.id);
  if (delErr) throw new Error(`playlist replace failed: ${delErr.message}`);
  const { error: insErr } = await db
    .from('playlist_items')
    .insert(items.map((it, i) => ({ playlist_id: playlist.id, media_id: it.id, position: i + 1 })));
  if (insErr) throw new Error(`playlist fill failed: ${insErr.message}`);

  // Assign (same two writes as assign_playlist).
  const { error: updErr } = await db
    .from('devices')
    .update({ assigned_playlist_id: playlist.id })
    .eq('id', device.id);
  if (updErr) throw new Error(`assign failed: ${updErr.message}`);
  const { error: linkErr } = await db
    .from('playlist_devices')
    .upsert({ playlist_id: playlist.id, device_id: device.id }, { onConflict: 'playlist_id,device_id' });
  if (linkErr) throw new Error(`playlist_devices upsert failed: ${linkErr.message}`);

  return {
    shown: true,
    device: device.name,
    playlist: playlist.name,
    items: items.map((i) => i.name),
    message: `"${device.name}" is now showing "${playlist.name}" (${items.map((i) => i.name).join(', ')}).`,
  };
}

// ---------- now_playing ----------

export const nowPlayingSchema = {
  device_name: z.string().optional().describe('Device (fuzzy match). Omit when the account has exactly one enrolled device.'),
  store_name: z.string().optional().describe('Store (fuzzy match).'),
};

const DAY_NAMES_NP = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function nowPlaying(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof nowPlayingSchema>>,
) {
  const db = getDb();
  const storeIds = await callerStoreIds(auth.sub);
  if (args.store_name) {
    const store = await resolveStore(auth, args.store_name);
    storeIds.splice(0, storeIds.length, store.id);
  }
  const { data: devs, error } = await db
    .from('devices')
    .select('id, name, store_id, enrollment_status, assigned_playlist_id, current_playlist_id, current_media_id, last_seen_at')
    .in('store_id', storeIds)
    .eq('enrollment_status', 'enrolled');
  if (error) throw new Error(`device lookup failed: ${error.message}`);
  const list = (devs ?? []) as DeviceRow[];
  let device: DeviceRow;
  if (args.device_name) {
    const q = args.device_name.toLowerCase();
    const m = list.filter((d) => d.name.toLowerCase().includes(q));
    if (m.length === 0) throw new Error(`No enrolled device matches "${args.device_name}".`);
    if (m.length > 1) throw new Error(`Ambiguous device — matches: ${m.map((d) => d.name).join(', ')}.`);
    device = m[0];
  } else {
    if (list.length === 0) throw new Error('No enrolled device found.');
    if (list.length > 1) throw new Error('Multiple devices — name the device.');
    device = list[0];
  }

  const plIds = [device.assigned_playlist_id, device.current_playlist_id].filter(Boolean) as string[];
  const { data: pls } = plIds.length
    ? await db.from('playlists').select('id, name').in('id', plIds)
    : { data: [] as { id: string; name: string }[] };
  const plName = new Map((pls ?? []).map((p) => [p.id, p.name]));

  let curMedia: string | null = null;
  if (device.current_media_id) {
    const { data } = await db.from('media').select('name').eq('id', device.current_media_id).maybeSingle();
    curMedia = data?.name ?? null;
  }

  const { data: links } = await db.from('schedule_devices').select('schedule_id').eq('device_id', device.id);
  const sids = (links ?? []).map((l) => l.schedule_id);
  let blocks: unknown[] = [];
  if (sids.length > 0) {
    const { data: scheds } = await db
      .from('schedules')
      .select('id, media_id, playlist_id, days_of_week, start_time, end_time')
      .in('id', sids)
      .is('archived_at', null)
      .order('start_time');
    const mIds = [...new Set((scheds ?? []).map((s) => s.media_id).filter(Boolean))];
    const pIds = [...new Set((scheds ?? []).map((s) => s.playlist_id).filter(Boolean))];
    const names = new Map<string, string>();
    if (mIds.length > 0) {
      const { data } = await db.from('media').select('id, name').in('id', mIds);
      (data ?? []).forEach((m) => names.set(`m:${m.id}`, m.name));
    }
    if (pIds.length > 0) {
      const { data } = await db.from('playlists').select('id, name').in('id', pIds);
      (data ?? []).forEach((p) => names.set(`p:${p.id}`, p.name));
    }
    blocks = (scheds ?? []).map((s) => ({
      content: s.media_id ? (names.get(`m:${s.media_id}`) ?? 'media') : (names.get(`p:${s.playlist_id}`) ?? 'playlist'),
      type: s.media_id ? 'media' : 'playlist',
      days: (s.days_of_week as number[]).map((d) => DAY_NAMES_NP[d]),
      start_time: s.start_time,
      end_time: s.end_time,
    }));
  }

  return {
    device: device.name,
    enrollment_status: device.enrollment_status,
    assigned_playlist: device.assigned_playlist_id ? (plName.get(device.assigned_playlist_id) ?? null) : null,
    now_playing_playlist: device.current_playlist_id ? (plName.get(device.current_playlist_id) ?? null) : null,
    now_playing_media: curMedia,
    last_seen_at: device.last_seen_at,
    schedules: blocks,
  };
}
