import { resolvePublicRequestOrigin } from "./http";

export function absoluteHttpsUrl(value: unknown, base?: string): URL | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value, base);
    if (url.protocol === "https:" && !url.username && !url.password) return url;
  } catch {
    // An invalid URL is not an asset or navigation target.
  }
  return undefined;
}

export function createPublicProductUrlPolicy(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const requestUrl = absoluteHttpsUrl(resolvePublicRequestOrigin(request));
  const publicOrigin = requestUrl && requestUrl.href === `${requestUrl.origin}/` ? requestUrl.origin : undefined;
  const origins = [
    ...new Set(
      [
        publicOrigin,
        absoluteHttpsUrl(env.CATALOG_ASSET_PUBLIC_BASE_URL)?.origin,
        absoluteHttpsUrl(env.MARKETPLACE_LISTING_PHOTO_PUBLIC_BASE_URL)?.origin,
      ].filter((origin): origin is string => origin !== undefined),
    ),
  ];
  return {
    origins,
    resolve(value: unknown) {
      const url = absoluteHttpsUrl(value, publicOrigin);
      return url && origins.includes(url.origin) ? url.href : undefined;
    },
  };
}
