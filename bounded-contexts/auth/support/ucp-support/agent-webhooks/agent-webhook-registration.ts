import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Webhook callback registration is carried on the OAuth client record itself:
 * each registered agent-platform client may
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

export type ParsedWebhookConfiguration = Readonly<{ callbackUrl: string | null }>;

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

/** Parse the account-facing webhook management payload. `null` disables delivery. */
export function parseWebhookConfiguration(
  body: Readonly<Record<string, unknown>> | null,
): { ok: true; configuration: ParsedWebhookConfiguration } | { ok: false; error: string } {
  if (!body || !Object.prototype.hasOwnProperty.call(body, "callback_url")) {
    return { ok: false, error: "callback_url is required and must be an HTTPS URL or null." };
  }

  if (body.callback_url === null) {
    return { ok: true, configuration: { callbackUrl: null } };
  }

  const result = parseWebhookRegistration({ webhook_callback_url: body.callback_url });
  if (!result.ok) {
    return result;
  }
  if (!result.registration) {
    return { ok: false, error: "callback_url is required and must be an HTTPS URL or null." };
  }
  return { ok: true, configuration: { callbackUrl: result.registration.callbackUrl } };
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
 *
 * The two facts live in different context databases — linked-platform
 * authorizations are Identity-owned while the callback URL / signing secret ride
 * on the Auth-owned OAuth client record — so the lookup is a two-pool join in
 * memory rather than a single SQL join. Both queryables may point at the same
 * connection when a caller happens to co-locate the tables.
 */
export async function resolveAgentWebhookTargets(
  linkedAuthorizationsDb: PgQueryable,
  oauthClientsDb: PgQueryable,
  accountId: string,
): Promise<readonly AgentWebhookTarget[]> {
  const grants = await linkedAuthorizationsDb.query<{ client_id: string; account_id: string }>(
    `SELECT DISTINCT client_id, account_id
     FROM identity_linked_platform_authorizations
     WHERE account_id = $1
       AND status = 'active'
       AND scopes ? $2`,
    [accountId, AGENT_WEBHOOK_ORDER_SCOPE],
  );
  if (grants.rows.length === 0) {
    return [];
  }

  const accountByClient = new Map(grants.rows.map((row) => [row.client_id, row.account_id]));
  const clientIds = [...accountByClient.keys()];
  const clients = await oauthClientsDb.query<{ client_id: string; webhook_callback_url: string }>(
    `SELECT client_id, webhook_callback_url
     FROM identity_ucp_oauth_clients
     WHERE client_id = ANY($1)
       AND webhook_callback_url IS NOT NULL
       AND webhook_signing_secret IS NOT NULL`,
    [clientIds],
  );

  return clients.rows.flatMap((row) => {
    const targetAccountId = accountByClient.get(row.client_id);
    if (!targetAccountId) {
      return [];
    }
    return [{ clientId: row.client_id, accountId: targetAccountId, callbackUrl: row.webhook_callback_url }];
  });
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
