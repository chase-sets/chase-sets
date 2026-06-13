import type { ReactNode } from "react";

export type MarketplaceDensity = "compact" | "comfortable" | "focused";
export type ListingModel = "product" | "service" | "rental" | "booking" | "digital" | "quote" | "local";
export type TrustTone = "verified" | "protection" | "secure" | "policy" | "warning";
export type StatusTone = "success" | "warning" | "error" | "info" | "neutral";

export const densityClasses: Record<MarketplaceDensity, string> = {
  compact: "p-3",
  comfortable: "p-4",
  focused: "p-5",
};

export const statusClasses: Record<StatusTone, string> = {
  success:
    "border-[color-mix(in_srgb,var(--success)_26%,var(--border))] bg-[var(--success-soft)] text-[var(--success)]",
  warning:
    "border-[color-mix(in_srgb,var(--warning)_32%,var(--border))] bg-[var(--warning-soft)] text-[var(--warning)]",
  error:
    "border-[color-mix(in_srgb,var(--destructive)_26%,var(--border))] bg-[var(--error-soft)] text-[var(--destructive)]",
  info: "border-[color-mix(in_srgb,var(--info)_26%,var(--border))] bg-[var(--info-soft)] text-[var(--info)]",
  neutral: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted-foreground)]",
};

export const modelLabels: Record<ListingModel, string> = {
  product: "Product",
  service: "Service",
  rental: "Rental",
  booking: "Booking",
  digital: "Digital",
  quote: "Quote",
  local: "Local",
};

export function formatMarketplaceNumber(value: unknown, fallback: ReactNode = "Not listed"): ReactNode {
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

export function normalizeRatingValue(value: number | string | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function hasReviewCount(value: number | string | null | undefined): value is number | string {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
  }

  return false;
}
