const fakeCdnAssetBaseUrl = "/fake-cdn/assets";

export const discoveryAssetUrls = {
  defaultProductImage: `${fakeCdnAssetBaseUrl}/pokemon_tcg_back.png`,
} as const;

type ImageFallback = Readonly<{
  url: string;
  alt: string;
  usage: "permanent" | "loading-only";
  variants: Record<
    string,
    {
      oneX?: string;
      twoX?: string;
    }
  >;
}>;

export function imageVariantSrcSet(fallback: ImageFallback | null | undefined, size: string): string | undefined {
  const variant = fallback?.variants?.[size];
  const entries = [variant?.oneX ? `${variant.oneX} 1x` : null, variant?.twoX ? `${variant.twoX} 2x` : null].filter(
    (entry): entry is string => entry !== null,
  );

  return entries.length > 0 ? entries.join(", ") : undefined;
}
