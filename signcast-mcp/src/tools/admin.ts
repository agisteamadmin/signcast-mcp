/**
 * admin.ts — Phase 4c platform-admin tools.
 *
 * Unlike the client tools (scoped to the caller's stores), these see ALL
 * clients/stores/devices — so they are gated on the `platform_admin` role
 * claim. A caller without the role gets a plain refusal, not an empty list.
 * They are the server-side API the Phase 5 Super Admin Portal will call.
 */
import { z } from 'zod';
import type { AuthContext } from '../auth.js';
import { getDb } from '../db.js';

function requireAdmin(auth: AuthContext): void {
  if (!auth.isPlatformAdmin) {
    throw new Error(
      'This tool requires the platform_admin role. Log in with the account that has that role, or assign it in Auth0 first.',
    );
  }
}

function ilike(col: string, value: string): string {
  return `${col}.ilike.%${value}%`;
}

// ---------------------------------------------------------------- list_clients
export const listClientsSchema = {};

export async function listClients(auth: AuthContext): Promise<unknown> {
  requireAdmin(auth);
  const db = getDb();

  const { data: clients, error } = await db
    .from('clients')
    .select('id, name, status, contact_email, contact_phone, country, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`list_clients failed: ${error.message}`);

  const { data: stores } = await db.from('stores').select('id, client_id');
  const { data: devices } = await db.from('devices').select('id, client_id, enrollment_status');
  const storeCount = new Map<string, number>();
  const deviceCount = new Map<string, number>();
  const enrolledCount = new Map<string, number>();
  for (const s of stores ?? []) storeCount.set(s.client_id, (storeCount.get(s.client_id) ?? 0) + 1);
  for (const d of devices ?? []) {
    deviceCount.set(d.client_id, (deviceCount.get(d.client_id) ?? 0) + 1);
    if (d.enrollment_status === 'enrolled') {
      enrolledCount.set(d.client_id, (enrolledCount.get(d.client_id) ?? 0) + 1);
    }
  }

  return {
    clients: (clients ?? []).map((c) => ({
      name: c.name,
      status: c.status,
      contact_email: c.contact_email,
      contact_phone: c.contact_phone,
      country: c.country,
      stores: storeCount.get(c.id) ?? 0,
      devices: deviceCount.get(c.id) ?? 0,
      devices_enrolled: enrolledCount.get(c.id) ?? 0,
    })),
  };
}

// --------------------------------------------------------- list_client_devices
export const listClientDevicesSchema = {
  client_name: z.string().describe('Client name (fuzzy match). Must match exactly one client.'),
};

async function resolveClient(name: string): Promise<{ id: string; name: string }> {
  const db = getDb();
  const { data, error } = await db
    .from('clients')
    .select('id, name')
    .or(ilike('name', name));
  if (error) throw new Error(`client lookup failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`No client found matching "${name}".`);
  if (data.length > 1) {
    throw new Error(
      `Multiple clients match "${name}": ${data.map((c) => c.name).join(', ')}. Be more specific.`,
    );
  }
  return data[0];
}

export async function listClientDevices(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof listClientDevicesSchema>>,
): Promise<unknown> {
  requireAdmin(auth);
  const db = getDb();
  const client = await resolveClient(args.client_name);

  const { data: devices, error } = await db
    .from('devices')
    .select(
      'id, name, enrollment_status, store_id, assigned_playlist_id, current_media_id, current_playlist_id, last_seen_at',
    )
    .eq('client_id', client.id)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`list_client_devices failed: ${error.message}`);

  const { data: stores } = await db.from('stores').select('id, name').eq('client_id', client.id);
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  const playlistIds = [...new Set((devices ?? []).map((d) => d.assigned_playlist_id).filter(Boolean))];
  const mediaIds = [...new Set((devices ?? []).map((d) => d.current_media_id).filter(Boolean))];
  const { data: playlists } = playlistIds.length
    ? await db.from('playlists').select('id, name').in('id', playlistIds)
    : { data: [] };
  const { data: media } = mediaIds.length
    ? await db.from('media').select('id, name').in('id', mediaIds)
    : { data: [] };
  const playlistName = new Map((playlists ?? []).map((p) => [p.id, p.name]));
  const mediaName = new Map((media ?? []).map((m) => [m.id, m.name]));

  return {
    client: client.name,
    devices: (devices ?? []).map((d) => ({
      name: d.name,
      status: d.enrollment_status,
      store: d.store_id ? (storeName.get(d.store_id) ?? '(unknown store)') : null,
      assigned_playlist: d.assigned_playlist_id
        ? (playlistName.get(d.assigned_playlist_id) ?? '(unknown playlist)')
        : null,
      now_playing: d.current_media_id ? (mediaName.get(d.current_media_id) ?? '(unknown media)') : null,
      last_seen_at: d.last_seen_at,
    })),
  };
}

// -------------------------------------------------------------- enroll_device
export const enrollDeviceSchema = {
  pairing_code: z.string().describe('The 6-digit pairing code shown on the TV.'),
  store_name: z.string().describe('Store to enroll the TV into (fuzzy match, must match exactly one store).'),
};

async function resolveStore(name: string): Promise<{ id: string; name: string; client_id: string }> {
  const db = getDb();
  const { data, error } = await db
    .from('stores')
    .select('id, name, client_id')
    .or(ilike('name', name));
  if (error) throw new Error(`store lookup failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`No store found matching "${name}".`);
  if (data.length > 1) {
    throw new Error(
      `Multiple stores match "${name}": ${data.map((s) => s.name).join(', ')}. Be more specific.`,
    );
  }
  return data[0];
}

export async function enrollDevice(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof enrollDeviceSchema>>,
): Promise<unknown> {
  requireAdmin(auth);
  const db = getDb();
  const store = await resolveStore(args.store_name);

  const { data: pending, error } = await db
    .from('devices')
    .select('id, name, pairing_code_expires_at')
    .eq('pairing_code', args.pairing_code)
    .eq('enrollment_status', 'pending_pairing')
    .limit(1)
    .single();
  if (error || !pending) {
    throw new Error(
      `No pending TV found with pairing code "${args.pairing_code}". Check the code on the TV screen (codes expire after 15 minutes).`,
    );
  }
  if (pending.pairing_code_expires_at && new Date(pending.pairing_code_expires_at) < new Date()) {
    throw new Error(`Pairing code "${args.pairing_code}" has expired. Re-mint a fresh code on the TV.`);
  }

  const { error: updErr } = await db
    .from('devices')
    .update({
      store_id: store.id,
      client_id: store.client_id,
      enrollment_status: 'enrolled',
      enrolled_at: new Date().toISOString(),
      enrolled_by: auth.sub,
      pairing_code: null,
      pairing_code_expires_at: null,
    })
    .eq('id', pending.id);
  if (updErr) throw new Error(`enroll_device failed: ${updErr.message}`);

  await db.from('admin_audit_log').insert({
    actor_auth_subject: auth.sub,
    actor_role: 'platform_admin',
    action: 'enroll_device',
    target_client_id: store.client_id,
    target_store_id: store.id,
    target_device_id: pending.id,
    details: { device_name: pending.name, store_name: store.name, via: 'mcp' },
  });

  return {
    enrolled: true,
    device: pending.name,
    store: store.name,
    message: `Enrolled "${pending.name}" into ${store.name}.`,
  };
}

// ------------------------------------------------------------ unenroll_device
export const unenrollDeviceSchema = {
  device_name: z.string().describe('Device name (fuzzy match, must match exactly one device).'),
};

export async function unenrollDevice(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof unenrollDeviceSchema>>,
): Promise<unknown> {
  requireAdmin(auth);
  const db = getDb();

  const { data, error } = await db
    .from('devices')
    .select('id, name, store_id, client_id, enrollment_status')
    .or(ilike('name', args.device_name));
  if (error) throw new Error(`device lookup failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`No device found matching "${args.device_name}".`);
  if (data.length > 1) {
    throw new Error(
      `Multiple devices match "${args.device_name}": ${data.map((d) => d.name).join(', ')}. Be more specific.`,
    );
  }
  const device = data[0];
  if (device.enrollment_status !== 'enrolled') {
    throw new Error(
      `"${device.name}" is not enrolled (status: ${device.enrollment_status}) — nothing to unenroll.`,
    );
  }

  // C1: clear every binding first, then the device itself.
  await db.from('playlist_devices').delete().eq('device_id', device.id);
  await db.from('schedule_devices').delete().eq('device_id', device.id);
  const { error: updErr } = await db
    .from('devices')
    .update({
      store_id: null,
      client_id: null,
      assigned_playlist_id: null,
      pairing_code: null,
      pairing_code_expires_at: null,
      device_token_hash: null,
      current_media_id: null,
      current_playlist_id: null,
      enrollment_status: 'unenrolled',
      unenrolled_at: new Date().toISOString(),
      unenrolled_by: auth.sub,
    })
    .eq('id', device.id);
  if (updErr) throw new Error(`unenroll_device failed: ${updErr.message}`);

  await db.from('admin_audit_log').insert({
    actor_auth_subject: auth.sub,
    actor_role: 'platform_admin',
    action: 'unenroll_device',
    target_client_id: device.client_id,
    target_store_id: device.store_id,
    target_device_id: device.id,
    details: { device_name: device.name, via: 'mcp' },
  });

  return {
    unenrolled: true,
    device: device.name,
    message: `"${device.name}" is unenrolled. Its playlist and schedule bindings were removed, and the TV will return to the pairing screen on its next poll.`,
  };
}
