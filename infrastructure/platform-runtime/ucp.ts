import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  verify as verifySignatureBytes,
  type KeyObject,
} from "node:crypto";
import { Hono, type Context } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createMemoryPlatformIdempotencyStore,
  type PlatformIdempotencyRecord,
  type PlatformIdempotencyStore,
} from "./idempotency";
import { MCP_LEGACY_PROTOCOL_VERSIONS, negotiateMcpProtocolVersion } from "./mcp-protocol";
import {
  buildUcpBusinessProfile,
  createUcpEnvelope,
  UCP_MCP_CART_REVIEW_RESOURCE_URI,
  UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
  UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
  UCP_MCP_RESOURCES,
  UCP_MCP_APP_RESOURCE_MIME_TYPE,
  UCP_MCP_TOOLS,
  unsupportedUcpOperation,
  type UcpBusinessProfile,
  type UcpEnvelope,
  type UcpMcpResourceDescriptor,
  type UcpMcpToolDescriptor,
} from "./ucp-contracts";
import type { McpToolCallLease, McpToolCallLimitKind, McpToolCallLimiter } from "./mcp-tool-call-limiter";
import type { ResolvedActor } from "./auth";
import { resolveClientAddress, resolvePublicRequestOrigin } from "./http";
import {
  agentGrantIdFromActor,
  platformAgentGuardrailsSchemaSql,
  type AgentGrantGuardrailViolation,
  type AgentGrantRateLimiter,
} from "./agent-guardrails";

export {
  buildUcpBusinessProfile,
  createUcpEnvelope,
  normalizeUcpOrigin,
  UCP_CAPABILITIES,
  UCP_LATEST_SPEC_BASE_URL,
  UCP_MCP_APP_RESOURCE_MIME_TYPE,
  UCP_MCP_CART_REVIEW_RESOURCE_URI,
  UCP_MCP_ENDPOINT_PATH,
  UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
  UCP_MCP_MARKETPLACE_RESULTS_RESOURCE_URI,
  UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
  UCP_MCP_RESOURCES,
  UCP_MCP_TOOLS,
  UCP_REST_ENDPOINT_PATH,
  UCP_SHOPPING_SERVICE,
  UCP_SPEC_BASE_URL,
  UCP_VERSION,
  unsupportedUcpOperation,
  type UcpBusinessProfile,
  type UcpCapabilityDeclaration,
  type UcpEnvelope,
  type UcpMcpResourceDescriptor,
  type UcpMcpSecurityScheme,
  type UcpMcpToolDescriptor,
  type UcpMessage,
  type UcpMessageSeverity,
  type UcpResponseStatus,
  type UcpServiceDeclaration,
  type UcpTransport,
} from "./ucp-contracts";
export type { PlatformIdempotencyRecord, PlatformIdempotencyStore } from "./idempotency";

type UcpRuntimeEnv = {
  Variables: {
    actor: ResolvedActor | null;
    context: EventStoreContext | null;
  };
};

type JsonRpcRequest = Readonly<{
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
}>;

const IDEMPOTENCY_PENDING_TTL_MS = 2 * 60 * 1000;

type UcpToolCallParams = Readonly<{
  name?: unknown;
  arguments?: unknown;
}>;

type UcpResourceReadParams = Readonly<{
  uri?: unknown;
}>;

export type UcpOperationHandlerInput = Readonly<{
  actor: ResolvedActor | null;
  context: EventStoreContext | null;
  arguments: Readonly<Record<string, unknown>>;
  request: Request;
  params: Readonly<Record<string, string>>;
}>;

export type UcpOperationHandler = (input: UcpOperationHandlerInput) => Promise<UcpEnvelope> | UcpEnvelope;

export type UcpIdempotencyRecord = PlatformIdempotencyRecord<UcpEnvelope>;

export type UcpIdempotencyStore = PlatformIdempotencyStore<UcpEnvelope>;

export type UcpSignatureKeyResolver = (
  profileUrl: string,
  keyId: string,
) => Promise<JsonWebKey | null> | JsonWebKey | null;

export type UcpSignatureVerificationOptions = Readonly<{
  keyResolver: UcpSignatureKeyResolver;
  createdFreshnessWindowMs?: number;
  now?: () => Date;
}>;

export type UcpProfileCacheOptions = Readonly<{
  db: PgQueryable;
  fetch?: typeof globalThis.fetch;
  ttlMs?: number;
  now?: () => Date;
}>;

export type UcpBusinessSigningAlgorithm = "ES256" | "ES384" | "ES512";

export type UcpBusinessSigningKey = Readonly<{
  kid: string;
  alg: UcpBusinessSigningAlgorithm;
  privateJwk: JsonWebKey;
}>;

export type UcpBusinessSigningKeySet = Readonly<{
  current: UcpBusinessSigningKey;
  previousPublicJwks?: readonly JsonWebKey[];
}>;

export type UcpRuntimeObserver = Readonly<{
  signedWriteRejected?: (event: UcpRuntimeSecurityEvent) => void;
  signatureVerificationFailed?: (event: UcpRuntimeSecurityEvent) => void;
  idempotencyReplayed?: (event: UcpRuntimeIdempotencyEvent) => void;
  idempotencyConflict?: (event: UcpRuntimeIdempotencyEvent) => void;
  operationCompleted?: (event: UcpRuntimeOperationEvent) => void;
  toolCallLimited?: (event: UcpRuntimeToolLimitEvent) => void;
  agentGuardrailTriggered?: (event: AgentGrantGuardrailViolation) => void;
}>;

export type UcpRuntimeSecurityEvent = Readonly<{
  transport: "rest" | "mcp";
  operation: string;
  reason: string;
  agentProfileUrl: string | null;
}>;

export type UcpRuntimeIdempotencyEvent = Readonly<{
  transport: "rest" | "mcp";
  operation: string;
  key: string;
  agentProfileUrl: string | null;
}>;

export type UcpRuntimeOperationEvent = Readonly<{
  transport: "rest" | "mcp";
  operation: string;
  status: UcpEnvelope["ucp"]["status"];
  agentProfileUrl: string | null;
}>;

export type UcpRuntimeToolLimitEvent = Readonly<{
  transport: "mcp";
  operation: string;
  reason: string;
  limitKind: McpToolCallLimitKind;
  actorId: string | null;
  accountId: string | null;
  agentProfileUrl: string | null;
}>;

export type CreateUcpRoutesOptions = Readonly<{
  restHandlers?: Readonly<Record<string, UcpOperationHandler>>;
  mcpToolHandlers?: Readonly<Record<string, UcpOperationHandler>>;
  idempotencyStore?: UcpIdempotencyStore;
  mcpToolCallLimiter?: McpToolCallLimiter;
  agentGrantRateLimiter?: AgentGrantRateLimiter;
  allowInMemoryIdempotencyStoreForTests?: boolean;
  signatureVerification?: UcpSignatureVerificationOptions;
  businessSigningKeys?: UcpBusinessSigningKeySet;
  observer?: UcpRuntimeObserver;
}>;

const JSON_RPC_VERSION = "2.0";

const SIGNED_WRITE_HEADERS = ["Signature-Input", "Signature", "Content-Digest", "UCP-Agent"] as const;

export const DEFAULT_UCP_SIGNATURE_CREATED_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;
const UCP_MCP_PRODUCT_CARDS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chase Sets Product Cards</title>
  <style>
    :root { color-scheme: light dark; --background: Canvas; --foreground: CanvasText; --card: color-mix(in srgb, Canvas 96%, CanvasText 4%); --border: color-mix(in srgb, CanvasText 16%, transparent); --muted: color-mix(in srgb, CanvasText 68%, transparent); --primary: LinkText; --surface-2: color-mix(in srgb, CanvasText 8%, transparent); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 12px; background: transparent; color: var(--foreground); }
    .results { display: grid; gap: 10px; }
    .card { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 10px; align-items: center; border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--card); }
    .image { display: grid; width: 72px; height: 96px; place-items: center; border-radius: 6px; background: var(--surface-2); color: var(--muted); font-size: 24px; font-weight: 800; }
    .title { margin: 0; font-size: 15px; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
    .meta { margin: 3px 0 0; font-size: 12px; color: var(--muted); line-height: 1.35; overflow-wrap: anywhere; }
    .signals { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .signal { border: 1px solid var(--border); border-radius: 999px; padding: 3px 8px; font-size: 12px; line-height: 1.25; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .action { color: var(--primary); font-weight: 650; font-size: 13px; text-decoration: none; }
    .empty { border: 1px solid var(--border); border-radius: 8px; padding: 14px; font-size: 14px; }
  </style>
</head>
<body>
  <main id="app" class="results" aria-live="polite"></main>
  <script>
    const app = document.getElementById("app");
    let latestResult = null;

    function productUrl(product) {
      const url = product?.extensions?.chase_sets?.actions?.view_product?.url || product?.url || "";
      return typeof url === "string" ? url : "";
    }

    function render(result) {
      latestResult = result;
      const products = Array.isArray(result?.structuredContent?.products)
        ? result.structuredContent.products
        : Array.isArray(result?.products)
          ? result.products
          : [];

      if (!products.length) {
        app.innerHTML = '<section class="empty">No matching marketplace products are available right now.</section>';
        return;
      }

      app.innerHTML = products.slice(0, 8).map((product) => {
        const chaseSets = product.extensions?.chase_sets ?? {};
        const href = productUrl(product);
        const market = chaseSets.marketplace ?? {};
        const price = chaseSets.price_display ?? "Not currently listed";
        const availability = chaseSets.availability_display ?? "Unavailable";
        const subtitle = product.subtitle || product.description || "";
        const initial = String(product.title || "?").trim().slice(0, 1).toUpperCase() || "?";
        return '<article class="card">' +
          '<div class="image" aria-hidden="true">' + escapeHtml(initial) + '</div>' +
          '<div>' +
            '<h2 class="title">' + escapeHtml(product.title || "Marketplace product") + '</h2>' +
            (subtitle ? '<p class="meta">' + escapeHtml(subtitle) + '</p>' : '') +
            '<div class="signals">' +
              '<span class="signal">' + escapeHtml(price) + '</span>' +
              '<span class="signal">' + escapeHtml(availability) + '</span>' +
              '<span class="signal">' + escapeHtml(String(market.active_listing_count ?? 0)) + ' listings</span>' +
            '</div>' +
            (href ? '<div class="actions"><a class="action" href="' + escapeHtml(href) + '">View product</a></div>' : '') +
          '</div>' +
        '</article>';
      }).join("");
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.method === "ui/notifications/tool-result") {
        render(message.params?.result ?? message.params ?? {});
      }
    });

    render(latestResult ?? {});
  </script>
</body>
</html>`;
const UCP_MCP_CART_REVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chase Sets Cart Review</title>
  <style>
    :root { color-scheme: light dark; --background: Canvas; --foreground: CanvasText; --card: color-mix(in srgb, Canvas 96%, CanvasText 4%); --border: color-mix(in srgb, CanvasText 16%, transparent); --muted: color-mix(in srgb, CanvasText 68%, transparent); --primary: LinkText; --surface-2: color-mix(in srgb, CanvasText 8%, transparent); --success-soft: color-mix(in srgb, CanvasText 6%, Canvas); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 12px; background: transparent; color: var(--foreground); }
    .panel { display: grid; gap: 10px; border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: var(--card); }
    .header { display: flex; align-items: start; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
    .eyebrow { margin: 0 0 3px; color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .title { margin: 0; font-size: 16px; line-height: 1.25; overflow-wrap: anywhere; }
    .status { border: 1px solid var(--border); border-radius: 999px; padding: 4px 8px; background: var(--success-soft); font-size: 12px; font-weight: 650; white-space: nowrap; }
    .lines { display: grid; gap: 8px; }
    .line { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .line:last-child { border-bottom: 0; padding-bottom: 0; }
    .name { margin: 0; font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
    .meta, .amount { margin: 3px 0 0; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .amount { color: var(--foreground); font-weight: 700; text-align: right; }
    .totals { display: grid; gap: 5px; border-top: 1px solid var(--border); padding-top: 10px; }
    .total { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
    .total strong { font-size: 15px; }
    .empty { border: 1px solid var(--border); border-radius: 8px; padding: 14px; font-size: 14px; }
  </style>
</head>
<body>
  <main id="app" aria-live="polite"></main>
  <script>
    const app = document.getElementById("app");

    function render(result) {
      const payload = result?.structuredContent ?? result ?? {};
      const checkout = payload.checkout ?? payload.session ?? payload.cart ?? {};
      const lines = Array.isArray(checkout.items) ? checkout.items
        : Array.isArray(checkout.line_items) ? checkout.line_items
        : Array.isArray(payload.items) ? payload.items
        : Array.isArray(payload.line_items) ? payload.line_items
        : [];
      const totals = Array.isArray(checkout.totals) ? checkout.totals : Array.isArray(payload.totals) ? payload.totals : [];
      const status = checkout.status || payload.status || payload.ucp?.status || "review";
      const title = checkout.id ? "Checkout " + checkout.id : "Cart review";

      if (!lines.length && !totals.length) {
        app.innerHTML = '<section class="empty">Cart review details will appear here after checkout data is available.</section>';
        return;
      }

      app.innerHTML = '<section class="panel">' +
        '<header class="header"><div><p class="eyebrow">Chase Sets</p><h2 class="title">' + escapeHtml(title) + '</h2></div><span class="status">' + escapeHtml(status) + '</span></header>' +
        '<div class="lines">' + lines.slice(0, 8).map(renderLine).join("") + '</div>' +
        (totals.length ? '<div class="totals">' + totals.slice(0, 6).map(renderTotal).join("") + '</div>' : '') +
      '</section>';
    }

    function renderLine(line) {
      const name = line.item_title || line.title || line.name || line.product_id || line.catalog_item_id || "Cart line";
      const quantity = Number(line.quantity ?? 1);
      const seller = line.seller_name || line.seller || line.account_name || "";
      const amount = line.amount_display || line.price_display || line.subtotal_display || "";
      return '<article class="line"><div><p class="name">' + escapeHtml(name) + '</p><p class="meta">Qty ' + escapeHtml(quantity) + (seller ? " - " + escapeHtml(seller) : "") + '</p></div><p class="amount">' + escapeHtml(amount) + '</p></article>';
    }

    function renderTotal(total) {
      const label = total.label || total.type || "Total";
      const amount = total.amount_display || total.display || total.amount || "";
      return '<div class="total"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(amount) + '</strong></div>';
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.method === "ui/notifications/tool-result") {
        render(message.params?.result ?? message.params ?? {});
      }
    });

    render({});
  </script>
</body>
</html>`;
const UCP_MCP_CHECKOUT_HANDOFF_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chase Sets Checkout Handoff</title>
  <style>
    :root { color-scheme: light dark; --background: Canvas; --foreground: CanvasText; --card: color-mix(in srgb, Canvas 96%, CanvasText 4%); --border: color-mix(in srgb, CanvasText 16%, transparent); --muted: color-mix(in srgb, CanvasText 68%, transparent); --primary: LinkText; --warning-soft: color-mix(in srgb, CanvasText 7%, Canvas); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 12px; background: transparent; color: var(--foreground); }
    .handoff { display: grid; gap: 10px; border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: var(--card); }
    .eyebrow { margin: 0; color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .title { margin: 0; font-size: 16px; line-height: 1.25; overflow-wrap: anywhere; }
    .message { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
    .notice { border: 1px solid var(--border); border-radius: 8px; padding: 9px; background: var(--warning-soft); font-size: 13px; line-height: 1.4; }
    .action { color: var(--primary); font-weight: 700; font-size: 14px; text-decoration: none; }
    .empty { border: 1px solid var(--border); border-radius: 8px; padding: 14px; font-size: 14px; }
  </style>
</head>
<body>
  <main id="app" aria-live="polite"></main>
  <script>
    const app = document.getElementById("app");

    function render(result) {
      const payload = result?.structuredContent ?? result ?? {};
      const action = payload.action ?? {};
      const message = payload.messages?.[0]?.message || action.reason || "Use trusted Chase Sets checkout before any order or payment is finalized.";
      const url = typeof action.url === "string" ? action.url : "";
      const checkoutId = payload.checkout?.id || payload.id || "";

      if (!url && !checkoutId && payload.ucp?.status !== "requires_action") {
        app.innerHTML = '<section class="empty">Checkout handoff details will appear here when trusted UI is required.</section>';
        return;
      }

      app.innerHTML = '<section class="handoff">' +
        '<p class="eyebrow">Trusted checkout</p>' +
        '<h2 class="title">' + escapeHtml(checkoutId ? "Checkout " + checkoutId : "Complete in Chase Sets") + '</h2>' +
        '<p class="message">' + escapeHtml(message) + '</p>' +
        '<div class="notice">Final order and payment authorization stay inside the trusted Chase Sets checkout surface.</div>' +
        (url ? '<a class="action" href="' + escapeHtml(url) + '">Open trusted checkout</a>' : '') +
      '</section>';
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.method === "ui/notifications/tool-result") {
        render(message.params?.result ?? message.params ?? {});
      }
    });

    render({});
  </script>
</body>
</html>`;
const UCP_MCP_APP_RESOURCES_BY_URI: Readonly<Record<string, Readonly<{ html: string; description: string }>>> = {
  [UCP_MCP_PRODUCT_CARDS_RESOURCE_URI]: {
    html: UCP_MCP_PRODUCT_CARDS_HTML,
    description: "Interactive Chase Sets product cards from marketplace listing search.",
  },
  [UCP_MCP_CART_REVIEW_RESOURCE_URI]: {
    html: UCP_MCP_CART_REVIEW_HTML,
    description: "Interactive Chase Sets cart and checkout review.",
  },
  [UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI]: {
    html: UCP_MCP_CHECKOUT_HANDOFF_HTML,
    description: "Interactive Chase Sets trusted checkout handoff.",
  },
};
const ECDSA_SIGNATURE_LENGTHS = {
  ES256: 64,
  ES384: 96,
  ES512: 132,
} satisfies Record<UcpBusinessSigningAlgorithm, number>;
const ECDSA_HASH_ALGORITHMS = {
  ES256: "sha256",
  ES384: "sha384",
  ES512: "sha512",
} satisfies Record<UcpBusinessSigningAlgorithm, string>;

export const platformUcpRuntimeSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_ucp_idempotency_records (
  key text PRIMARY KEY,
  request_hash text NOT NULL,
  response jsonb NULL,
  status text NOT NULL DEFAULT 'completed',
  created_at timestamptz NOT NULL,
  expires_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_ucp_idempotency_records
  ALTER COLUMN response DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'platform_ucp_idempotency_records_status_check'
  ) THEN
    ALTER TABLE platform_ucp_idempotency_records
      ADD CONSTRAINT platform_ucp_idempotency_records_status_check
      CHECK (status IN ('pending', 'completed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS platform_ucp_idempotency_records_created_at_idx
  ON platform_ucp_idempotency_records (created_at);

CREATE INDEX IF NOT EXISTS platform_ucp_idempotency_records_expires_at_idx
  ON platform_ucp_idempotency_records (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_ucp_agent_profiles (
  profile_url text PRIMARY KEY,
  profile jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_error text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_ucp_agent_profiles_expires_at_idx
  ON platform_ucp_agent_profiles (expires_at);

${platformAgentGuardrailsSchemaSql}
`;

function requestOrigin(request: Request) {
  return resolvePublicRequestOrigin(request);
}

function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: id ?? null,
    result,
  };
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: id ?? null,
    error: {
      code,
      message,
    },
  };
}

function toolResult(tool: UcpMcpToolDescriptor, result: UcpEnvelope) {
  const meta = {
    ...(requiresOAuthChallenge(result) ? { "mcp/www_authenticate": oauthChallenge(tool) } : {}),
    ...(tool.resultResourceUri
      ? {
          ui: {
            resourceUri: tool.resultResourceUri,
          },
          "openai/outputTemplate": tool.resultResourceUri,
          chase_sets: {
            result_kind: tool.name,
          },
        }
      : {}),
  };

  return {
    structuredContent: result,
    content: [
      {
        type: "text",
        text: summarizeUcpMcpResult(tool, result),
      },
    ],
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}

function requiresOAuthChallenge(result: UcpEnvelope) {
  return result.messages?.some((message) => message.code === "authentication_required") ?? false;
}

function oauthChallenge(tool: UcpMcpToolDescriptor) {
  const scopes = tool.securitySchemes
    .flatMap((scheme) => (scheme.type === "oauth2" ? [...scheme.scopes] : []))
    .filter((scope, index, scopes) => scopes.indexOf(scope) === index);
  return scopes.length > 0 ? `Bearer realm="Chase Sets", scope="${scopes.join(" ")}"` : 'Bearer realm="Chase Sets"';
}

function unsignedMcpTrustedHandoff(tool: UcpMcpToolDescriptor, args: Readonly<Record<string, unknown>>) {
  const checkoutId = typeof args.id === "string" ? args.id : null;
  const action =
    tool.name === "cancel_checkout"
      ? {
          type: "trusted_checkout_handoff",
          ...(checkoutId ? { url: `/checkout/${checkoutId}` } : {}),
          reason: "Checkout cancellation is available only through trusted UI for ChatGPT OAuth callers.",
        }
      : {
          type: "trusted_checkout_handoff",
          ...(checkoutId ? { url: `/checkout/${checkoutId}` } : {}),
          reason:
            "Checkout completion requires trusted UI unless a signed UCP/AP2 agent supplies verified mandate evidence.",
        };
  const message =
    tool.name === "cancel_checkout"
      ? "Open the trusted checkout UI to abandon or revise this checkout session."
      : "Open the trusted checkout UI before creating orders or payment through ChatGPT.";

  return createUcpEnvelope("requires_action", { action }, [
    {
      severity: "warning",
      code: "trusted_ui_required",
      message,
    },
  ]);
}

function normalizeArguments(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function normalizeResourceReadParams(value: unknown): UcpResourceReadParams {
  return normalizeArguments(value) as UcpResourceReadParams;
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function toMcpToolListItem(tool: UcpMcpToolDescriptor) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    securitySchemes: tool.securitySchemes,
    annotations: {
      capability: tool.capability,
      idempotencyKeyRequired: tool.idempotencyKeyRequired,
      ...tool.annotations,
    },
    _meta: {
      securitySchemes: tool.securitySchemes,
      "openai/toolInvocation/invoking": tool.invoking,
      "openai/toolInvocation/invoked": tool.invoked,
      ...(tool.resultResourceUri
        ? {
            ui: {
              resourceUri: tool.resultResourceUri,
            },
            "openai/outputTemplate": tool.resultResourceUri,
          }
        : {}),
    },
  };
}

function toMcpResourceListItem(resource: UcpMcpResourceDescriptor) {
  return {
    uri: resource.uri,
    name: resource.name,
    title: resource.title,
    description: resource.description,
    mimeType: resource.mimeType,
  };
}

function summarizeUcpMcpResult(tool: UcpMcpToolDescriptor, result: UcpEnvelope) {
  if (result.ucp.status === "error") {
    return result.messages?.[0]?.message ?? `${tool.title} returned an error.`;
  }

  const products = readArray((result as Readonly<Record<string, unknown>>).products);
  if (products.length > 0) {
    const names = products
      .slice(0, 3)
      .map((entry) => readObject(entry)?.title)
      .filter((title): title is string => typeof title === "string" && title.trim().length > 0);
    const count = Number((result as Readonly<Record<string, unknown>>).total ?? products.length);
    return names.length > 0
      ? `Found ${count} marketplace result${count === 1 ? "" : "s"}: ${names.join(", ")}.`
      : `Found ${count} marketplace result${count === 1 ? "" : "s"}.`;
  }

  const product = readObject((result as Readonly<Record<string, unknown>>).product);
  if (product) {
    const title = typeof product.title === "string" ? product.title : "the requested product";
    return `Found ${title}.`;
  }

  return `${tool.title} completed.`;
}

function readUcpMcpResource(uri: string) {
  const resource = UCP_MCP_APP_RESOURCES_BY_URI[uri];
  if (!resource) {
    return null;
  }

  return {
    contents: [
      {
        uri,
        mimeType: UCP_MCP_APP_RESOURCE_MIME_TYPE,
        text: resource.html,
        _meta: {
          ui: {
            preferredBorder: true,
          },
          "openai/widgetDescription": resource.description,
          "openai/widgetCSP": {
            connect_domains: [],
            resource_domains: [],
          },
          "openai/widgetPrefersBorder": true,
        },
      },
    ],
  };
}

function missingSignedWriteHeaders(request: Request) {
  return SIGNED_WRITE_HEADERS.filter((header) => !request.headers.get(header));
}

async function requestBodyHash(request: Request) {
  const body = Buffer.from(await request.clone().arrayBuffer());
  return createHash("sha256").update(body).digest("base64");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function mcpToolRequestHash(toolName: string, args: Readonly<Record<string, unknown>>) {
  return createHash("sha256")
    .update(
      stableJson({
        method: "tools/call",
        name: toolName,
        arguments: args,
      }),
    )
    .digest("base64");
}

async function verifyContentDigest(request: Request) {
  const digest = request.headers.get("Content-Digest");
  if (!digest) {
    return false;
  }

  const match = /^sha-256=:(.+):$/i.exec(digest.trim());
  if (!match) {
    return false;
  }

  return (await requestBodyHash(request)) === match[1];
}

async function signedWriteFailure(request: Request) {
  const missing = missingSignedWriteHeaders(request);
  if (missing.length > 0) {
    return `Missing required UCP signed request header(s): ${missing.join(", ")}.`;
  }

  if (!(await verifyContentDigest(request))) {
    return "Content-Digest did not match the request body.";
  }

  return null;
}

function ucpAgentProfileUrl(request: Request) {
  const header = request.headers.get("UCP-Agent")?.trim() ?? "";
  const match = /(?:^|[,\s])profile="([^"]+)"/.exec(header);
  return match?.[1] ?? null;
}

function emitObserver<TEvent>(observer: ((event: TEvent) => void) | undefined, event: TEvent) {
  try {
    observer?.(event);
  } catch {
    // Observability must never change UCP request behavior.
  }
}

function parseSignatureInput(request: Request) {
  const header = request.headers.get("Signature-Input")?.trim() ?? "";
  const match = /^([A-Za-z0-9_.*-]+)=\(([^)]*)\)(.*)$/.exec(header);
  if (!match) {
    return null;
  }

  const params = match[3] ?? "";
  const keyId = /(?:^|;)keyid="([^"]+)"/.exec(params)?.[1] ?? null;
  const createdText = /(?:^|;)created=([^;]+)/.exec(params)?.[1] ?? null;
  const components = [...match[2].matchAll(/"([^"]+)"/g)].map((entry) => entry[1].toLowerCase());

  return {
    label: match[1],
    components,
    params: `(${match[2]})${params}`,
    keyId,
    createdSeconds: createdText && /^[0-9]+$/.test(createdText) ? Number(createdText) : null,
  };
}

function parseSignature(request: Request, label: string) {
  const header = request.headers.get("Signature")?.trim() ?? "";
  const expression = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=:([^:]+):`);
  const match = expression.exec(header);
  return match ? Buffer.from(match[1], "base64") : null;
}

function signatureComponentValue(request: Request, component: string) {
  const url = new URL(request.url);
  switch (component) {
    case "@method":
      return request.method.toUpperCase();
    case "@path":
      return url.pathname;
    case "@query":
      return url.search;
    case "@authority":
      return request.headers.get("host") ?? url.host;
    default:
      return request.headers.get(component);
  }
}

function signatureBase(request: Request, components: readonly string[], params: string) {
  const lines = components.map((component) => {
    const value = signatureComponentValue(request, component);
    if (value === null) {
      throw new Error(`Signed component '${component}' is missing.`);
    }

    return `"${component}": ${value}`;
  });

  return [...lines, `"@signature-params": ${params}`].join("\n");
}

function validateSignatureInputCoverage(
  request: Request,
  input: NonNullable<ReturnType<typeof parseSignatureInput>>,
  options: UcpSignatureVerificationOptions,
) {
  const coveredComponents = new Set(input.components);
  const requiredComponents = ["@method", "@path", "content-digest"];
  if (idempotencyKey(request)) {
    requiredComponents.push("idempotency-key");
  }

  const missingComponents = requiredComponents.filter((component) => !coveredComponents.has(component));
  if (missingComponents.length > 0) {
    return `Signature-Input must cover ${missingComponents.join(", ")} for signed UCP writes.`;
  }

  const createdSeconds = input.createdSeconds;
  if (typeof createdSeconds !== "number" || !Number.isSafeInteger(createdSeconds)) {
    return "Signature-Input must include a valid created timestamp.";
  }

  const windowMs = options.createdFreshnessWindowMs ?? DEFAULT_UCP_SIGNATURE_CREATED_FRESHNESS_WINDOW_MS;
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const createdMs = createdSeconds * 1000;
  if (createdMs < nowMs - windowMs) {
    return "Signature-Input created timestamp is outside the allowed freshness window.";
  }
  if (createdMs > nowMs + windowMs) {
    return "Signature-Input created timestamp is too far in the future.";
  }

  return null;
}

function publicKeyAlgorithm(jwk: JsonWebKey) {
  return jwk.alg === "EdDSA" || jwk.crv === "Ed25519" ? null : "sha256";
}

function base64Url(bytes: Buffer | string) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new Error("UCP AP2 merchant authorization payload must be JSON serializable.");
}

function checkoutPayloadForMerchantAuthorization(checkout: Readonly<Record<string, unknown>>) {
  const { ap2: _ap2, ...payload } = checkout;
  return payload;
}

function publicJwkForPrivateKey(key: UcpBusinessSigningKey): JsonWebKey {
  const publicJwk = createPublicKey(createPrivateKey({ key: key.privateJwk, format: "jwk" })).export({ format: "jwk" });
  return {
    ...publicJwk,
    kid: key.kid,
    alg: key.alg,
    use: "sig",
  } as JsonWebKey;
}

export function publicUcpBusinessSigningKeys(keys: UcpBusinessSigningKeySet | undefined): readonly JsonWebKey[] {
  if (!keys) {
    return [];
  }
  return [publicJwkForPrivateKey(keys.current), ...(keys.previousPublicJwks ?? [])];
}

function readDerLength(bytes: Buffer, offset: number) {
  const first = bytes[offset];
  if (first === undefined) {
    throw new Error("Invalid DER signature.");
  }
  if (first < 0x80) {
    return { length: first, offset: offset + 1 };
  }
  const byteCount = first & 0x7f;
  let length = 0;
  for (let index = 0; index < byteCount; index += 1) {
    const next = bytes[offset + 1 + index];
    if (next === undefined) {
      throw new Error("Invalid DER signature.");
    }
    length = (length << 8) + next;
  }
  return { length, offset: offset + 1 + byteCount };
}

function readDerInteger(bytes: Buffer, offset: number) {
  if (bytes[offset] !== 0x02) {
    throw new Error("Invalid DER ECDSA signature.");
  }
  const length = readDerLength(bytes, offset + 1);
  const value = bytes.subarray(length.offset, length.offset + length.length);
  return { value, offset: length.offset + length.length };
}

function derEcdsaToJose(signature: Buffer, alg: UcpBusinessSigningAlgorithm) {
  if (signature[0] !== 0x30) {
    throw new Error("Invalid DER ECDSA signature.");
  }
  const sequence = readDerLength(signature, 1);
  const r = readDerInteger(signature, sequence.offset);
  const s = readDerInteger(signature, r.offset);
  const partLength = ECDSA_SIGNATURE_LENGTHS[alg] / 2;
  return Buffer.concat([leftPadUnsignedInteger(r.value, partLength), leftPadUnsignedInteger(s.value, partLength)]);
}

function leftPadUnsignedInteger(bytes: Buffer, length: number) {
  const normalized = bytes[0] === 0 ? bytes.subarray(1) : bytes;
  if (normalized.length > length) {
    return normalized.subarray(normalized.length - length);
  }
  if (normalized.length === length) {
    return normalized;
  }
  return Buffer.concat([Buffer.alloc(length - normalized.length), normalized]);
}

export function signUcpAp2MerchantAuthorization(
  checkout: Readonly<Record<string, unknown>>,
  keys: UcpBusinessSigningKeySet,
) {
  const header = {
    alg: keys.current.alg,
    kid: keys.current.kid,
  };
  const encodedHeader = base64Url(JSON.stringify(header));
  const canonicalPayload = canonicalizeJson(checkoutPayloadForMerchantAuthorization(checkout));
  const signingInput = `${encodedHeader}.${base64Url(canonicalPayload)}`;
  const privateKey: KeyObject = createPrivateKey({
    key: keys.current.privateJwk,
    format: "jwk",
  });
  const derSignature = createSign(ECDSA_HASH_ALGORITHMS[keys.current.alg]).update(signingInput).end().sign(privateKey);
  return `${encodedHeader}..${base64Url(derEcdsaToJose(derSignature, keys.current.alg))}`;
}

export function addUcpAp2MerchantAuthorization(
  checkout: Readonly<Record<string, unknown>>,
  keys: UcpBusinessSigningKeySet | undefined,
) {
  if (!keys) {
    return checkout;
  }
  const unsigned = checkoutPayloadForMerchantAuthorization(checkout);
  const authorization = signUcpAp2MerchantAuthorization(unsigned, keys);
  return {
    ...unsigned,
    ap2: {
      ...readObject(checkout.ap2),
      merchant_authorization: authorization,
    },
  };
}

function buildBusinessProfile(origin: string, keys: UcpBusinessSigningKeySet | undefined): UcpBusinessProfile {
  return buildUcpBusinessProfile(origin, {
    signingKeys: publicUcpBusinessSigningKeys(keys),
  });
}

async function verifyHttpMessageSignature(request: Request, options: UcpSignatureVerificationOptions | undefined) {
  if (!options) {
    return null;
  }

  const agentProfileUrl = ucpAgentProfileUrl(request);
  if (!agentProfileUrl) {
    return "UCP-Agent must contain a profile URL.";
  }

  const input = parseSignatureInput(request);
  if (!input?.keyId) {
    return "Signature-Input must include keyid.";
  }

  const coverageFailure = validateSignatureInputCoverage(request, input, options);
  if (coverageFailure) {
    return coverageFailure;
  }

  const signature = parseSignature(request, input.label);
  if (!signature) {
    return "Signature header did not include the declared signature label.";
  }

  const jwk = await options.keyResolver(agentProfileUrl, input.keyId);
  if (!jwk) {
    return "No signing key matched the UCP-Agent profile and Signature-Input keyid.";
  }

  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const base = signatureBase(request, input.components, input.params);
    const verified = verifySignatureBytes(publicKeyAlgorithm(jwk), Buffer.from(base), key, signature);
    return verified ? null : "HTTP Message Signature verification failed.";
  } catch (error) {
    return error instanceof Error ? error.message : "HTTP Message Signature verification failed.";
  }
}

function idempotencyKey(request: Request) {
  return request.headers.get("Idempotency-Key")?.trim() ?? "";
}

function missingIdempotencyKey(request: Request) {
  return !idempotencyKey(request);
}

function unsupported(operation: string) {
  return unsupportedUcpOperation(operation);
}

async function invokeRestHandler(
  handlers: CreateUcpRoutesOptions["restHandlers"],
  operation: string,
  input: UcpOperationHandlerInput,
) {
  return handlers?.[operation]?.(input) ?? unsupported(operation);
}

async function signedWriteOrJsonError(request: Request) {
  const reason = await signedWriteFailure(request);
  return reason
    ? createUcpEnvelope("error", {}, [
        {
          severity: "error",
          code: "signed_request_required",
          message: reason,
        },
      ])
    : null;
}

function idempotencyRequiredEnvelope(operation: string) {
  return createUcpEnvelope("error", {}, [
    {
      severity: "error",
      code: "idempotency_key_required",
      message: `Idempotency-Key is required for ${operation}.`,
    },
  ]);
}

function idempotencyConflictEnvelope() {
  return createUcpEnvelope("error", {}, [
    {
      severity: "error",
      code: "idempotency_key_conflict",
      message: "Idempotency-Key was already used with different request parameters.",
    },
  ]);
}

function idempotencyInProgressEnvelope() {
  return createUcpEnvelope("error", {}, [
    {
      severity: "warning",
      code: "idempotency_key_in_progress",
      message: "A matching request is already in progress. Retry later.",
    },
  ]);
}

function shouldStoreIdempotencyResponse(response: UcpEnvelope): boolean {
  return response.ucp.status === "ok" || response.ucp.status === "requires_action";
}

function createMemoryUcpIdempotencyStore(): UcpIdempotencyStore {
  return createMemoryPlatformIdempotencyStore<UcpEnvelope>();
}

function isUcpTestRuntime() {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function resolveUcpIdempotencyStore(options: CreateUcpRoutesOptions, transport: "REST" | "MCP"): UcpIdempotencyStore {
  if (options.idempotencyStore) {
    return options.idempotencyStore;
  }

  if (
    isUcpTestRuntime() ||
    (options.allowInMemoryIdempotencyStoreForTests === true && process.env.NODE_ENV !== "production")
  ) {
    return createMemoryUcpIdempotencyStore();
  }

  throw new Error(
    `${transport} UCP routes require a durable idempotencyStore. Bootstrap platformUcpRuntimeSchemaSql and pass createPostgresUcpIdempotencyStore(...) for production mounts; allowInMemoryIdempotencyStoreForTests is only for isolated tests.`,
  );
}

export function createPostgresUcpIdempotencyStore<TResponse = UcpEnvelope>(
  db: PgQueryable,
  options: Readonly<{
    retentionMs?: number;
    pendingTtlMs?: number;
    now?: () => Date;
  }> = {},
): PlatformIdempotencyStore<TResponse> {
  const pendingTtlMs = options.pendingTtlMs ?? 2 * 60 * 1000;
  return {
    get: async (key) => {
      const result = await db.query<{
        key: string;
        request_hash: string;
        response: TResponse | null;
        status: string;
        created_at: Date | string;
        expires_at: Date | string | null;
      }>(
        `SELECT key, request_hash, response, status, created_at, expires_at
         FROM platform_ucp_idempotency_records
         WHERE key = $1
           AND (expires_at IS NULL OR expires_at > now())`,
        [key],
      );
      const row = result.rows[0];
      return row
        ? {
            key: row.key,
            requestHash: row.request_hash,
            response: row.response as TResponse | null,
            status: row.status === "pending" ? "pending" : "completed",
            createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
            expiresAt:
              row.expires_at instanceof Date
                ? row.expires_at.toISOString()
                : row.expires_at
                  ? String(row.expires_at)
                  : null,
          }
        : null;
    },
    reserve: async (input) => {
      const pendingExpiresAt =
        input.expiresAt ?? new Date(new Date(input.createdAt).getTime() + pendingTtlMs).toISOString();
      const reserved = await db.query<{
        key: string;
        request_hash: string;
        response: TResponse | null;
        status: string;
        created_at: Date | string;
        expires_at: Date | string | null;
      }>(
        `INSERT INTO platform_ucp_idempotency_records (
           key,
           request_hash,
           response,
           status,
           created_at,
           expires_at,
           updated_at
         ) VALUES ($1, $2, NULL, 'pending', $3::timestamptz, $4::timestamptz, now())
         ON CONFLICT (key) DO UPDATE
         SET request_hash = EXCLUDED.request_hash,
             response = NULL,
             status = 'pending',
             created_at = EXCLUDED.created_at,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()
         WHERE platform_ucp_idempotency_records.status = 'pending'
           AND platform_ucp_idempotency_records.expires_at IS NOT NULL
           AND platform_ucp_idempotency_records.expires_at <= now()
         RETURNING key, request_hash, response, status, created_at, expires_at`,
        [input.key, input.requestHash, input.createdAt, pendingExpiresAt],
      );
      const reservedRow = reserved.rows[0];
      if (reservedRow) {
        return {
          outcome: "reserved" as const,
          record: toIdempotencyRecord<TResponse>(reservedRow),
        };
      }

      const existing = await db.query<{
        key: string;
        request_hash: string;
        response: TResponse | null;
        status: string;
        created_at: Date | string;
        expires_at: Date | string | null;
      }>(
        `SELECT key, request_hash, response, status, created_at, expires_at
         FROM platform_ucp_idempotency_records
         WHERE key = $1
           AND (expires_at IS NULL OR expires_at > now())`,
        [input.key],
      );
      const record = existing.rows[0] ? toIdempotencyRecord<TResponse>(existing.rows[0]) : null;
      if (!record) {
        return {
          outcome: "pending" as const,
          record: {
            key: input.key,
            requestHash: input.requestHash,
            response: null,
            status: "pending" as const,
            createdAt: input.createdAt,
            expiresAt: pendingExpiresAt,
          },
        };
      }
      if (record.requestHash !== input.requestHash) {
        return { outcome: "conflict" as const, record };
      }
      return { outcome: record.status === "completed" ? "completed" : "pending", record } as const;
    },
    complete: async (record) => {
      const createdAt = new Date(record.createdAt);
      const expiresAt =
        record.expiresAt ??
        (options.retentionMs ? new Date(createdAt.getTime() + options.retentionMs).toISOString() : null);
      const result = await db.query(
        `UPDATE platform_ucp_idempotency_records
         SET response = $3::jsonb,
             status = 'completed',
             expires_at = $4::timestamptz,
             updated_at = now()
         WHERE key = $1
           AND request_hash = $2
           AND status = 'pending'`,
        [record.key, record.requestHash, JSON.stringify(record.response), expiresAt],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new Error("Idempotency reservation was not pending when completion was recorded.");
      }
    },
    abandon: async (input) => {
      await db.query(
        `DELETE FROM platform_ucp_idempotency_records
         WHERE key = $1
           AND request_hash = $2
           AND status = 'pending'`,
        [input.key, input.requestHash],
      );
    },
    put: async (record) => {
      const createdAt = new Date(record.createdAt);
      const expiresAt =
        record.expiresAt ??
        (options.retentionMs ? new Date(createdAt.getTime() + options.retentionMs).toISOString() : null);
      await db.query(
        `INSERT INTO platform_ucp_idempotency_records (
           key,
           request_hash,
           response,
           status,
           created_at,
           expires_at,
           updated_at
         ) VALUES ($1, $2, $3::jsonb, 'completed', $4::timestamptz, $5::timestamptz, now())
         ON CONFLICT (key) DO NOTHING`,
        [record.key, record.requestHash, JSON.stringify(record.response), record.createdAt, expiresAt],
      );
    },
    pruneExpired: async (now = options.now?.() ?? new Date()) => {
      const result = await db.query(
        `DELETE FROM platform_ucp_idempotency_records
         WHERE expires_at IS NOT NULL
           AND expires_at <= $1::timestamptz`,
        [now.toISOString()],
      );
      return result.rowCount ?? 0;
    },
  };
}

function toIdempotencyRecord<TResponse>(row: {
  key: string;
  request_hash: string;
  response: TResponse | null;
  status: string;
  created_at: Date | string;
  expires_at: Date | string | null;
}): PlatformIdempotencyRecord<TResponse> {
  return {
    key: row.key,
    requestHash: row.request_hash,
    response: row.response,
    status: row.status === "pending" ? "pending" : "completed",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    expiresAt:
      row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at ? String(row.expires_at) : null,
  };
}

export function createUcpProfileKeyResolver(options: UcpProfileCacheOptions): UcpSignatureKeyResolver {
  return async (profileUrl, keyId) => {
    const profile = await resolveCachedUcpProfile(options, profileUrl);
    return findProfileSigningKey(profile, keyId);
  };
}

async function resolveCachedUcpProfile(options: UcpProfileCacheOptions, profileUrl: string) {
  const now = options.now?.() ?? new Date();
  const cached = await options.db.query<{
    profile: unknown;
    expires_at: Date | string;
  }>(
    `SELECT profile, expires_at
     FROM platform_ucp_agent_profiles
     WHERE profile_url = $1`,
    [profileUrl],
  );
  const cachedRow = cached.rows[0];
  const cachedExpiresAt = cachedRow ? new Date(cachedRow.expires_at).getTime() : 0;
  if (cachedRow && cachedExpiresAt > now.getTime()) {
    return readObject(cachedRow.profile) ?? {};
  }

  try {
    const response = await (options.fetch ?? globalThis.fetch)(profileUrl, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`UCP profile fetch failed with status ${response.status}.`);
    }
    const profile = readObject(await response.json()) ?? {};
    const fetchedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_PROFILE_CACHE_TTL_MS)).toISOString();
    await options.db.query(
      `INSERT INTO platform_ucp_agent_profiles (
         profile_url,
         profile,
         fetched_at,
         expires_at,
         last_error,
         updated_at
       ) VALUES ($1, $2::jsonb, $3::timestamptz, $4::timestamptz, NULL, now())
       ON CONFLICT (profile_url) DO UPDATE
       SET profile = EXCLUDED.profile,
           fetched_at = EXCLUDED.fetched_at,
           expires_at = EXCLUDED.expires_at,
           last_error = NULL,
           updated_at = EXCLUDED.updated_at`,
      [profileUrl, JSON.stringify(profile), fetchedAt, expiresAt],
    );
    return profile;
  } catch (error) {
    await options.db.query(
      `INSERT INTO platform_ucp_agent_profiles (
         profile_url,
         profile,
         fetched_at,
         expires_at,
         last_error,
         updated_at
       ) VALUES ($1, '{}'::jsonb, now(), now(), $2, now())
       ON CONFLICT (profile_url) DO UPDATE
       SET last_error = EXCLUDED.last_error,
           updated_at = EXCLUDED.updated_at`,
      [profileUrl, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  }
}

function findProfileSigningKey(profile: Readonly<Record<string, unknown>>, keyId: string) {
  const keys = [...readArray(profile.signing_keys), ...readArray(readObject(profile.ucp)?.signing_keys)];
  for (const entry of keys) {
    const key = readObject(entry);
    if (!key || key.kid !== keyId) {
      continue;
    }
    return key as JsonWebKey;
  }
  return null;
}

function idempotencyScope(operation: string, request: Request, actor: ResolvedActor | null) {
  return [
    operation,
    actor?.tenantId ?? "anonymous",
    actor?.accountId ?? "anonymous",
    request.headers.get("UCP-Agent")?.trim() ?? "unknown-agent",
    idempotencyKey(request),
  ].join(":");
}

async function invokeRestWrite(
  c: Context<UcpRuntimeEnv>,
  options: CreateUcpRoutesOptions,
  operation: string,
  params: Readonly<Record<string, string>>,
  idempotencyStore: UcpIdempotencyStore,
) {
  const failure = await signedWriteOrJsonError(c.req.raw);
  if (failure) {
    emitObserver(options.observer?.signedWriteRejected, {
      transport: "rest",
      operation,
      reason: failure.messages?.[0]?.message ?? "Signed write rejected.",
      agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
    });
    return c.json(failure, 400);
  }

  const signatureFailure = await verifyHttpMessageSignature(c.req.raw, options.signatureVerification);
  if (signatureFailure) {
    emitObserver(options.observer?.signatureVerificationFailed, {
      transport: "rest",
      operation,
      reason: signatureFailure,
      agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
    });
    return c.json(
      createUcpEnvelope("error", {}, [
        {
          severity: "error",
          code: "signed_request_required",
          message: signatureFailure,
        },
      ]),
      400,
    );
  }

  if (missingIdempotencyKey(c.req.raw)) {
    return c.json(idempotencyRequiredEnvelope(operation), 400);
  }

  const rateLimit = enforceAgentGrantRateLimit(c, options, operation);
  if (rateLimit) {
    return c.json(rateLimit, 429);
  }

  const input = handlerInput(c, params);
  const key = idempotencyScope(operation, c.req.raw, input.actor);
  const requestHash = await requestBodyHash(c.req.raw);
  const createdAt = new Date();
  const reservation = await idempotencyStore.reserve({
    key,
    requestHash,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + IDEMPOTENCY_PENDING_TTL_MS).toISOString(),
  });
  if (reservation.outcome === "completed") {
    if (reservation.record.response) {
      emitObserver(options.observer?.idempotencyReplayed, {
        transport: "rest",
        operation,
        key,
        agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
      });
      return c.json(reservation.record.response);
    }
  }
  if (reservation.outcome === "pending") {
    return c.json(idempotencyInProgressEnvelope(), 409);
  }
  if (reservation.outcome === "conflict") {
    emitObserver(options.observer?.idempotencyConflict, {
      transport: "rest",
      operation,
      key,
      agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
    });
    return c.json(idempotencyConflictEnvelope(), 409);
  }
  const reservedRecord = reservation.record;

  let response: UcpEnvelope;
  try {
    response = await invokeRestHandler(options.restHandlers, operation, input);
    if (shouldStoreIdempotencyResponse(response)) {
      await idempotencyStore.complete({
        ...reservedRecord,
        response,
      });
    } else {
      await idempotencyStore.abandon({ key, requestHash });
    }
  } catch (error) {
    await idempotencyStore.abandon({ key, requestHash });
    throw error;
  }
  emitObserver(options.observer?.operationCompleted, {
    transport: "rest",
    operation,
    status: response.ucp.status,
    agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
  });
  return c.json(response);
}

async function invokeMcpTool(
  c: Context<UcpRuntimeEnv>,
  options: CreateUcpRoutesOptions,
  tool: UcpMcpToolDescriptor,
  args: Readonly<Record<string, unknown>>,
  idempotencyStore: UcpIdempotencyStore,
) {
  const toolName = tool.name;
  const rateLimit = enforceAgentGrantRateLimit(c, options, toolName);
  if (rateLimit) {
    return rateLimit;
  }

  const input: UcpOperationHandlerInput = {
    actor: c.get("actor") ?? null,
    context: c.get("context") ?? null,
    arguments: args,
    request: c.req.raw,
    params: {},
  };
  const key = idempotencyScope(toolName, c.req.raw, input.actor);
  const requestHash = mcpToolRequestHash(toolName, args);
  const createdAt = new Date();
  const reservation = await idempotencyStore.reserve({
    key,
    requestHash,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + IDEMPOTENCY_PENDING_TTL_MS).toISOString(),
  });
  if (reservation.outcome === "completed") {
    if (reservation.record.response) {
      emitObserver(options.observer?.idempotencyReplayed, {
        transport: "mcp",
        operation: toolName,
        key,
        agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
      });
      return reservation.record.response;
    }
  }
  if (reservation.outcome === "pending") {
    return idempotencyInProgressEnvelope();
  }
  if (reservation.outcome === "conflict") {
    emitObserver(options.observer?.idempotencyConflict, {
      transport: "mcp",
      operation: toolName,
      key,
      agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
    });
    return idempotencyConflictEnvelope();
  }
  const reservedRecord = reservation.record;

  const limit = await acquireUcpMcpToolCallLease(c, options, tool);
  if (!limit.allowed) {
    await idempotencyStore.abandon({ key, requestHash });
    return ucpMcpToolLimitEnvelope(limit.reason);
  }

  try {
    const response = await (options.mcpToolHandlers?.[toolName]?.(input) ?? unsupported(toolName));
    if (shouldStoreIdempotencyResponse(response)) {
      await idempotencyStore.complete({
        ...reservedRecord,
        response,
      });
    } else {
      await idempotencyStore.abandon({ key, requestHash });
    }
    emitObserver(options.observer?.operationCompleted, {
      transport: "mcp",
      operation: toolName,
      status: response.ucp.status,
      agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
    });
    return response;
  } catch (error) {
    await idempotencyStore.abandon({ key, requestHash });
    throw error;
  } finally {
    await Promise.resolve(limit.lease?.release()).catch(() => undefined);
  }
}

function ucpMcpToolLimitKind(tool: UcpMcpToolDescriptor): McpToolCallLimitKind {
  return tool.idempotencyKeyRequired ? "write" : "read";
}

async function acquireUcpMcpToolCallLease(
  c: Context<UcpRuntimeEnv>,
  options: CreateUcpRoutesOptions,
  tool: UcpMcpToolDescriptor,
): Promise<
  | Readonly<{
      allowed: true;
      lease?: McpToolCallLease;
      limitKind: McpToolCallLimitKind;
    }>
  | Readonly<{
      allowed: false;
      reason: string;
      limitKind: McpToolCallLimitKind;
    }>
> {
  const limitKind = ucpMcpToolLimitKind(tool);
  const actor = c.get("actor") ?? null;
  if (!options.mcpToolCallLimiter) {
    return { allowed: true, limitKind };
  }

  try {
    const result = await options.mcpToolCallLimiter.acquire({
      transport: "ucp-mcp",
      toolName: tool.name,
      limitKind,
      grantId: agentGrantIdFromActor(actor),
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
      clientAddress: resolveClientAddress(c.req.raw),
    });

    if (result.allowed) {
      return { allowed: true, lease: result.lease, limitKind };
    }

    emitUcpToolCallLimited(c, options, tool, limitKind, result.reason);
    return { allowed: false, reason: result.reason, limitKind };
  } catch {
    const reason = "UCP MCP tool call limiter is unavailable.";
    emitUcpToolCallLimited(c, options, tool, limitKind, reason);
    return { allowed: false, reason, limitKind };
  }
}

function emitUcpToolCallLimited(
  c: Context<UcpRuntimeEnv>,
  options: CreateUcpRoutesOptions,
  tool: UcpMcpToolDescriptor,
  limitKind: McpToolCallLimitKind,
  reason: string,
) {
  const actor = c.get("actor") ?? null;
  emitObserver(options.observer?.toolCallLimited, {
    transport: "mcp",
    operation: tool.name,
    reason,
    limitKind,
    actorId: actor?.userId ?? null,
    accountId: actor?.accountId ?? null,
    agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
  });
}

function enforceAgentGrantRateLimit(
  c: Context<UcpRuntimeEnv>,
  options: Pick<CreateUcpRoutesOptions, "agentGrantRateLimiter" | "observer">,
  operation: string,
) {
  const actor = c.get("actor") ?? null;
  const grantId = agentGrantIdFromActor(actor);
  if (!options.agentGrantRateLimiter || !grantId) {
    return null;
  }

  const decision = options.agentGrantRateLimiter.check({
    grantId,
    accountId: actor?.accountId ?? null,
    actorId: actor?.userId ?? null,
    operation,
  });
  if (decision.allowed) {
    return null;
  }

  const violation = {
    kind: "rate-limit" as const,
    grantId,
    accountId: actor?.accountId ?? null,
    operation,
    reason: decision.reason,
    evidence: {
      retryAfterSeconds: decision.decision.retryAfterSeconds,
      limit: decision.decision.limit,
      resetAt: new Date(decision.decision.resetAt).toISOString(),
    },
  };
  emitObserver(options.observer?.agentGuardrailTriggered, violation);
  return createUcpEnvelope("error", {}, [
    {
      severity: "error",
      code: "agent_grant_rate_limited",
      message: decision.reason,
    },
  ]);
}

function ucpMcpToolLimitEnvelope(reason: string) {
  return createUcpEnvelope("error", {}, [
    {
      severity: "error",
      code: "tool_call_limited",
      message: reason,
    },
  ]);
}

export function createUcpProfileRoutes(options: Pick<CreateUcpRoutesOptions, "businessSigningKeys"> = {}) {
  const app = new Hono();

  app.get("/ucp", (c) => c.json(buildBusinessProfile(requestOrigin(c.req.raw), options.businessSigningKeys)));

  return app;
}

export function createUcpRestRoutes(options: CreateUcpRoutesOptions = {}) {
  const app = new Hono<UcpRuntimeEnv>();
  const idempotencyStore = resolveUcpIdempotencyStore(options, "REST");

  app.get("/", (c) => c.json(buildBusinessProfile(requestOrigin(c.req.raw), options.businessSigningKeys)));

  app.post("/catalog/search", async (c) =>
    c.json(await invokeRestHandler(options.restHandlers, "search_catalog", handlerInput(c, {}))),
  );
  app.post("/catalog/lookup", async (c) =>
    c.json(await invokeRestHandler(options.restHandlers, "lookup_catalog", handlerInput(c, {}))),
  );
  app.post("/catalog/product", async (c) =>
    c.json(await invokeRestHandler(options.restHandlers, "get_product", handlerInput(c, {}))),
  );

  app.post("/checkout-sessions", async (c) => invokeRestWrite(c, options, "create_checkout", {}, idempotencyStore));
  app.get("/checkout-sessions/:id", async (c) =>
    c.json(await invokeRestHandler(options.restHandlers, "get_checkout", handlerInput(c, { id: c.req.param("id") }))),
  );
  app.put("/checkout-sessions/:id", async (c) =>
    invokeRestWrite(c, options, "update_checkout", { id: c.req.param("id") }, idempotencyStore),
  );
  app.post("/checkout-sessions/:id/complete", async (c) =>
    invokeRestWrite(c, options, "complete_checkout", { id: c.req.param("id") }, idempotencyStore),
  );
  app.post("/checkout-sessions/:id/cancel", async (c) =>
    invokeRestWrite(c, options, "cancel_checkout", { id: c.req.param("id") }, idempotencyStore),
  );
  app.get("/orders/:id", async (c) =>
    c.json(await invokeRestHandler(options.restHandlers, "get_order", handlerInput(c, { id: c.req.param("id") }))),
  );

  return app;
}

export function createUcpMcpRoutes(options: CreateUcpRoutesOptions = {}) {
  const app = new Hono<UcpRuntimeEnv>();
  const idempotencyStore = resolveUcpIdempotencyStore(options, "MCP");

  app.post("/", async (c) => {
    const body = (await c.req.raw
      .clone()
      .json()
      .catch(() => null)) as JsonRpcRequest | readonly unknown[] | null;
    if (Array.isArray(body)) {
      return c.json(jsonRpcError(null, -32600, "JSON-RPC batch requests are not supported."), 400);
    }
    if (!body || typeof body !== "object") {
      return c.json(jsonRpcError(null, -32600, "Invalid JSON-RPC request."), 400);
    }

    const request = body as JsonRpcRequest;
    if (request.jsonrpc !== JSON_RPC_VERSION) {
      return c.json(jsonRpcError(null, -32600, "Invalid JSON-RPC request."), 400);
    }

    if (request.method === "initialize") {
      return c.json(
        jsonRpcResult(request.id, {
          protocolVersion: negotiateMcpProtocolVersion(request.params, MCP_LEGACY_PROTOCOL_VERSIONS),
          serverInfo: {
            name: "chase-sets-ucp",
            title: "Chase Sets UCP",
            version: "0.1.0",
          },
          capabilities: {
            tools: {},
            resources: {},
          },
        }),
      );
    }

    if (request.method === "tools/list") {
      return c.json(
        jsonRpcResult(request.id, {
          tools: UCP_MCP_TOOLS.map(toMcpToolListItem),
        }),
      );
    }

    if (request.method === "resources/list") {
      return c.json(
        jsonRpcResult(request.id, {
          resources: UCP_MCP_RESOURCES.map(toMcpResourceListItem),
        }),
      );
    }

    if (request.method === "tools/call") {
      const params = normalizeArguments(request.params) as UcpToolCallParams;
      const toolName = typeof params.name === "string" ? params.name : "";
      const tool = UCP_MCP_TOOLS.find((candidate) => candidate.name === toolName);
      if (!tool) {
        return c.json(jsonRpcError(request.id, -32602, `Unknown UCP MCP tool '${toolName}'.`));
      }

      const args = normalizeArguments(params.arguments);
      if (tool.idempotencyKeyRequired) {
        const signedFailure = await signedWriteFailure(c.req.raw);
        if (signedFailure) {
          if (tool.trustedHandoffOnUnsignedMcp && c.get("actor")) {
            return c.json(jsonRpcResult(request.id, toolResult(tool, unsignedMcpTrustedHandoff(tool, args))));
          }
          emitObserver(options.observer?.signedWriteRejected, {
            transport: "mcp",
            operation: tool.name,
            reason: signedFailure,
            agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
          });
          return c.json(jsonRpcError(request.id, -32602, signedFailure));
        }
        const signatureFailure = await verifyHttpMessageSignature(c.req.raw, options.signatureVerification);
        if (signatureFailure) {
          emitObserver(options.observer?.signatureVerificationFailed, {
            transport: "mcp",
            operation: tool.name,
            reason: signatureFailure,
            agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
          });
          return c.json(jsonRpcError(request.id, -32602, signatureFailure));
        }

        if (missingIdempotencyKey(c.req.raw)) {
          return c.json(jsonRpcError(request.id, -32602, `Idempotency-Key is required for ${tool.name}.`));
        }
      }

      const result = tool.idempotencyKeyRequired
        ? await invokeMcpTool(c, options, tool, args, idempotencyStore)
        : await invokeNonIdempotentMcpTool(c, options, tool, args);

      if (
        tool.idempotencyKeyRequired &&
        result.messages?.some((message) => message.code === "idempotency_key_conflict")
      ) {
        return c.json(
          jsonRpcError(request.id, -32000, "Idempotency-Key was already used with different request parameters."),
        );
      }
      if (
        tool.idempotencyKeyRequired &&
        result.messages?.some((message) => message.code === "idempotency_key_in_progress")
      ) {
        return c.json(jsonRpcError(request.id, -32029, "A matching request is already in progress. Retry later."));
      }

      return c.json(jsonRpcResult(request.id, toolResult(tool, result)));
    }

    if (request.method === "resources/read") {
      const params = normalizeResourceReadParams(request.params);
      const uri = typeof params.uri === "string" ? params.uri : "";
      const result = readUcpMcpResource(uri);
      if (!result) {
        return c.json(jsonRpcError(request.id, -32602, `Unknown UCP MCP resource '${uri}'.`));
      }

      return c.json(jsonRpcResult(request.id, result));
    }

    return c.json(jsonRpcError(request.id, -32601, `Unsupported UCP MCP method '${request.method ?? ""}'.`));
  });

  return app;
}

async function invokeNonIdempotentMcpTool(
  c: Context<UcpRuntimeEnv>,
  options: CreateUcpRoutesOptions,
  tool: UcpMcpToolDescriptor,
  args: Readonly<Record<string, unknown>>,
) {
  const limit = await acquireUcpMcpToolCallLease(c, options, tool);
  if (!limit.allowed) {
    return ucpMcpToolLimitEnvelope(limit.reason);
  }

  try {
    return await (options.mcpToolHandlers?.[tool.name]?.({
      actor: c.get("actor") ?? null,
      context: c.get("context") ?? null,
      arguments: args,
      request: c.req.raw,
      params: {},
    }) ?? unsupported(tool.name));
  } finally {
    await Promise.resolve(limit.lease?.release()).catch(() => undefined);
  }
}

function handlerInput(c: Context<UcpRuntimeEnv>, params: Readonly<Record<string, string>>): UcpOperationHandlerInput {
  return {
    actor: c.get("actor") ?? null,
    context: c.get("context") ?? null,
    arguments: {},
    request: c.req.raw,
    params,
  };
}
