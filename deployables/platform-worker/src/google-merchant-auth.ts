import { createSign } from "node:crypto";
import type { GoogleMerchantAccessTokenProvider } from "./google-merchant-client";

type FetchFunction = typeof fetch;

type ServiceAccountCredentials = Readonly<{
  client_email: string;
  private_key: string;
  token_uri?: string;
}>;

export type GoogleMerchantServiceAccountAccessTokenProviderOptions = Readonly<{
  credentialSecretName: string;
  scope?: string;
  fetch?: FetchFunction;
  now?: () => number;
  secretResolver?: (secretName: string) => string | null | undefined;
}>;

const defaultScope = "https://www.googleapis.com/auth/content";
const defaultTokenUri = "https://oauth2.googleapis.com/token";
const jwtGrantType = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const refreshSkewMs = 5 * 60 * 1000;

export function createGoogleMerchantServiceAccountAccessTokenProvider(
  options: GoogleMerchantServiceAccountAccessTokenProviderOptions,
): GoogleMerchantAccessTokenProvider {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const resolveSecret = options.secretResolver ?? ((secretName) => process.env[secretName]);
  const scope = options.scope ?? defaultScope;
  let cached: Readonly<{ token: string; expiresAtMs: number }> | null = null;

  return async () => {
    if (cached && cached.expiresAtMs - refreshSkewMs > now()) {
      return cached.token;
    }

    const credentials = readServiceAccountCredentials(options.credentialSecretName, resolveSecret);
    const tokenUri = credentials.token_uri?.trim() || defaultTokenUri;
    const assertion = createServiceAccountJwt({
      clientEmail: credentials.client_email,
      privateKey: credentials.private_key,
      scope,
      tokenUri,
      now,
    });
    const response = await fetchFn(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: jwtGrantType,
        assertion,
      }),
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`Google Merchant credential exchange failed: ${safeTokenErrorMessage(body)}`);
    }

    const accessToken = typeof body.access_token === "string" ? body.access_token : null;
    const expiresInSeconds = Number(body.expires_in ?? 3600);
    if (!accessToken) {
      throw new Error("Google Merchant credential exchange did not return an access token.");
    }

    cached = {
      token: accessToken,
      expiresAtMs: now() + Math.max(60, expiresInSeconds) * 1000,
    };
    return cached.token;
  };
}

export function createServiceAccountJwt(
  input: Readonly<{
    clientEmail: string;
    privateKey: string;
    scope: string;
    tokenUri: string;
    now: () => number;
  }>,
): string {
  const issuedAt = Math.floor(input.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const claimSet = {
    iss: input.clientEmail,
    scope: input.scope,
    aud: input.tokenUri,
    exp: issuedAt + 3600,
    iat: issuedAt,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claimSet)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(normalizePrivateKey(input.privateKey), "base64url")}`;
}

function readServiceAccountCredentials(
  credentialSecretName: string,
  resolveSecret: (secretName: string) => string | null | undefined,
): ServiceAccountCredentials {
  const secretValue = resolveSecret(credentialSecretName);
  if (!secretValue?.trim()) {
    throw new Error("Google Merchant credential secret is not available.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(secretValue);
  } catch {
    throw new Error("Google Merchant credential secret is not valid service account JSON.");
  }

  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const clientEmail = typeof record.client_email === "string" ? record.client_email.trim() : "";
  const privateKey = typeof record.private_key === "string" ? record.private_key : "";
  const tokenUri = typeof record.token_uri === "string" ? record.token_uri.trim() : undefined;

  if (!clientEmail || !privateKey) {
    throw new Error("Google Merchant credential secret is missing service account email or private key.");
  }

  return {
    client_email: clientEmail,
    private_key: privateKey,
    token_uri: tokenUri,
  };
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function normalizePrivateKey(value: string) {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

function safeTokenErrorMessage(value: unknown) {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const error = typeof record.error === "string" ? record.error : "token_request_failed";
  const description = typeof record.error_description === "string" ? record.error_description : "";
  return [error, description].filter(Boolean).join(": ").slice(0, 500);
}
