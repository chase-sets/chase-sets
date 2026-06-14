import { useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { Box, Stack } from "../../primitives/layout";
import { type ResponsiveImageSource } from "../data-display/product-media";

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
  const [loaded, setLoaded] = useState(false);
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
        <div className="relative min-w-0 overflow-hidden rounded-tokenMd border border-[var(--border)] bg-[var(--surface-2)] shadow-tokenSm">
          {resolvedLoadingImage && !loaded ? (
            <img
              src={resolvedLoadingImage.src}
              alt={loadingImageAlt ?? imageAlt}
              srcSet={resolvedLoadingImage.srcSet}
              sizes={resolvedLoadingImage.sizes}
              width={resolvedLoadingImage.width}
              height={resolvedLoadingImage.height}
              className="absolute inset-0 aspect-[2.5/3.5] h-full w-full object-contain p-1.5"
              aria-hidden="true"
            />
          ) : null}
          <img
            src={resolvedImage.src}
            alt={imageAlt}
            srcSet={resolvedImage.srcSet}
            sizes={resolvedImage.sizes}
            width={resolvedImage.width}
            height={resolvedImage.height}
            className="aspect-[2.5/3.5] h-full w-full object-contain p-1.5"
            loading="lazy"
            onLoad={() => setLoaded(true)}
          />
        </div>
        <Stack gap={3} minWidth="0">
          <Stack gap={1} minWidth="0">
            <div className="min-w-0 text-base font-semibold leading-snug text-[var(--foreground)]">{title}</div>
            {subtitle ? (
              <div className="min-w-0 text-sm leading-5 text-[var(--muted-foreground)]">{subtitle}</div>
            ) : null}
          </Stack>
          <div className="min-w-0 space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              {productLabel}
            </div>
            <Box minWidth="0">{productSummary}</Box>
          </div>
        </Stack>
        <div className="col-span-2 grid min-w-0 grid-cols-1 items-end gap-3 border-t border-[var(--border)] pt-3 min-[420px]:grid-cols-3 md:col-span-1 md:grid-cols-1 md:border-t-0 md:pt-0">
          <div className="min-w-0">{quantityControl}</div>
          <div className="grid min-w-0 gap-2 min-[420px]:contents md:grid md:grid-cols-1" data-cart-line-actions>
            {actions}
          </div>
        </div>
      </div>
    </div>
  );
}
