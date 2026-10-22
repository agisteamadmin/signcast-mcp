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
import { listDevices, listDevicesSchema } from './tools/devices.js';
import { getSchedule, getScheduleSchema, scheduleContent, scheduleContentSchema } from './tools/schedule.js';
import { searchMedia, searchMediaSchema } from './tools/media.js';
import { assignPlaylist, assignPlaylistSchema } from './tools/playlists.js';

const app = express();
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
    const status = /Authorization|token|JWT|audience|issuer/i.test(message) ? 401 : 500;
    if (!res.headersSent) res.status(status).json({ error: message });
  }
});

app.get('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Use POST /mcp with an MCP client (Streamable HTTP transport).' });
});

const port = Number(process.env.PORT ?? 3100);
app.listen(port, () => {
  console.log(`signcast-mcp listening on :${port} (POST /mcp, GET /health)`);
});
