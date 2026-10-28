/**
 * tools/generation.ts — Phase 7: AI image generation + approval publish.
 *
 * The owner's clarified approval flow:
 *   ask -> generate (store logo + named background image) -> preview
 *   -> client approves -> saved to Media Library (+ playlist) -> schedule
 *
 * generate_image NEVER writes to the Media Library or any playlist: it only
 * produces a preview in the private `generated-media` bucket and a row in
 * `ai_generations` (SHA-256 cache on prompt+brand inputs, per the schema).
 * Nothing plays until publish_generated_image runs on the client's approval.
 *
 * Two generation modes:
 *   (a) background_media_name given: the library image is the base, the store
 *       logo is composited on top, and `headline` is rendered as a banner
 *       caption (sharp + SVG). Deterministic, free, no AI provider call.
 *   (b) no background: Pollinations.ai (free, no key) text-to-image, then the
 *       logo is composited on top when available. NOTE: Pollinations'
 *       commercial-use terms are unclear (Sep 2026 audit) — resolve the
 *       provider question before this content is sold commercially.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { getDb, callerStores, callerStoreIds } from '../db.js';
import type { AuthContext } from '../auth.js';

const GENERATED_BUCKET = 'generated-media';
const MEDIA_BUCKET = 'media';
const TV_W = 1920;
const TV_H = 1080;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'image';
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function resolveStore(
  auth: AuthContext,
  storeName?: string,
): Promise<{ id: string; name: string; client_id: string; logo_url: string | null; brand: Record<string, unknown> }> {
  const db = getDb();
  const storeIds = await callerStoreIds(auth.sub);
  const { data, error } = await db
    .from('stores')
    .select('id, name, client_id, logo_url, brand')
    .in('id', storeIds);
  if (error) throw new Error(`store lookup failed: ${error.message}`);
  const list = data ?? [];
  if (storeName) {
    const q = storeName.toLowerCase();
    const m = list.filter((s) => s.name.toLowerCase().includes(q));
    if (m.length === 0) throw new Error(`No store matches "${storeName}".`);
    if (m.length > 1) throw new Error(`Ambiguous store — matches: ${m.map((s) => s.name).join(', ')}.`);
    return m[0];
  }
  if (list.length === 0) throw new Error('No stores found for this account.');
  if (list.length > 1) throw new Error('Multiple stores — name the store to generate for.');
  return list[0];
}

async function downloadFromBucket(bucket: string, path: string): Promise<Buffer> {
  const db = getDb();
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`Could not download ${bucket}/${path}: ${error?.message ?? 'empty'}`);
  return Buffer.from(await data.arrayBuffer());
}

async function fetchUrlBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function resolveLogoBuffer(logoUrl: string | null): Promise<Buffer | null> {
  if (!logoUrl) return null;
  try {
    if (/^https?:\/\//i.test(logoUrl)) return await fetchUrlBuffer(logoUrl);
    return await downloadFromBucket('store-branding', logoUrl);
  } catch {
    return null; // logo is best-effort: a missing logo must not kill the generation
  }
}

function headlineSvg(headline: string): Buffer {
  const text = escapeXml(headline.slice(0, 48));
  const svg = `<svg width="${TV_W}" height="${TV_H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="${TV_H - 200}" width="${TV_W}" height="200" fill="black" fill-opacity="0.55"/>` +
    `<text x="60" y="${TV_H - 70}" font-family="sans-serif" font-size="84" font-weight="bold" fill="white">${text}</text>` +
    `</svg>`;
  return Buffer.from(svg);
}

// ---------------------------------------------------------------- generate_image
export const generateImageSchema = {
  prompt: z.string().describe('What the image should show/say (e.g. "Men\'s haircut sale Mon-Fri 10AM-2PM $14.99").'),
  store_name: z.string().optional().describe('Store to generate for (fuzzy match). Required when the account has several stores.'),
  background_media_name: z.string().optional().describe('Library image to use as the background (fuzzy match). Omit for a fully AI-generated background.'),
  headline: z.string().optional().describe('Banner headline text rendered over the image. Defaults to the prompt text.'),
  use_logo: z.boolean().optional().describe('Overlay the store logo (default true).'),
  name: z.string().optional().describe('Name for the generated image (used on publish). Defaults to "AI: <prompt>".'),
};

export async function generateImage(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof generateImageSchema>>,
) {
  const db = getDb();
  const store = await resolveStore(auth, args.store_name);
  const useLogo = args.use_logo !== false;
  const headline = args.headline ?? args.prompt;

  const hashInput = [
    store.id,
    args.prompt,
    args.background_media_name ?? '',
    headline,
    useLogo ? 'logo' : 'nologo',
  ].join('|');
  const promptHash = sha256(hashInput);
  // Deterministic object path: identical inputs -> identical path, so the
  // SHA-256 cache actually works and publish finds the exact file.
  const objectPath = `${store.id}/gen-${promptHash}.jpg`;

  // SHA-256 cache: identical inputs return the existing preview.
  const { data: cached } = await db
    .from('ai_generations')
    .select('id, status')
    .eq('store_id', store.id)
    .eq('prompt_hash', promptHash)
    .limit(1)
    .single();
  if (cached && cached.status === 'completed') {
    const { data: signed, error: signErr } = await db.storage
      .from(GENERATED_BUCKET)
      .createSignedUrl(objectPath, 3600);
    if (!signErr && signed) {
      return {
        generation_id: cached.id,
        preview_url: signed.signedUrl,
        name: args.name ?? `AI: ${args.prompt.slice(0, 40)}`,
        provider: 'cache',
        cached: true,
        message:
          'Preview ready (same image as before — identical prompt and brand inputs). Show the preview and ask for approval — do NOT save, playlist, or schedule it until they approve.',
      };
    }
    // If the cached file is gone, fall through and regenerate it.
  }

  let base: Buffer;
  let provider: string;
  if (args.background_media_name) {
    const q = args.background_media_name.toLowerCase();
    const { data: media, error } = await db
      .from('media')
      .select('id, name, storage_bucket, storage_path')
      .eq('store_id', store.id)
      .is('archived_at', null);
    if (error) throw new Error(`background lookup failed: ${error.message}`);
    const m = (media ?? []).filter((x) => x.name.toLowerCase().includes(q));
    if (m.length === 0) throw new Error(`No library image matches "${args.background_media_name}".`);
    if (m.length > 1) throw new Error(`Ambiguous background — matches: ${m.map((x) => x.name).join(', ')}.`);
    if (!m[0].storage_path) throw new Error(`"${m[0].name}" has no stored image to use as a background.`);
    base = await downloadFromBucket(m[0].storage_bucket || MEDIA_BUCKET, m[0].storage_path);
    provider = 'composite';
  } else {
    const url =
      `https://image.pollinations.ai/prompt/${encodeURIComponent(args.prompt)}` +
      `?width=${TV_W}&height=${TV_H}&seed=${Math.floor(Math.random() * 1e9)}&model=flux&nologo=true`;
    try {
      base = await fetchUrlBuffer(url);
    } catch (err) {
      throw new Error(`AI image generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    provider = 'pollinations';
  }

  // Compose: base -> TV canvas, logo top-left, headline band bottom.
  let composed: Buffer;
  try {
    let pipeline = sharp(base).resize(TV_W, TV_H, { fit: 'cover' });
    const composites: { input: Buffer; top: number; left: number }[] = [];
    if (useLogo) {
      const logo = await resolveLogoBuffer(store.logo_url);
      if (logo) {
        const logoBuf = await sharp(logo).resize({ width: 360 }).png().toBuffer();
        composites.push({ input: logoBuf, top: 60, left: 60 });
      }
    }
    composites.push({ input: headlineSvg(headline), top: 0, left: 0 });
    if (composites.length) pipeline = pipeline.composite(composites);
    composed = await pipeline.jpeg({ quality: 88 }).toBuffer();
  } catch {
    // Compositing is enhancement; the base image alone is still a valid preview.
    composed = await sharp(base).resize(TV_W, TV_H, { fit: 'cover' }).jpeg({ quality: 88 }).toBuffer();
  }

  const { error: upErr } = await db.storage.from(GENERATED_BUCKET).upload(objectPath, composed, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (upErr) throw new Error(`generated-media upload failed: ${upErr.message}`);

  const { data: gen, error: genErr } = await db
    .from('ai_generations')
    .upsert(
      {
        store_id: store.id,
        provider,
        media_kind: 'image',
        prompt: args.prompt,
        prompt_hash: promptHash,
        status: 'completed',
        created_by: auth.sub,
      },
      { onConflict: 'store_id,provider,prompt_hash' },
    )
    .select('id')
    .single();
  if (genErr || !gen) throw new Error(`ai_generations write failed: ${genErr?.message ?? 'no row'}`);

  const { data: signed, error: signErr } = await db.storage
    .from(GENERATED_BUCKET)
    .createSignedUrl(objectPath, 3600);
  if (signErr || !signed) throw new Error(`preview URL failed: ${signErr?.message ?? 'no url'}`);

  return {
    generation_id: gen.id,
    preview_url: signed.signedUrl,
    name: args.name ?? `AI: ${args.prompt.slice(0, 40)}`,
    provider,
    message:
      'Preview ready. Show the preview to the user and ask for approval — do NOT save, playlist, or schedule it until they approve.',
  };
}

// ------------------------------------------------------------- edit_image
// Instruction-based edit of an existing library image (e.g. change a baked-in
// price from $11.99 to $10.99). Uses Pollinations' kontext model with the
// source image as reference. Like generate_image, this returns a PREVIEW only;
// publish_generated_image (after approval) is what saves it to the library.
// Caveat: the model regenerates the image, so fine details can shift slightly
// — the preview + approval step exists so the client verifies the new text
// before anything goes live.
export const editImageSchema = {
  source_media_name: z.string().describe('Library image to edit (fuzzy match, must be an image in your stores).'),
  edit_instruction: z.string().describe('The change, e.g. "change the price text from $11.99 to $10.99, keep everything else identical".'),
  store_name: z.string().optional().describe('Store the image belongs to (fuzzy match).'),
  name: z.string().optional().describe('Name for the edited image (used on publish).'),
};

export async function editImage(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof editImageSchema>>,
) {
  const db = getDb();
  const storeIds = await callerStoreIds(auth.sub);
  const { data: stores } = await db.from('stores').select('id, name, client_id').in('id', storeIds);
  const storeList = stores ?? [];
  let store: { id: string; name: string; client_id: string };
  if (args.store_name) {
    const q = args.store_name.toLowerCase();
    const m = storeList.filter((s) => s.name.toLowerCase().includes(q));
    if (m.length === 0) throw new Error(`No store matches "${args.store_name}".`);
    if (m.length > 1) throw new Error(`Ambiguous store — matches: ${m.map((s) => s.name).join(', ')}.`);
    store = m[0];
  } else {
    if (storeList.length === 0) throw new Error('No stores found for this account.');
    if (storeList.length > 1) throw new Error('Multiple stores — name the store the image belongs to.');
    store = storeList[0];
  }

  const q = args.source_media_name.toLowerCase();
  const { data: media, error } = await db
    .from('media')
    .select('id, name, media_type, storage_bucket, storage_path')
    .eq('store_id', store.id)
    .is('archived_at', null);
  if (error) throw new Error(`media lookup failed: ${error.message}`);
  const m = (media ?? []).filter((x) => x.name.toLowerCase().includes(q));
  if (m.length === 0) throw new Error(`No library image matches "${args.source_media_name}".`);
  if (m.length > 1) throw new Error(`Ambiguous image — matches: ${m.map((x) => x.name).join(', ')}.`);
  const source = m[0];
  if (source.media_type !== 'image') throw new Error(`"${source.name}" is not an image — only images can be edited.`);
  if (!source.storage_path) throw new Error(`"${source.name}" has no stored image to edit.`);

  // Pollinations needs a publicly fetchable reference URL; a signed URL works.
  const { data: signed, error: signErr } = await db.storage
    .from(source.storage_bucket || MEDIA_BUCKET)
    .createSignedUrl(source.storage_path, 3600);
  if (signErr || !signed) throw new Error(`reference URL failed: ${signErr?.message ?? 'no url'}`);

  const promptHash = sha256([store.id, source.id, args.edit_instruction].join('|'));
  const objectPath = `${store.id}/gen-${promptHash}.jpg`;

  const { data: cached } = await db
    .from('ai_generations')
    .select('id, status')
    .eq('store_id', store.id)
    .eq('prompt_hash', promptHash)
    .limit(1)
    .single();
  if (cached && cached.status === 'completed') {
    const { data: preview, error: prevErr } = await db.storage
      .from(GENERATED_BUCKET)
      .createSignedUrl(objectPath, 3600);
    if (!prevErr && preview) {
      return {
        generation_id: cached.id,
        preview_url: preview.signedUrl,
        name: args.name ?? `Edited: ${source.name}`,
        cached: true,
        message:
          'Preview ready (same edit as before). Show the preview and check the changed text reads correctly — do NOT publish until the user approves.',
      };
    }
  }

  const editPrompt = `${args.edit_instruction}. Keep everything else in the image exactly identical.`;
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(editPrompt)}` +
    `?image=${encodeURIComponent(signed.signedUrl)}&model=kontext&width=${TV_W}&height=${TV_H}&nologo=true`;
  let edited: Buffer;
  try {
    edited = await fetchUrlBuffer(url);
  } catch (err) {
    throw new Error(`Image edit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const composed = await sharp(edited).jpeg({ quality: 90 }).toBuffer();

  const { error: upErr } = await db.storage.from(GENERATED_BUCKET).upload(objectPath, composed, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (upErr) throw new Error(`generated-media upload failed: ${upErr.message}`);

  const { data: gen, error: genErr } = await db
    .from('ai_generations')
    .upsert(
      {
        store_id: store.id,
        provider: 'kontext',
        media_kind: 'image',
        prompt: editPrompt,
        prompt_hash: promptHash,
        status: 'completed',
        created_by: auth.sub,
      },
      { onConflict: 'store_id,provider,prompt_hash' },
    )
    .select('id')
    .single();
  if (genErr || !gen) throw new Error(`ai_generations write failed: ${genErr?.message ?? 'no row'}`);

  const { data: preview, error: prevErr2 } = await db.storage
    .from(GENERATED_BUCKET)
    .createSignedUrl(objectPath, 3600);
  if (prevErr2 || !preview) throw new Error(`preview URL failed: ${prevErr2?.message ?? 'no url'}`);

  return {
    generation_id: gen.id,
    preview_url: preview.signedUrl,
    name: args.name ?? `Edited: ${source.name}`,
    message:
      'Preview ready. Show the preview and verify the changed text reads correctly — do NOT save, playlist, or schedule it until the user approves.',
  };
}

// ------------------------------------------------------- publish_generated_image
export const publishGeneratedImageSchema = {
  generation_id: z.string().describe('The generation_id returned by generate_image.'),
  media_name: z.string().optional().describe('Name for the saved library item. Defaults to the generated name.'),
  playlist_name: z.string().optional().describe('Playlist to add the image to after saving (fuzzy match, same store).'),
};

export async function publishGeneratedImage(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof publishGeneratedImageSchema>>,
) {
  const db = getDb();
  const storeIds = [...(await callerStores(auth.sub)).keys()];

  const { data: gen, error } = await db
    .from('ai_generations')
    .select('id, store_id, prompt, prompt_hash, status, media_id')
    .eq('id', args.generation_id)
    .single();
  if (error || !gen) throw new Error(`No generation found with id "${args.generation_id}".`);
  if (!storeIds.includes(gen.store_id)) throw new Error('That generation belongs to a different store.');
  if (gen.status !== 'completed') throw new Error(`Generation is ${gen.status}, not completed.`);
  if (gen.media_id) throw new Error('This generation was already published to the media library.');

  // Deterministic path from the generation's own hash — the exact preview file.
  const objectPath = `${gen.store_id}/gen-${gen.prompt_hash}.jpg`;
  const buffer = await downloadFromBucket(GENERATED_BUCKET, objectPath);

  const mediaName = args.media_name ?? `AI: ${gen.prompt.slice(0, 40)}`;
  const mediaPath = `${gen.store_id}/${Date.now()}-${sanitizeName(mediaName)}.jpg`;
  const { error: upErr } = await db.storage.from(MEDIA_BUCKET).upload(mediaPath, buffer, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (upErr) throw new Error(`media upload failed: ${upErr.message}`);

  const { data: store } = await db.from('stores').select('client_id').eq('id', gen.store_id).single();
  const { data: media, error: medErr } = await db
    .from('media')
    .insert({
      store_id: gen.store_id,
      client_id: store?.client_id ?? null,
      name: mediaName,
      media_type: 'image',
      source: 'ai_generated',
      storage_bucket: MEDIA_BUCKET,
      storage_path: mediaPath,
      duration_seconds: 10,
      created_by: auth.sub,
    })
    .select('id, name')
    .single();
  if (medErr || !media) throw new Error(`media insert failed: ${medErr?.message ?? 'no row'}`);

  await db.from('ai_generations').update({ media_id: media.id }).eq('id', gen.id);

  let playlist: string | null = null;
  if (args.playlist_name) {
    const q = args.playlist_name.toLowerCase();
    const { data: pls } = await db
      .from('playlists')
      .select('id, name')
      .eq('store_id', gen.store_id)
      .is('archived_at', null);
    const m = (pls ?? []).filter((p) => p.name.toLowerCase().includes(q));
    if (m.length === 0) throw new Error(`No playlist matches "${args.playlist_name}" in this store.`);
    if (m.length > 1) throw new Error(`Ambiguous playlist — matches: ${m.map((p) => p.name).join(', ')}.`);
    const { data: items } = await db
      .from('playlist_items')
      .select('position')
      .eq('playlist_id', m[0].id)
      .order('position', { ascending: false })
      .limit(1);
    const nextPos = (items && items.length ? items[0].position : 0) + 1;
    const { error: itemErr } = await db
      .from('playlist_items')
      .insert({ playlist_id: m[0].id, media_id: media.id, position: nextPos });
    if (itemErr) throw new Error(`playlist add failed: ${itemErr.message}`);
    playlist = m[0].name;
  }

  return {
    published: true,
    media_name: media.name,
    playlist,
    message: playlist
      ? `"${media.name}" is saved in the media library and added to the "${playlist}" playlist.`
      : `"${media.name}" is saved in the media library.`,
  };
}
