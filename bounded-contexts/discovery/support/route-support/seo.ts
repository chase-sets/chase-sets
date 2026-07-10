const MARKETPLACE_PRODUCTION_HOSTNAME = "marketplace.chasesets.com";

/**
 * Serializes a JSON-LD payload for embedding in an `application/ld+json` script tag,
 * escaping `<` so the payload cannot prematurely close the surrounding tag.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Structured data should only ever describe the canonical production marketplace page;
 * staging/preview origins and non-canonical URLs never get Product or BreadcrumbList markup.
 */
export function isProductionMarketplaceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === MARKETPLACE_PRODUCTION_HOSTNAME;
  } catch {
    return false;
  }
}

export type SchemaOrgBreadcrumbListItem = Readonly<{ name: string; url: string }>;

export type SchemaOrgBreadcrumbList = Readonly<{
  "@context": "https://schema.org";
  "@type": "BreadcrumbList";
  itemListElement: ReadonlyArray<
    Readonly<{
      "@type": "ListItem";
      position: number;
      name: string;
      item: string;
    }>
  >;
}>;

/**
 * Builds a schema.org BreadcrumbList mirroring the page's actual browse hierarchy.
 * Entries without both a name and an absolute URL are dropped; a trail shorter than
 * two entries is not a meaningful breadcrumb, so it is omitted entirely.
 */
export function buildBreadcrumbListJsonLd(
  items: readonly SchemaOrgBreadcrumbListItem[],
): SchemaOrgBreadcrumbList | null {
  const trail = items.filter((entry) => entry.name.trim().length > 0 && entry.url.trim().length > 0);

  if (trail.length < 2) {
    return null;
  }

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((entry, index) => ({
      "@type": "ListItem" as const,
      position: index + 1,
      name: entry.name,
      item: entry.url,
    })),
  };
}
