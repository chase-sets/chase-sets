export const PUBLIC_WEB_CANONICAL_ORIGIN = "https://chasesets.com";

export function resolvePublicOrigin() {
  return process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || PUBLIC_WEB_CANONICAL_ORIGIN;
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
  return new URL(`${pathname}${search}`, origin).toString();
}
