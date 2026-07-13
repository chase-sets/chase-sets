export const listingEvidenceAnalyticsEventNames = [
  "requirement_shown",
  "upload_started",
  "upload_completed",
  "upload_failed",
  "remediation_completed",
  "publication_blocked",
  "publication_succeeded",
] as const;

export type ListingEvidenceAnalyticsEventName = (typeof listingEvidenceAnalyticsEventNames)[number];

export type ListingEvidenceAnalyticsProperties = Readonly<
  Partial<{
    surface: "listing-create" | "listing-detail";
    complete: boolean;
    unmetCount: number;
    slotCount: number;
  }>
>;

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

export function trackListingEvidenceEvent(
  eventName: ListingEvidenceAnalyticsEventName,
  properties: ListingEvidenceAnalyticsProperties = {},
) {
  if (typeof window === "undefined") return;

  const detail = { event: eventName, ...properties };
  window.dispatchEvent(new CustomEvent("chase-sets:listing-evidence-analytics", { detail }));
  window.dataLayer?.push(detail);
}
