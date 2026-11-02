export type CookieOptions = Readonly<{
  request?: Request;
  maxAgeSeconds?: number;
}>;

/**
 * The one `Set-Cookie` value every first-party cookie uses: HttpOnly,
 * SameSite=Lax and site-wide, with `Secure` only when the request is HTTPS.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];

  if (typeof options.maxAgeSeconds === "number") {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }

  if (options.request && new URL(options.request.url).protocol === "https:") {
    parts.push("Secure");
  }

  return parts.join("; ");
}
