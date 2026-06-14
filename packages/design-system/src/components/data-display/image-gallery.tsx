import { useState } from "react";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cx } from "../../utils/cx";
import { ProductMediaImage } from "./product-media";
import type { ResponsiveImageSource } from "./product-media";

export interface GalleryImage extends ResponsiveImageSource {
  thumbnailSrc?: string;
  thumbnailSrcSet?: string;
  thumbnailSizes?: string;
  alt: string;
}

export interface ImageGalleryProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  images: GalleryImage[];
  aspectRatio?: string;
  emptyState?: ReactNode;
  fallbackImage?: GalleryImage;
  fallbackImageMode?: "permanent" | "loading-only";
  maxHeightClassName?: string;
  thumbnailPlacement?: "bottom" | "left";
}

function parseAspectRatio(value: string): number {
  const parts = value.split("/");

  if (parts.length === 2) {
    const width = Number(parts[0]);
    const height = Number(parts[1]);

    if (width > 0 && height > 0) {
      return width / height;
    }
  }

  const numeric = Number(value);

  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
}

export function ImageGallery({
  images,
  aspectRatio = "3/4",
  emptyState,
  fallbackImage,
  fallbackImageMode = "permanent",
  maxHeightClassName,
  thumbnailPlacement = "bottom",
  ...rest
}: ImageGalleryProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [loadedImageSources, setLoadedImageSources] = useState<ReadonlySet<string>>(() => new Set());
  const [failedImageSources, setFailedImageSources] = useState<ReadonlySet<string>>(() => new Set());

  function resolveImage(image: GalleryImage | undefined): GalleryImage | undefined {
    if (!image) {
      return fallbackImageMode === "permanent" && fallbackImage && !failedImageSources.has(fallbackImage.src)
        ? fallbackImage
        : undefined;
    }

    if (failedImageSources.has(image.src)) {
      return fallbackImageMode === "permanent" && fallbackImage && !failedImageSources.has(fallbackImage.src)
        ? fallbackImage
        : undefined;
    }

    return image;
  }

  function markImageFailed(src: string) {
    setFailedImageSources((current) => {
      if (current.has(src)) {
        return current;
      }

      const next = new Set(current);
      next.add(src);
      return next;
    });
  }

  function markImageLoaded(src: string) {
    setLoadedImageSources((current) => {
      if (current.has(src)) {
        return current;
      }

      const next = new Set(current);
      next.add(src);
      return next;
    });
  }

  const hasProvidedImages = images.length > 0;
  const galleryImages = fallbackImageMode === "permanent" && fallbackImage ? [...images, fallbackImage] : images;
  const safeGalleryIndex = activeIndex < galleryImages.length ? activeIndex : 0;
  const active = resolveImage(hasProvidedImages ? galleryImages[safeGalleryIndex] : undefined);
  const showLoadingFallback = Boolean(
    active &&
    fallbackImage &&
    active.src !== fallbackImage.src &&
    !loadedImageSources.has(active.src) &&
    !failedImageSources.has(active.src),
  );
  const loadingFallback = showLoadingFallback ? fallbackImage : undefined;
  // ds-dynamic-css-var: allow --gallery-aspect-ratio for per-instance media sizing in the future DS scanner, issue 1719.
  const galleryStyle = {
    aspectRatio,
    "--gallery-aspect-ratio": String(parseAspectRatio(aspectRatio)),
  } as CSSProperties;
  const constrainedFrameClasses = maxHeightClassName
    ? cx(
        maxHeightClassName,
        "lg:h-[var(--gallery-max-height)]",
        "lg:w-[min(100%,calc(var(--gallery-max-height)*var(--gallery-aspect-ratio)))]",
        "lg:max-w-full",
      )
    : "";
  const productFrameClassName = cx("relative overflow-visible", constrainedFrameClasses);
  const surfaceFrameClassName = cx(
    "modern-surface relative overflow-hidden rounded-tokenLg border border-muted",
    constrainedFrameClasses,
  );
  const thumbnailRail =
    galleryImages.length > 1 ? (
      <div
        className={cx(
          "flex gap-2 overflow-auto",
          thumbnailPlacement === "left" ? "max-h-full w-16 shrink-0 flex-col" : "overflow-x-auto",
        )}
      >
        {galleryImages.map((image, index) => {
          const thumbnail = resolveImage(image);

          return (
            <button
              key={index}
              type="button"
              onClick={() => setActiveIndex(index)}
              aria-label={image.alt}
              className={cx(
                "focus-ring h-16 w-16 shrink-0 overflow-hidden rounded-tokenMd border transition",
                index === safeGalleryIndex ? "border-accent shadow-tokenSm" : "border-muted hover:border-accent",
              )}
            >
              {thumbnail ? (
                <img
                  src={thumbnail.thumbnailSrc ?? thumbnail.src}
                  alt=""
                  aria-hidden="true"
                  srcSet={thumbnail.thumbnailSrcSet ?? thumbnail.srcSet}
                  sizes={thumbnail.thumbnailSizes ?? "64px"}
                  onError={() => markImageFailed(thumbnail.thumbnailSrc ?? thumbnail.src)}
                  className="h-full w-full object-cover"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    ) : null;

  if (!hasProvidedImages && !fallbackImage) {
    if (!emptyState) {
      return null;
    }

    return (
      <div {...rest} className={thumbnailPlacement === "left" ? "flex items-start justify-center gap-3" : "space-y-3"}>
        <div
          className={cx(surfaceFrameClassName, "flex items-center justify-center p-6 shadow-tokenSm")}
          style={galleryStyle}
        >
          {emptyState}
        </div>
      </div>
    );
  }

  return (
    <div {...rest} className={thumbnailPlacement === "left" ? "flex items-start justify-center gap-3" : "space-y-3"}>
      {thumbnailPlacement === "left" ? thumbnailRail : null}
      <div className={active ? productFrameClassName : surfaceFrameClassName} style={galleryStyle}>
        {active ? (
          <>
            {loadingFallback ? (
              <ProductMediaImage
                src={loadingFallback.src}
                alt={loadingFallback.alt}
                srcSet={loadingFallback.srcSet}
                sizes={loadingFallback.sizes}
                width={loadingFallback.width}
                height={loadingFallback.height}
                className="absolute inset-0"
                aria-hidden="true"
              />
            ) : null}
            <ProductMediaImage
              src={active.src}
              alt={active.alt}
              srcSet={active.srcSet}
              sizes={active.sizes}
              width={active.width}
              height={active.height}
              onLoad={() => markImageLoaded(active.src)}
              onError={() => markImageFailed(active.src)}
              className="relative"
            />
          </>
        ) : (
          (emptyState ?? null)
        )}
      </div>
      {thumbnailPlacement === "bottom" ? thumbnailRail : null}
    </div>
  );
}
