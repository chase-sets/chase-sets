import type { SavedListPreviewContent } from "./preview-contract";

// Privacy-safe structured metadata for a shared Saved List.
//
// Two hard rules drive every branch below:
//  1. Metadata never carries a field the page does not also render, so a
//     scraper cannot infer a hidden quantity or value from markup.
//  2. Index posture is opt-in: unlisted lists are always noindex/nofollow and
//     absent from sitemaps; public lists index only under an explicit posture
//     resolved upstream.

export type SavedListPreviewRobots = "index, follow" | "noindex, nofollow";

export type SavedListPreviewMetaDescriptor =
  | Readonly<{ title: string }>
  | Readonly<{ name: string; content: string }>
  | Readonly<{ property: string; content: string }>;

export type SavedListPreviewJsonLdItem = Readonly<{
  "@type": "ListItem";
  position: number;
  name: string;
  url?: string;
  image?: string;
  offers?: Readonly<{ "@type": "Offer"; price: string; priceCurrency: string }>;
}>;

export type SavedListPreviewJsonLd = Readonly<{
  "@context": "https://schema.org";
  "@type": "ItemList";
  name: string;
  description?: string;
  numberOfItems: number;
  itemListElement: readonly SavedListPreviewJsonLdItem[];
}>;

export type SavedListPreviewMetadata = Readonly<{
  robots: SavedListPreviewRobots;
  indexable: boolean;
  includeInSitemap: boolean;
  descriptors: readonly SavedListPreviewMetaDescriptor[];
  jsonLd: SavedListPreviewJsonLd;
}>;

export function isSavedListPreviewIndexable(content: SavedListPreviewContent): boolean {
  return content.visibility === "public" && content.seoIndexable;
}

function buildJsonLdItems(content: SavedListPreviewContent): SavedListPreviewJsonLdItem[] {
  const showValue = content.disclosure.showEstimatedValue;

  return content.lines
    .filter((line) => line.availability !== "removed")
    .map((line) => {
      const item: {
        "@type": "ListItem";
        position: number;
        name: string;
        url?: string;
        image?: string;
        offers?: { "@type": "Offer"; price: string; priceCurrency: string };
      } = {
        "@type": "ListItem",
        position: line.position,
        name: line.productName,
      };

      if (line.productHref) item.url = line.productHref;
      if (line.imageUrl) item.image = line.imageUrl;
      if (showValue && line.estimatedValue) {
        item.offers = {
          "@type": "Offer",
          price: line.estimatedValue.amount,
          priceCurrency: line.estimatedValue.currencyCode,
        };
      }

      return item;
    });
}

export function buildSavedListPreviewMetadata(
  content: SavedListPreviewContent,
  options: Readonly<{ title: string }>,
): SavedListPreviewMetadata {
  const indexable = isSavedListPreviewIndexable(content);
  const robots: SavedListPreviewRobots = indexable ? "index, follow" : "noindex, nofollow";

  const descriptors: SavedListPreviewMetaDescriptor[] = [
    { title: options.title },
    { name: "robots", content: robots },
    { property: "og:title", content: content.title },
    { property: "og:type", content: "website" },
  ];

  if (content.description) {
    descriptors.push({ name: "description", content: content.description });
    descriptors.push({ property: "og:description", content: content.description });
  }
  if (content.coverImageUrl) {
    descriptors.push({ property: "og:image", content: content.coverImageUrl });
  }

  const jsonLd: SavedListPreviewJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: content.title,
    ...(content.description ? { description: content.description } : {}),
    numberOfItems: content.lineCount,
    itemListElement: buildJsonLdItems(content),
  };

  return { robots, indexable, includeInSitemap: indexable, descriptors, jsonLd };
}
