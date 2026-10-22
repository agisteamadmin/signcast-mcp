/**
 * db.ts — Supabase client for the MCP server.
 *
 * Uses the SERVICE ROLE key: RLS is bypassed, so every query in the tools
 * MUST scope itself to the caller's stores (resolved from store_members via
 * the verified Auth0 sub). The key never leaves this server.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url) throw new Error('SUPABASE_URL is not set');
    if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

/** Store ids the caller belongs to (via store_members). Throws when none. */
export async function callerStoreIds(sub: string): Promise<string[]> {
  const db = getDb();
  const { data, error } = await db
    .from('store_members')
    .select('store_id')
    .eq('auth_subject', sub);
  if (error) throw new Error(`store_members lookup failed: ${error.message}`);
  const ids = (data ?? []).map((r) => r.store_id).filter(Boolean) as string[];
  if (ids.length === 0) {
    throw new Error('No store is linked to this login. Set up a store in the SignCast portal first.');
  }
  return [...new Set(ids)];
}

/** Store id -> { store name, client_id } for the caller's stores. */
export async function callerStores(
  sub: string,
): Promise<Map<string, { name: string; client_id: string }>> {
  const ids = await callerStoreIds(sub);
  const db = getDb();
  const { data, error } = await db
    .from('stores')
    .select('id, name, client_id')
    .in('id', ids);
  if (error) throw new Error(`stores lookup failed: ${error.message}`);
  const map = new Map<string, { name: string; client_id: string }>();
  for (const s of data ?? []) map.set(s.id, { name: s.name, client_id: s.client_id });
  return map;
}
