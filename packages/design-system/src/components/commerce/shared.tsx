import type { ReactNode } from "react";
import { surfaceSemanticToneClasses } from "../../primitives/layout";
import type { DensityMode } from "../../theme/tokens";

export type MarketplaceDensity = DensityMode;
export type ListingModel = "product" | "service" | "rental" | "booking" | "digital" | "quote" | "local";
export type TrustTone = "verified" | "protection" | "secure" | "policy" | "warning";
export type StatusTone = "success" | "warning" | "error" | "info" | "neutral";

export const densityClasses: Record<MarketplaceDensity, string> = {
  compact: "p-3",
  comfortable: "p-4",
};

// Status tints reuse the canonical `Surface` semantic tone triple. This context
// names the negative tone `error`, so it aliases the `danger` triple, and uses a
// plain `border`/`text-tertiary` frame for the neutral case.
export const statusClasses: Record<StatusTone, string> = {
  success: surfaceSemanticToneClasses.success,
  warning: surfaceSemanticToneClasses.warning,
  error: surfaceSemanticToneClasses.danger,
  info: surfaceSemanticToneClasses.info,
  neutral: "border-border bg-surface-2 text-tertiary",
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
