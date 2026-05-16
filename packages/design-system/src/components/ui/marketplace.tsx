import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  Eye,
  FileText,
  Heart,
  HelpCircle,
  ImageIcon,
  Inbox,
  LifeBuoy,
  Lock,
  MapPin,
  MessageSquare,
  Package,
  PackageCheck,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Star,
  Tag,
  Truck,
  UserCheck,
  XCircle
} from "lucide-react";
import { cn } from "../../lib/utils";
import { Badge } from "./badge";
import { Button } from "./button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card";
import { Input } from "./input";
import { Progress, Skeleton } from "./progress";

export type MarketplaceDensity = "compact" | "comfortable" | "focused";
export type ListingModel = "product" | "service" | "rental" | "booking" | "digital" | "quote" | "local";
export type TrustTone = "verified" | "protection" | "secure" | "policy" | "warning";
export type StatusTone = "success" | "warning" | "error" | "info" | "neutral";
export type AvailabilityTone = "available" | "limited" | "unavailable" | "pending";

const densityClasses: Record<MarketplaceDensity, string> = {
  compact: "p-3",
  comfortable: "p-4",
  focused: "p-5"
};

const statusClasses: Record<StatusTone, string> = {
  success: "border-[color-mix(in_srgb,var(--success)_26%,var(--border))] bg-[var(--success-soft)] text-[var(--success)]",
  warning: "border-[color-mix(in_srgb,var(--warning)_32%,var(--border))] bg-[var(--warning-soft)] text-[var(--warning)]",
  error: "border-[color-mix(in_srgb,var(--destructive)_26%,var(--border))] bg-[var(--error-soft)] text-[var(--destructive)]",
  info: "border-[color-mix(in_srgb,var(--info)_26%,var(--border))] bg-[var(--info-soft)] text-[var(--info)]",
  neutral: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted-foreground)]"
};

const modelLabels: Record<ListingModel, string> = {
  product: "Product",
  service: "Service",
  rental: "Rental",
  booking: "Booking",
  digital: "Digital",
  quote: "Quote",
  local: "Local"
};

export function formatMarketplaceNumber(
  value: unknown,
  fallback: ReactNode = "Not listed",
): ReactNode {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toLocaleString() : fallback;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }

    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric.toLocaleString() : trimmed;
  }

  return fallback;
}

export interface ProductSelectionDetail {
  label: ReactNode;
  value: ReactNode;
}

export function productSelectionDetailsFromSummary(
  summary: string | null | undefined,
): ProductSelectionDetail[] {
  if (!summary) {
    return [];
  }

  return summary
    .split("|")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const [label, ...valueParts] = segment.split(":");
      const value = valueParts.join(":").trim();

      if (!value) {
        return { label: "Product", value: segment };
      }

      return { label: label.trim(), value };
    })
    .filter((selection) => Boolean(selection.label) && Boolean(selection.value));
}

export interface ProductSelectionSummaryProps {
  selections?: readonly ProductSelectionDetail[];
  summary?: ReactNode;
  emptyLabel?: ReactNode;
  summaryAsChip?: boolean;
  className?: string;
}

export function ProductSelectionSummary({
  selections = [],
  summary,
  emptyLabel = "No product selected",
  summaryAsChip = false,
  className,
}: ProductSelectionSummaryProps) {
  if (selections.length === 0) {
    if (summaryAsChip) {
      return (
        <span className={cn("inline-flex flex-wrap items-center justify-end gap-1.5", className)}>
          <span className="inline-flex min-h-7 items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold leading-4 text-[var(--foreground)]">
            {summary ?? emptyLabel}
          </span>
        </span>
      );
    }

    return (
      <span className={cn("text-[var(--text-secondary)]", className)}>
        {summary ?? emptyLabel}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex flex-wrap items-center justify-end gap-1.5", className)}>
      {selections.map((selection, index) => (
        <span
          key={index}
          className="inline-flex min-h-7 items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold leading-4 text-[var(--foreground)]"
        >
          {selection.label}: {selection.value}
        </span>
      ))}
    </span>
  );
}

export interface MarketplaceCartLineItemProps {
  imageSrc: string;
  imageAlt: string;
  imageSrcSet?: string;
  imageSizes?: string;
  loadingImageSrc?: string;
  loadingImageAlt?: string;
  loadingImageSrcSet?: string;
  loadingImageSizes?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  productLabel: ReactNode;
  productSummary: ReactNode;
  quantityControl: ReactNode;
  actions: ReactNode;
}

export function MarketplaceCartLineItem({
  imageSrc,
  imageAlt,
  imageSrcSet,
  imageSizes,
  loadingImageSrc,
  loadingImageAlt,
  loadingImageSrcSet,
  loadingImageSizes,
  title,
  subtitle,
  productLabel,
  productSummary,
  quantityControl,
  actions,
}: MarketplaceCartLineItemProps) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div
      className="surface-border min-w-0 max-w-full rounded-tokenLg bg-elevated p-4 shadow-tokenSm sm:p-5"
      data-marketplace-cart-line
    >
      <div className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] gap-3 sm:grid-cols-[5.5rem_minmax(0,1fr)] md:grid-cols-[5.5rem_minmax(0,1fr)_minmax(13rem,16rem)] md:gap-4">
        <div className="relative min-w-0 overflow-hidden rounded-tokenMd border border-[var(--border)] bg-[var(--surface-2)] shadow-tokenSm">
          {loadingImageSrc && !loaded ? (
            <img
              src={loadingImageSrc}
              alt={loadingImageAlt ?? imageAlt}
              srcSet={loadingImageSrcSet}
              sizes={loadingImageSizes}
              className="absolute inset-0 aspect-[2.5/3.5] h-full w-full object-contain p-1.5"
              aria-hidden="true"
            />
          ) : null}
          <img
            src={imageSrc}
            alt={imageAlt}
            srcSet={imageSrcSet}
            sizes={imageSizes}
            className="aspect-[2.5/3.5] h-full w-full object-contain p-1.5"
            loading="lazy"
            onLoad={() => setLoaded(true)}
          />
        </div>
        <div className="min-w-0 space-y-3">
          <div className="min-w-0 space-y-1">
            <div className="min-w-0 text-base font-semibold leading-snug text-[var(--foreground)]">
              {title}
            </div>
            {subtitle ? (
              <div className="min-w-0 text-sm leading-5 text-[var(--muted-foreground)]">
                {subtitle}
              </div>
            ) : null}
          </div>
          <div className="min-w-0 space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              {productLabel}
            </div>
            <div className="min-w-0">{productSummary}</div>
          </div>
        </div>
        <div className="col-span-2 grid min-w-0 grid-cols-1 items-end gap-3 border-t border-[var(--border)] pt-3 min-[420px]:grid-cols-3 md:col-span-1 md:grid-cols-1 md:border-t-0 md:pt-0">
          <div className="min-w-0">{quantityControl}</div>
          <div
            className="grid min-w-0 gap-2 min-[420px]:contents [&>button]:!min-h-11 md:grid md:grid-cols-1"
            data-cart-line-actions
          >
            {actions}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface TrustBadgeProps {
  children: ReactNode;
  tone?: TrustTone;
  className?: string;
}

export function TrustBadge({ children, tone = "verified", className }: TrustBadgeProps) {
  const Icon =
    tone === "warning"
      ? AlertTriangle
      : tone === "secure"
        ? Lock
        : tone === "policy"
          ? HelpCircle
          : ShieldCheck;
  const toneClass =
    tone === "warning"
      ? "border-[color-mix(in_srgb,var(--warning)_28%,var(--border))] bg-[var(--warning-soft)] text-[var(--warning)]"
      : "border-[color-mix(in_srgb,var(--trust)_28%,var(--border))] bg-[var(--trust-soft)] text-[var(--trust)]";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold leading-4",
        toneClass,
        className
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {children}
    </span>
  );
}

export interface NamedTrustBadgeProps {
  label: ReactNode;
  className?: string;
}

export function VerifiedSellerBadge({ label, className }: NamedTrustBadgeProps) {
  return <TrustBadge className={className}>{label}</TrustBadge>;
}

export function BuyerProtectionBadge({ label, className }: NamedTrustBadgeProps) {
  return <TrustBadge tone="protection" className={className}>{label}</TrustBadge>;
}

export function SecurePaymentCue({ label, className }: NamedTrustBadgeProps) {
  return <TrustBadge tone="secure" className={className}>{label}</TrustBadge>;
}

export interface ReturnPolicySnippetProps {
  label: ReactNode;
  detail?: ReactNode;
  className?: string;
}

export function ReturnPolicySnippet({ label, detail, className }: ReturnPolicySnippetProps) {
  return (
    <div className={cn("flex gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm", className)}>
      <RotateCcw className="mt-0.5 h-4 w-4 text-[var(--trust)]" aria-hidden="true" />
      <div>
        <div className="font-semibold text-[var(--foreground)]">{label}</div>
        {detail ? <div className="leading-5 text-[var(--text-secondary)]">{detail}</div> : null}
      </div>
    </div>
  );
}

export interface DisputeResolutionNoticeProps {
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
}

export function DisputeResolutionNotice({ title, description, action }: DisputeResolutionNoticeProps) {
  return (
    <MarketplaceNotice
      tone="info"
      title={title}
      description={description}
      action={action}
    />
  );
}

export interface SellerQualityIndicatorProps {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
}

export function SellerQualityIndicator({ label, value, detail }: SellerQualityIndicatorProps) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="text-xs font-medium text-[var(--muted-foreground)]">{label}</div>
      <div className="text-base font-bold tabular-nums text-[var(--foreground)]">{value}</div>
      {detail ? <div className="mt-1 text-xs leading-4 text-[var(--text-secondary)]">{detail}</div> : null}
    </div>
  );
}

export interface PlatformCredibilityCueProps {
  title: ReactNode;
  description: ReactNode;
}

export function PlatformCredibilityCue({ title, description }: PlatformCredibilityCueProps) {
  return (
    <div className="flex gap-3 rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--trust)_28%,var(--border))] bg-[var(--trust-soft)] p-4">
      <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--trust)]" aria-hidden="true" />
      <div>
        <div className="font-semibold text-[var(--foreground)]">{title}</div>
        <div className="text-sm leading-5 text-[var(--text-secondary)]">{description}</div>
      </div>
    </div>
  );
}

export interface RatingSummaryProps {
  value: number;
  count?: number | string;
  label?: string;
  compact?: boolean;
}

export function RatingSummary({ value, count, label, compact = false }: RatingSummaryProps) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-[var(--text-secondary)]", compact ? "text-xs" : "text-sm")}
      aria-label={label ?? `${value} rating${count ? ` from ${count} reviews` : ""}`}
    >
      <Star className="h-4 w-4 fill-[var(--rating)] text-[var(--rating)]" aria-hidden="true" />
      <span className="font-semibold tabular-nums text-[var(--foreground)]">{value.toFixed(1)}</span>
      {count ? <span className="tabular-nums">({count})</span> : null}
    </span>
  );
}

export interface ListingCardProps {
  href?: string;
  title: string;
  model?: ListingModel;
  imageSrc?: string;
  imageSrcSet?: string;
  imageSizes?: string;
  imageAlt?: string;
  imageFallbackSrc?: string;
  imageFallbackAlt?: string;
  imageFallbackSrcSet?: string;
  imageFallbackSizes?: string;
  imageFallbackMode?: "permanent" | "loading-only";
  showMediaPlaceholder?: boolean;
  price: ReactNode;
  priceDetail?: ReactNode;
  priceExplanation?: ReactNode;
  rating?: number;
  reviewCount?: number | string;
  sellerName: string;
  sellerTrust?: ReactNode;
  sellerTrustLabel: ReactNode;
  sellerVerified?: boolean;
  sellerMeta?: ReactNode;
  fulfillment: ReactNode;
  availability: ReactNode;
  condition?: ReactNode;
  valueCue?: ReactNode;
  truncateValueCue?: boolean;
  recommendationReason?: ReactNode;
  promotion?: ReactNode;
  protection?: ReactNode;
  returnPolicy?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
  compareAction?: ReactNode;
  saveLabel?: string;
  savedLabel?: string;
  watchingLabel?: string;
  saved?: boolean;
  watching?: boolean;
  density?: MarketplaceDensity;
  className?: string;
}

export function ListingCard({
  href,
  title,
  model = "product",
  imageSrc,
  imageSrcSet,
  imageSizes,
  imageAlt,
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
  sellerTrust,
  sellerTrustLabel,
  sellerVerified = false,
  sellerMeta,
  fulfillment,
  availability,
  condition,
  valueCue,
  truncateValueCue = true,
  recommendationReason,
  promotion,
  protection,
  returnPolicy,
  primaryAction,
  secondaryAction,
  compareAction,
  saveLabel = "Save",
  savedLabel = "Saved",
  watchingLabel = "Watching",
  saved = false,
  watching = false,
  density = "compact",
  className
}: ListingCardProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const hasMediaFrame = Boolean(imageSrc || showMediaPlaceholder);
  const isLinked = Boolean(href);
  const resolvedSellerTrust = sellerTrust ?? (
    sellerVerified
      ? <VerifiedSellerBadge label={sellerTrustLabel} />
      : <TrustBadge tone="policy">{sellerTrustLabel}</TrustBadge>
  );
  const resolvedProtection = protection ? <BuyerProtectionBadge label={protection} /> : null;
  const canUseFallbackAsImage = Boolean(imageFallbackSrc) && imageFallbackMode === "permanent";
  const resolvedImageSrc = imageSrc && !imageFailed
    ? imageSrc
    : canUseFallbackAsImage
      ? imageFallbackSrc
      : undefined;
  const resolvedImageAlt = resolvedImageSrc === imageFallbackSrc
    ? imageFallbackAlt ?? imageAlt ?? title
    : imageAlt ?? title;
  const resolvedImageSrcSet = resolvedImageSrc === imageFallbackSrc
    ? imageFallbackSrcSet
    : imageSrcSet;
  const resolvedImageSizes = resolvedImageSrc === imageFallbackSrc
    ? imageFallbackSizes
    : imageSizes;
  const showLoadingFallback = Boolean(imageSrc && imageFallbackSrc && !imageLoaded && !imageFailed);

  return (
    <article
      className={cn(
        "group relative grid overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-sm)] transition-colors hover:border-[color-mix(in_srgb,var(--primary)_38%,var(--border))] focus-within:border-[var(--primary)]",
        hasMediaFrame
          ? density === "compact"
            ? "grid-cols-1 sm:grid-cols-[minmax(9rem,0.95fr)_minmax(0,1fr)]"
            : "sm:grid-cols-[minmax(10rem,0.95fr)_minmax(0,1fr)]"
          : "grid-cols-1",
        isLinked && "cursor-pointer",
        className
      )}
    >
      {href ? (
        <a
          href={href}
          aria-label={`View details for ${title}`}
          className="focus-ring absolute inset-0 z-10 rounded-[var(--radius)]"
        />
      ) : null}
      {hasMediaFrame ? (
        <div
          className={cn(
            "relative grid min-h-44 place-items-center bg-[var(--surface-2)] sm:min-h-36 sm:items-start sm:justify-items-center",
            isLinked && "z-20 pointer-events-none"
          )}
        >
          {showLoadingFallback ? (
            <img
              src={imageFallbackSrc}
              alt={imageFallbackAlt ?? imageAlt ?? title}
              srcSet={imageFallbackSrcSet}
              sizes={imageFallbackSizes}
              className="absolute inset-0 h-full max-h-72 min-h-44 w-full object-contain p-3 sm:h-auto sm:max-h-80 sm:min-h-0"
              aria-hidden="true"
            />
          ) : null}
          {resolvedImageSrc ? (
            <img
              src={resolvedImageSrc}
              alt={resolvedImageAlt}
              srcSet={resolvedImageSrcSet}
              sizes={resolvedImageSizes}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageFailed(true)}
              className="relative h-full max-h-72 min-h-44 w-full object-contain p-3 sm:h-auto sm:max-h-80 sm:min-h-0"
            />
          ) : (
            <div className="grid h-full min-h-36 place-items-center text-sm font-semibold text-[var(--muted-foreground)]">
              {modelLabels[model]}
            </div>
          )}
          {promotion ? (
            <div className="absolute left-2 top-2 rounded-full bg-[var(--deal-soft)] px-2 py-1 text-xs font-semibold text-[var(--deal)]">
              {promotion}
            </div>
          ) : null}
        </div>
      ) : promotion ? (
        <div className="px-3 pt-3">
          <div className="inline-flex rounded-full bg-[var(--deal-soft)] px-2 py-1 text-xs font-semibold text-[var(--deal)]">
            {promotion}
          </div>
        </div>
      ) : null}

      <div className={cn("grid content-start gap-3", densityClasses[density], isLinked && "z-20 pointer-events-none")}>
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {condition ? <Badge variant="outline">{condition}</Badge> : null}
            {availability ? <span className="text-xs font-medium text-[var(--text-secondary)]">{availability}</span> : null}
          </div>
          <h3 className="m-0 line-clamp-2 text-base font-semibold leading-6 text-[var(--foreground)]">
            {title}
          </h3>
          {valueCue ? (
            <p className={cn("m-0 text-sm leading-5 text-[var(--text-secondary)]", truncateValueCue && "line-clamp-2")}>
              {valueCue}
            </p>
          ) : null}
        </div>

        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="grid gap-1">
            <div className="text-xl font-bold leading-7 tabular-nums text-[var(--foreground)]">{price}</div>
            {priceDetail ? <div className="text-xs leading-4 text-[var(--muted-foreground)]">{priceDetail}</div> : null}
            {priceExplanation ? <div className="text-xs leading-4 text-[var(--text-secondary)]">{priceExplanation}</div> : null}
          </div>
          {rating ? <RatingSummary value={rating} count={reviewCount} compact /> : null}
        </div>

        <div className="grid gap-2 text-sm text-[var(--text-secondary)]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-[var(--foreground)]">{sellerName}</span>
            {resolvedSellerTrust}
            {sellerMeta ? <span>{sellerMeta}</span> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5">
              <Truck className="h-4 w-4 text-[var(--trust)]" aria-hidden="true" />
              {fulfillment}
            </span>
            {resolvedProtection}
            {returnPolicy ? <TrustBadge tone="policy">{returnPolicy}</TrustBadge> : null}
          </div>
        </div>

        {recommendationReason ? (
          <div className="rounded-[var(--radius)] bg-[var(--surface-2)] px-3 py-2 text-xs leading-4 text-[var(--text-secondary)]">
            {recommendationReason}
          </div>
        ) : null}

        <div
          className={cn("flex flex-wrap items-center gap-2 pt-1", isLinked && "pointer-events-auto relative z-30")}
          data-primary-action-count="1"
        >
          {primaryAction}
          {secondaryAction ?? (
            <Button variant="outline" size="icon" aria-label={`${saved ? savedLabel : saveLabel} ${title}`} aria-pressed={saved}>
              <Heart className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          {compareAction}
          {watching ? (
            <Button variant="ghost" size="icon" aria-label={`${watchingLabel} ${title}`} aria-pressed>
              <Eye className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export interface DeliveryEstimateProps {
  label: ReactNode;
  detail?: ReactNode;
  tone?: StatusTone;
}

export function DeliveryEstimate({ label, detail, tone = "neutral" }: DeliveryEstimateProps) {
  return (
    <div className={cn("flex gap-2 rounded-[var(--radius)] border p-3", statusClasses[tone])}>
      <Truck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <div className="font-semibold text-[var(--foreground)]">{label}</div>
        {detail ? <div className="text-sm leading-5 text-[var(--text-secondary)]">{detail}</div> : null}
      </div>
    </div>
  );
}

export interface AvailabilityStateProps {
  label: ReactNode;
  tone?: AvailabilityTone;
  detail?: ReactNode;
}

export function AvailabilityState({ label, tone = "available", detail }: AvailabilityStateProps) {
  const noticeTone: StatusTone =
    tone === "available" ? "success" : tone === "limited" ? "warning" : tone === "unavailable" ? "error" : "info";

  return (
    <div className={cn("inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold", statusClasses[noticeTone])}>
      <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{label}</span>
      {detail ? <span className="font-medium opacity-80">{detail}</span> : null}
    </div>
  );
}

export function ConditionLabel({ children }: { children: ReactNode }) {
  return <Badge variant="outline">{children}</Badge>;
}

export interface WhyThisPriceProps {
  title: ReactNode;
  reasons: Array<{ label: ReactNode; value: ReactNode }>;
}

export function WhyThisPrice({ title, reasons }: WhyThisPriceProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2">
          {reasons.map((reason) => (
            <div key={String(reason.label)} className="flex items-center justify-between gap-4 rounded-[var(--radius)] bg-[var(--surface-2)] px-3 py-2 text-sm">
              <span className="text-[var(--text-secondary)]">{reason.label}</span>
              <span className="font-semibold tabular-nums text-[var(--foreground)]">{reason.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export interface WatchlistButtonProps {
  label: string;
  active?: boolean;
  watchingLabel?: string;
}

export function WatchlistButton({ label, active = false, watchingLabel }: WatchlistButtonProps) {
  return (
    <Button variant="outline" aria-pressed={active}>
      <Heart className="h-4 w-4" aria-hidden="true" />
      {active ? watchingLabel ?? label : label}
    </Button>
  );
}

export interface SavedSearchCardProps {
  title: ReactNode;
  description: ReactNode;
  action: ReactNode;
  filters?: ReactNode[];
}

export function SavedSearchCard({ title, description, action, filters = [] }: SavedSearchCardProps) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-2">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
            {filters.length ? (
              <div className="flex flex-wrap gap-2">
                {filters.map((filter) => <Badge key={String(filter)} variant="secondary">{filter}</Badge>)}
              </div>
            ) : null}
          </div>
          {action}
        </div>
      </CardContent>
    </Card>
  );
}

export interface RecommendationModuleProps {
  title: ReactNode;
  description?: ReactNode;
  items: Array<{ title: ReactNode; reason: ReactNode; action?: ReactNode }>;
}

export function RecommendationModule({ title, description, items }: RecommendationModuleProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <div className="grid gap-3">
          {items.map((item) => (
            <div key={String(item.title)} className="flex items-start justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <div>
                <div className="font-semibold text-[var(--foreground)]">{item.title}</div>
                <div className="text-sm leading-5 text-[var(--text-secondary)]">{item.reason}</div>
              </div>
              {item.action}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export interface ComparisonCardProps {
  title: ReactNode;
  price: ReactNode;
  signals: Array<{ label: ReactNode; value: ReactNode }>;
  action?: ReactNode;
  selected?: boolean;
}

export function ComparisonCard({ title, price, signals, action, selected = false }: ComparisonCardProps) {
  return (
    <article className={cn("grid gap-3 rounded-[var(--radius)] border bg-[var(--card)] p-4 shadow-[var(--shadow-sm)]", selected ? "border-[var(--primary)]" : "border-[var(--border)]")}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="m-0 text-base font-semibold leading-6 text-[var(--foreground)]">{title}</h3>
        <div className="text-lg font-bold tabular-nums text-[var(--foreground)]">{price}</div>
      </div>
      <dl className="grid gap-2">
        {signals.map((signal) => (
          <div key={String(signal.label)} className="flex items-center justify-between gap-3 text-sm">
            <dt className="text-[var(--text-secondary)]">{signal.label}</dt>
            <dd className="m-0 font-semibold text-[var(--foreground)]">{signal.value}</dd>
          </div>
        ))}
      </dl>
      {action ? <div>{action}</div> : null}
    </article>
  );
}

export interface SellerTrustCardProps {
  name: string;
  verified?: boolean;
  rating?: number;
  reviewCount?: number | string;
  completedSales?: ReactNode;
  responseTime?: ReactNode;
  shipsFrom?: ReactNode;
  joined?: ReactNode;
  policies?: Array<{ label: string; value: ReactNode }>;
  actions?: ReactNode;
}

export function SellerTrustCard({
  name,
  verified = false,
  rating,
  reviewCount,
  completedSales,
  responseTime,
  shipsFrom,
  joined,
  policies = [],
  actions
}: SellerTrustCardProps) {
  const facts = [
    completedSales ? { icon: PackageCheck, label: "Completed", value: completedSales } : null,
    responseTime ? { icon: Clock, label: "Response", value: responseTime } : null,
    shipsFrom ? { icon: MapPin, label: "Ships from", value: shipsFrom } : null,
    joined ? { icon: BadgeCheck, label: "Seller since", value: joined } : null
  ].filter(Boolean) as Array<{ icon: typeof PackageCheck; label: string; value: ReactNode }>;

  return (
    <Card className="p-0">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-2">
            <CardTitle>{name}</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {verified ? <TrustBadge>Verified seller</TrustBadge> : <Badge variant="outline">New seller</Badge>}
              {rating ? <RatingSummary value={rating} count={reviewCount} compact /> : null}
            </div>
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label} className="flex gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <fact.icon className="mt-0.5 h-4 w-4 text-[var(--trust)]" aria-hidden="true" />
              <div>
                <div className="text-xs font-medium text-[var(--muted-foreground)]">{fact.label}</div>
                <div className="text-sm font-semibold text-[var(--foreground)]">{fact.value}</div>
              </div>
            </div>
          ))}
        </div>
        {policies.length ? (
          <div className="mt-4 grid gap-2">
            {policies.map((policy) => (
              <div key={policy.label} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-[var(--text-secondary)]">{policy.label}</span>
                <span className="font-semibold text-[var(--foreground)]">{policy.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export interface SearchFilterPanelProps {
  searchLabel: string;
  filterLabel: string;
  clearLabel?: string;
  popularLabel?: ReactNode;
  placeholder?: string;
  resultCount?: ReactNode;
  appliedFilters?: string[];
  popularSearches?: string[];
  actions?: ReactNode;
}

export function SearchFilterPanel({
  searchLabel,
  filterLabel,
  clearLabel,
  popularLabel,
  placeholder,
  resultCount,
  appliedFilters = [],
  popularSearches = [],
  actions
}: SearchFilterPanelProps) {
  return (
    <Card>
      <CardContent className="gap-4 p-0">
        <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
          <label className="relative">
            <span className="sr-only">{searchLabel}</span>
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[var(--muted-foreground)]" aria-hidden="true" />
            <Input className="pl-9" placeholder={placeholder} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline">
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
              {filterLabel}
            </Button>
            {actions}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {resultCount ? <span className="font-semibold text-[var(--foreground)]">{resultCount}</span> : null}
          {appliedFilters.map((filter) => (
            <span key={filter} className="rounded-full bg-[var(--primary-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--primary)]">
              {filter}
            </span>
          ))}
          {appliedFilters.length && clearLabel ? <button className="text-xs font-semibold text-[var(--text-secondary)] underline-offset-4 hover:underline">{clearLabel}</button> : null}
        </div>
        {popularSearches.length ? (
          <div className="flex flex-wrap gap-2 text-sm">
            {popularLabel ? <span className="text-[var(--muted-foreground)]">{popularLabel}</span> : null}
            {popularSearches.map((search) => (
              <button key={search} className="font-semibold text-[var(--primary)] underline-offset-4 hover:underline">
                {search}
              </button>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export interface AppliedFilterChipsProps {
  filters: Array<{ id: string; label: ReactNode; onRemove?: () => void }>;
  clearAction?: ReactNode;
  removeLabel?: (label: ReactNode) => string;
}

export function AppliedFilterChips({ filters, clearAction, removeLabel }: AppliedFilterChipsProps) {
  if (!filters.length && !clearAction) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((filter) => (
        <span key={filter.id} className="inline-flex min-h-8 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 text-xs font-semibold text-[var(--foreground)]">
          {filter.label}
          {filter.onRemove ? (
            <button
              type="button"
              className="ds-focus rounded-full text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              aria-label={removeLabel ? removeLabel(filter.label) : undefined}
              onClick={filter.onRemove}
            >
              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ))}
      {clearAction}
    </div>
  );
}

export interface SavedSearchPromptProps {
  title: ReactNode;
  description: ReactNode;
  action: ReactNode;
}

export function SavedSearchPrompt({ title, description, action }: SavedSearchPromptProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <div className="flex gap-3">
        <Bell className="mt-0.5 h-5 w-5 text-[var(--primary)]" aria-hidden="true" />
        <div>
          <div className="font-semibold text-[var(--foreground)]">{title}</div>
          <div className="text-sm leading-5 text-[var(--text-secondary)]">{description}</div>
        </div>
      </div>
      {action}
    </div>
  );
}

export interface SearchControlBarProps {
  search: ReactNode;
  sort?: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
  filterControlsVisibility?: "always" | "desktop";
  appliedFilters?: ReactNode;
  summary?: ReactNode;
  savedSearch?: ReactNode;
}

export function SearchControlBar({
  search,
  sort,
  filters,
  actions,
  filterControlsVisibility = "always",
  appliedFilters,
  summary,
  savedSearch
}: SearchControlBarProps) {
  const hasControls = Boolean(sort || filters || actions);
  const filterControlsClass =
    filterControlsVisibility === "desktop" ? "hidden lg:flex" : "flex";

  return (
    <section className="grid gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)] p-3 shadow-[var(--shadow-sm)]">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">{search}</div>
        {hasControls ? (
          <div className="flex min-w-0 flex-wrap items-end gap-3 lg:justify-end">
            {sort ? <div className="min-w-44">{sort}</div> : null}
            {filters || actions ? (
              <div className={cn(filterControlsClass, "min-w-0 flex-wrap items-end gap-3")}>
                {filters ? <div className="min-w-44">{filters}</div> : null}
                {actions ? (
                  <div className="flex min-h-11 items-end [&>a]:min-h-11 [&>button]:min-h-11">
                    {actions}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {appliedFilters || summary || savedSearch ? (
        <div className="grid gap-3 border-t border-[var(--border)] pt-3 md:grid-cols-[1fr_auto] md:items-center">
          <div className="grid gap-2">
            {appliedFilters}
            {summary ? <div className="text-sm text-[var(--text-secondary)]">{summary}</div> : null}
          </div>
          {savedSearch}
        </div>
      ) : null}
    </section>
  );
}

export interface SortSelectorProps {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange?: (value: string) => void;
}

export function SortSelector({ label, value, options, onChange }: SortSelectorProps) {
  return (
    <label className="grid gap-1 text-sm font-semibold text-[var(--foreground)]">
      <span>{label}</span>
      <select
        className="ds-focus min-h-11 rounded-[var(--radius)] border border-[var(--input)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)]"
        value={value}
        onChange={(event) => onChange?.(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export interface MarketplaceFilterDrawerProps {
  title: ReactNode;
  open: boolean;
  children: ReactNode;
  footer?: ReactNode;
}

export function MarketplaceFilterDrawer({ title, open, children, footer }: MarketplaceFilterDrawerProps) {
  if (!open) {
    return null;
  }

  return (
    <aside className="fixed inset-x-0 bottom-0 z-drawer max-h-[86vh] overflow-y-auto rounded-t-[var(--radius-xl)] border border-[var(--border)] bg-[var(--card)] p-4 shadow-[var(--shadow-overlay)] md:hidden" aria-label={String(title)}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="m-0 text-base font-semibold text-[var(--foreground)]">{title}</h2>
      </div>
      <div className="grid gap-4">{children}</div>
      {footer ? <div className="sticky bottom-0 mt-4 border-t border-[var(--border)] bg-[var(--card)] pt-3">{footer}</div> : null}
    </aside>
  );
}

export interface NoResultsRecoveryProps {
  title: ReactNode;
  description: ReactNode;
  recommendations?: string[];
  savedSearchAction?: ReactNode;
  resetAction?: ReactNode;
  trustCue?: ReactNode;
}

export function NoResultsRecovery({
  title,
  description,
  recommendations = [],
  savedSearchAction,
  resetAction,
  trustCue
}: NoResultsRecoveryProps) {
  return (
    <MarketplaceEmptyState
      title={title}
      description={description}
      recommendations={recommendations}
      trustCue={trustCue}
      recoveryActions={
        <>
          {resetAction}
          {savedSearchAction}
        </>
      }
    />
  );
}

export interface PriceBreakdownProps {
  title?: ReactNode;
  description?: ReactNode;
  lines: Array<{ label: string; value: ReactNode; muted?: boolean }>;
  total: ReactNode;
  totalLabel?: ReactNode;
  reassurance?: ReactNode;
}

export function PriceBreakdown({ title, description, lines, total, totalLabel, reassurance }: PriceBreakdownProps) {
  return (
    <Card>
      {title || description ? (
        <CardHeader>
          {title ? <CardTitle>{title}</CardTitle> : null}
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent>
        <div className="grid gap-2">
          {lines.map((line) => (
            <div key={line.label} className="flex items-center justify-between gap-4 text-sm">
              <span className={cn(line.muted ? "text-[var(--muted-foreground)]" : "text-[var(--text-secondary)]")}>{line.label}</span>
              <span className="font-semibold tabular-nums text-[var(--foreground)]">{line.value}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-4 border-t border-[var(--border)] pt-4">
          {totalLabel ? <span className="min-w-0 font-semibold text-[var(--foreground)]">{totalLabel}</span> : null}
          <span className="min-w-0 max-w-full break-words text-right text-xl font-bold leading-tight tabular-nums text-[var(--foreground)] sm:text-2xl">{total}</span>
        </div>
        {reassurance ? (
          <div className="mt-4 rounded-[var(--radius)] bg-[var(--trust-soft)] p-3 text-sm font-medium text-[var(--trust)]">
            {reassurance}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export interface ListingPurchasePanelProps {
  title: ReactNode;
  price: ReactNode;
  seller: ReactNode;
  trust: ReactNode;
  availability: ReactNode;
  fulfillment: ReactNode;
  policy: ReactNode;
  protection: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
  reassurance?: ReactNode;
}

export function ListingPurchasePanel({
  title,
  price,
  seller,
  trust,
  availability,
  fulfillment,
  policy,
  protection,
  primaryAction,
  secondaryAction,
  reassurance
}: ListingPurchasePanelProps) {
  return (
    <Card className="border-[color-mix(in_srgb,var(--primary)_22%,var(--border))]">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {reassurance ? <CardDescription>{reassurance}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                Price
              </div>
              <div className="text-3xl font-bold tabular-nums text-[var(--foreground)]">{price}</div>
            </div>
            <TrustBadge>{trust}</TrustBadge>
          </div>
          <div className="grid gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm">
            {[
              ["Seller", seller],
              ["Availability", availability],
              ["Fulfillment", fulfillment],
              ["Returns", policy],
              ["Protection", protection],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex justify-between gap-4">
                <span className="text-[var(--text-secondary)]">{label}</span>
                <span className="text-right font-semibold text-[var(--foreground)]">{value}</span>
              </div>
            ))}
          </div>
          <div className="grid gap-2" data-primary-action-count="1">
            {primaryAction}
            {secondaryAction}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export interface OrderIntentSummaryProps {
  title: ReactNode;
  subtitle?: ReactNode;
  price: ReactNode;
  quantity: ReactNode;
  seller: ReactNode;
  availability: ReactNode;
  fulfillment: ReactNode;
  protection: ReactNode;
  paymentStatus: ReactNode;
}

export function OrderIntentSummary({
  title,
  subtitle,
  price,
  quantity,
  seller,
  availability,
  fulfillment,
  protection,
  paymentStatus
}: OrderIntentSummaryProps) {
  return (
    <Card className="border-[color-mix(in_srgb,var(--trust)_22%,var(--border))]">
      <CardContent>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-base font-semibold leading-6 text-[var(--foreground)]">{title}</div>
              {subtitle ? <div className="text-sm text-[var(--text-secondary)]">{subtitle}</div> : null}
            </div>
            <div className="text-right text-xl font-bold tabular-nums text-[var(--foreground)]">{price}</div>
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            {[
              ["Seller", seller],
              ["Quantity", quantity],
              ["Availability", availability],
              ["Fulfillment", fulfillment],
              ["Protection", protection],
              ["Payment", paymentStatus],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-[var(--radius)] bg-[var(--surface-2)] p-3">
                <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                  {label}
                </div>
                <div className="font-semibold text-[var(--foreground)]">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export interface BuyerProtectionModuleProps {
  title?: ReactNode;
  items: Array<{ title: ReactNode; description: ReactNode; icon?: ReactNode }>;
}

export function BuyerProtectionModule({ title, items }: BuyerProtectionModuleProps) {
  return (
    <Card className="border-[color-mix(in_srgb,var(--trust)_28%,var(--border))] bg-[var(--trust-soft)]">
      {title ? (
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[var(--trust)]">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            {title}
          </CardTitle>
        </CardHeader>
      ) : null}
      <CardContent>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-5">
          {items.map((item) => (
            <div key={String(item.title)} className="flex min-w-0 gap-3">
              <div className="mt-0.5 shrink-0 text-[var(--trust)]">{item.icon ?? <CheckCircle2 className="h-5 w-5" aria-hidden="true" />}</div>
              <div className="min-w-0">
                <div className="font-semibold text-[var(--foreground)]">{item.title}</div>
                <div className="text-sm leading-5 text-[var(--text-secondary)]">{item.description}</div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export interface RatingDistributionProps {
  title?: ReactNode;
  average: number;
  count: number | string;
  rows: Array<{ stars: number; value: number }>;
  starLabel?: (stars: number) => ReactNode;
}

export function RatingDistribution({ title, average, count, rows, starLabel }: RatingDistributionProps) {
  return (
    <Card>
      <CardHeader>
        {title ? <CardTitle>{title}</CardTitle> : null}
        <CardDescription>
          <RatingSummary value={average} count={count} />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2">
          {rows.map((row) => (
            <div key={row.stars} className="grid grid-cols-[3rem_1fr_3rem] items-center gap-3 text-sm">
              <span className="font-medium">{starLabel ? starLabel(row.stars) : row.stars}</span>
              <Progress value={row.value} className="h-2" />
              <span className="text-right tabular-nums text-[var(--muted-foreground)]">{row.value}%</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export interface PolicySummaryProps {
  title: ReactNode;
  policies: Array<{ label: string; value: ReactNode; tone?: StatusTone }>;
}

export function PolicySummary({ title, policies }: PolicySummaryProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2">
          {policies.map((policy) => (
            <div key={policy.label} className="flex items-start justify-between gap-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm">
              <span className="text-[var(--text-secondary)]">{policy.label}</span>
              <span className="font-semibold text-[var(--foreground)]">{policy.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export interface MarketplaceNoticeProps {
  tone?: StatusTone;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function MarketplaceNotice({ tone = "info", title, description, action }: MarketplaceNoticeProps) {
  const Icon = tone === "error" ? XCircle : tone === "warning" ? AlertTriangle : tone === "success" ? CheckCircle2 : HelpCircle;

  return (
    <div className={cn("flex gap-3 rounded-[var(--radius)] border p-4", statusClasses[tone])}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="grid gap-2">
        <div className="font-semibold text-[var(--foreground)]">{title}</div>
        {description ? <div className="text-sm leading-5 text-[var(--text-secondary)]">{description}</div> : null}
        {action ? <div>{action}</div> : null}
      </div>
    </div>
  );
}

export interface PaymentRecoveryPanelProps {
  statusLabel: ReactNode;
  title: ReactNode;
  description: ReactNode;
  chargeStatus: ReactNode;
  nextStep: ReactNode;
  supportPath?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
}

export function PaymentRecoveryPanel({
  statusLabel,
  title,
  description,
  chargeStatus,
  nextStep,
  supportPath,
  primaryAction,
  secondaryAction
}: PaymentRecoveryPanelProps) {
  return (
    <Card className="border-[color-mix(in_srgb,var(--warning)_32%,var(--border))]">
      <CardHeader>
        <Badge variant="warning">{statusLabel}</Badge>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <MarketplaceNotice tone="warning" title={chargeStatus} />
            <MarketplaceNotice tone="info" title={nextStep} description={supportPath} />
          </div>
          <div className="flex flex-wrap gap-2" data-primary-action-count="1">
            {primaryAction}
            {secondaryAction}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export interface StickyCtaBarProps {
  price?: ReactNode;
  context?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
}

export function StickyCtaBar({ price, context, primaryAction, secondaryAction }: StickyCtaBarProps) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_94%,transparent)] px-4 py-3 shadow-[var(--shadow-overlay)] backdrop-blur">
      <div className="mx-auto grid max-w-7xl gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          {price ? <div className="text-lg font-bold tabular-nums text-[var(--foreground)]">{price}</div> : null}
          {context ? <div className="text-xs leading-5 text-[var(--muted-foreground)] sm:truncate">{context}</div> : null}
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:shrink-0" data-primary-action-count="1">
          {secondaryAction}
          {primaryAction}
        </div>
      </div>
    </div>
  );
}

export interface CheckoutConfidencePanelProps {
  title: ReactNode;
  items: Array<{ title: ReactNode; description: ReactNode; icon?: ReactNode }>;
  securePayment?: ReactNode;
}

export function CheckoutConfidencePanel({ title, items, securePayment }: CheckoutConfidencePanelProps) {
  return (
    <Card className="border-[color-mix(in_srgb,var(--trust)_28%,var(--border))] bg-[var(--trust-soft)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[var(--trust)]">
          <Lock className="h-5 w-5" aria-hidden="true" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-3">
          {items.map((item) => (
            <div key={String(item.title)} className="flex gap-3">
              <div className="mt-0.5 text-[var(--trust)]">{item.icon ?? <CheckCircle2 className="h-5 w-5" aria-hidden="true" />}</div>
              <div>
                <div className="font-semibold text-[var(--foreground)]">{item.title}</div>
                <div className="text-sm leading-5 text-[var(--text-secondary)]">{item.description}</div>
              </div>
            </div>
          ))}
        </div>
        {securePayment ? <div className="rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--trust)_24%,var(--border))] bg-[var(--card)] p-3">{securePayment}</div> : null}
      </CardContent>
    </Card>
  );
}

export interface EditableOrderSectionProps {
  title: ReactNode;
  summary: ReactNode;
  editAction?: ReactNode;
  children?: ReactNode;
}

export function EditableOrderSection({ title, summary, editAction, children }: EditableOrderSectionProps) {
  return (
    <section className="grid gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="m-0 text-base font-semibold text-[var(--foreground)]">{title}</h3>
          <div className="text-sm leading-5 text-[var(--text-secondary)]">{summary}</div>
        </div>
        {editAction}
      </div>
      {children}
    </section>
  );
}

export interface GuestCheckoutCueProps {
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
}

export function GuestCheckoutCue({ title, description, action }: GuestCheckoutCueProps) {
  return (
    <MarketplaceNotice
      tone="neutral"
      title={title}
      description={description}
      action={action}
    />
  );
}

export interface PostPurchaseSupportPanelProps {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  policies?: Array<{ label: ReactNode; value: ReactNode }>;
}

export function PostPurchaseSupportPanel({ title, description, actions, policies = [] }: PostPurchaseSupportPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LifeBuoy className="h-5 w-5 text-[var(--trust)]" aria-hidden="true" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {policies.length ? (
          <div className="grid gap-2">
            {policies.map((policy) => (
              <div key={String(policy.label)} className="flex items-center justify-between gap-3 rounded-[var(--radius)] bg-[var(--surface-2)] px-3 py-2 text-sm">
                <span className="text-[var(--text-secondary)]">{policy.label}</span>
                <span className="font-semibold text-[var(--foreground)]">{policy.value}</span>
              </div>
            ))}
          </div>
        ) : null}
        {actions}
      </CardContent>
    </Card>
  );
}

export interface MessageThreadPreviewProps {
  sellerName: string;
  title: ReactNode;
  responseTimeLabel?: ReactNode;
  responseTime?: ReactNode;
  messages: Array<{ author: string; body: ReactNode; meta?: ReactNode }>;
  action?: ReactNode;
}

export function MessageThreadPreview({ title, responseTimeLabel, responseTime, messages, action }: MessageThreadPreviewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-[var(--primary)]" aria-hidden="true" />
          {title}
        </CardTitle>
        {responseTime ? <CardDescription>{responseTimeLabel} {responseTime}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <div className="grid gap-3">
          {messages.map((message) => (
            <div key={`${message.author}-${String(message.body)}`} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-[var(--muted-foreground)]">
                <span>{message.author}</span>
                {message.meta ? <span>{message.meta}</span> : null}
              </div>
              <div className="text-sm leading-5 text-[var(--foreground)]">{message.body}</div>
            </div>
          ))}
          {action}
        </div>
      </CardContent>
    </Card>
  );
}

export interface ProductMediaModuleProps {
  title: string;
  media?: Array<{ src?: string; alt: string; label?: ReactNode }>;
  badges?: ReactNode;
}

export function ProductMediaModule({ title, media = [], badges }: ProductMediaModuleProps) {
  const primary = media[0];
  const thumbnails = media.slice(1, 5);

  return (
    <section className="grid gap-3" aria-label={`${title} media`}>
      <div className="relative grid min-h-80 place-items-center overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-2)]">
        {primary?.src ? (
          <img src={primary.src} alt={primary.alt} className="h-full max-h-[32rem] w-full object-contain p-4" />
        ) : (
          <div className="grid place-items-center gap-3 text-center text-[var(--muted-foreground)]">
            <ImageIcon className="h-10 w-10" aria-hidden="true" />
            <span className="text-sm font-semibold">{primary?.alt ?? "Product media"}</span>
          </div>
        )}
        {badges ? <div className="absolute left-3 top-3 flex flex-wrap gap-2">{badges}</div> : null}
      </div>
      {thumbnails.length ? (
        <div className="grid grid-cols-4 gap-2">
          {thumbnails.map((item) => (
            <button
              key={item.alt}
              type="button"
              className="ds-focus aspect-square overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)]"
              aria-label={`View ${item.alt}`}
            >
              {item.src ? (
                <img src={item.src} alt="" className="h-full w-full object-contain p-2" />
              ) : (
                <span className="grid h-full place-items-center text-xs font-semibold text-[var(--muted-foreground)]">
                  {item.label ?? "Media"}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export interface DetailConfidenceModuleProps {
  title: ReactNode;
  description?: ReactNode;
  items: Array<{ label: string; value: ReactNode; icon?: ReactNode; tone?: StatusTone }>;
}

export function DetailConfidenceModule({ title, description, items }: DetailConfidenceModuleProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <div key={item.label} className="flex gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <div className={cn("mt-0.5", item.tone ? statusClasses[item.tone].split(" ").at(-1) : "text-[var(--trust)]")}>
                {item.icon ?? <CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
              </div>
              <div>
                <div className="text-xs font-medium text-[var(--muted-foreground)]">{item.label}</div>
                <div className="text-sm font-semibold leading-5 text-[var(--foreground)]">{item.value}</div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export interface SpecificationListProps {
  title?: ReactNode;
  specs: Array<{ label: string; value: ReactNode }>;
}

export function SpecificationList({ title, specs }: SpecificationListProps) {
  return (
    <Card>
      {title ? (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent>
        <dl className="grid gap-0 overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
          {specs.map((spec) => (
            <div key={spec.label} className="grid grid-cols-[minmax(8rem,0.8fr)_1fr] gap-3 border-b border-[var(--border)] bg-[var(--card)] px-3 py-2.5 last:border-b-0">
              <dt className="text-sm text-[var(--muted-foreground)]">{spec.label}</dt>
              <dd className="m-0 text-sm font-semibold text-[var(--foreground)]">{spec.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export interface ComparisonModuleProps {
  title?: ReactNode;
  description?: ReactNode;
  signalLabel?: ReactNode;
  columns: string[];
  rows: Array<{ label: string; values: ReactNode[] }>;
}

export function ComparisonModule({ title, description, signalLabel, columns, rows }: ComparisonModuleProps) {
  return (
    <Card>
      {title || description ? (
        <CardHeader>
          {title ? <CardTitle>{title}</CardTitle> : null}
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent>
        <div className="overflow-x-auto">
          <table className="min-w-[42rem] w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border-b border-[var(--border)] px-3 py-2 text-left text-[var(--muted-foreground)]">{signalLabel}</th>
                {columns.map((column) => (
                  <th key={column} className="border-b border-[var(--border)] px-3 py-2 text-left font-semibold text-[var(--foreground)]">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th className="border-b border-[var(--border)] px-3 py-2 text-left font-medium text-[var(--text-secondary)]">{row.label}</th>
                  {row.values.map((value, index) => (
                    <td key={`${row.label}-${columns[index]}`} className="border-b border-[var(--border)] px-3 py-2 font-semibold text-[var(--foreground)]">
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export interface SellerProfileHeaderProps {
  name: string;
  verified?: boolean;
  tagline?: ReactNode;
  stats?: Array<{ label: string; value: ReactNode }>;
  actions?: ReactNode;
}

export function SellerProfileHeader({ name, verified = false, tagline, stats = [], actions }: SellerProfileHeaderProps) {
  return (
    <section className="ds-panel grid gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] p-4 md:grid-cols-[1fr_auto] md:items-end">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-2xl font-bold leading-8 text-[var(--foreground)]">{name}</h2>
          {verified ? <TrustBadge>Verified seller</TrustBadge> : <Badge variant="outline">Building trust</Badge>}
        </div>
        {tagline ? <p className="m-0 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">{tagline}</p> : null}
        {stats.length ? (
          <div className="grid gap-2 sm:grid-cols-4">
            {stats.map((stat) => (
              <div key={stat.label} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <div className="text-lg font-bold tabular-nums text-[var(--foreground)]">{stat.value}</div>
                <div className="text-xs text-[var(--muted-foreground)]">{stat.label}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </section>
  );
}

export interface SellerCredibilityHeaderProps {
  name: ReactNode;
  verification: ReactNode;
  summary?: ReactNode;
  facts: Array<{ label: ReactNode; value: ReactNode }>;
  policies?: Array<{ label: ReactNode; value: ReactNode }>;
  contactAction?: ReactNode;
  reportAction?: ReactNode;
}

export function SellerCredibilityHeader({
  name,
  verification,
  summary,
  facts,
  policies = [],
  contactAction,
  reportAction
}: SellerCredibilityHeaderProps) {
  return (
    <section className="ds-panel grid gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
      <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-start">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-2xl font-bold leading-8 text-[var(--foreground)]">{name}</h2>
            <TrustBadge>{verification}</TrustBadge>
          </div>
          {summary ? <p className="m-0 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">{summary}</p> : null}
        </div>
        {contactAction || reportAction ? (
          <div className="flex flex-wrap gap-2">
            {contactAction}
            {reportAction}
          </div>
        ) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {facts.map((fact) => (
          <div key={String(fact.label)} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <div className="text-sm font-semibold text-[var(--foreground)]">{fact.value}</div>
            <div className="text-xs text-[var(--muted-foreground)]">{fact.label}</div>
          </div>
        ))}
      </div>
      {policies.length ? (
        <div className="grid gap-2 border-t border-[var(--border)] pt-4 sm:grid-cols-2">
          {policies.map((policy) => (
            <div key={String(policy.label)} className="flex gap-2 text-sm">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--trust)]" aria-hidden="true" />
              <div>
                <div className="font-semibold text-[var(--foreground)]">{policy.label}</div>
                <div className="text-[var(--text-secondary)]">{policy.value}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export interface FilterRailProps {
  title: ReactNode;
  groups: Array<{ title: string; options: Array<{ label: string; value?: ReactNode; selected?: boolean }> }>;
  action?: ReactNode;
}

export function FilterRail({ title, groups, action }: FilterRailProps) {
  return (
    <aside className="grid gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-base font-semibold">{title}</h2>
        {action}
      </div>
      {groups.map((group) => (
        <fieldset key={group.title} className="grid gap-2 border-t border-[var(--border)] pt-4">
          <legend className="mb-1 text-sm font-semibold text-[var(--foreground)]">{group.title}</legend>
          {group.options.map((option) => (
            <label key={option.label} className="flex min-h-9 items-center justify-between gap-3 text-sm">
              <span className="inline-flex items-center gap-2">
                <input type="checkbox" defaultChecked={option.selected} className="h-4 w-4 accent-[var(--primary)]" />
                {option.label}
              </span>
              {option.value ? <span className="text-xs text-[var(--muted-foreground)]">{option.value}</span> : null}
            </label>
          ))}
        </fieldset>
      ))}
    </aside>
  );
}

export interface ReviewCardProps {
  author: string;
  rating: number;
  body: ReactNode;
  meta?: ReactNode;
  verified?: boolean;
  sellerResponse?: ReactNode;
}

export function ReviewCard({ author, rating, body, meta, verified = false, sellerResponse }: ReviewCardProps) {
  return (
    <article className="grid gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-[var(--foreground)]">{author}</div>
          {meta ? <div className="text-xs text-[var(--muted-foreground)]">{meta}</div> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RatingSummary value={rating} compact />
          {verified ? <Badge variant="trust">Verified purchase</Badge> : null}
        </div>
      </div>
      <p className="m-0 text-sm leading-6 text-[var(--text-secondary)]">{body}</p>
      {sellerResponse ? (
        <div className="rounded-[var(--radius)] bg-[var(--surface-2)] p-3 text-sm leading-5 text-[var(--text-secondary)]">
          <span className="font-semibold text-[var(--foreground)]">Seller response: </span>
          {sellerResponse}
        </div>
      ) : null}
    </article>
  );
}

export interface MarketplaceEmptyStateProps {
  title: ReactNode;
  description: ReactNode;
  recoveryActions?: ReactNode;
  recommendations?: string[];
  trustCue?: ReactNode;
}

export function MarketplaceEmptyState({
  title,
  description,
  recoveryActions,
  recommendations = [],
  trustCue
}: MarketplaceEmptyStateProps) {
  return (
    <section className="grid gap-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--card)] p-6 text-center">
      <Inbox className="mx-auto h-10 w-10 text-[var(--muted-foreground)]" aria-hidden="true" />
      <div className="grid gap-2">
        <h2 className="m-0 text-xl font-bold text-[var(--foreground)]">{title}</h2>
        <p className="m-0 mx-auto max-w-xl text-sm leading-6 text-[var(--text-secondary)]">{description}</p>
      </div>
      {trustCue ? <div className="mx-auto w-full max-w-2xl text-left">{trustCue}</div> : null}
      {recommendations.length ? (
        <div className="flex flex-wrap justify-center gap-2">
          {recommendations.map((recommendation) => (
            <Badge key={recommendation} variant="secondary">{recommendation}</Badge>
          ))}
        </div>
      ) : null}
      {recoveryActions ? <div className="flex flex-wrap justify-center gap-2">{recoveryActions}</div> : null}
    </section>
  );
}

export function ListingGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="grid grid-cols-[112px_1fr] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)]">
          <Skeleton className="h-36 rounded-none" />
          <div className="grid gap-3 p-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-9 w-32" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DetailModuleSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]" aria-hidden="true">
      <Skeleton className="min-h-80" />
      <div className="grid gap-3">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-11 w-40" />
      </div>
    </div>
  );
}

export function CheckoutSummarySkeleton() {
  return (
    <div className="grid gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4" aria-hidden="true">
      <Skeleton className="h-5 w-36" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-8 w-32" />
    </div>
  );
}

export function SellerProfileSkeleton() {
  return (
    <div className="grid gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)] p-4" aria-hidden="true">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-full" />
      <div className="grid gap-2 sm:grid-cols-4">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    </div>
  );
}

export interface MarketplaceStatusTimelineProps {
  steps: Array<{ label: string; description?: ReactNode; status: "complete" | "current" | "upcoming" | "issue" }>;
}

export function MarketplaceStatusTimeline({ steps }: MarketplaceStatusTimelineProps) {
  const iconByStatus = {
    complete: CheckCircle2,
    current: Clock,
    upcoming: Package,
    issue: AlertTriangle
  };

  return (
    <ol className="grid gap-3">
      {steps.map((step) => {
        const Icon = iconByStatus[step.status];
        const tone = step.status === "issue" ? "warning" : step.status === "complete" ? "success" : step.status === "current" ? "info" : "neutral";

        return (
          <li key={step.label} className="flex gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-3">
            <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full border", statusClasses[tone])}>
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <div className="font-semibold text-[var(--foreground)]">{step.label}</div>
              {step.description ? <div className="text-sm leading-5 text-[var(--text-secondary)]">{step.description}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface OfferCardProps {
  title: ReactNode;
  amount: ReactNode;
  status?: ReactNode;
  details?: ReactNode;
  actions?: ReactNode;
}

export function OfferCard({ title, amount, status, details, actions }: OfferCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{title}</CardTitle>
            {status ? <CardDescription>{status}</CardDescription> : null}
          </div>
          <div className="text-right text-2xl font-bold tabular-nums text-[var(--foreground)]">{amount}</div>
        </div>
      </CardHeader>
      <CardContent>
        {details ? <div className="text-sm leading-6 text-[var(--text-secondary)]">{details}</div> : null}
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </CardContent>
    </Card>
  );
}

export interface MarketplaceDashboardPanelProps {
  title: ReactNode;
  description?: ReactNode;
  metrics: Array<{ label: string; value: ReactNode; detail?: ReactNode }>;
  action?: ReactNode;
}

export function MarketplaceDashboardPanel({ title, description, metrics, action }: MarketplaceDashboardPanelProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-3">
          {metrics.map((metric) => (
            <div key={metric.label} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <div className="text-2xl font-bold tabular-nums text-[var(--foreground)]">{metric.value}</div>
              <div className="text-sm font-medium text-[var(--text-secondary)]">{metric.label}</div>
              {metric.detail ? <div className="mt-1 text-xs text-[var(--muted-foreground)]">{metric.detail}</div> : null}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export interface CategoryNavigationProps {
  items: Array<{ label: string; href?: string; count?: ReactNode; active?: boolean }>;
}

export function CategoryNavigation({ items }: CategoryNavigationProps) {
  return (
    <nav aria-label="Marketplace categories" className="overflow-x-auto">
      <div className="flex min-w-max gap-2">
        {items.map((item) => (
          <a
            key={item.label}
            href={item.href ?? "#"}
            aria-current={item.active ? "page" : undefined}
            className={cn(
              "ds-focus inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-semibold",
              item.active
                ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "border-[var(--border)] bg-[var(--card)] text-[var(--text-secondary)] hover:border-[var(--primary)] hover:text-[var(--foreground)]"
            )}
          >
            {item.label}
            {item.count ? <span className="text-xs opacity-75">{item.count}</span> : null}
          </a>
        ))}
      </div>
    </nav>
  );
}

export interface MarketplaceTemplateGalleryProps {
  templates: Array<{ name: string; purpose: ReactNode; criticalSignals: string[]; primaryAction: string }>;
}

export function MarketplaceTemplateGallery({ templates }: MarketplaceTemplateGalleryProps) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {templates.map((template) => (
        <article key={template.name} className="grid gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="m-0 text-base font-semibold text-[var(--foreground)]">{template.name}</h3>
              <p className="m-0 mt-1 text-sm leading-5 text-[var(--text-secondary)]">{template.purpose}</p>
            </div>
            <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" aria-hidden="true" />
          </div>
          <div className="flex flex-wrap gap-2">
            {template.criticalSignals.map((signal) => (
              <Badge key={signal} variant="secondary">{signal}</Badge>
            ))}
          </div>
          <div className="text-xs font-semibold uppercase text-[var(--muted-foreground)]">Primary action: {template.primaryAction}</div>
        </article>
      ))}
    </div>
  );
}

export const marketplaceDesignPrinciples = [
  "Trust before persuasion",
  "Clarity before cleverness",
  "Speed before visual complexity",
  "Comparison before exploration",
  "Consistency before novelty",
  "Accessibility before aesthetics",
  "Conversion through confidence, not pressure"
] as const;

export const marketplacePageTemplates = [
  "Homepage",
  "Category page",
  "Search results page",
  "Listing detail page",
  "Seller profile page",
  "Cart or order summary page",
  "Checkout page",
  "Confirmation page",
  "Buyer dashboard",
  "Messages/negotiation page",
  "Empty search results page",
  "Error state page"
] as const;

export const marketplaceIconGuidance = {
  trust: ShieldCheck,
  payment: CreditCard,
  delivery: Truck,
  seller: UserCheck,
  policy: FileText,
  deal: Tag,
  support: LifeBuoy,
  notification: Bell,
  booking: CalendarDays,
  return: RotateCcw,
  recovery: RefreshCcw,
  cart: ShoppingCart
} as const;

export function SecurePaymentIndicator({ label }: { label?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--trust)]">
      <CreditCard className="h-4 w-4" aria-hidden="true" />
      {label}
    </span>
  );
}
