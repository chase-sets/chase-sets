import { useState, type HTMLAttributes, type ReactNode } from "react";
import { motion } from "motion/react";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { Card } from "../../components/data-display";
import { Badge } from "../../components/feedback";
import { Icon, type IconName } from "../../icons";
import { toMotionDomProps } from "../../utils/motion-props";
import { MarketStatusBadge, type MarketplaceStatus } from "./commerce-atoms";

export interface ProductCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  title: ReactNode;
  subtitle?: ReactNode;
  price?: ReactNode;
  imageSrc?: string;
  imageAlt?: string;
  imageFit?: "cover" | "contain";
  fallbackImageSrc?: string;
  fallbackImageAlt?: string;
  fallbackImageFit?: "cover" | "contain";
  href?: string;
  target?: string;
  rel?: string;
  onSelect?: () => void;
  selectLabel?: string;
  status?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  actionLabel?: ReactNode;
  children?: ReactNode;
}

export function ProductCard({
  title,
  subtitle,
  price,
  imageSrc,
  imageAlt,
  imageFit = "cover",
  fallbackImageSrc,
  fallbackImageAlt,
  fallbackImageFit = "contain",
  href,
  target,
  rel,
  onSelect,
  selectLabel,
  status,
  meta,
  actions,
  actionLabel,
  children,
  ...rest
}: ProductCardProps) {
  const motionSettings = useChaseMotion();
  const [failedImageSources, setFailedImageSources] = useState<ReadonlySet<string>>(() => new Set());

  const resolvedImageSrc =
    imageSrc && !failedImageSources.has(imageSrc)
      ? imageSrc
      : fallbackImageSrc && !failedImageSources.has(fallbackImageSrc)
        ? fallbackImageSrc
        : undefined;
  const showingFallbackImage = Boolean(fallbackImageSrc) && resolvedImageSrc === fallbackImageSrc;
  const resolvedImageFit = showingFallbackImage ? fallbackImageFit : imageFit;
  const resolvedImageAlt = showingFallbackImage ? (fallbackImageAlt ?? imageAlt ?? "") : (imageAlt ?? "");
  const interactiveMotion = motionSettings.reducedMotion
    ? {}
    : {
        whileHover: { y: -2, scale: 1.01 },
        whileTap: { y: 0, scale: 0.99 },
        transition: { duration: motionSettings.durations.base, ease: motionSettings.easing },
      };
  const content = (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-tokenMd border border-muted bg-surface-2">
        {status ? <div className="absolute left-2 top-2 z-10">{status}</div> : null}
        <div className="flex aspect-[4/3] items-center justify-center">
          {resolvedImageSrc ? (
            <img
              src={resolvedImageSrc}
              alt={resolvedImageAlt}
              onError={() => {
                setFailedImageSources((current) => {
                  if (current.has(resolvedImageSrc)) {
                    return current;
                  }

                  const next = new Set(current);
                  next.add(resolvedImageSrc);
                  return next;
                });
              }}
              className={cx("h-full w-full", resolvedImageFit === "contain" ? "object-contain p-3" : "object-cover")}
            />
          ) : (
            <Icon name="image" size="lg" tone="secondary" />
          )}
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-sm font-semibold leading-snug text-foreground">{title}</div>
        {subtitle ? <div className="text-xs text-secondary">{subtitle}</div> : null}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div>
          {price ? <div className="font-heading text-xl font-semibold text-foreground">{price}</div> : null}
          {meta ? <div className="mt-1 text-xs text-secondary">{meta}</div> : null}
        </div>
        {actions}
      </div>
      {children ? <div>{children}</div> : null}
      {actionLabel ? (
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-accent">
          <span>{actionLabel}</span>
          <Icon name="chevronRight" size="sm" tone="accent" />
        </div>
      ) : null}
    </div>
  );

  const interactiveClassName = cx(
    "focus-ring glass-surface block w-full overflow-hidden rounded-tokenLg border border-muted bg-surface p-4 text-left shadow-tokenSm transition hover:border-accent hover:shadow-tokenMd",
  );

  if (href) {
    return (
      <motion.a
        {...toMotionDomProps(rest)}
        href={href}
        target={target}
        rel={rel ?? (target === "_blank" ? "noreferrer" : undefined)}
        className={interactiveClassName}
        {...interactiveMotion}
      >
        {content}
      </motion.a>
    );
  }

  if (onSelect) {
    return (
      <motion.button
        {...toMotionDomProps(rest)}
        type="button"
        aria-label={selectLabel}
        className={interactiveClassName}
        onClick={onSelect}
        {...interactiveMotion}
      >
        {content}
      </motion.button>
    );
  }

  return (
    <Card {...rest} variant="product" interactive>
      {content}
    </Card>
  );
}

export interface CategoryTileProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  icon: IconName;
  label: ReactNode;
  detail?: ReactNode;
}

export interface MarketplaceProductCardProps {
  href?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  imageSrc?: string;
  imageAlt?: string;
  fallbackImageSrc?: string;
  fallbackImageAlt?: string;
  fallbackImageFit?: "cover" | "contain";
  status: MarketplaceStatus;
  price?: ReactNode;
  meta?: ReactNode;
  actionLabel?: ReactNode;
  categoryTags?: ReactNode[];
  metadataTags?: ReactNode[];
}

export function MarketplaceProductCard({
  href,
  title,
  subtitle,
  description,
  imageSrc,
  imageAlt,
  fallbackImageSrc,
  fallbackImageAlt,
  fallbackImageFit = "contain",
  status,
  price,
  meta,
  actionLabel,
  categoryTags = [],
  metadataTags = [],
}: MarketplaceProductCardProps) {
  return (
    <ProductCard
      href={href}
      title={title}
      subtitle={subtitle}
      imageSrc={imageSrc}
      imageAlt={imageAlt}
      imageFit="cover"
      fallbackImageSrc={fallbackImageSrc}
      fallbackImageAlt={fallbackImageAlt}
      fallbackImageFit={fallbackImageFit}
      status={<MarketStatusBadge status={status} />}
      price={price}
      meta={meta}
      actionLabel={actionLabel}
    >
      <div className="space-y-2">
        {description ? <div className="text-sm text-secondary">{description}</div> : null}
        {categoryTags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {categoryTags.map((tag, index) => (
              <Badge key={index} tone="accent">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
        {metadataTags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {metadataTags.map((tag, index) => (
              <Badge key={index} tone="neutral">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </ProductCard>
  );
}

export function CategoryTile({ icon, label, detail, ...rest }: CategoryTileProps) {
  return (
    <Card {...rest} variant="feature" interactive>
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="rounded-tokenLg border border-accent-soft bg-accent-soft p-3 text-accent shadow-tokenSm">
          <Icon name={icon} size="lg" tone="accent" />
        </div>
        <div>
          <div className="text-sm font-semibold text-foreground">{label}</div>
          {detail ? <div className="mt-1 text-xs text-secondary">{detail}</div> : null}
        </div>
      </div>
    </Card>
  );
}

export interface FeatureCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  icon: IconName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function FeatureCard({ icon, title, description, action, ...rest }: FeatureCardProps) {
  return (
    <Card {...rest} variant="feature">
      <div className="flex gap-4">
        <div className="shrink-0 text-accent">
          <Icon name={icon} size="lg" tone="accent" />
        </div>
        <div className="space-y-2">
          <div className="font-heading text-lg font-semibold text-foreground">{title}</div>
          {description ? <div className="text-sm leading-relaxed text-secondary">{description}</div> : null}
          {action ? <div>{action}</div> : null}
        </div>
      </div>
    </Card>
  );
}

export interface PromoStripProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function PromoStrip({ icon = "spark", title, description, action, ...rest }: PromoStripProps) {
  return (
    <div
      {...rest}
      className="glass-surface glow-accent flex flex-col gap-4 rounded-tokenLg border border-accent-soft p-5 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex items-center gap-4">
        <div className="brand-gradient rounded-tokenLg p-3 text-accent-contrast shadow-tokenMd">
          <Icon name={icon} size="lg" tone="inverse" />
        </div>
        <div>
          <div className="font-heading text-xl font-semibold text-foreground">{title}</div>
          {description ? <div className="mt-1 text-sm text-secondary">{description}</div> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
