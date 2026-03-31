import { useState } from "react";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cx } from "../../utils/cx";

export interface GalleryImage {
  src: string;
  alt: string;
}

export interface ImageGalleryProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  images: GalleryImage[];
  aspectRatio?: string;
  emptyState?: ReactNode;
  maxHeightClassName?: string;
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
  maxHeightClassName,
  ...rest
}: ImageGalleryProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = images[activeIndex];
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
  const frameClassName = cx(
    "modern-surface overflow-hidden rounded-tokenLg border border-muted",
    constrainedFrameClasses,
  );

  if (images.length === 0) {
    if (!emptyState) {
      return null;
    }

    return (
      <div {...rest} className="space-y-3">
        <div
          className={cx(
            frameClassName,
            "flex items-center justify-center p-6 shadow-tokenSm",
          )}
          style={galleryStyle}
        >
          {emptyState}
        </div>
      </div>
    );
  }

  return (
    <div {...rest} className="space-y-3">
      <div
        className={frameClassName}
        style={galleryStyle}
      >
        {active ? (
          <img
            src={active.src}
            alt={active.alt}
            className="h-full w-full object-contain"
          />
        ) : null}
      </div>
      {images.length > 1 ? (
        <div className="flex gap-2 overflow-x-auto">
          {images.map((image, index) => (
            <button
              key={index}
              type="button"
              onClick={() => setActiveIndex(index)}
              className={cx(
                "focus-ring h-16 w-16 shrink-0 overflow-hidden rounded-tokenMd border transition",
                index === activeIndex
                  ? "border-accent shadow-tokenSm"
                  : "border-muted hover:border-accent"
              )}
            >
              <img
                src={image.src}
                alt={image.alt}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
