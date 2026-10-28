import { createHash, timingSafeEqual } from "node:crypto";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import {
  EBAY_RECEIPT_LOOKUP_PERMISSION,
  STAGING_EBAY_RECEIPT_LOOKUP_SERVICE_ID,
  type ReceiptLookupCredential,
  type ReceiptLookupServiceActor,
} from "@chase-sets/auth-context";

export type { ReceiptLookupCredential } from "@chase-sets/auth-context";
export type ReceiptLookupActorOptions = Readonly<{
  deploymentEnvironment?: string;
  canonicalAdminOrigin: string;
  readCredential: () => unknown;
  now?: () => Date;
}>;
export type ReceiptLookupActorResolution =
  | Readonly<{ actor: ReceiptLookupServiceActor; status: 200 }>
  | Readonly<{ error: string; status: 401 | 403 }>;

export function parseReceiptLookupCredential(input: unknown, now = new Date()): ReceiptLookupCredential | null {
  try {
    if (typeof input !== "string" || input.length > 512) return null;
    const value: unknown = JSON.parse(input);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      !Object.hasOwn(value, "version") ||
      !Object.hasOwn(value, "token") ||
      !Object.hasOwn(value, "expiresAt")
    )
      return null;
    const { version, token, expiresAt } = value as Record<string, unknown>;
    if (
      version !== 1 ||
      typeof token !== "string" ||
      !/^[\x21-\x7e]{32,256}$/.test(token) ||
      typeof expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(expiresAt) ||
      expiresAt.startsWith("0000-") ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      new Date(expiresAt).toISOString().slice(0, 19) !== expiresAt.slice(0, 19) ||
      Date.parse(expiresAt) <= now.getTime()
    )
      return null;
    return { version, token, expiresAt };
  } catch {
    return null;
  }
}

export function resolveReceiptLookupServiceActor(
  request: Request,
  options: ReceiptLookupActorOptions,
): ReceiptLookupActorResolution {
  if (options.deploymentEnvironment !== "staging") return { status: 403, error: "receipt_actor_environment_forbidden" };
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (
    resolvePublicRequestOrigin(request, { trustForwardedHeaders: false }) !== options.canonicalAdminOrigin ||
    (origin !== null && origin !== options.canonicalAdminOrigin) ||
    (request.headers.has("host") && request.headers.get("host") !== new URL(options.canonicalAdminOrigin).host)
  )
    return { status: 403, error: "receipt_actor_origin_forbidden" };
  if (url.pathname !== "/api/channels/staff/ebay-account-deletion/lookup" || request.method !== "POST")
    return { status: 403, error: "receipt_actor_operation_forbidden" };
  const refused = { status: 401, error: "receipt_actor_authentication_required" } as const;
  if (request.headers.has("cookie")) return refused;
  const bearer = request.headers.get("authorization");
  if (!bearer || !/^Bearer [\x21-\x7e]{32,256}$/.test(bearer)) return refused;
  const credential = parseReceiptLookupCredential(options.readCredential(), (options.now ?? (() => new Date()))());
  if (!credential) return refused;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  if (!timingSafeEqual(digest(bearer.slice(7)), digest(credential.token))) return refused;
  return {
    status: 200,
    actor: {
      kind: "service",
      serviceId: STAGING_EBAY_RECEIPT_LOOKUP_SERVICE_ID,
      permissions: [EBAY_RECEIPT_LOOKUP_PERMISSION],
    },
  };
}
