import type { HTMLAttributes, ImgHTMLAttributes, ReactNode } from "react";
import { Eyebrow } from "../../primitives/typography";
import { resolveDensityMode, type DensityInput } from "../../theme/tokens";
import { cx } from "../../utils/cx";

export interface MarketingHeroHighlight {
  label: ReactNode;
  value: ReactNode;
}

export interface MarketingImageHeroProps {
  imageSrc: string;
  imageAlt: string;
  /** `srcset` candidates (e.g. `"/hero-800w.webp 800w, /hero-1200w.webp 1200w"`) so narrower viewports skip desktop-weight bytes. */
  imageSrcSet?: ImgHTMLAttributes<HTMLImageElement>["srcSet"];
  /** `sizes` describing the image's rendered width per viewport; required for `imageSrcSet` to pick the right candidate. */
  imageSizes?: ImgHTMLAttributes<HTMLImageElement>["sizes"];
  imageFetchPriority?: ImgHTMLAttributes<HTMLImageElement>["fetchPriority"];
  imageLoading?: ImgHTMLAttributes<HTMLImageElement>["loading"];
  imageDecoding?: ImgHTMLAttributes<HTMLImageElement>["decoding"];
  imageWidth?: ImgHTMLAttributes<HTMLImageElement>["width"];
  imageHeight?: ImgHTMLAttributes<HTMLImageElement>["height"];
  imagePosition?: "left" | "center" | "right";
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  conversionPanel?: ReactNode;
  highlights?: MarketingHeroHighlight[];
  density?: DensityInput;
}

export function MarketingImageHero({
  imageSrc,
  imageAlt,
  imageSrcSet,
  imageSizes,
  imageFetchPriority = "high",
  imageLoading = "eager",
  imageDecoding = "async",
  imageWidth,
  imageHeight,
  imagePosition = "center",
  eyebrow,
  title,
  description,
  actions,
  conversionPanel,
  highlights = [],
  density = "comfortable",
}: MarketingImageHeroProps) {
  const imagePositionClass =
    imagePosition === "left" ? "object-left" : imagePosition === "right" ? "object-right" : "object-[18%_72%]";
  const isCompact = resolveDensityMode(density) === "compact";

  return (
    <section
      className={cx(
        "relative overflow-hidden rounded-tokenLg border border-border bg-surface shadow-tokenLg",
        isCompact ? "min-h-[18rem] sm:min-h-[20rem]" : "min-h-[22rem]",
      )}
    >
      <img
        src={imageSrc}
        srcSet={imageSrcSet}
        sizes={imageSrcSet ? imageSizes : undefined}
        alt={imageAlt}
        loading={imageLoading}
        decoding={imageDecoding}
        fetchPriority={imageFetchPriority}
        width={imageWidth}
        height={imageHeight}
        className={cx("absolute inset-0 h-full w-full object-cover", imagePositionClass)}
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--background)_92%,transparent)_0%,color-mix(in_srgb,var(--background)_78%,transparent)_48%,color-mix(in_srgb,var(--background)_46%,transparent)_100%)] lg:bg-[linear-gradient(90deg,color-mix(in_srgb,var(--background)_94%,transparent)_0%,color-mix(in_srgb,var(--background)_76%,transparent)_44%,color-mix(in_srgb,var(--background)_14%,transparent)_100%)]" />
      <div
        className={cx(
          "relative grid lg:grid-cols-[minmax(0,0.9fr)_minmax(18rem,0.55fr)]",
          isCompact
            ? "min-h-[18rem] gap-3 p-3 sm:min-h-[20rem] sm:p-5 lg:p-6"
            : "min-h-[22rem] gap-4 p-4 sm:gap-5 sm:p-6 lg:p-6",
        )}
      >
        <div className={cx("flex max-w-3xl flex-col justify-start lg:justify-center", isCompact ? "gap-3" : "gap-4")}>
          <div className={cx("grid", isCompact ? "gap-2" : "gap-3")}>
            {eyebrow ? <Eyebrow variant="primary">{eyebrow}</Eyebrow> : null}
            <h1
              className={cx(
                "max-w-2xl font-display font-semibold leading-tight text-foreground md:leading-hero",
                isCompact ? "text-3xl sm:text-4xl md:text-5xl" : "text-3xl sm:text-4xl md:text-5xl",
              )}
            >
              {title}
            </h1>
            {description ? (
              <p
                className={cx(
                  "max-w-2xl text-secondary",
                  isCompact
                    ? "text-sm leading-6 sm:text-base md:text-lg md:leading-7"
                    : "text-base leading-7 md:text-lg",
                )}
              >
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
          {conversionPanel && highlights.length > 0 ? (
            <>
              <div
                className="flex max-w-2xl min-h-[2.75rem] items-center gap-2 rounded-tokenSm border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_76%,transparent)] px-3 py-2 backdrop-blur md:hidden"
                aria-label="Marketing highlight"
              >
                <span className="shrink-0 truncate text-xs font-semibold uppercase tracking-wide text-tertiary">
                  {highlights[0].label}
                </span>
                <span className="truncate text-sm font-semibold text-foreground">{highlights[0].value}</span>
              </div>
              <div className="hidden max-w-2xl grid-cols-3 gap-2 md:grid" aria-label="Marketing highlights">
                {highlights.map((highlight, index) => (
                  <div
                    key={index}
                    className="min-w-0 rounded-tokenSm border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_76%,transparent)] px-3 py-2 backdrop-blur"
                  >
                    <div className="truncate text-xs font-semibold uppercase tracking-wide text-tertiary">
                      {highlight.label}
                    </div>
                    <div className="mt-0.5 truncate text-sm font-semibold text-foreground">{highlight.value}</div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
        {conversionPanel ? (
          <div className="grid w-full min-w-0 content-center lg:justify-self-end">{conversionPanel}</div>
        ) : highlights.length > 0 ? (
          <div className="grid content-end gap-3 lg:justify-self-end">
            {highlights.map((highlight, index) => (
              <div
                key={index}
                className="max-w-sm rounded-tokenLg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_88%,transparent)] p-4 shadow-tokenSm backdrop-blur"
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-tertiary">{highlight.label}</div>
                <div className="mt-1 font-heading text-lg font-semibold text-foreground">{highlight.value}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
