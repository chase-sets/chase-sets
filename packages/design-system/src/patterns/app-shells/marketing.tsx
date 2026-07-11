import type { HTMLAttributes, ImgHTMLAttributes, ReactNode } from "react";
import { Button } from "../../components/actions";
import { Card, Stat, StatGrid } from "../../components/data-display";
import { Badge, type BadgeProps } from "../../components/feedback";
import { resolveDensityMode, type DensityInput } from "../../theme/tokens";
import { cx } from "../../utils/cx";

export interface MarketplaceFilterAction {
  id: string;
  label: ReactNode;
  selected?: boolean;
  onSelect: () => void;
}

export interface MarketplaceLandingMetric {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
}

export interface MarketplaceHeroBadge {
  label: ReactNode;
  tone?: BadgeProps["tone"];
}

export interface MarketplaceLandingHeroProps {
  badges?: MarketplaceHeroBadge[];
  title: ReactNode;
  description?: ReactNode;
  search: ReactNode;
  filters?: MarketplaceFilterAction[];
  metrics?: MarketplaceLandingMetric[];
}

export function MarketplaceLandingHero({
  badges = [],
  title,
  description,
  search,
  filters = [],
  metrics = [],
}: MarketplaceLandingHeroProps) {
  return (
    <Card variant="feature" glow>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col justify-center gap-5">
          <div className="space-y-3">
            {badges.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {badges.map((badge, index) => (
                  <Badge key={index} tone={badge.tone ?? "accent"}>
                    {badge.label}
                  </Badge>
                ))}
              </div>
            ) : null}
            <h1 className="font-display text-3xl font-semibold leading-tight text-foreground md:text-5xl">{title}</h1>
            {description ? <div className="text-base text-secondary">{description}</div> : null}
          </div>
          {search}
          {filters.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {filters.map((filter) => (
                <Button
                  key={filter.id}
                  tone={filter.selected ? "primary" : "secondary"}
                  size="sm"
                  onClick={filter.onSelect}
                  leadingIcon={filter.id ? "tag" : "grid"}
                >
                  {filter.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        {metrics.length > 0 ? (
          <div className="hidden md:block">
            <StatGrid columns={{ base: 1 }}>
              {metrics.map((metric, index) => (
                <Stat key={index} label={metric.label} value={metric.value} trend={metric.detail} />
              ))}
            </StatGrid>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

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
            {eyebrow ? (
              <div className="text-xs font-semibold uppercase tracking-wide text-primary">{eyebrow}</div>
            ) : null}
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

export interface MarketingVisualCardProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  imageSrc: string;
  imageAlt: string;
  /** `srcset` candidates (e.g. `"/card-600w.webp 600w, /card-1080w.webp 1080w"`) so narrower viewports skip desktop-weight bytes. */
  imageSrcSet?: ImgHTMLAttributes<HTMLImageElement>["srcSet"];
  /** `sizes` describing the image's rendered width per viewport; required for `imageSrcSet` to pick the right candidate. */
  imageSizes?: ImgHTMLAttributes<HTMLImageElement>["sizes"];
  imageFetchPriority?: ImgHTMLAttributes<HTMLImageElement>["fetchPriority"];
  imageLoading?: ImgHTMLAttributes<HTMLImageElement>["loading"];
  imageDecoding?: ImgHTMLAttributes<HTMLImageElement>["decoding"];
  imageWidth?: ImgHTMLAttributes<HTMLImageElement>["width"];
  imageHeight?: ImgHTMLAttributes<HTMLImageElement>["height"];
  imagePosition?: "left" | "center" | "right";
  badge?: ReactNode;
  badgeTone?: BadgeProps["tone"];
  title: ReactNode;
  description?: ReactNode;
}

const marketingVisualCardImagePositionClasses: Record<
  NonNullable<MarketingVisualCardProps["imagePosition"]>,
  string
> = {
  left: "object-left",
  center: "object-center",
  right: "object-right",
};

export function MarketingVisualCard({
  imageSrc,
  imageAlt,
  imageSrcSet,
  imageSizes,
  imageFetchPriority = "auto",
  imageLoading = "lazy",
  imageDecoding = "async",
  imageWidth,
  imageHeight,
  imagePosition = "center",
  badge,
  badgeTone = "neutral",
  title,
  description,
  ...rest
}: MarketingVisualCardProps) {
  return (
    <article
      {...rest}
      className="relative min-h-[22rem] overflow-hidden rounded-tokenLg border border-border bg-surface shadow-tokenLg"
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
        className={cx(
          "absolute inset-0 h-full w-full object-cover",
          marketingVisualCardImagePositionClasses[imagePosition],
        )}
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_34%,transparent)_0%,color-mix(in_srgb,var(--card)_88%,transparent)_58%,var(--card)_100%)]" />
      <div className="relative flex min-h-[22rem] flex-col justify-end gap-3 p-5">
        {badge ? (
          <div className="flex">
            <Badge tone={badgeTone}>{badge}</Badge>
          </div>
        ) : null}
        <div className="max-w-full space-y-2">
          <h3 className="max-w-[34rem] text-pretty font-heading text-xl font-semibold leading-snug text-foreground md:text-2xl">
            {title}
          </h3>
          {description ? <p className="text-sm leading-6 text-secondary">{description}</p> : null}
        </div>
      </div>
    </article>
  );
}
