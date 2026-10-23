import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { EbayApplicationKeyAuthorityConfiguration } from "../domain/configuration";
import type { ProviderKeyAuthorityOutcome } from "@chase-sets/http/provider-errors";

export class EbayDeletionBoundaryError extends Error {
  constructor(public readonly status: 408 | 413) {
    super("ebay_account_deletion_body_invalid");
  }
}

async function deadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new EbayDeletionBoundaryError(408));
        }, 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function readBody(body: ReadableStream<Uint8Array> | null, signal: AbortSignal) {
  if (signal.aborted) throw new EbayDeletionBoundaryError(408);
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted) throw new EbayDeletionBoundaryError(408);
      if (part.done) return Buffer.concat(chunks);
      size += part.value.byteLength;
      if (size > 64 * 1024) {
        cancel();
        throw new EbayDeletionBoundaryError(413);
      }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export function readEbayDeletionBody(request: Request) {
  return deadline((signal) => readBody(request.body, signal));
}

function base64(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    !value ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error();
  return bytes;
}

export function parseEbayDeletionSignature(header: string | undefined) {
  try {
    if (!header || Buffer.byteLength(header) > 8 * 1024) return null;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64(header)));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "alg,digest,kid,signature" ||
      value.alg !== "ECDSA" ||
      value.digest !== "sha256" ||
      typeof value.kid !== "string" ||
      value.kid === "." ||
      value.kid === ".." ||
      !/^[\x21-\x7e]{1,256}$/.test(value.kid)
    )
      return null;
    return { kid: value.kid as string, signature: base64(value.signature) };
  } catch {
    return null;
  }
}

export function createEbayDeletionKeyAuthority(
  config: EbayApplicationKeyAuthorityConfiguration | null,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  let token: { value: string; refreshAt: number } | undefined;
  let tokenFlight: Promise<string> | undefined;
  const keys = new Map<string, { key: KeyObject; expiresAt: number }>();
  const flights = new Map<string, Promise<KeyObject>>();
  const host = config?.environment === "production" ? "https://api.ebay.com" : "https://api.sandbox.ebay.com";

  async function request(path: string, init: RequestInit) {
    return deadline(async (signal) => {
      const response = await fetcher(host + path, { ...init, signal, redirect: "error" });
      const bytes = await readBody(response.body, signal);
      if (!response.ok) throw new Error("authority_refused");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    });
  }

  return {
    async verify(value: unknown, signature: NonNullable<ReturnType<typeof parseEbayDeletionSignature>>) {
      const outcomes: { tokenMint: ProviderKeyAuthorityOutcome; keyFetch: ProviderKeyAuthorityOutcome } = {
        tokenMint: "not-attempted",
        keyFetch: "not-attempted",
      };
      if (!config) return { status: "unavailable" as const, ...outcomes };
      let key = keys.get(signature.kid);
      if (key && key.expiresAt <= now()) {
        keys.delete(signature.kid);
        key = undefined;
      }
      let publicKey: KeyObject;
      try {
        if (key) publicKey = key.key;
        else {
          let flight = flights.get(signature.kid);
          if (!flight) {
            flight = (async () => {
              let accessToken = token && token.refreshAt > now() ? token.value : undefined;
              if (!accessToken) {
                if (!tokenFlight) {
                  tokenFlight = (async () => {
                    outcomes.tokenMint = "unavailable";
                    const result = await request("/identity/v1/oauth2/token", {
                      method: "POST",
                      headers: {
                        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
                        "Content-Type": "application/x-www-form-urlencoded",
                      },
                      body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
                    });
                    if (
                      typeof result.access_token !== "string" ||
                      !/^[\x21-\x7e]+$/.test(result.access_token) ||
                      typeof result.expires_in !== "number" ||
                      !Number.isSafeInteger(result.expires_in) ||
                      result.expires_in <= 0
                    )
                      throw new Error();
                    token = { value: result.access_token, refreshAt: now() + (result.expires_in - 300) * 1000 };
                    outcomes.tokenMint = "succeeded";
                    return token.value;
                  })().finally(() => {
                    tokenFlight = undefined;
                  });
                }
                accessToken = await tokenFlight;
              }
              outcomes.keyFetch = "unavailable";
              const result = await request(
                `/commerce/notification/v1/public_key/${encodeURIComponent(signature.kid)}`,
                {
                  headers: { Authorization: `Bearer ${accessToken}` },
                },
              );
              if (result.algorithm !== "ECDSA" || result.digest !== "sha256" || typeof result.key !== "string")
                throw new Error();
              const der = base64(result.key.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, ""));
              const fetched = createPublicKey({ key: der, format: "der", type: "spki" });
              if (fetched.asymmetricKeyType !== "ec") throw new Error();
              outcomes.keyFetch = "succeeded";
              if (keys.size >= 128) keys.delete(keys.keys().next().value!);
              keys.set(signature.kid, { key: fetched, expiresAt: now() + 3_600_000 });
              return fetched;
            })().finally(() => {
              flights.delete(signature.kid);
            });
            flights.set(signature.kid, flight);
          }
          publicKey = await flight;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "authority_refused") {
          if (outcomes.keyFetch === "unavailable") outcomes.keyFetch = "refused";
          else if (outcomes.tokenMint === "unavailable") outcomes.tokenMint = "refused";
        }
        return { status: "unavailable" as const, ...outcomes };
      }
      try {
        const valid = verify(
          "sha256",
          Buffer.from(JSON.stringify(value), "utf8"),
          { key: publicKey, dsaEncoding: "der" },
          signature.signature,
        );
        return { status: valid ? ("verified" as const) : ("invalid" as const), ...outcomes };
      } catch {
        return { status: "invalid" as const, ...outcomes };
      }
    },
  };
}
