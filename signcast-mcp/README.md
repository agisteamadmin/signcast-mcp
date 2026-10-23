# signcast-mcp — SignCast MCP server (Phase 4)

AI Assistant backend for SignCast. Express + the official `@modelcontextprotocol/sdk`
(Streamable HTTP). It never talks to TVs directly — it reads/writes Supabase and the
TV sticks pick changes up by polling.

**Tools (Phase 4a read-only, 4b write):**
`list_devices` · `get_schedule` · `search_media` · `schedule_content`
(conflict-first, writes only with `replace_existing: true`) · `assign_playlist`

Phase 4c (platform-admin tools) and 4d (subscription tools) come with Phases 5/6.
`generate_image` / video come with Phase 7.

## Run locally

```bash
npm install
cp .env.example .env   # fill in values (service-role key stays on this machine)
npm run dev            # tsx, :3100
```

Health check: `GET http://localhost:3100/health` (no auth needed).

## Test with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Connect to `http://localhost:3100/mcp` (Streamable HTTP) and add a request header
`Authorization: Bearer <your-Auth0-token>`. Grab a token by logging into the portal,
then in the browser console: an ID token works — `await (await fetch(...))` is awkward;
easiest is Auth0's dashboard "Test" tab for the app, or decode-free copy from the
portal's network requests (the `Authorization` header the app sends to Supabase is the
ID token `__raw`).

Try: `list_devices` → should return your store's devices.

## Deploy to Render

1. Push this folder to GitHub (new repo, e.g. `signcast-mcp`).
2. Render → New → Web Service → pick the repo. `render.yaml` sets build/start/health.
3. In Render's **Environment** tab set (values are yours; never commit them):
   `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
   The service-role key is a master key — it goes **only** here, never in chat,
   never in the frontend repo.
4. Deploy → endpoint is `https://signcast-mcp.onrender.com/mcp`.
   Free tier sleeps when idle (first call is slow); move to Starter ($7/mo) when live.

## Client hookup

Any MCP client (Claude Desktop/Code, the in-app AI Assistant) points at the `/mcp`
URL and sends the user's Auth0 token as `Authorization: Bearer <token>`. The server
verifies the JWT via the Auth0 JWKS, maps `sub` → stores via `store_members`, and
every tool filters to those stores. Platform-admin-only tools (4c/4d) additionally
require the `platform_admin` role claim.

## POST /chat — in-app AI Assistant

`POST /chat` with the same `Authorization: Bearer <token>` header and a JSON body
`{ "message": "...", "history": [{ "role": "user"|"assistant", "content": "..." }] }`.
The server verifies the token, then runs an Anthropic (Claude) tool-use loop against
the same five tools — same powers, same store scoping — and returns
`{ "reply": "...", "tools_used": [...] }`. The Anthropic API key stays on the server
(`ANTHROPIC_API_KEY` env var); it never touches the browser. The loop is capped at
8 tool steps per message to bound cost.
