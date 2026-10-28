/**
 * tools/dynamic_menu.ts — "Dynamic" menus/posters.
 *
 * Flow the owner specified:
 *   upload poster -> extract_menu (vision reads categories/items/prices +
 *   the poster's style, stored for future re-renders) -> owner reviews and
 *   corrects -> update_menu (price, sold-out, add/remove items, colors)
 *   -> render_menu (template poster from the data, playlist replaced, so
 *   the front-desk TV shows the update automatically when the playlist is
 *   assigned to it) -> download / player via the normal media flows.
 *
 * The rendered poster is a clean template design built from the data, NOT a
 * pixel replica of the uploaded poster. That is what makes a price change
 * instant: change one number, re-render, done.
 *
 * TV-update story: render_menu REPLACES the menu playlist's contents with
 * the latest render. A TV playing that playlist picks up the new version on
 * its next poll — no re-assign needed after the first assignment.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import sharp from 'sharp';
import { getDb, callerStoreIds } from '../db.js';
import type { AuthContext } from '../auth.js';
import { assignPlaylist } from './playlists.js';

const MEDIA_BUCKET = 'media';
const TV_W = 1920;
const TV_H = 1080;

// ------------------------------------------------------------------ types
export interface MenuItem {
  name: string;
  price: string | null;
  note?: string;
  sold_out?: boolean;
}
export interface MenuCategory {
  name: string;
  price_note?: string | null;
  items: MenuItem[];
}
export interface MenuData {
  title: string;
  price_note?: string | null;
  categories: MenuCategory[];
  contact?: { phone?: string; address?: string };
}
export interface MenuStyle {
  background_color?: string;
  accent_color?: string;
  header_color?: string;
  text_color?: string;
  layout_notes?: string;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'menu';
}

async function resolveStoreRow(auth: AuthContext, storeName?: string) {
  const db = getDb();
  const storeIds = await callerStoreIds(auth.sub);
  const { data, error } = await db
    .from('stores')
    .select('id, name, client_id, logo_url')
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
  if (list.length > 1) throw new Error('Multiple stores — name the store.');
  return list[0];
}

async function resolveMenu(
  auth: AuthContext,
  menuName: string,
  storeName?: string,
) {
  const db = getDb();
  const store = await resolveStoreRow(auth, storeName);
  const q = menuName.toLowerCase();
  const { data, error } = await db
    .from('dynamic_menus')
    .select('id, store_id, client_id, name, source_media_id, menu_data, style, background_media_id, status')
    .eq('store_id', store.id);
  if (error) throw new Error(`menu lookup failed: ${error.message}`);
  const m = (data ?? []).filter((x) => x.name.toLowerCase().includes(q));
  if (m.length === 0) throw new Error(`No dynamic menu matches "${menuName}" in ${store.name}.`);
  if (m.length > 1) throw new Error(`Ambiguous menu — matches: ${m.map((x) => x.name).join(', ')}.`);
  return { row: m[0], store };
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

function mediaTypeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  throw new Error(`Unsupported image type ".${ext}" — use a JPG, PNG, WebP, or GIF poster.`);
}

// -------------------------------------------------------------- extract_menu
export const extractMenuSchema = {
  media_name: z.string().describe('Uploaded poster image in the media library (fuzzy match, must be an image).'),
  menu_name: z.string().optional().describe('Name for the dynamic menu. Defaults to the poster name.'),
  store_name: z.string().optional().describe('Store the poster belongs to (fuzzy match).'),
};

const EXTRACT_SYSTEM =
  'You extract structured menu data from restaurant or salon poster images. ' +
  'Return ONLY a JSON object, no other text, no markdown fences. ' +
  'Schema: {"title": string, "price_note": string|null, ' +
  '"categories": [{"name": string, "price_note": string|null, ' +
  '"items": [{"name": string, "price": string|null, "note": string|null}]}], ' +
  '"contact": {"phone": string|null, "address": string|null}, ' +
  '"style": {"background_color": hex|null, "accent_color": hex|null, ' +
  '"header_color": hex|null, "text_color": hex|null, "layout_notes": string|null}}. ' +
  'Rules: copy item names and prices EXACTLY as shown. If prices are per-person ' +
  'tiers (e.g. "Adults: $14.99 | Kids: $9.99") rather than per item, put them in ' +
  'price_note at the menu or category level and leave item prices null. ' +
  'A "35+ items" style badge is not an item — ignore badges. ' +
  'style colors: sample the poster\'s dominant background, accent/header, and ' +
  'body-text colors as hex values. If a price or phone number is partly ' +
  'unreadable, use null for it rather than guessing.';

export async function extractMenu(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof extractMenuSchema>>,
) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
  const db = getDb();
  const store = await resolveStoreRow(auth, args.store_name);

  const q = args.media_name.toLowerCase();
  const { data: media, error } = await db
    .from('media')
    .select('id, name, media_type, storage_bucket, storage_path')
    .eq('store_id', store.id)
    .is('archived_at', null);
  if (error) throw new Error(`media lookup failed: ${error.message}`);
  const m = (media ?? []).filter((x) => x.name.toLowerCase().includes(q));
  if (m.length === 0) throw new Error(`No library image matches "${args.media_name}".`);
  if (m.length > 1) throw new Error(`Ambiguous image — matches: ${m.map((x) => x.name).join(', ')}.`);
  const source = m[0];
  if (source.media_type !== 'image') throw new Error(`"${source.name}" is not an image.`);
  if (!source.storage_path) throw new Error(`"${source.name}" has no stored image to read.`);

  let buffer = await downloadFromBucket(source.storage_bucket || MEDIA_BUCKET, source.storage_path);
  if (buffer.length > 4.5 * 1024 * 1024) {
    buffer = await sharp(buffer).resize(2000, 2000, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
  }
  const mediaType = mediaTypeForPath(source.storage_path);

  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: 4096,
    system: EXTRACT_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType as 'image/jpeg', data: buffer.toString('base64') },
          },
          {
            type: 'text',
            text: 'Extract the full menu from this poster: every category, every item, every price, plus phone/address and the poster\'s style colors.',
          },
        ],
      },
    ],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) throw new Error('The AI did not return menu JSON — try again with a clearer poster photo.');
  let parsed: { title?: unknown; categories?: unknown; price_note?: unknown; contact?: unknown; style?: unknown };
  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as typeof parsed;
  } catch {
    throw new Error('The AI returned malformed menu JSON — try again.');
  }
  if (!Array.isArray(parsed.categories)) throw new Error('The AI returned no categories — try a clearer poster photo.');

  const menuData: MenuData = {
    title: typeof parsed.title === 'string' && parsed.title ? parsed.title : source.name,
    price_note: typeof parsed.price_note === 'string' ? parsed.price_note : null,
    categories: (parsed.categories as MenuCategory[]).map((c) => ({
      name: String(c.name ?? 'Menu'),
      price_note: typeof c.price_note === 'string' ? c.price_note : null,
      items: (Array.isArray(c.items) ? c.items : []).map((it) => ({
        name: String(it.name ?? ''),
        price: typeof it.price === 'string' ? it.price : null,
        note: typeof it.note === 'string' ? it.note : undefined,
        sold_out: false,
      })),
    })),
    contact: (parsed.contact as MenuData['contact']) ?? undefined,
  };
  const style = (parsed.style as MenuStyle) ?? {};

  const menuName = args.menu_name ?? source.name;
  const { data: existing } = await db
    .from('dynamic_menus')
    .select('id')
    .eq('store_id', store.id)
    .eq('name', menuName)
    .limit(1);
  if (existing && existing.length > 0) {
    throw new Error(`A dynamic menu named "${menuName}" already exists in ${store.name} — pick a different name or update it.`);
  }

  const { data: row, error: insErr } = await db
    .from('dynamic_menus')
    .insert({
      store_id: store.id,
      client_id: store.client_id,
      name: menuName,
      source_media_id: source.id,
      menu_data: menuData,
      style,
      status: 'draft',
      created_by: auth.sub,
    })
    .select('id, name')
    .single();
  if (insErr || !row) throw new Error(`dynamic menu save failed: ${insErr?.message ?? 'no row'}`);

  return {
    menu_id: row.id,
    menu_name: row.name,
    menu_data: menuData,
    style,
    message:
      'Menu extracted as a DRAFT. Show the owner the categories, items, and prices and ask them to review and correct anything misread BEFORE rendering — a wrong price on a TV menu is costly. Corrections go through update_menu; rendering through render_menu.',
  };
}

// --------------------------------------------------------------- update_menu
export const updateMenuSchema = {
  menu_name: z.string().describe('Dynamic menu name (fuzzy match, must resolve to one menu).'),
  store_name: z.string().optional().describe('Store the menu belongs to (fuzzy match).'),
  item_name: z.string().optional().describe('Item to change (fuzzy match within the menu, must resolve to one item).'),
  new_price: z.string().optional().describe('New price text for the item (e.g. "$10.99").'),
  sold_out: z.boolean().optional().describe('Mark the item sold out (true) or available again (false).'),
  remove_item: z.boolean().optional().describe('Remove the item (requires item_name).'),
  add_item: z
    .object({ category: z.string(), name: z.string(), price: z.string().optional() })
    .optional()
    .describe('Add a new item to a category (created if missing).'),
  new_title: z.string().optional().describe('New menu title.'),
  background_color: z.string().optional().describe('New background color hex for future renders (e.g. "#1e3a8a").'),
  seasonal_media_name: z.string().optional().describe('Library image to use as the poster background (fuzzy match).'),
};

function findItem(menu: MenuData, query: string): { category: MenuCategory; item: MenuItem }[] {
  const q = query.toLowerCase();
  const out: { category: MenuCategory; item: MenuItem }[] = [];
  for (const cat of menu.categories) {
    for (const item of cat.items) {
      if (item.name.toLowerCase().includes(q)) out.push({ category: cat, item });
    }
  }
  return out;
}

export async function updateMenu(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof updateMenuSchema>>,
) {
  const db = getDb();
  const { row, store } = await resolveMenu(auth, args.menu_name, args.store_name);
  const menu = row.menu_data as unknown as MenuData;
  const style = row.style as unknown as MenuStyle;
  const applied: string[] = [];

  if (args.new_title) {
    menu.title = args.new_title;
    applied.push(`title -> "${args.new_title}"`);
  }
  if (args.background_color) {
    style.background_color = args.background_color;
    applied.push(`background color -> ${args.background_color}`);
  }
  if (args.seasonal_media_name) {
    const q = args.seasonal_media_name.toLowerCase();
    const { data: media } = await db
      .from('media')
      .select('id, name, media_type')
      .eq('store_id', store.id)
      .is('archived_at', null);
    const m = (media ?? []).filter((x) => x.name.toLowerCase().includes(q) && x.media_type === 'image');
    if (m.length === 0) throw new Error(`No library image matches "${args.seasonal_media_name}".`);
    if (m.length > 1) throw new Error(`Ambiguous background — matches: ${m.map((x) => x.name).join(', ')}.`);
    await db.from('dynamic_menus').update({ background_media_id: m[0].id }).eq('id', row.id);
    applied.push(`seasonal background -> "${m[0].name}"`);
  }
  if (args.item_name) {
    const matches = findItem(menu, args.item_name);
    if (matches.length === 0) throw new Error(`No item matches "${args.item_name}" in this menu.`);
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous item — matches: ${matches.map((x) => `${x.item.name} (${x.category.name})`).join(', ')}.`,
      );
    }
    const { category, item } = matches[0];
    if (args.remove_item) {
      category.items = category.items.filter((i) => i !== item);
      applied.push(`removed "${item.name}" from ${category.name}`);
    } else {
      if (args.new_price !== undefined) {
        item.price = args.new_price;
        applied.push(`"${item.name}" price -> ${args.new_price}`);
      }
      if (args.sold_out !== undefined) {
        item.sold_out = args.sold_out;
        applied.push(`"${item.name}" ${args.sold_out ? 'marked SOLD OUT' : 'back in stock'}`);
      }
    }
  }
  if (args.add_item) {
    const catName = args.add_item.category;
    let cat = menu.categories.find((c) => c.name.toLowerCase() === catName.toLowerCase());
    if (!cat) {
      cat = { name: catName, items: [] };
      menu.categories.push(cat);
      applied.push(`new category "${catName}"`);
    }
    cat.items.push({ name: args.add_item.name, price: args.add_item.price ?? null, sold_out: false });
    applied.push(`added "${args.add_item.name}" to ${cat.name}`);
  }
  if (applied.length === 0) throw new Error('No changes given — pass item_name with new_price/sold_out, add_item, new_title, or background_color.');

  const { error } = await db
    .from('dynamic_menus')
    .update({ menu_data: menu, style })
    .eq('id', row.id);
  if (error) throw new Error(`menu update failed: ${error.message}`);

  return {
    menu_name: row.name,
    changes: applied,
    categories: menu.categories.length,
    items: menu.categories.reduce((n, c) => n + c.items.length, 0),
    message: `Menu updated: ${applied.join('; ')}. Re-render with render_menu to push it to the TV.`,
  };
}

// --------------------------------------------------------------- render_menu
type Block =
  | { kind: 'header'; text: string; priceNote: string | null }
  | { kind: 'item'; lines: string[]; price: string | null; soldOut: boolean };

function wrapLines(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
    if (lines.length === 1 && cur.length > maxChars) break;
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) {
    lines.length = 2;
    lines[1] = `${lines[1].replace(/…?$/, '')}…`;
  }
  return lines.length ? lines : [''];
}

function layoutPages(menu: MenuData): Block[][][] {
  const COLS = 3;
  const COL_H = 800;
  const HEADER_H = 56;
  const ITEM_H = (lines: number) => lines * 32 + 10;
  const pages: Block[][][] = [];
  let page: Block[][] = [[], [], []];
  let col = 0;
  let colH = 0;
  const nextCol = () => {
    col += 1;
    colH = 0;
    if (col >= COLS) {
      pages.push(page);
      page = [[], [], []];
      col = 0;
    }
  };
  for (const cat of menu.categories) {
    const header: Block = { kind: 'header', text: cat.name, priceNote: cat.price_note ?? null };
    if (colH + HEADER_H > COL_H && colH > 0) nextCol();
    page[col].push(header);
    colH += HEADER_H;
    for (const item of cat.items) {
      const lines = wrapLines(item.name, 26);
      const h = ITEM_H(lines.length);
      if (colH + h > COL_H && colH > 0) {
        nextCol();
        page[col].push({ kind: 'header', text: cat.name, priceNote: null });
        colH += HEADER_H;
      }
      page[col].push({ kind: 'item', lines, price: item.price, soldOut: item.sold_out ?? false });
      colH += h;
    }
  }
  pages.push(page);
  return pages;
}

function renderPageSvg(
  menu: MenuData,
  storeName: string,
  page: Block[][],
  pageIndex: number,
  pageCount: number,
  style: MenuStyle,
): string {
  const bg = style.background_color ?? '#7f1d1d';
  const accent = style.accent_color ?? '#f59e0b';
  const headerColor = style.header_color ?? '#ffffff';
  const textColor = style.text_color ?? '#ffffff';
  const COL_X = [60, 693, 1326];
  const COL_W = 573;
  let body = '';
  page.forEach((blocks, ci) => {
    let y = 185;
    const x = COL_X[ci];
    for (const b of blocks) {
      if (b.kind === 'header') {
        body += `<rect x="${x}" y="${y}" width="${COL_W}" height="6" fill="${accent}"/>`;
        body += `<text x="${x}" y="${y + 40}" font-family="sans-serif" font-size="36" font-weight="bold" fill="${accent}">${escapeXml(b.text.toUpperCase())}</text>`;
        y += 56;
        if (b.priceNote) {
          body += `<text x="${x}" y="${y}" font-family="sans-serif" font-size="22" font-style="italic" fill="${headerColor}">${escapeXml(b.priceNote)}</text>`;
          y += 30;
        }
      } else {
        const priceX = x + COL_W;
        b.lines.forEach((line, li) => {
          const decor = b.soldOut ? ' text-decoration="line-through"' : '';
          body += `<text x="${x}" y="${y + li * 32}" font-family="sans-serif" font-size="28" fill="${textColor}"${decor}>${escapeXml(line)}</text>`;
        });
        if (b.price) {
          body += `<text x="${priceX}" y="${y}" font-family="sans-serif" font-size="28" font-weight="bold" fill="${headerColor}" text-anchor="end">${escapeXml(b.price)}</text>`;
        }
        if (b.soldOut) {
          body += `<rect x="${priceX - 92}" y="${y + 8}" width="92" height="26" rx="13" fill="#dc2626"/>`;
          body += `<text x="${priceX - 46}" y="${y + 27}" font-family="sans-serif" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="middle">SOLD</text>`;
        }
        y += b.lines.length * 32 + 10;
      }
    }
  });
  const title = escapeXml(menu.title);
  const store = escapeXml(storeName);
  const priceNote = menu.price_note ? `<text x="960" y="160" font-family="sans-serif" font-size="30" font-weight="bold" fill="${accent}" text-anchor="middle">${escapeXml(menu.price_note)}</text>` : '';
  const contact = menu.contact;
  const footer = contact && (contact.phone || contact.address)
    ? `<text x="960" y="1035" font-family="sans-serif" font-size="28" fill="${headerColor}" text-anchor="middle">${escapeXml([contact.phone, contact.address].filter(Boolean).join('  •  '))}</text>`
    : '';
  const pageLabel = pageCount > 1 ? `<text x="1860" y="1040" font-family="sans-serif" font-size="22" fill="${headerColor}" text-anchor="end">${pageIndex + 1}/${pageCount}</text>` : '';
  return `<svg width="${TV_W}" height="${TV_H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${TV_W}" height="${TV_H}" fill="${bg}"/>` +
    `<text x="960" y="58" font-family="sans-serif" font-size="36" letter-spacing="4" fill="${accent}" text-anchor="middle">${store.toUpperCase()}</text>` +
    `<text x="960" y="128" font-family="sans-serif" font-size="76" font-weight="bold" fill="${headerColor}" text-anchor="middle">${title}</text>` +
    priceNote +
    `<rect x="60" y="1010" width="1800" height="4" fill="${accent}"/>` +
    body + footer + pageLabel +
    `</svg>`;
}

export const renderMenuSchema = {
  menu_name: z.string().describe('Dynamic menu name (fuzzy match, must resolve to one menu).'),
  store_name: z.string().optional().describe('Store the menu belongs to (fuzzy match).'),
  playlist_name: z.string().optional().describe('Playlist to fill with the rendered pages (replaces its contents). Defaults to "Menu: <menu name>".'),
  device_name: z.string().optional().describe('Device to assign the menu playlist to (front-desk TV).'),
  seasonal_media_name: z.string().optional().describe('Library image to use as the poster background for this render (transient override).'),
  background_color: z.string().optional().describe('Background color hex for this render (transient override).'),
};

export async function renderMenu(
  auth: AuthContext,
  args: z.infer<z.ZodObject<typeof renderMenuSchema>>,
) {
  const db = getDb();
  const { row, store } = await resolveMenu(auth, args.menu_name, args.store_name);
  const menu = row.menu_data as unknown as MenuData;
  const style: MenuStyle = { ...(row.style as unknown as MenuStyle) };
  if (args.background_color) style.background_color = args.background_color;

  let bgBuffer: Buffer | null = null;
  const bgMediaId = row.background_media_id as string | null;
  let bgMediaName = args.seasonal_media_name;
  if (bgMediaName || bgMediaId) {
    let mediaRow: { storage_bucket: string | null; storage_path: string | null } | null = null;
    if (bgMediaName) {
      const q = bgMediaName.toLowerCase();
      const { data: media } = await db
        .from('media')
        .select('id, name, media_type, storage_bucket, storage_path')
        .eq('store_id', store.id)
        .is('archived_at', null);
      const m = (media ?? []).filter((x) => x.name.toLowerCase().includes(q) && x.media_type === 'image');
      if (m.length === 0) throw new Error(`No library image matches "${bgMediaName}".`);
      if (m.length > 1) throw new Error(`Ambiguous background — matches: ${m.map((x) => x.name).join(', ')}.`);
      mediaRow = m[0];
    } else if (bgMediaId) {
      const { data } = await db
        .from('media')
        .select('storage_bucket, storage_path')
        .eq('id', bgMediaId)
        .single();
      mediaRow = data;
    }
    if (mediaRow?.storage_path) {
      try {
        bgBuffer = await downloadFromBucket(mediaRow.storage_bucket || MEDIA_BUCKET, mediaRow.storage_path);
      } catch {
        bgBuffer = null; // background is best-effort; solid color still renders
      }
    }
  }

  let logoBuffer: Buffer | null = null;
  if (store.logo_url) {
    try {
      logoBuffer = /^https?:\/\//i.test(store.logo_url)
        ? await fetchUrlBuffer(store.logo_url)
        : await downloadFromBucket('store-branding', store.logo_url);
    } catch {
      logoBuffer = null;
    }
  }

  const pages = layoutPages(menu);
  const pageNames: string[] = [];
  const ts = Date.now();
  for (let i = 0; i < pages.length; i++) {
    const textSvg = renderPageSvg(menu, store.name, pages[i], i, pages.length, style);
    let pipeline: sharp.Sharp;
    if (bgBuffer) {
      const base = await sharp(bgBuffer).resize(TV_W, TV_H, { fit: 'cover' }).toBuffer();
      const scrim = `<svg width="${TV_W}" height="${TV_H}" xmlns="http://www.w3.org/2000/svg"><rect width="${TV_W}" height="${TV_H}" fill="black" fill-opacity="0.45"/></svg>`;
      pipeline = sharp(base).composite([{ input: Buffer.from(scrim), top: 0, left: 0 }]);
    } else {
      pipeline = sharp({
        create: { width: TV_W, height: TV_H, channels: 3, background: style.background_color ?? '#7f1d1d' },
      });
    }
    const composites: { input: Buffer; top: number; left: number }[] = [{ input: Buffer.from(textSvg), top: 0, left: 0 }];
    if (logoBuffer) {
      try {
        const logo = await sharp(logoBuffer).resize({ width: 220 }).png().toBuffer();
        composites.push({ input: logo, top: 24, left: 60 });
      } catch {
        // logo is best-effort
      }
    }
    const out = await pipeline.composite(composites).jpeg({ quality: 88 }).toBuffer();
    const pageName = pages.length > 1 ? `Menu: ${row.name} (p${i + 1})` : `Menu: ${row.name}`;
    const mediaPath = `${store.id}/${ts}-${sanitizeName(pageName)}.jpg`;
    const { error: upErr } = await db.storage.from(MEDIA_BUCKET).upload(mediaPath, out, {
      contentType: 'image/jpeg',
      upsert: true,
    });
    if (upErr) throw new Error(`menu page upload failed: ${upErr.message}`);
    const { data: media, error: medErr } = await db
      .from('media')
      .insert({
        store_id: store.id,
        client_id: store.client_id,
        name: pageName,
        media_type: 'image',
        source: 'ai_generated',
        storage_bucket: MEDIA_BUCKET,
        storage_path: mediaPath,
        duration_seconds: 15,
        created_by: auth.sub,
      })
      .select('id, name')
      .single();
    if (medErr || !media) throw new Error(`menu media insert failed: ${medErr?.message ?? 'no row'}`);
    pageNames.push(media.name);
  }

  // The menu playlist ALWAYS shows the latest render: replace its contents.
  const playlistName = args.playlist_name ?? `Menu: ${row.name}`;
  const { data: pls } = await db
    .from('playlists')
    .select('id, name')
    .eq('store_id', store.id)
    .eq('name', playlistName)
    .is('archived_at', null)
    .limit(1);
  let playlistId: string;
  if (pls && pls.length > 0) {
    playlistId = pls[0].id;
    await db.from('playlist_items').delete().eq('playlist_id', playlistId);
  } else {
    const { data: created, error: plErr } = await db
      .from('playlists')
      .insert({ store_id: store.id, client_id: store.client_id, name: playlistName })
      .select('id')
      .single();
    if (plErr || !created) throw new Error(`playlist create failed: ${plErr?.message ?? 'no row'}`);
    playlistId = created.id;
  }
  const { data: pageRows } = await db
    .from('media')
    .select('id, name')
    .eq('store_id', store.id)
    .in('name', pageNames);
  const byName = new Map((pageRows ?? []).map((r) => [r.name, r.id]));
  for (let i = 0; i < pageNames.length; i++) {
    const mid = byName.get(pageNames[i]);
    if (!mid) continue;
    await db.from('playlist_items').insert({ playlist_id: playlistId, media_id: mid, position: i + 1 });
  }

  await db.from('dynamic_menus').update({ status: 'active' }).eq('id', row.id);

  let device: string | null = null;
  if (args.device_name) {
    const assigned = await assignPlaylist(auth, { device_name: args.device_name, playlist_name: playlistName });
    device = (assigned as { device: string }).device;
  }

  return {
    menu_name: row.name,
    pages: pageNames,
    playlist: playlistName,
    device,
    message: device
      ? `Menu "${row.name}" rendered (${pageNames.length} page${pageNames.length > 1 ? 's' : ''}) into playlist "${playlistName}" and assigned to ${device} — the TV shows the new version.`
      : `Menu "${row.name}" rendered (${pageNames.length} page${pageNames.length > 1 ? 's' : ''}) into playlist "${playlistName}". Assign it to a device to show it.`,
  };
}
