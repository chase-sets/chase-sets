import { t } from "@chase-sets/localization";
const DEFAULT_MARKETPLACE_DESCRIPTION = t("marketplace.app.seo.browse.the.chase.sets.marketplace.with");

export function shouldIndexMarketplace() {
  const value = process.env.CHASE_SETS_MARKETPLACE_INDEXING?.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value ?? "");
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

export function buildMarketplaceMeta({
  title,
  description = DEFAULT_MARKETPLACE_DESCRIPTION,
  imageUrl,
  type = "website",
}: {
  title: string;
  description?: string;
  imageUrl?: string;
  type?: "website" | "product";
}) {
  const meta = [
    { title },
    { name: "description", content: description },
    { property: "og:site_name", content: "Chase Sets" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: type },
    { name: "twitter:card", content: imageUrl ? "summary_large_image" : "summary" },
  ];

  if (imageUrl) {
    meta.push({ property: "og:image", content: imageUrl });
  }

  return meta;
}
