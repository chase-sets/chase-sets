import { useState } from "react";
import {
  AutoGrid,
  Banner,
  Box,
  Button,
  ChaseRoot,
  LiveRegion,
  MarketplaceProductCard,
  NoResultsRecovery,
  Skeleton,
  Stack,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";

type Money = { currency: string; amount: number };
type CatalogProduct = {
  id: string;
  title: string;
  description?: string;
  url?: string;
  image?: { url: string; alt?: string };
  price: { min: Money; max: Money };
};

type CatalogResult =
  | { kind: "malformed" }
  | { kind: "error"; messages: string[] }
  | { kind: "products"; products: CatalogProduct[] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function money(value: unknown): Money | undefined {
  const price = record(value);
  if (
    typeof price?.currency === "string" &&
    /^[A-Z]{3}$/.test(price.currency) &&
    typeof price.amount === "number" &&
    Number.isSafeInteger(price.amount) &&
    price.amount >= 0
  ) {
    return { currency: price.currency, amount: price.amount };
  }
}

function catalogProduct(value: unknown, allowedOrigins: readonly string[]): CatalogProduct | undefined {
  const product = record(value);
  if (!product || typeof product.id !== "string" || typeof product.title !== "string") return;
  const description = record(product.description);
  const range = record(product.price_range);
  const min = money(range?.min);
  const max = money(range?.max);
  if (!description || !min || !max || !Array.isArray(product.variants) || product.variants.length === 0) return;
  const image = (Array.isArray(product.media) ? product.media : []).flatMap((entry) => {
    const media = record(entry);
    const url = media?.type === "image" ? admittedUrl(media.url, allowedOrigins) : undefined;
    return url ? [{ url, alt: typeof media?.alt_text === "string" ? media.alt_text : undefined }] : [];
  })[0];
  return {
    id: product.id,
    title: product.title,
    description: typeof description.plain === "string" ? description.plain : undefined,
    url: admittedUrl(product.url, allowedOrigins),
    image,
    price: { min, max },
  };
}

function admittedUrl(value: unknown, origins: readonly string[]): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && origins.includes(url.origin)) return url.href;
  } catch {
    // An invalid URL has no widget action or image.
  }
}

function catalogResult(result: unknown, allowedOrigins: readonly string[]): CatalogResult {
  const envelope = record(record(result)?.structuredContent);
  const ucp = record(envelope?.ucp);
  if (!envelope || ucp?.version !== "2026-08-25") return { kind: "malformed" };
  if (ucp.status === "error" && Array.isArray(envelope.messages) && envelope.messages.length > 0) {
    const messages = envelope.messages.map((entry) => record(entry)?.content);
    if (messages.every((message): message is string => typeof message === "string")) return { kind: "error", messages };
  }
  if (ucp.status !== "success") return { kind: "malformed" };
  const raw = "product" in envelope && !("products" in envelope) ? [envelope.product] : envelope.products;
  if (!Array.isArray(raw) || ("product" in envelope && "products" in envelope)) return { kind: "malformed" };
  const products = raw.map((entry) => catalogProduct(entry, allowedOrigins));
  return products.every((product): product is CatalogProduct => product !== undefined)
    ? { kind: "products", products }
    : { kind: "malformed" };
}

function displayPrice({ min, max }: CatalogProduct["price"]) {
  const format = new Intl.NumberFormat("en", { style: "currency", currency: min.currency });
  const price = format.format(min.amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
  return min.amount === max.amount && min.currency === max.currency
    ? price
    : t("discovery.features.search.ui.agentProductCards.priceFrom", { price });
}

export function AgentProductCardsView({
  theme,
  state,
  allowedOrigins,
  openLink,
}: Readonly<{
  theme?: "light" | "dark";
  state: { kind: "loading" } | { kind: "result"; result: unknown };
  allowedOrigins: readonly string[];
  openLink: (url: string) => Promise<void>;
}>) {
  const [linkFailed, setLinkFailed] = useState(false);
  const view = state.kind === "loading" ? state : catalogResult(state.result, allowedOrigins);
  const showProduct = async (url: string) => {
    setLinkFailed(false);
    try {
      await openLink(url);
    } catch {
      setLinkFailed(true);
    }
  };

  return (
    <ChaseRoot colorMode={theme ?? "system"}>
      <Box element="main" padding={3}>
        <Stack gap={3}>
          {view.kind === "loading" && (
            <AutoGrid minItemWidth="sm">
              <LiveRegion>{t("discovery.features.search.ui.agentProductCards.loading")}</LiveRegion>
              <Skeleton height="lg" />
              <Skeleton height="lg" />
            </AutoGrid>
          )}
          {view.kind === "malformed" && (
            <Banner tone="warning" title={t("discovery.features.search.ui.agentProductCards.malformed")} />
          )}
          {view.kind === "error" && (
            <Banner
              tone="danger"
              title={t("discovery.features.search.ui.agentProductCards.error")}
              description={view.messages.join(" ")}
            />
          )}
          {view.kind === "products" &&
            (view.products.length === 0 ? (
              <NoResultsRecovery
                title={t("discovery.features.search.ui.agentProductCards.empty")}
                description={t("discovery.features.search.ui.agentProductCards.empty.description")}
              />
            ) : (
              <AutoGrid minItemWidth="sm">
                {view.products.map(({ id, title, description, url, image, price }) => (
                  <Stack key={id} gap={2}>
                    <MarketplaceProductCard
                      title={title}
                      description={description}
                      imageSrc={image?.url}
                      imageAlt={image?.alt ?? ""}
                      status="available"
                      price={displayPrice(price)}
                    />
                    {url && (
                      <Button type="button" onClick={() => void showProduct(url)}>
                        {t("discovery.features.search.ui.agentProductCards.open")}
                      </Button>
                    )}
                  </Stack>
                ))}
              </AutoGrid>
            ))}
          {linkFailed && (
            <Banner tone="warning" title={t("discovery.features.search.ui.agentProductCards.open.error")} />
          )}
        </Stack>
      </Box>
    </ChaseRoot>
  );
}
