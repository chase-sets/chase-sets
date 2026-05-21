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
  buildUcpBusinessProfile,
  createUcpEnvelope,
  UCP_MCP_MARKETPLACE_RESULTS_RESOURCE_URI,
  UCP_MCP_RESOURCES,
  UCP_MCP_APP_RESOURCE_MIME_TYPE,
  UCP_MCP_TOOLS,
  unsupportedUcpOperation,
  type UcpBusinessProfile,
  type UcpEnvelope,
  type UcpMcpResourceDescriptor,
  type UcpMcpToolDescriptor,
} from "@chase-sets/ucp";
import type { ResolvedActor } from "./auth";

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

export type UcpIdempotencyRecord = Readonly<{
  key: string;
  requestHash: string;
  response: UcpEnvelope;
  createdAt: string;
  expiresAt?: string | null;
}>;

export type UcpIdempotencyStore = Readonly<{
  get: (key: string) => Promise<UcpIdempotencyRecord | null> | UcpIdempotencyRecord | null;
  put: (record: UcpIdempotencyRecord) => Promise<void> | void;
  pruneExpired?: (now?: Date) => Promise<number> | number;
}>;

export type UcpSignatureKeyResolver = (
  profileUrl: string,
  keyId: string,
) => Promise<JsonWebKey | null> | JsonWebKey | null;

export type UcpSignatureVerificationOptions = Readonly<{
  keyResolver: UcpSignatureKeyResolver;
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

export type CreateUcpRoutesOptions = Readonly<{
  restHandlers?: Readonly<Record<string, UcpOperationHandler>>;
  mcpToolHandlers?: Readonly<Record<string, UcpOperationHandler>>;
  idempotencyStore?: UcpIdempotencyStore;
  signatureVerification?: UcpSignatureVerificationOptions;
  businessSigningKeys?: UcpBusinessSigningKeySet;
  observer?: UcpRuntimeObserver;
}>;

const JSON_RPC_VERSION = "2.0";

const SIGNED_WRITE_HEADERS = ["Signature-Input", "Signature", "Content-Digest", "UCP-Agent"] as const;

const DEFAULT_PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;
const UCP_MCP_MARKETPLACE_RESULTS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chase Sets Marketplace Results</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 12px; background: transparent; color: CanvasText; }
    .results { display: grid; gap: 10px; }
    .card { display: grid; grid-template-columns: 72px 1fr; gap: 10px; align-items: center; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 10px; background: color-mix(in srgb, Canvas 96%, CanvasText 4%); }
    .image { width: 72px; height: 96px; object-fit: cover; border-radius: 6px; background: color-mix(in srgb, CanvasText 12%, transparent); }
    .title { margin: 0; font-size: 15px; font-weight: 700; line-height: 1.25; }
    .meta { margin: 3px 0 0; font-size: 12px; color: color-mix(in srgb, CanvasText 70%, transparent); line-height: 1.35; }
    .signals { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .signal { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 999px; padding: 3px 8px; font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .action { color: LinkText; font-weight: 650; font-size: 13px; text-decoration: none; }
    .empty { border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 14px; font-size: 14px; }
  </style>
</head>
<body>
  <main id="app" class="results" aria-live="polite"></main>
  <script>
    const app = document.getElementById("app");
    let latestResult = null;

    function productImage(product) {
      const chaseSets = product?.extensions?.chase_sets ?? {};
      return chaseSets.primary_image_url || product?.image_urls?.[0] || "";
    }

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
        const image = productImage(product);
        const href = productUrl(product);
        const market = chaseSets.marketplace ?? {};
        const price = chaseSets.price_display ?? "Not currently listed";
        const availability = chaseSets.availability_display ?? "Unavailable";
        const subtitle = product.subtitle || product.description || "";
        return '<article class="card">' +
          (image ? '<img class="image" src="' + escapeHtml(image) + '" alt="">' : '<div class="image"></div>') +
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
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_ucp_idempotency_records
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;

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
`;

function requestOrigin(request: Request) {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim() || url.host;

  const protocol =
    forwardedProto || (url.protocol === "http:" && isPublicHostname(host) ? "https" : url.protocol.slice(0, -1));

  return `${protocol}://${host}`;
}

function isPublicHostname(host: string) {
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return false;
  }

  if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) {
    return false;
  }

  const private172Match = /^172\.(\d+)\./.exec(hostname);
  if (private172Match) {
    const secondOctet = Number.parseInt(private172Match[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return false;
    }
  }

  return hostname.includes(".");
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
  if (uri !== UCP_MCP_MARKETPLACE_RESULTS_RESOURCE_URI) {
    return null;
  }

  return {
    contents: [
      {
        uri,
        mimeType: UCP_MCP_APP_RESOURCE_MIME_TYPE,
        text: UCP_MCP_MARKETPLACE_RESULTS_HTML,
        _meta: {
          ui: {
            preferredBorder: true,
          },
          "openai/widgetDescription": "Interactive Chase Sets marketplace search results.",
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
  const components = [...match[2].matchAll(/"([^"]+)"/g)].map((entry) => entry[1].toLowerCase());

  return {
    label: match[1],
    components,
    params: `(${match[2]})${params}`,
    keyId,
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
      return `${url.pathname}${url.search}`;
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

function createMemoryUcpIdempotencyStore(): UcpIdempotencyStore {
  const records = new Map<string, UcpIdempotencyRecord>();
  return {
    get: (key) => {
      const record = records.get(key);
      if (!record) {
        return null;
      }
      if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
        records.delete(key);
        return null;
      }
      return record;
    },
    put: (record) => {
      records.set(record.key, record);
    },
    pruneExpired: (now = new Date()) => {
      let deletedCount = 0;
      for (const [key, record] of records) {
        if (record.expiresAt && new Date(record.expiresAt).getTime() <= now.getTime()) {
          records.delete(key);
          deletedCount += 1;
        }
      }
      return deletedCount;
    },
  };
}

export function createPostgresUcpIdempotencyStore(
  db: PgQueryable,
  options: Readonly<{
    retentionMs?: number;
    now?: () => Date;
  }> = {},
): UcpIdempotencyStore {
  return {
    get: async (key) => {
      const result = await db.query<{
        key: string;
        request_hash: string;
        response: UcpEnvelope;
        created_at: Date | string;
        expires_at: Date | string | null;
      }>(
        `SELECT key, request_hash, response, created_at, expires_at
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
            response: row.response,
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
           created_at,
           expires_at,
           updated_at
         ) VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz, now())
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

  const input = handlerInput(c, params);
  const key = idempotencyScope(operation, c.req.raw, input.actor);
  const requestHash = await requestBodyHash(c.req.raw);
  const existing = await idempotencyStore.get(key);
  if (existing) {
    if (existing.requestHash === requestHash) {
      emitObserver(options.observer?.idempotencyReplayed, {
        transport: "rest",
        operation,
        key,
        agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
      });
      return c.json(existing.response);
    }
    emitObserver(options.observer?.idempotencyConflict, {
      transport: "rest",
      operation,
      key,
      agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
    });
    return c.json(idempotencyConflictEnvelope(), 409);
  }

  const response = await invokeRestHandler(options.restHandlers, operation, input);
  await idempotencyStore.put({
    key,
    requestHash,
    response,
    createdAt: new Date().toISOString(),
  });
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
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  idempotencyStore: UcpIdempotencyStore,
) {
  const input: UcpOperationHandlerInput = {
    actor: c.get("actor") ?? null,
    context: c.get("context") ?? null,
    arguments: args,
    request: c.req.raw,
    params: {},
  };
  const key = idempotencyScope(toolName, c.req.raw, input.actor);
  const requestHash = await requestBodyHash(c.req.raw);
  const existing = await idempotencyStore.get(key);
  if (existing) {
    if (existing.requestHash === requestHash) {
      emitObserver(options.observer?.idempotencyReplayed, {
        transport: "mcp",
        operation: toolName,
        key,
        agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
      });
      return existing.response;
    }
    emitObserver(options.observer?.idempotencyConflict, {
      transport: "mcp",
      operation: toolName,
      key,
      agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
    });
    return idempotencyConflictEnvelope();
  }

  const response = await (options.mcpToolHandlers?.[toolName]?.(input) ?? unsupported(toolName));
  await idempotencyStore.put({
    key,
    requestHash,
    response,
    createdAt: new Date().toISOString(),
  });
  emitObserver(options.observer?.operationCompleted, {
    transport: "mcp",
    operation: toolName,
    status: response.ucp.status,
    agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
  });
  return response;
}

export function createUcpProfileRoutes(options: Pick<CreateUcpRoutesOptions, "businessSigningKeys"> = {}) {
  const app = new Hono();

  app.get("/ucp", (c) => c.json(buildBusinessProfile(requestOrigin(c.req.raw), options.businessSigningKeys)));

  return app;
}

export function createUcpRestRoutes(options: CreateUcpRoutesOptions = {}) {
  const app = new Hono<UcpRuntimeEnv>();
  const idempotencyStore = options.idempotencyStore ?? createMemoryUcpIdempotencyStore();

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
  const idempotencyStore = options.idempotencyStore ?? createMemoryUcpIdempotencyStore();

  app.post("/", async (c) => {
    const body = (await c.req.raw
      .clone()
      .json()
      .catch(() => null)) as JsonRpcRequest | null;
    if (!body || body.jsonrpc !== JSON_RPC_VERSION) {
      return c.json(jsonRpcError(null, -32600, "Invalid JSON-RPC request."), 400);
    }

    if (body.method === "initialize") {
      return c.json(
        jsonRpcResult(body.id, {
          protocolVersion: "2025-06-18",
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

    if (body.method === "tools/list") {
      return c.json(
        jsonRpcResult(body.id, {
          tools: UCP_MCP_TOOLS.map(toMcpToolListItem),
        }),
      );
    }

    if (body.method === "resources/list") {
      return c.json(
        jsonRpcResult(body.id, {
          resources: UCP_MCP_RESOURCES.map(toMcpResourceListItem),
        }),
      );
    }

    if (body.method === "tools/call") {
      const params = normalizeArguments(body.params) as UcpToolCallParams;
      const toolName = typeof params.name === "string" ? params.name : "";
      const tool = UCP_MCP_TOOLS.find((candidate) => candidate.name === toolName);
      if (!tool) {
        return c.json(jsonRpcError(body.id, -32602, `Unknown UCP MCP tool '${toolName}'.`), 400);
      }

      const args = normalizeArguments(params.arguments);
      if (tool.idempotencyKeyRequired) {
        const signedFailure = await signedWriteFailure(c.req.raw);
        if (signedFailure) {
          if (tool.trustedHandoffOnUnsignedMcp && c.get("actor")) {
            return c.json(jsonRpcResult(body.id, toolResult(tool, unsignedMcpTrustedHandoff(tool, args))));
          }
          emitObserver(options.observer?.signedWriteRejected, {
            transport: "mcp",
            operation: tool.name,
            reason: signedFailure,
            agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
          });
          return c.json(jsonRpcError(body.id, -32602, signedFailure), 400);
        }
        const signatureFailure = await verifyHttpMessageSignature(c.req.raw, options.signatureVerification);
        if (signatureFailure) {
          emitObserver(options.observer?.signatureVerificationFailed, {
            transport: "mcp",
            operation: tool.name,
            reason: signatureFailure,
            agentProfileUrl: ucpAgentProfileUrl(c.req.raw),
          });
          return c.json(jsonRpcError(body.id, -32602, signatureFailure), 400);
        }

        if (missingIdempotencyKey(c.req.raw)) {
          return c.json(jsonRpcError(body.id, -32602, `Idempotency-Key is required for ${tool.name}.`), 400);
        }
      }

      const result = tool.idempotencyKeyRequired
        ? await invokeMcpTool(c, options, tool.name, args, idempotencyStore)
        : await (options.mcpToolHandlers?.[tool.name]?.({
            actor: c.get("actor") ?? null,
            context: c.get("context") ?? null,
            arguments: args,
            request: c.req.raw,
            params: {},
          }) ?? unsupported(tool.name));

      if (
        tool.idempotencyKeyRequired &&
        result.messages?.some((message) => message.code === "idempotency_key_conflict")
      ) {
        return c.json(
          jsonRpcError(body.id, -32000, "Idempotency-Key was already used with different request parameters."),
          409,
        );
      }

      return c.json(jsonRpcResult(body.id, toolResult(tool, result)));
    }

    if (body.method === "resources/read") {
      const params = normalizeResourceReadParams(body.params);
      const uri = typeof params.uri === "string" ? params.uri : "";
      const result = readUcpMcpResource(uri);
      if (!result) {
        return c.json(jsonRpcError(body.id, -32602, `Unknown UCP MCP resource '${uri}'.`), 400);
      }

      return c.json(jsonRpcResult(body.id, result));
    }

    return c.json(jsonRpcError(body.id, -32601, `Unsupported UCP MCP method '${body.method ?? ""}'.`), 404);
  });

  return app;
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
