export type CanonicalUrlInput = Readonly<{
  origin: string;
  pathname: string;
  search?: string;
  includeSearch?: boolean;
}>;

export type SitemapEntry = Readonly<{
  path: string;
  updatedAt?: string | Date | null;
}>;

export function buildCanonicalUrl({ origin, pathname, search = "", includeSearch = true }: CanonicalUrlInput) {
  return new URL(`${pathname}${includeSearch ? search : ""}`, origin).toString();
}

export function shouldIndexFromEnv(varName: string, env: Partial<Record<string, string | undefined>> = process.env) {
  const value = env[varName]?.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value ?? "");
}

export function buildRobotsTxt({ origin, shouldIndex }: Readonly<{ origin: string; shouldIndex: boolean }>) {
  return shouldIndex
    ? ["User-agent: *", "Allow: /", `Sitemap: ${origin}/sitemap.xml`].join("\n")
    : ["User-agent: *", "Disallow: /"].join("\n");
}

export function buildSitemapXml(origin: string, entries: readonly SitemapEntry[]) {
  const urls = entries
    .map((entry) => {
      const loc = escapeXml(new URL(entry.path, origin).toString());
      const lastmod = entry.updatedAt ? `<lastmod>${escapeXml(new Date(entry.updatedAt).toISOString())}</lastmod>` : "";

      return `<url><loc>${loc}</loc>${lastmod}</url>`;
    })
    .join("");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
  ].join("");
}

export type SitemapIndexEntry = Readonly<{
  path: string;
  lastmod?: string | Date | null;
}>;

/**
 * Builds a sitemap index document referencing child sitemaps, keeping any single
 * sitemap under the protocol's per-file URL ceiling by paginating large entity kinds
 * across multiple child sitemaps instead of truncating them.
 */
export function buildSitemapIndexXml(origin: string, entries: readonly SitemapIndexEntry[]) {
  const sitemaps = entries
    .map((entry) => {
      const loc = escapeXml(new URL(entry.path, origin).toString());
      const lastmod = entry.lastmod ? `<lastmod>${escapeXml(new Date(entry.lastmod).toISOString())}</lastmod>` : "";

      return `<sitemap><loc>${loc}</loc>${lastmod}</sitemap>`;
    })
    .join("");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    sitemaps,
    "</sitemapindex>",
  ].join("");
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
