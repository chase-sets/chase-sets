import { buildCanonicalUrl as buildPlatformCanonicalUrl, shouldIndexFromEnv } from "@chase-sets/platform-runtime/seo";

export const PUBLIC_WEB_CANONICAL_ORIGIN = "https://chasesets.com";

export function resolvePublicOrigin() {
  return process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || PUBLIC_WEB_CANONICAL_ORIGIN;
}

export function shouldIndexPublicWeb() {
  return shouldIndexFromEnv("CHASE_SETS_PUBLIC_INDEXING");
}

export function buildCanonicalUrl({
  origin,
  pathname,
  search = "",
}: {
  origin: string;
  pathname: string;
  search?: string;
}) {
  return buildPlatformCanonicalUrl({ origin, pathname, search, includeSearch: false });
}
