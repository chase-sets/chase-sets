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

  // Surface-diet law: the hero is furniture, so its root carries no border,
  // fill or shadow. Below `lg` the root bleeds by exactly the `Page` gutter
  // (`px-4 md:px-6` in page-layouts.tsx; `Page` clips at its padding box, so
  // the bleed reaches its outer edge) and the image and scrim run edge to edge
  // with square corners; from `lg` up they are clipped to the token radius on
  // their own. The copy grid pads by the same gutter so the eyebrow, title and
  // panel sit back on the page gutter. Only the `conversionPanel` slot may
  // render raised.
  return (
    <section
      className={cx("relative -mx-4 md:-mx-6 lg:mx-0", isCompact ? "min-h-[18rem] sm:min-h-[20rem]" : "min-h-[22rem]")}
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
        className={cx("absolute inset-0 h-full w-full object-cover lg:rounded-tokenLg", imagePositionClass)}
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--background)_92%,transparent)_0%,color-mix(in_srgb,var(--background)_78%,transparent)_48%,color-mix(in_srgb,var(--background)_46%,transparent)_100%)] lg:rounded-tokenLg lg:bg-[linear-gradient(90deg,color-mix(in_srgb,var(--background)_94%,transparent)_0%,color-mix(in_srgb,var(--background)_76%,transparent)_44%,color-mix(in_srgb,var(--background)_14%,transparent)_100%)]" />
      <div
        className={cx(
          "relative grid px-4 md:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(18rem,0.55fr)] lg:p-6",
          isCompact ? "min-h-[18rem] gap-3 py-3 sm:min-h-[20rem] sm:py-5" : "min-h-[22rem] gap-4 py-4 sm:gap-5 sm:py-6",
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
            // Highlights are copy, not tiles: flush label/value text rows with
            // the mobile first-highlight and desktop three-column behavior.
            <>
              <div className="flex max-w-2xl items-center gap-2 md:hidden" aria-label="Marketing highlight">
                <span className="shrink-0 truncate text-xs font-semibold uppercase tracking-wide text-tertiary">
                  {highlights[0].label}
                </span>
                <span className="truncate text-sm font-semibold text-foreground">{highlights[0].value}</span>
              </div>
              <div className="hidden max-w-2xl grid-cols-3 gap-4 md:grid" aria-label="Marketing highlights">
                {highlights.map((highlight, index) => (
                  <div key={index} className="min-w-0">
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
              <div key={index} className="max-w-sm">
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
