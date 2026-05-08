export const PUBLIC_WEB_CANONICAL_ORIGIN = "https://chasesets.com";

export function resolvePublicOrigin() {
  return process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || PUBLIC_WEB_CANONICAL_ORIGIN;
}

export function shouldIndexPublicWeb() {
  const value = process.env.CHASE_SETS_PUBLIC_INDEXING?.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value ?? "");
}

export function buildCanonicalUrl({
  origin,
  pathname,
  search: _search = "",
}: {
  origin: string;
  pathname: string;
  search?: string;
}) {
  return new URL(pathname, origin).toString();
}
