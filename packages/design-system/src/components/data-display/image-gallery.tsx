import { useState } from "react";
import type { HTMLAttributes } from "react";
import { cx } from "../../utils/cx";

export interface GalleryImage {
  src: string;
  alt: string;
}

export interface ImageGalleryProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  images: GalleryImage[];
  aspectRatio?: string;
}

export function ImageGallery({
  images,
  aspectRatio = "3/4",
  ...rest
}: ImageGalleryProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = images[activeIndex];

  if (images.length === 0) return null;

  return (
    <div {...rest} className="space-y-3">
      <div
        className="modern-surface overflow-hidden rounded-tokenLg border border-muted"
        style={{ aspectRatio }}
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
