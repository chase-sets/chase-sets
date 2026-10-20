import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Source-derived inventory of every caller that authors, transports, wires, or
// moderates a Listing Evidence description, Review Feedback, Review Response,
// or Marketplace Report details. Detection is by executable code shape -- the
// command literal, the owner call, the owner implementation, the composition
// call, or the moderation dispatch -- never by file or folder name.

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const shapes = {
  command:
    /\btype:\s*"(?:SubmitReview|UpdateReview|SubmitReviewReply|CreateListing|AddListingPhotos|ClassifyListingPhoto|ReplaceListingPhoto|SubmitMarketplaceReport)"/,
  ownerCall:
    /\.(?:submitReview|updateReview|submitReviewReply|addListingPhotos|classifyListingPhoto|updateListingPhotoClassification|replaceListingPhoto|createListingWithPhotos|reportListing|reportReview)\s*\(/,
  photoUploads: /\blistingPhotoUploads\s*[:,]/,
  ownerImplementation:
    /(?:^|[\s,{])(?:async\s+)?(?:submitReview|updateReview|submitReviewReply|addListingPhotos|classifyListingPhoto|replaceListingPhoto|reportListing|reportReview)\s*(?:\(\s*params|:\s*(?:async|vi\.fn|\())/m,
  composition:
    /\b(?:buildReviewApi|buildMarketplaceApi|createReviewRuntime|createMarketplaceListingRuntime|createMarketplaceReportRuntime|createMarketplaceServices)\s*\(/,
  moderationDispatch: /\.(?:operatorWithdrawReview|operatorRedactReviewFeedback|operatorWithdrawReviewReply)\s*\(/,
} as const;

const mcpToolShape = /\bMcpToolHandler\b/;
const ownerServiceInterface = /\b(?:ReviewServices|MarketplaceListingServices|MarketplaceReportServices)\b/;

type Surface = "domain" | "owner-runtime" | "http" | "browser" | "seed" | "composition" | "moderation";
type InventoryEntry = Readonly<{
  surface: Surface;
  /** What the caller does with authored text, and where the one safeguard applies to it. */
  classification: string;
  /** Source tokens that must be present: the enforcement or the transport this row relies on. */
  evidence: readonly string[];
  /** Source tokens that must stay absent. */
  absent?: readonly string[];
}>;

const SAFEGUARD_BY_DECIDER = "the owner decider runs the safeguard before append";

const inventory: Readonly<Record<string, InventoryEntry>> = {
  "bounded-contexts/marketplace/features/reviews/domain/domain.ts": {
    surface: "domain",
    classification:
      "Review Feedback and Review Response: the safeguard runs inside SubmitReview, UpdateReview and SubmitReviewReply",
    evidence: [
      'assertSafeAuthoredText("review-feedback", feedback);',
      'assertSafeAuthoredText("review-feedback", feedback, state.feedback);',
      'assertSafeAuthoredText("review-response-feedback", feedback);',
    ],
  },
  "bounded-contexts/marketplace/features/listings/domain/domain.ts": {
    surface: "domain",
    classification:
      "Listing Evidence descriptions: new evidence on create/add, changed descriptions on classify/replace",
    evidence: [
      "assertSafeNewPhotoAltTexts(normalizeListingPhotos(command.evidence ?? []))",
      "assertSafeNewPhotoAltTexts(normalizeListingPhotos(command.photos))",
      'assertSafeAuthoredText("listing-evidence-alt-text", altText, target.altText);',
      'assertSafeAuthoredText("listing-evidence-alt-text", replacement.altText, target.altText);',
    ],
  },
  "bounded-contexts/marketplace/features/reports/domain/domain.ts": {
    surface: "domain",
    classification:
      "Report details: private reporter evidence for human review, outside the public-text safeguard and unchanged",
    evidence: ["details: normalizeDetails(command.details)"],
    absent: ["assertSafeAuthoredText"],
  },
  "bounded-contexts/marketplace/features/reviews/api/runtime.ts": {
    surface: "owner-runtime",
    classification: `Review owner services; ${SAFEGUARD_BY_DECIDER}`,
    evidence: ['type: "SubmitReview"', 'type: "UpdateReview"', 'type: "SubmitReviewReply"'],
  },
  "bounded-contexts/marketplace/features/listings/api/runtime.ts": {
    surface: "owner-runtime",
    classification: "Listing owner services; descriptions are judged before any image work, then again by the decider",
    evidence: [
      'assertSafeAuthoredText("listing-evidence-alt-text", upload.altText?.trim());',
      'assertSafeAuthoredText("listing-evidence-alt-text", params.upload.altText?.trim(), target.altText);',
    ],
  },
  "bounded-contexts/marketplace/features/reports/api/runtime.ts": {
    surface: "owner-runtime",
    classification: "Report owner services; report details unchanged",
    evidence: ["details: params.details ?? null"],
    absent: ["assertSafeAuthoredText"],
  },
  "bounded-contexts/marketplace/features/reviews/api/route.ts": {
    surface: "http",
    classification: "Review HTTP authoring: closed rejection codes and the per-account authoring rate limit",
    evidence: [
      "const rateLimited = rateLimitedAuthoring(access.actor.accountId);",
      "error instanceof AuthoredTextRejectedError",
    ],
  },
  "bounded-contexts/marketplace/features/listings/api/route.ts": {
    surface: "http",
    classification: "Listing HTTP create/photos/classify/replace: closed rejection codes",
    evidence: ["...authoredTextListingErrors"],
  },
  "bounded-contexts/marketplace/features/reports/api/route.ts": {
    surface: "http",
    classification: "Report HTTP: report details and the existing report rate limit, unchanged",
    evidence: ['details: typeof body.details === "string" ? body.details : null'],
  },
  "bounded-contexts/marketplace/support/route-support/review-submission-route.tsx": {
    surface: "browser",
    classification: "Review submission action through Review HTTP; closed recovery keeps the draft",
    evidence: ["authoredTextRecoveryFromApiError(error.body)"],
  },
  "bounded-contexts/marketplace/routes/marketplace/account-review.tsx": {
    surface: "browser",
    classification: "Review Response action through Review HTTP; closed recovery keeps the draft",
    evidence: ["authoredTextRecoveryFromApiError(error.body)"],
  },
  "bounded-contexts/marketplace/routes/account-listing.tsx": {
    surface: "browser",
    classification: "Listing detail classify action through Listing HTTP; closed recovery keeps the description",
    evidence: ['intent === "classify-photo" ? authoredTextRecoveryFromApiError(error.body) : null'],
  },
  "bounded-contexts/marketplace/routes/account-listings-new.tsx": {
    surface: "browser",
    classification: "Listing create action uploads evidence through Listing HTTP without a description field",
    evidence: ["createListingWithPhotos("],
    absent: ["listingPhotoAltText"],
  },
  "bounded-contexts/marketplace/support/route-support/review-report-action.ts": {
    surface: "browser",
    classification: "Review report action through Report HTTP; report details unchanged",
    evidence: [".reportReview("],
  },
  "bounded-contexts/discovery/routes/public-account.tsx": {
    surface: "browser",
    classification: "Discovery public profile Review report through Report HTTP; report details unchanged",
    evidence: [".reportReview("],
  },
  "bounded-contexts/discovery/routes/public-listing.tsx": {
    surface: "browser",
    classification: "Discovery public Listing report through Report HTTP; report details unchanged",
    evidence: [".reportListing("],
  },
  "bounded-contexts/checkout/routes/account-sell-list.tsx": {
    surface: "browser",
    classification:
      "Checkout Sell List evidence upload through Listing HTTP; the owner route, runtime and decider enforce, Checkout owns its form copy",
    evidence: ['upload.append("listingPhotoAltText"', "marketplaceApi.addListingPhotos("],
  },
  "bounded-contexts/marketplace/support/runtime-support/seed.ts": {
    surface: "seed",
    classification: `Seeded Reviews and Listing Evidence descriptions; ${SAFEGUARD_BY_DECIDER}`,
    evidence: ["services.reviews.commandHandler(", "altText: `Seed listing evidence image ${index + 1}`"],
  },
  "contracts/catalog-seed/representative-commerce-state.ts": {
    surface: "seed",
    classification:
      "Representative staging seed descriptions through Listing owner services; runtime pre-check and decider enforce",
    evidence: ['altText: "Representative staging listing condition evidence photo"'],
  },
  "bounded-contexts/marketplace/support/runtime-support/services.ts": {
    surface: "composition",
    classification: "Builds the owner runtimes every caller uses; no authored input",
    evidence: ["createReviewRuntime(", "createMarketplaceListingRuntime(", "createMarketplaceReportRuntime("],
  },
  "bounded-contexts/marketplace/index.ts": {
    surface: "composition",
    classification: "Mounts the owner HTTP routes; no authored input",
    evidence: ["buildReviewApi(", "buildMarketplaceApi("],
  },
  "bounded-contexts/marketplace/api.ts": {
    surface: "composition",
    classification: "Mounts Listing and Report HTTP routes on the owner services; no authored input",
    evidence: ["createAccountListingRoutes(services.listings", "createMarketplaceReportRoutes(services.reports)"],
  },
  "bounded-contexts/marketplace/features/reviews/api/http.ts": {
    surface: "composition",
    classification: "Mounts Review HTTP routes on the owner services; no authored input",
    evidence: ["createAccountReviewRoutes(reviews)"],
  },
  "bounded-contexts/marketplace/features/reviews/integrations/moderation/moderation-reaction.ts": {
    surface: "moderation",
    classification: "Recorded Platform Operations actions withdraw or redact through owner commands; authors no text",
    evidence: ["deps.operatorRedactReviewFeedback("],
  },
};

type SourceFile = Readonly<{ path: string; source: string }>;

function isTestFile(file: string) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)(?:tests?|__tests__|test-support|e2e)\//.test(file);
}

function trackedTypeScriptFiles(): readonly SourceFile[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => ({ path: file, source: readFileSync(path.join(repoRoot, file), "utf8") }));
}

function matchingShapes(source: string) {
  return Object.entries(shapes)
    .filter(([, shape]) => shape.test(source))
    .map(([name]) => name);
}

function deriveProductionEntrypoints(files: readonly SourceFile[]) {
  return files
    .filter((file) => !isTestFile(file.path) && matchingShapes(file.source).length > 0)
    .map((file) => file.path)
    .sort();
}

let cachedFiles: readonly SourceFile[] | null = null;
function repositoryFiles() {
  cachedFiles ??= trackedTypeScriptFiles();
  return cachedFiles;
}

describe("issue-5258-marketplace-ac1 authored text entrypoint inventory", () => {
  it("classifies every source-derived entrypoint and reports scanned/total", () => {
    const files = repositoryFiles();
    const derived = deriveProductionEntrypoints(files);
    const scanned = files.filter((file) => file.source.length > 0).length;

    console.info(
      `issue-5258-marketplace-ac1 scanned ${scanned}/${files.length} TypeScript files; ${derived.length} production entrypoints classified`,
    );
    expect(scanned).toBe(files.length);
    expect(derived).toEqual(Object.keys(inventory).sort());
  });

  it("pins each classification to the enforcement or transport it relies on", () => {
    const sources = new Map(repositoryFiles().map((file) => [file.path, file.source]));
    for (const [file, entry] of Object.entries(inventory)) {
      const source = sources.get(file) ?? "";
      for (const token of entry.evidence) expect(source, `${file} (${entry.surface})`).toContain(token);
      for (const token of entry.absent ?? []) expect(source, `${file} (${entry.surface})`).not.toContain(token);
    }
  });

  it.each([
    [
      "a seed-style command dispatch",
      "bounded-contexts/marketplace/support/runtime-support/legacy-reply-backfill.ts",
      'await services.reviews.commandHandler({ streamId, command: { type: "SubmitReviewReply", replyId, subjectAccountId, feedback, submittedAt } });',
    ],
    [
      "a browser description write",
      "bounded-contexts/discovery/routes/item-photo-caption.tsx",
      "await api.updateListingPhotoClassification(listingId, photoId, { altText: caption });",
    ],
    [
      "a new service double",
      "bounded-contexts/catalog/support/runtime-support/listing-proxy.ts",
      "export const listings = { classifyListingPhoto: async (params) => forward(params) };",
    ],
  ])("fails on a planted, differently named sibling: %s", (_label, plantedPath, plantedSource) => {
    const derived = deriveProductionEntrypoints([...repositoryFiles(), { path: plantedPath, source: plantedSource }]);

    expect(derived.filter((file) => !Object.hasOwn(inventory, file))).toEqual([plantedPath]);
  });

  it("finds no authored-text entrypoint on any MCP tool surface", () => {
    const mcpAuthoring = repositoryFiles()
      .filter((file) => !isTestFile(file.path) && mcpToolShape.test(file.source))
      .filter((file) => shapes.command.test(file.source) || shapes.ownerCall.test(file.source))
      .map((file) => file.path);

    expect(mcpAuthoring).toEqual([]);
  });

  it("types every owner-service double against the owner interface", () => {
    const mocks = repositoryFiles().filter(
      (file) => isTestFile(file.path) && shapes.ownerImplementation.test(file.source),
    );

    expect(mocks.length).toBeGreaterThan(0);
    for (const mock of mocks) expect(mock.source, mock.path).toMatch(ownerServiceInterface);
  });
});
