import {
  AUTH_ACCOUNT_SELECTION_COOKIE_NAME,
  AUTH_SESSION_COOKIE_NAME,
} from "../request-support/cookies";
import {
  AUTH_ACCOUNT_SELECTION_TTL_MS,
  AUTH_SESSION_TTL_MS,
} from "../../features/sessions/domain/auth-flow";

export function parseCookieHeader(cookieHeader: string | null) {
  if (!cookieHeader) {
    return new Map<string, string>();
  }

  return new Map(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex < 0) {
          return [part, ""];
        }

        return [
          part.slice(0, separatorIndex),
          decodeURIComponent(part.slice(separatorIndex + 1)),
        ];
      }),
  );
}

export function readCookie(request: Request, name: string) {
  return parseCookieHeader(request.headers.get("cookie")).get(name) ?? null;
}

export function serializeCookie(
  name: string,
  value: string,
  options: Readonly<{
    request?: Request;
    maxAgeSeconds?: number;
  }> = {},
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (typeof options.maxAgeSeconds === "number") {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }

  const protocol = options.request
    ? new URL(options.request.url).protocol
    : "http:";

  if (protocol === "https:") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function createRedirectResponse(location: string, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Location", location);
  return new Response(null, { status: 302, headers: responseHeaders });
}

function appendCookie(
  headers: Headers,
  name: string,
  value: string,
  options: Readonly<{
    request?: Request;
    maxAgeSeconds: number;
  }>,
) {
  headers.append("Set-Cookie", serializeCookie(name, value, options));
}

export function appendSessionCookie(
  headers: Headers,
  sessionToken: string,
  request?: Request,
) {
  appendCookie(headers, AUTH_SESSION_COOKIE_NAME, sessionToken, {
    request,
    maxAgeSeconds: AUTH_SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(
  headers: Headers,
  request?: Request,
) {
  appendCookie(headers, AUTH_SESSION_COOKIE_NAME, "", {
    request,
    maxAgeSeconds: 0,
  });
}

export function appendAccountSelectionCookie(
  headers: Headers,
  selectionToken: string,
  request?: Request,
) {
  appendCookie(headers, AUTH_ACCOUNT_SELECTION_COOKIE_NAME, selectionToken, {
    request,
    maxAgeSeconds: AUTH_ACCOUNT_SELECTION_TTL_MS / 1000,
  });
}

export function clearAccountSelectionCookie(
  headers: Headers,
  request?: Request,
) {
  appendCookie(headers, AUTH_ACCOUNT_SELECTION_COOKIE_NAME, "", {
    request,
    maxAgeSeconds: 0,
  });
}

function isSafeReturnTo(value: string | null): value is string {
  return Boolean(value && value.startsWith("/") && !value.startsWith("//"));
}

export function getSafeReturnTo(request: Request, fallback: string) {
  const returnTo = new URL(request.url).searchParams.get("returnTo");
  return isSafeReturnTo(returnTo) ? returnTo : fallback;
}

export function readAuthSessionToken(request: Request) {
  const cookieToken = readCookie(request, AUTH_SESSION_COOKIE_NAME);
  if (cookieToken) {
    return cookieToken;
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}
