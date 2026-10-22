/**
 * tools/schedule.ts — Phase 4a get_schedule (read-only) + Phase 4b
 * schedule_content (write, conflict-first per contract C2).
 *
 * Convention: days_of_week uses 0=Sunday .. 6=Saturday; times are store-local HH:MM.
 */
import { z } from 'zod';
import { getDb, callerStoreIds, callerStores } from '../db.js';
import type { AuthContext } from '../auth.js';

// ---------- shared helpers ----------

const DAY_ALIASES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

export function parseDays(days: string[]): number[] {
  const out = new Set<number>();
  for (const raw of days) {
    const d = raw.trim().toLowerCase();
    if (d === 'weekdays') [1, 2, 3, 4, 5].forEach((n) => out.add(n));
    else if (d === 'weekends') [0, 6].forEach((n) => out.add(n));
    else if (d === 'all' || d === 'daily' || d === 'every day') [0, 1, 2, 3, 4, 5, 6].forEach((n) => out.add(n));
    else if (DAY_ALIASES[d] !== undefined) out.add(DAY_ALIASES[d]);
    else if (/^[0-6]$/.test(d)) out.add(Number(d));
    else throw new Error(`Unrecognized day "${raw}" (use e.g. "Friday", "weekdays", "weekends").`);
  }
  return [...out].sort();
}

export function parseTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
  if (!m) throw new Error(`Invalid time "${t}" (use HH:MM, 24h).`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time "${t}".`);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Resolve device names (fuzzy) to device rows within the caller's stores. */
async function resolveDevices(auth: AuthContext, names: string[]) {
  const storeIds = await callerStoreIds(auth.sub);
  const db = getDb();
  const { data, error } = await db
    .from('devices')
    .select('id, name, store_id, enrollment_status')
    .in('store_id', storeIds);
  if (error) throw new Error(`device lookup failed: ${error.message}`);

  return names.map((n) => {
    const q = n.toLowerCase();
    const matches = (data ?? []).filter((d) => d.name.toLowerCase().includes(q));
    if (matches.length === 0) throw new Error(`No device matches "${n}". Use list_devices to see device names.`);
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous device "${n}" — matches: ${matches.map((m) => m.name).join(', ')}. Be more specific.`,
      );
    }
    return matches[0];
  });
}

/** Resolve a media name (fuzzy) to one media row within the caller's stores. */
async function resolveMedia(auth: AuthContext, name: string) {
  const storeIds = await callerStoreIds(auth.sub);
  const db = getDb();
  const { data, error } = await db
    .from('media')
    .select('id, name, media_type, store_id')
    .in('store_id', storeIds)
    .is('archived_at', null)
    .ilike('name', `%${name}%`)
    .limit(6);
  if (error) throw new Error(`media lookup failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(`No media matches "${name}". Use search_media to find the exact name.`);
  }
  if (data.length > 1) {
    throw new Error(
      `Ambiguous media "${name}" — matches: ${data.map((m) => m.name).join(', ')}. Be more specific.`,
    );
  }
  return data[0];
}

/** Find non-archived schedules overlapping (device, days, time window). */
async function findConflicts(
  deviceIds: string[],
  days: number[],
  start: string,
  end: string,
) {
  const db = getDb();
  const { data: links, error: linkErr } = await db
    .from('schedule_devices')
    .select('schedule_id, device_id')
    .in('device_id', deviceIds);
  if (linkErr) throw new Error(`schedule lookup failed: ${linkErr.message}`);
  if (!links || links.length === 0) return [];

  const scheduleIds = [...new Set(links.map((l) => l.schedule_id))];
  const { data: scheds, error: schedErr } = await db
    .from('schedules')
    .select('id, store_id, media_id, playlist_id, days_of_week, start_time, end_time')
    .in('id', scheduleIds)
    .is('archived_at', null);
  if (schedErr) throw new Error(`schedule lookup failed: ${schedErr.message}`);

  const overlapping = (scheds ?? []).filter(
    (s) =>
      (s.days_of_week as number[]).some((d) => days.includes(d)) &&
      s.start_time < end &&
      s.end_time > start,
  );
  if (overlapping.length === 0) return [];

  // Names for the conflicting content
  const mediaIds = [...new Set(overlapping.map((s) => s.media_id).filter(Boolean))];
  const playlistIds = [...new Set(overlapping.map((s) => s.playlist_id).filter(Boolean))];
  const names = new Map<string, string>();
  if (mediaIds.length > 0) {
    const { data } = await db.from('media').select('id, name').in('id', mediaIds);
    (data ?? []).forEach((m) => names.set(`media:${m.id}`, m.name));
  }
  if (playlistIds.length > 0) {
    const { data } = await db.from('playlists').select('id, name').in('id', playlistIds);
    (data ?? []).forEach((p) => names.set(`playlist:${p.id}`, p.name));
  }
  const deviceNameById = new Map((await db.from('devices').select('id, name').in('id', deviceIds)).data?.map((d) => [d.id, d.name]) ?? []);

  return overlapping.map((s) => {
    const devIds = links.filter((l) => l.schedule_id === s.id).map((l) => l.device_id);
    return {
      schedule_id: s.id,
      content: s.media_id
        ? (names.get(`media:${s.media_id}`) ?? 'media')
        : (names.get(`playlist:${s.playlist_id}`) ?? 'playlist'),
      devices: devIds.map((id) => deviceNameById.get(id) ?? id),
      days: (s.days_of_week as number[]).map((d) => DAY_NAMES[d]),
      start_time: s.start_time,
      end_time: s.end_time,
    };
  });
}

// ---------- Phase 4a: get_schedule ----------

export const getScheduleSchema = {
  device: z.string().describe('Device name (fuzzy match).'),
  day: z
    .string()
    .optional()
    .describe('One day to inspect (e.g. "Friday"). Omit for the whole week.'),
};

export async function getSchedule(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof getScheduleSchema>>,
) {
  const [device] = await resolveDevices(auth, [args.device]);
  const days = args.day ? parseDays([args.day]) : [0, 1, 2, 3, 4, 5, 6];
  const db = getDb();

  const { data: links } = await db
    .from('schedule_devices')
    .select('schedule_id')
    .eq('device_id', device.id);
  const scheduleIds = (links ?? []).map((l) => l.schedule_id);
  if (scheduleIds.length === 0) return { device: device.name, blocks: [], note: 'No schedules target this device.' };

  const { data: scheds, error } = await db
    .from('schedules')
    .select('id, media_id, playlist_id, days_of_week, start_time, end_time')
    .in('id', scheduleIds)
    .is('archived_at', null)
    .order('start_time');
  if (error) throw new Error(`get_schedule failed: ${error.message}`);

  const mediaIds = [...new Set((scheds ?? []).map((s) => s.media_id).filter(Boolean))];
  const playlistIds = [...new Set((scheds ?? []).map((s) => s.playlist_id).filter(Boolean))];
  const names = new Map<string, string>();
  if (mediaIds.length > 0) {
    const { data } = await db.from('media').select('id, name').in('id', mediaIds);
    (data ?? []).forEach((m) => names.set(`media:${m.id}`, m.name));
  }
  if (playlistIds.length > 0) {
    const { data } = await db.from('playlists').select('id, name').in('id', playlistIds);
    (data ?? []).forEach((p) => names.set(`playlist:${p.id}`, p.name));
  }

  const blocks = (scheds ?? [])
    .filter((s) => (s.days_of_week as number[]).some((d) => days.includes(d)))
    .map((s) => ({
      content: s.media_id
        ? names.get(`media:${s.media_id}`) ?? 'media'
        : (names.get(`playlist:${s.playlist_id}`) ?? 'playlist'),
      type: s.media_id ? 'media' : 'playlist',
      days: (s.days_of_week as number[])
        .filter((d) => days.includes(d))
        .map((d) => DAY_NAMES[d]),
      start_time: s.start_time,
      end_time: s.end_time,
    }));

  return { device: device.name, blocks };
}

// ---------- Phase 4b: schedule_content (contract C2) ----------

export const scheduleContentSchema = {
  media_name: z.string().describe('Media item name (fuzzy match, must resolve to one item).'),
  devices: z
    .array(z.string())
    .min(1)
    .describe('Device names (fuzzy match). Use list_devices to see names.'),
  days: z
    .array(z.string())
    .min(1)
    .describe('Days, e.g. ["Friday"] or ["weekdays"]. 0=Sunday..6=Saturday internally.'),
  start_time: z.string().describe('Window start, HH:MM 24h, store-local time.'),
  end_time: z.string().describe('Window end, HH:MM 24h, store-local time.'),
  replace_existing: z
    .boolean()
    .default(false)
    .describe(
      'When true, conflicting schedules are archived and the new schedule is written. When false (default), conflicts are returned and nothing is written.',
    ),
};

export async function scheduleContent(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof scheduleContentSchema>>,
) {
  const start = parseTime(args.start_time);
  const end = parseTime(args.end_time);
  if (end <= start) throw new Error('end_time must be after start_time.');
  const days = parseDays(args.days);

  const media = await resolveMedia(auth, args.media_name);
  const devices = await resolveDevices(auth, args.devices);
  const deviceIds = devices.map((d) => d.id);

  const conflicts = await findConflicts(deviceIds, days, start, end);

  if (conflicts.length > 0 && !args.replace_existing) {
    return {
      written: false,
      conflicts,
      message:
        'Conflicting schedule(s) found. Reply "Replace it" to archive them and write the new schedule, or "keep both" to leave them playing alongside.',
    };
  }

  const db = getDb();
  if (conflicts.length > 0) {
    const { error } = await db
      .from('schedules')
      .update({ archived_at: new Date().toISOString() })
      .in(
        'id',
        conflicts.map((c) => c.schedule_id),
      );
    if (error) throw new Error(`archiving conflicts failed: ${error.message}`);
  }

  const stores = await callerStores(auth.sub);
  const storeInfo = stores.get(media.store_id);
  if (!storeInfo) throw new Error('Media store is not in your memberships.');

  const { data: sched, error: insErr } = await db
    .from('schedules')
    .insert({
      store_id: media.store_id,
      client_id: storeInfo.client_id,
      media_id: media.id,
      playlist_id: null,
      days_of_week: days,
      start_time: start,
      end_time: end,
      created_via: 'ai_assistant',
      created_by: auth.sub,
    })
    .select('id')
    .single();
  if (insErr) throw new Error(`schedule insert failed: ${insErr.message}`);

  const { error: linkErr } = await db.from('schedule_devices').insert(
    deviceIds.map((device_id) => ({ schedule_id: sched.id, device_id })),
  );
  if (linkErr) throw new Error(`schedule_devices insert failed: ${linkErr.message}`);

  return {
    written: true,
    archived_conflicts: conflicts.map((c) => c.schedule_id),
    schedule: {
      media: media.name,
      devices: devices.map((d) => d.name),
      days: days.map((d) => DAY_NAMES[d]),
      start_time: start,
      end_time: end,
    },
    message: `Scheduled "${media.name}" on ${devices.map((d) => d.name).join(', ')}.`,
  };
}
