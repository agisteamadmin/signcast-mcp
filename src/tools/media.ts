/**
 * tools/media.ts — Phase 4a: search_media (read-only).
 */
import { z } from 'zod';
import { getDb, callerStoreIds, callerStores } from '../db.js';
import type { AuthContext } from '../auth.js';

export const searchMediaSchema = {
  query: z.string().describe('Name text to search for (matches media name).'),
  type: z
    .enum(['image', 'video', 'text_slide'])
    .optional()
    .describe('Filter by media type. Omit for all types.'),
  limit: z.number().int().min(1).max(50).default(10).describe('Max results (1-50).'),
};

export async function searchMedia(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof searchMediaSchema>>,
) {
  const storeIds = await callerStoreIds(auth.sub);
  const stores = await callerStores(auth.sub);
  const db = getDb();

  let q = db
    .from('media')
    .select('id, name, media_type, category, duration_seconds, store_id, created_at')
    .in('store_id', storeIds)
    .is('archived_at', null)
    .ilike('name', `%${args.query}%`)
    .order('created_at', { ascending: false })
    .limit(args.limit);
  if (args.type) q = q.eq('media_type', args.type);

  const { data, error } = await q;
  if (error) throw new Error(`search_media failed: ${error.message}`);

  return {
    media: (data ?? []).map((m) => ({
      name: m.name,
      type: m.media_type,
      category: m.category,
      duration_seconds: m.duration_seconds,
      store: stores.get(m.store_id)?.name ?? '(unknown store)',
    })),
  };
}
