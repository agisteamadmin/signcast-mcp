/**
 * auth.ts — Auth0 JWT verification for the MCP server.
 *
 * Callers (in-app AI Assistant, Claude Desktop/Code, etc.) send the user's
 * Auth0 token as `Authorization: Bearer <token>`. We verify the signature via
 * the tenant's JWKS, then map `sub` -> stores through `store_members`.
 *
 * Audience: the API identifier (access tokens) AND the app Client ID (ID
 * tokens) are both accepted — the "Add roles to token" Action puts the
 * `role` + namespaced roles claims on both tokens.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export const ROLES_CLAIM = 'https://signcast.app/roles';
export const PLATFORM_ADMIN_ROLE = 'platform_admin';

export interface AuthContext {
  /** Raw Auth0 subject, e.g. google-oauth2|107701317771852753331 */
  sub: string;
  roles: string[];
  isPlatformAdmin: boolean;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    const domain = process.env.AUTH0_DOMAIN;
    if (!domain) throw new Error('AUTH0_DOMAIN is not set');
    jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
  }
  return jwks;
}

function rolesFromPayload(payload: JWTPayload): string[] {
  const namespaced = payload[ROLES_CLAIM];
  if (Array.isArray(namespaced)) return namespaced.filter((r) => typeof r === 'string');
  const appMeta = (payload as Record<string, unknown>).app_metadata as
    | { roles?: unknown }
    | undefined;
  if (appMeta && Array.isArray(appMeta.roles)) {
    return appMeta.roles.filter((r): r is string => typeof r === 'string');
  }
  return [];
}

export async function verifyAuthToken(token: string): Promise<AuthContext> {
  const domain = process.env.AUTH0_DOMAIN;
  const apiAudience = process.env.AUTH0_AUDIENCE;
  const clientId = process.env.AUTH0_CLIENT_ID;
  if (!domain) throw new Error('AUTH0_DOMAIN is not set');

  const audiences = [apiAudience, clientId].filter((a): a is string => !!a);
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: `https://${domain}/`,
    ...(audiences.length > 0 ? { audience: audiences } : {}),
  });

  const sub = payload.sub;
  if (!sub) throw new Error('Token has no sub claim');

  const roles = rolesFromPayload(payload);
  return {
    sub,
    roles,
    isPlatformAdmin: roles.includes(PLATFORM_ADMIN_ROLE),
  };
}

export function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    throw new Error('Missing or malformed Authorization header (expected "Bearer <token>")');
  }
  return authHeader.slice(7).trim();
}
