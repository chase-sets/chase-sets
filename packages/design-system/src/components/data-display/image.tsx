import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";
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
  /**
   * Intrinsic display width. A number is treated as pixels. When set, the image
   * sizes itself to this width (capped at 100% of its container) and keeps its
   * natural aspect ratio instead of filling a sized parent.
   */
  width?: number | string;
  /** Apply a rounded corner radius token to the rendered image. Defaults to `false`. */
  rounded?: boolean;
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
  width,
  rounded = false,
  onLoad,
  onError,
  ...rest
}: ImageProps) {
  const [failedSources, setFailedSources] = useState<ReadonlySet<string>>(() => new Set());
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const resolvedSrc =
    src && !failedSources.has(src) ? src : fallbackSrc && !failedSources.has(fallbackSrc) ? fallbackSrc : undefined;

  // After SSR, an image can finish loading (or fail) before hydration attaches the
  // synthetic onLoad/onError handlers, so those events never fire. Reconcile the
  // image's actual state on mount and whenever the resolved source changes:
  // re-arm the skeleton, then settle it from the live <img> if it is already complete.
  useEffect(() => {
    setLoaded(false);

    if (!resolvedSrc) {
      return;
    }

    const img = imgRef.current;
    if (!img?.complete) {
      return;
    }

    if (img.naturalWidth > 0) {
      setLoaded(true);
    } else {
      setFailedSources((current) => (current.has(resolvedSrc) ? current : new Set(current).add(resolvedSrc)));
    }
  }, [resolvedSrc]);

  // Every source failed and a custom fallback node was supplied.
  if (!resolvedSrc && fallback !== undefined) {
    return <>{fallback}</>;
  }

  const showSkeleton = skeleton && !loaded && Boolean(resolvedSrc);
  const selfSized = width !== undefined;
  const wrapperStyle = selfSized ? { width, maxWidth: "100%" } : undefined;

  return (
    <span
      style={wrapperStyle}
      className={cx(
        "relative block overflow-hidden",
        selfSized ? "max-w-full" : "h-full w-full",
        rounded && "rounded-tokenMd",
      )}
    >
      {showSkeleton ? <span aria-hidden="true" className="absolute inset-0 animate-pulse bg-muted" /> : null}
      {resolvedSrc ? (
        <img
          {...rest}
          ref={imgRef}
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
            "block transition-opacity duration-200",
            selfSized ? "h-auto w-full" : "h-full w-full",
            imageFitClasses[fit],
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}
    </span>
  );
}
