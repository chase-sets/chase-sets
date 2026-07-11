import type { MarketplaceReportReason } from "../domain/domain";

export type MarketplaceReportSubmissionSnapshot = Readonly<{
  id: string;
  version: number;
  status: "submitted";
  targetType: "listing" | "review";
  targetId: string;
  reportCount: number;
  threshold: number;
  autoUnlisted: boolean;
}>;

export type ReportListingRequest = Readonly<{
  reason: MarketplaceReportReason;
  details?: string | null;
  sourceRoutePath?: string | null;
}>;

export type ReportReviewRequest = Readonly<{
  reason: MarketplaceReportReason;
  details?: string | null;
  sourceRoutePath?: string | null;
}>;

export type MarketplaceReviewReportSubmissionSnapshot = Readonly<{
  id: string;
  version: number;
  status: "submitted";
  targetType: "review";
  targetId: string;
}>;
