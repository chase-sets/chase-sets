import { type ImgHTMLAttributes, type ReactNode } from "react";
import { Icon } from "../../icons";
import { Box, Grid, Stack } from "../../primitives/layout";
import { Image } from "../data-display/image";
import { type ResponsiveImageSource } from "../data-display/product-media";

// Designed empty/placeholder state for a cart line thumbnail with no image (or
// once every source has failed). Routed through the `Image` primitive's
// `fallback` slot so a missing image never renders a blank square.
function MarketplaceCartLineImagePlaceholder() {
  return (
    <span className="flex h-full w-full items-center justify-center text-tertiary" aria-hidden="true">
      <Icon name="image" size="md" tone="tertiary" />
    </span>
  );
}

export interface MarketplaceCartLineItemProps {
  image?: ResponsiveImageSource;
  imageSrc: string;
  imageAlt: string;
  imageSrcSet?: string;
  imageSizes?: string;
  imageWidth?: ImgHTMLAttributes<HTMLImageElement>["width"];
  imageHeight?: ImgHTMLAttributes<HTMLImageElement>["height"];
  loadingImage?: ResponsiveImageSource;
  loadingImageSrc?: string;
  loadingImageAlt?: string;
  loadingImageSrcSet?: string;
  loadingImageSizes?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  productLabel: ReactNode;
  productSummary: ReactNode;
  quantityControl: ReactNode;
  actions: ReactNode;
}

export function MarketplaceCartLineItem({
  image,
  imageSrc,
  imageAlt,
  imageSrcSet,
  imageSizes,
  imageWidth,
  imageHeight,
  loadingImage,
  loadingImageSrc,
  loadingImageAlt,
  loadingImageSrcSet,
  loadingImageSizes,
  title,
  subtitle,
  productLabel,
  productSummary,
  quantityControl,
  actions,
}: MarketplaceCartLineItemProps) {
  const resolvedImage = image ?? {
    src: imageSrc,
    srcSet: imageSrcSet,
    sizes: imageSizes,
    width: imageWidth,
    height: imageHeight,
  };
  const resolvedLoadingImage =
    loadingImage ??
    (loadingImageSrc
      ? {
          src: loadingImageSrc,
          srcSet: loadingImageSrcSet,
          sizes: loadingImageSizes,
        }
      : undefined);

  return (
    <div
      className="surface-border min-w-0 max-w-full rounded-tokenLg bg-elevated p-4 shadow-tokenSm sm:p-5"
      data-marketplace-cart-line
    >
      <div className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] gap-3 sm:grid-cols-[5.5rem_minmax(0,1fr)] md:grid-cols-[5.5rem_minmax(0,1fr)_minmax(13rem,16rem)] md:gap-4">
        <div className="relative aspect-[2.5/3.5] min-w-0 overflow-hidden rounded-tokenMd border border-border bg-surface-2 p-1.5 shadow-tokenSm">
          {resolvedImage.src ? (
            // The box owns the 2.5/3.5 aspect ratio and fill, so the image fills
            // its parent rather than self-sizing to an intrinsic width. Intrinsic
            // width/height attributes are intentionally not forwarded.
            <Image
              src={resolvedImage.src}
              alt={imageAlt}
              srcSet={resolvedImage.srcSet}
              sizes={resolvedImage.sizes}
              fit="contain"
              loading="lazy"
              fallbackSrc={resolvedLoadingImage?.src}
              fallback={<MarketplaceCartLineImagePlaceholder />}
            />
          ) : (
            <MarketplaceCartLineImagePlaceholder />
          )}
        </div>
        <Stack gap={3} minWidth="0">
          <Stack gap={1} minWidth="0">
            <div className="line-clamp-2 min-w-0 text-base font-semibold leading-snug text-foreground">{title}</div>
            {subtitle ? <div className="line-clamp-2 min-w-0 text-sm leading-5 text-tertiary">{subtitle}</div> : null}
          </Stack>
          <div className="min-w-0 space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-wide text-tertiary">{productLabel}</div>
            <Box minWidth="0">{productSummary}</Box>
          </div>
        </Stack>
        <div className="col-span-2 min-w-0 border-t border-[var(--border)] pt-3 md:col-span-1 md:border-t-0 md:pt-0">
          <Grid columns={{ base: 2, md: 1 }} gap={3} align="end">
            <div className="min-w-0">{quantityControl}</div>
            <div className="min-w-0" data-cart-line-actions>
              {actions}
            </div>
          </Grid>
        </div>
      </div>
    </div>
  );
}
