import type { ColorMode } from "@chase-sets/design-system";

export const USER_PREFERENCES_COLOR_MODE_COOKIE_NAME = "chase_sets_color_mode";

const USER_PREFERENCES_COLOR_MODE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;
const supportedColorModes = new Set<ColorMode>(["system", "light", "dark"]);

function decodeCookieValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function parseCookieHeader(cookieHeader: string | null) {
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

        return [part.slice(0, separatorIndex), decodeCookieValue(part.slice(separatorIndex + 1))];
      }),
  );
}

export function isUserPreferencesColorMode(value: unknown): value is ColorMode {
  return typeof value === "string" && supportedColorModes.has(value as ColorMode);
}

export function readUserPreferencesColorModeCookie(request: Request): ColorMode | null {
  const value = parseCookieHeader(request.headers.get("cookie")).get(USER_PREFERENCES_COLOR_MODE_COOKIE_NAME);
  return isUserPreferencesColorMode(value) ? value : null;
}

export function serializeUserPreferencesColorModeCookie(colorMode: ColorMode, request?: Request) {
  const parts = [
    `${USER_PREFERENCES_COLOR_MODE_COOKIE_NAME}=${encodeURIComponent(colorMode)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${USER_PREFERENCES_COLOR_MODE_COOKIE_MAX_AGE_SECONDS}`,
  ];

  const protocol = request ? new URL(request.url).protocol : "http:";
  if (protocol === "https:") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function appendUserPreferencesColorModeCookie(headers: Headers, colorMode: ColorMode, request?: Request) {
  headers.append("Set-Cookie", serializeUserPreferencesColorModeCookie(colorMode, request));
}

export function createUserPreferencesColorModeCookieSeedHeaders(
  request: Request,
  colorMode: ColorMode | null | undefined,
): Headers | null {
  if (!colorMode || readUserPreferencesColorModeCookie(request) === colorMode) {
    return null;
  }

  const headers = new Headers();
  appendUserPreferencesColorModeCookie(headers, colorMode, request);
  return headers;
}
