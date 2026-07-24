import { useState, type ImgHTMLAttributes, type MouseEventHandler, type ReactNode } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { Box, Inline, Stack } from "../../primitives/layout";
import { IconButton } from "../actions";
import { ProductMediaImage, type ResponsiveImageSource } from "../data-display/product-media";
import { Badge } from "../feedback";
import { AccountReputationSummary, OrderProtectionBadge, TrustBadge, VerifiedAccountBadge } from "./trust";
import {
  densityClasses,
  hasReviewCount,
  modelLabels,
  normalizeRatingValue,
  type ListingModel,
  type MarketplaceDensity,
} from "./shared";

export interface ListingCardProps {
  href?: string;
  onDetailClick?: MouseEventHandler<HTMLAnchorElement>;
  title: string;
  subtitle?: ReactNode;
  model?: ListingModel;
  cardLayout?: "standard" | "search-result";
  image?: ResponsiveImageSource;
  imageSrc?: string;
  imageSrcSet?: string;
  imageSizes?: string;
  imageAlt?: string;
  imageFetchPriority?: ImgHTMLAttributes<HTMLImageElement>["fetchPriority"];
  imageLoading?: ImgHTMLAttributes<HTMLImageElement>["loading"];
  imageDecoding?: ImgHTMLAttributes<HTMLImageElement>["decoding"];
  imageWidth?: ImgHTMLAttributes<HTMLImageElement>["width"];
  imageHeight?: ImgHTMLAttributes<HTMLImageElement>["height"];
  imageSlot?: "fluid" | "compact-product";
  imageFallback?: ResponsiveImageSource;
  imageFallbackSrc?: string;
  imageFallbackAlt?: string;
  imageFallbackSrcSet?: string;
  imageFallbackSizes?: string;
  imageFallbackMode?: "permanent" | "loading-only";
  showMediaPlaceholder?: boolean;
  price?: ReactNode;
  priceDetail?: ReactNode;
  priceExplanation?: ReactNode;
  rating?: number;
  reviewCount?: number | string;
  sellerName?: string | null;
  sellerHref?: string | null;
  sellerTrust?: ReactNode;
  sellerTrustLabel?: ReactNode;
  sellerVerified?: boolean;
  sellerMeta?: ReactNode;
  sellerFeedbackAction?: ReactNode;
  fulfillment?: ReactNode;
  availability?: ReactNode;
  condition?: ReactNode;
  badges?: ReactNode;
  valueCue?: ReactNode;
  truncateValueCue?: boolean;
  recommendationReason?: ReactNode;
  promotion?: ReactNode;
  protection?: ReactNode;
  returnPolicy?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
  compareAction?: ReactNode;
  detailLinkLabel: string;
  saveLabel: string;
  savedLabel: string;
  watchingLabel: string;
  saved?: boolean;
  watching?: boolean;
  density?: MarketplaceDensity;
  className?: string;
}

export function ListingCard({
  href,
  onDetailClick,
  title,
  subtitle,
  model = "product",
  cardLayout = "standard",
  image,
  imageSrc,
  imageSrcSet,
  imageSizes,
  imageAlt,
  imageFetchPriority = "auto",
  imageLoading = "lazy",
  imageDecoding = "async",
  imageWidth,
  imageHeight,
  imageSlot = "fluid",
  imageFallback,
  imageFallbackSrc,
  imageFallbackAlt,
  imageFallbackSrcSet,
  imageFallbackSizes,
  imageFallbackMode = "permanent",
  showMediaPlaceholder = true,
  price,
  priceDetail,
  priceExplanation,
  rating,
  reviewCount,
  sellerName,
  sellerHref,
  sellerTrust,
  sellerTrustLabel,
  sellerVerified = false,
  sellerMeta,
  sellerFeedbackAction,
  fulfillment,
  availability,
  condition,
  badges,
  valueCue,
  truncateValueCue = true,
  recommendationReason,
  promotion,
  protection,
  returnPolicy,
  primaryAction,
  secondaryAction,
  compareAction,
  detailLinkLabel,
  saveLabel,
  savedLabel,
  watchingLabel,
  saved = false,
  watching = false,
  density = "compact",
  className,
}: ListingCardProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const primaryImage =
    image ??
    (imageSrc
      ? { src: imageSrc, srcSet: imageSrcSet, sizes: imageSizes, width: imageWidth, height: imageHeight }
      : undefined);
  const fallbackImage =
    imageFallback ??
    (imageFallbackSrc
      ? {
          src: imageFallbackSrc,
          srcSet: imageFallbackSrcSet,
          sizes: imageFallbackSizes,
          width: imageWidth,
          height: imageHeight,
        }
      : undefined);
  const hasMediaFrame = Boolean(primaryImage || showMediaPlaceholder);
  const isLinked = Boolean(href);
  const resolvedSellerTrust =
    sellerTrust ??
    (sellerTrustLabel ? (
      sellerVerified ? (
        <VerifiedAccountBadge label={sellerTrustLabel} />
      ) : (
        <TrustBadge tone="policy">{sellerTrustLabel}</TrustBadge>
      )
    ) : null);
  const sellerHasAccountReputation =
    Boolean(sellerName && sellerHref) || normalizeRatingValue(rating) !== null || hasReviewCount(reviewCount);
  const sellerTrustSummary =
    sellerName || resolvedSellerTrust || sellerMeta || sellerFeedbackAction ? (
      <Stack gap={1} minWidth="0">
        <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
          {sellerName && sellerHasAccountReputation ? (
            <AccountReputationSummary
              accountName={sellerName}
              href={sellerHref}
              averageRating={rating}
              reviewCount={reviewCount}
              className="min-w-0"
            />
          ) : sellerName ? (
            <span className="min-w-0 truncate font-semibold leading-5 text-foreground">{sellerName}</span>
          ) : null}
          {resolvedSellerTrust}
        </div>
        {sellerMeta || sellerFeedbackAction ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-secondary">
            {sellerMeta ? <span>{sellerMeta}</span> : null}
            {sellerFeedbackAction}
          </div>
        ) : null}
      </Stack>
    ) : null;
  const resolvedProtection = protection ? <OrderProtectionBadge label={protection} /> : null;
  const hasPrice = price !== undefined && price !== null && price !== false && price !== "";
  const hasMarketSignals = sellerTrustSummary || fulfillment || resolvedProtection || returnPolicy;
  const canUseFallbackAsImage = Boolean(fallbackImage) && imageFallbackMode === "permanent";
  const resolvedImage = primaryImage && !imageFailed ? primaryImage : canUseFallbackAsImage ? fallbackImage : undefined;
  const resolvedImageSrc = resolvedImage?.src;
  const resolvedImageAlt =
    resolvedImageSrc === fallbackImage?.src ? (imageFallbackAlt ?? imageAlt ?? title) : (imageAlt ?? title);
  const isSearchResultLayout = cardLayout === "search-result";
  const showFallbackPreview = Boolean(
    primaryImage &&
    fallbackImage &&
    imageFallbackMode === "permanent" &&
    !imageFailed &&
    primaryImage.src !== fallbackImage.src &&
    (isSearchResultLayout || !imageLoaded),
  );
  const productMediaSlotClassName =
    imageSlot === "compact-product"
      ? isSearchResultLayout
        ? "w-full max-w-[7.25rem] justify-self-center sm:max-w-[7.75rem] md:max-w-[10.25rem]"
        : "w-full max-w-[10rem] justify-self-center"
      : undefined;
  const mediaContainerClassName = isSearchResultLayout
    ? "relative grid min-h-40 place-items-center py-3 pl-3 pr-1 sm:min-h-40 md:min-h-[14rem] md:py-4 md:pl-4 md:pr-1"
    : "relative grid min-h-44 place-items-center sm:min-h-36 sm:items-start sm:justify-items-center";
  const mediaImageClassName = isSearchResultLayout
    ? "relative z-10 aspect-[2.5/3.5] h-auto max-h-40 min-h-0 md:max-h-[12.5rem]"
    : "relative max-h-72 min-h-44 sm:h-auto sm:max-h-80 sm:min-h-0";
  const fallbackPreviewImageClassName = isSearchResultLayout
    ? "absolute z-0 aspect-[2.5/3.5] h-auto max-h-40 min-h-0 -translate-x-2 -translate-y-2 opacity-75 md:max-h-[12.5rem]"
    : "absolute inset-0 max-h-72 min-h-44 sm:h-auto sm:max-h-80 sm:min-h-0";
  const contentClassName = isSearchResultLayout
    ? "gap-2.5 py-3 pl-1 pr-3 md:gap-2.5 md:py-4 md:pl-1 md:pr-4"
    : cx("gap-3", densityClasses[density]);
  return (
    <article
      className={cx(
        "group relative grid overflow-hidden rounded-tokenMd border border-border bg-surface shadow-tokenSm transition-colors hover:border-[color-mix(in_srgb,var(--primary)_38%,var(--border))] focus-within:border-accent",
        hasMediaFrame
          ? isSearchResultLayout
            ? "grid-cols-[minmax(7.5rem,8.25rem)_minmax(0,1fr)] md:grid-cols-[minmax(10.5rem,12.5rem)_minmax(0,1fr)]"
            : density === "compact"
              ? "grid-cols-1 sm:grid-cols-[minmax(9rem,0.95fr)_minmax(0,1fr)]"
              : "sm:grid-cols-[minmax(10rem,0.95fr)_minmax(0,1fr)]"
          : "grid-cols-1",
        isLinked && "cursor-pointer",
        className,
      )}
      data-card-layout={cardLayout}
    >
      {hasMediaFrame ? (
        <div
          className={cx(
            mediaContainerClassName,
            resolvedImageSrc || showFallbackPreview ? "bg-transparent" : "bg-surface-2",
            isLinked && "z-20 pointer-events-none",
          )}
        >
          {showFallbackPreview ? (
            <ProductMediaImage
              src={imageFallbackSrc}
              alt={imageFallbackAlt ?? imageAlt ?? title}
              image={fallbackImage}
              fetchPriority={imageFetchPriority}
              loading={imageLoading}
              decoding={imageDecoding}
              className={cx(fallbackPreviewImageClassName, productMediaSlotClassName)}
              aria-hidden="true"
            />
          ) : null}
          {resolvedImageSrc ? (
            <ProductMediaImage
              src={resolvedImageSrc}
              alt={resolvedImageAlt}
              image={resolvedImage}
              loading={imageLoading}
              decoding={imageDecoding}
              fetchPriority={imageFetchPriority}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageFailed(true)}
              className={cx(mediaImageClassName, productMediaSlotClassName)}
            />
          ) : (
            <div className="grid h-full min-h-36 place-items-center text-sm font-semibold text-tertiary">
              {isSearchResultLayout ? (
                <Icon name="image" size="lg" tone="tertiary" aria-hidden="true" />
              ) : (
                modelLabels[model]
              )}
            </div>
          )}
          {promotion && !isSearchResultLayout ? (
            <div className="absolute left-2 top-2 rounded-tokenFull bg-deal-soft px-2 py-1 text-xs font-semibold text-deal">
              {promotion}
            </div>
          ) : null}
        </div>
      ) : promotion && !isSearchResultLayout ? (
        <div className="px-3 pt-3">
          <div className="inline-flex rounded-tokenFull bg-deal-soft px-2 py-1 text-xs font-semibold text-deal">
            {promotion}
          </div>
        </div>
      ) : null}

      <div className={cx("grid content-start", contentClassName, isLinked && "z-20 pointer-events-none")}>
        <div className="grid gap-1.5">
          {condition || availability ? (
            <Inline gap={2}>
              {condition ? (
                <Badge variant="outline" tone="neutral">
                  {condition}
                </Badge>
              ) : null}
              {availability ? <span className="text-xs font-medium text-secondary">{availability}</span> : null}
            </Inline>
          ) : null}
          {isSearchResultLayout && badges ? <Box>{badges}</Box> : null}
          <div className="relative">
            <h3
              className={cx(
                "m-0 line-clamp-2 font-semibold text-foreground",
                isLinked && "transition-colors hover:text-accent",
                isSearchResultLayout ? "text-sm leading-5 md:text-base md:leading-6" : "text-base leading-6",
              )}
            >
              {title}
            </h3>
            {href ? (
              <a
                href={href}
                aria-label={detailLinkLabel}
                onClick={onDetailClick}
                className="focus-ring pointer-events-auto absolute inset-0 z-30 rounded-tokenSm"
              />
            ) : null}
          </div>
          {subtitle ? <p className="m-0 text-sm font-medium leading-5 text-foreground">{subtitle}</p> : null}
          {valueCue ? (
            <p className={cx("m-0 text-sm leading-5 text-secondary", truncateValueCue && "line-clamp-2")}>{valueCue}</p>
          ) : null}
        </div>

        {hasPrice || priceDetail || priceExplanation ? (
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <Stack gap={1}>
              {hasPrice ? (
                <div
                  className={cx(
                    "font-bold tabular-nums text-foreground",
                    isSearchResultLayout ? "text-lg leading-6" : "text-xl leading-7",
                  )}
                >
                  {price}
                </div>
              ) : null}
              {priceDetail ? <div className="text-xs leading-4 text-tertiary">{priceDetail}</div> : null}
              {priceExplanation ? <div className="text-xs leading-4 text-secondary">{priceExplanation}</div> : null}
            </Stack>
          </div>
        ) : null}

        {hasMarketSignals ? (
          <div className="grid gap-2 text-sm text-secondary">
            {sellerTrustSummary}
            {fulfillment || resolvedProtection || returnPolicy ? (
              <Inline gap={2}>
                {fulfillment ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="truck" size="sm" tone="trust" aria-hidden="true" />
                    {fulfillment}
                  </span>
                ) : null}
                {resolvedProtection}
                {returnPolicy ? <TrustBadge tone="policy">{returnPolicy}</TrustBadge> : null}
              </Inline>
            ) : null}
          </div>
        ) : null}

        {recommendationReason ? (
          <div className="rounded-tokenMd bg-surface-2 px-3 py-2 text-xs leading-4 text-secondary">
            {recommendationReason}
          </div>
        ) : null}

        <div
          className={cx("flex flex-wrap items-center gap-2 pt-1", isLinked && "pointer-events-auto relative z-30")}
          data-primary-action-count="1"
        >
          {primaryAction}
          {secondaryAction ?? (
            <IconButton label={saved ? savedLabel : saveLabel} icon="heart" tone="secondary" aria-pressed={saved} />
          )}
          {compareAction}
          {watching ? <IconButton label={watchingLabel} icon="eye" tone="ghost" aria-pressed /> : null}
        </div>
      </div>
    </article>
  );
}
