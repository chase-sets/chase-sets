import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Webhook callback registration is carried on the OAuth client record itself
 * (the DCR/CIMD slice, issue #3755): each registered agent-platform client may
 * register a single callback URL and is issued one signing secret. The secret
 * is stored so the marketplace can compute delivery signatures; it is returned
 * to the integrator exactly once at registration and never surfaced again in any
 * list/detail read or log line — reads expose only a non-reversible preview.
 *
 * Column-level encryption / KMS wrapping of `webhook_signing_secret` is a
 * deliberate hardening follow-up; the access surface is already narrowed to a
 * single resolver so that upgrade is local.
 */
export const agentWebhookRegistrationSchemaSql = `
ALTER TABLE identity_ucp_oauth_clients
  ADD COLUMN IF NOT EXISTS webhook_callback_url text NULL;

ALTER TABLE identity_ucp_oauth_clients
  ADD COLUMN IF NOT EXISTS webhook_signing_secret text NULL;

ALTER TABLE identity_ucp_oauth_clients
  ADD COLUMN IF NOT EXISTS webhook_signing_secret_created_at timestamptz NULL;
`;

export const AGENT_WEBHOOK_ORDER_SCOPE = "order:read";
const MAX_CALLBACK_URL_LENGTH = 2048;

export type ParsedWebhookRegistration = Readonly<{ callbackUrl: string }>;

/**
 * Parse the optional `webhook`/`webhook_callback_url` metadata from a client
 * registration body. Returns `undefined` when no webhook is requested, or an
 * error when the supplied callback is not a trusted URL.
 */
export function parseWebhookRegistration(
  body: Readonly<Record<string, unknown>>,
): { ok: true; registration: ParsedWebhookRegistration | undefined } | { ok: false; error: string } {
  const callbackUrl = readCallbackUrl(body);
  if (callbackUrl === undefined) {
    return { ok: true, registration: undefined };
  }
  if (callbackUrl.length > MAX_CALLBACK_URL_LENGTH) {
    return { ok: false, error: "webhook callback URL is too long." };
  }
  if (!isTrustedCallbackUrl(callbackUrl)) {
    return { ok: false, error: "webhook callback URL must be an HTTPS URL or a localhost HTTP URL." };
  }
  return { ok: true, registration: { callbackUrl } };
}

function readCallbackUrl(body: Readonly<Record<string, unknown>>): string | undefined {
  const direct = readString(body.webhook_callback_url);
  if (direct) {
    return direct;
  }
  const webhook = body.webhook;
  if (typeof webhook === "object" && webhook !== null && !Array.isArray(webhook)) {
    const nested = readString(
      (webhook as Record<string, unknown>).callback_url ?? (webhook as Record<string, unknown>).url,
    );
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

export type AgentWebhookTarget = Readonly<{
  clientId: string;
  accountId: string;
  callbackUrl: string;
}>;

/**
 * Every agent-platform callback that should receive order updates for
 * `accountId`: an active linked-platform authorization granting `order:read`
 * whose OAuth client has registered a webhook callback. One order can fan out to
 * several linked platforms.
 */
export async function resolveAgentWebhookTargets(
  db: PgQueryable,
  accountId: string,
): Promise<readonly AgentWebhookTarget[]> {
  const result = await db.query<{ client_id: string; account_id: string; webhook_callback_url: string }>(
    `SELECT DISTINCT authorization.client_id, authorization.account_id, client.webhook_callback_url
     FROM identity_linked_platform_authorizations AS authorization
     JOIN identity_ucp_oauth_clients AS client ON client.client_id = authorization.client_id
     WHERE authorization.account_id = $1
       AND authorization.status = 'active'
       AND client.webhook_callback_url IS NOT NULL
       AND client.webhook_signing_secret IS NOT NULL
       AND authorization.scopes ? $2`,
    [accountId, AGENT_WEBHOOK_ORDER_SCOPE],
  );
  return result.rows.map((row) => ({
    clientId: row.client_id,
    accountId: row.account_id,
    callbackUrl: row.webhook_callback_url,
  }));
}

/** Resolve a client's plaintext signing secret for outbound signing (dispatcher only). */
export async function resolveAgentWebhookSigningSecret(db: PgQueryable, clientId: string): Promise<string | null> {
  const result = await db.query<{ webhook_signing_secret: string | null }>(
    `SELECT webhook_signing_secret
     FROM identity_ucp_oauth_clients
     WHERE client_id = $1
     LIMIT 1`,
    [clientId],
  );
  return result.rows[0]?.webhook_signing_secret ?? null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isTrustedCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) {
      return false;
    }
    if (url.protocol === "https:") {
      return true;
    }
    return url.protocol === "http:" && isLocalHost(url.hostname);
  } catch {
    return false;
  }
}

function isLocalHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value.endsWith(".localhost");
}
