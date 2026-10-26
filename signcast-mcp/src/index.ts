/**
 * index.ts — SignCast MCP server (Phase 4).
 *
 * Express + Streamable HTTP transport at /mcp. Every request must carry
 * `Authorization: Bearer <Auth0 token>`; the token is verified per request
 * and the resulting AuthContext is closed over by the tool handlers, so tools
 * can only ever act within the caller's own stores.
 */
import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { verifyAuthToken, extractBearerToken, type AuthContext } from './auth.js';
import { chat, type ChatMessage } from './chat.js';
import { listDevices, listDevicesSchema } from './tools/devices.js';
import { getSchedule, getScheduleSchema, scheduleContent, scheduleContentSchema } from './tools/schedule.js';
import { searchMedia, searchMediaSchema } from './tools/media.js';
import { assignPlaylist, assignPlaylistSchema } from './tools/playlists.js';
import {
  listClients,
  listClientsSchema,
  listClientDevices,
  listClientDevicesSchema,
  enrollDevice,
  enrollDeviceSchema,
  unenrollDevice,
  unenrollDeviceSchema,
} from './tools/admin.js';

const app = express();

/**
 * CORS — the portal's AI Assistant page (Prompt 16) calls POST /chat from the
 * browser on the Netlify origin, which is cross-origin to *.onrender.com. The
 * `Authorization` header makes every request a preflighted one, so without
 * these headers the browser blocks the call (Postman/Inspector are unaffected
 * — they don't do CORS). Wildcard origin is safe here: auth rides on Bearer
 * tokens, not cookies, so there is no CSRF exposure.
 */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'signcast-mcp', time: new Date().toISOString() });
});

/** Build a per-request MCP server whose tools see only the caller's stores. */
function buildServer(auth: AuthContext): McpServer {
  const server = new McpServer({ name: 'signcast-mcp', version: '0.1.0' });

  server.tool('list_devices', 'List the TV devices in your stores (status, assigned playlist, now-playing).', listDevicesSchema, (args) =>
    listDevices(auth, args).then((r) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] })),
  );

  server.tool('get_schedule', 'Show the schedule blocks for a device (one day or the whole week).', getScheduleSchema, (args) =>
    getSchedule(auth, args).then((r) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] })),
  );

  server.tool('search_media', 'Search your media library by name.', searchMediaSchema, (args) =>
    searchMedia(auth, args).then((r) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] })),
  );

  server.tool(
    'schedule_content',
    'Schedule media on store TVs. Returns conflicts instead of overwriting; writes only when re-called with replace_existing=true.',
    scheduleContentSchema,
    (args) =>
      scheduleContent(auth, args).then((r) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] })),
  );

  server.tool('assign_playlist', 'Assign a playlist to a device (sets its primary playlist and targeting).', assignPlaylistSchema, (args) =>
    assignPlaylist(auth, args).then((r) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] })),
  );

  // Phase 4c — platform-admin tools (role-gated inside each handler).
  server.tool('list_clients', 'PLATFORM ADMIN ONLY: list all clients with store/device counts.', listClientsSchema, () =>
    listClients(auth).then((r) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] })),
  );

  server.tool('list_client_devices', 'PLATFORM ADMIN ONLY: list all devices of one client, with now-playing.', listClientDevicesSchema, (args) =>
    listClientDevices(auth, args).then((r) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] })),
  );

  server.tool('enroll_device', 'PLATFORM ADMIN ONLY: enroll a pending TV (by pairing code) into a store.', enrollDeviceSchema, (args) =>
    enrollDevice(auth, args).then((r) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] })),
  );

  server.tool('unenroll_device', 'PLATFORM ADMIN ONLY: unenroll a device (clears store/playlist/schedule bindings, audits the action).', unenrollDeviceSchema, (args) =>
    unenrollDevice(auth, args).then((r) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] })),
  );

  return server;
}

app.post('/mcp', async (req, res) => {
  try {
    const token = extractBearerToken(req.headers.authorization);
    const auth = await verifyAuthToken(token);

    const server = buildServer(auth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: one server per request
    });
    res.on('close', () => transport.close().catch(() => {}));
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /Authorization|token|JWT|audience|issuer|alg/i.test(message) ? 401 : 500;
    if (!res.headersSent) res.status(status).json({ error: message });
  }
});

app.get('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Use POST /mcp with an MCP client (Streamable HTTP transport).' });
});

/**
 * POST /chat — in-app AI Assistant.
 * Body: { message: string, history?: [{ role: 'user'|'assistant', content: string }] }
 * Same Bearer-token auth as /mcp. Runs the Anthropic tool loop server-side and
 * returns { reply, tools_used }. The LLM API key never leaves the server.
 */
app.post('/chat', async (req, res) => {
  try {
    const token = extractBearerToken(req.headers.authorization);
    const auth = await verifyAuthToken(token);
    const { message, history } = (req.body ?? {}) as { message?: unknown; history?: ChatMessage[] };
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Body must include "message" (string).' });
      return;
    }
    const result = await chat(auth, message, Array.isArray(history) ? history : []);
    res.json(result);
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    const status = /Authorization|token|JWT|audience|issuer|alg/i.test(messageText) ? 401 : 500;
    if (!res.headersSent) res.status(status).json({ error: messageText });
  }
});

const port = Number(process.env.PORT ?? 3100);
app.listen(port, () => {
  console.log(`signcast-mcp listening on :${port} (POST /mcp, GET /health)`);
});
