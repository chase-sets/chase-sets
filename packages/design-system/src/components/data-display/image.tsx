import { useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { cx } from "../../utils/cx";

export interface ImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "className" | "style"> {
  src: string;
  alt: string;
  /** Object-fit for the image inside its box. Defaults to `cover`. */
  fit?: "cover" | "contain" | "fill" | "none";
  /** Skeleton placeholder shown while the image loads. Set `false` to opt out. Defaults to `true`. */
  skeleton?: boolean;
  /** Source swapped in when the primary image (or a prior fallback) fails to load. */
  fallbackSrc?: string;
  /** Node rendered in place of the image once every source has failed. */
  fallback?: ReactNode;
  /** Native lazy/eager loading hint. Defaults to `lazy`. */
  loading?: ImgHTMLAttributes<HTMLImageElement>["loading"];
}

const imageFitClasses: Record<NonNullable<ImageProps["fit"]>, string> = {
  cover: "object-cover",
  contain: "object-contain",
  fill: "object-fill",
  none: "object-none",
};

/**
 * Design-system `<img>` replacement with native lazy loading, a skeleton placeholder
 * while the image streams in, and graceful fallback handling when a source fails.
 * Use this instead of raw `<img>` so loading and error states stay consistent.
 */
export function Image({
  src,
  alt,
  fit = "cover",
  skeleton = true,
  fallbackSrc,
  fallback,
  loading = "lazy",
  onLoad,
  onError,
  ...rest
}: ImageProps) {
  const [failedSources, setFailedSources] = useState<ReadonlySet<string>>(() => new Set());
  const [loaded, setLoaded] = useState(false);

  const resolvedSrc =
    src && !failedSources.has(src) ? src : fallbackSrc && !failedSources.has(fallbackSrc) ? fallbackSrc : undefined;

  // Every source failed and a custom fallback node was supplied.
  if (!resolvedSrc && fallback !== undefined) {
    return <>{fallback}</>;
  }

  const showSkeleton = skeleton && !loaded && Boolean(resolvedSrc);

  return (
    <span className="relative block h-full w-full overflow-hidden">
      {showSkeleton ? <span aria-hidden="true" className="absolute inset-0 animate-pulse bg-muted" /> : null}
      {resolvedSrc ? (
        <img
          {...rest}
          src={resolvedSrc}
          alt={alt}
          loading={loading}
          onLoad={(event) => {
            setLoaded(true);
            onLoad?.(event);
          }}
          onError={(event) => {
            setFailedSources((current) => {
              if (current.has(resolvedSrc)) {
                return current;
              }

              const next = new Set(current);
              next.add(resolvedSrc);
              return next;
            });
            onError?.(event);
          }}
          className={cx(
            "block h-full w-full transition-opacity duration-200",
            imageFitClasses[fit],
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}
    </span>
  );
}
