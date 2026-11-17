import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  enumerateReviewReportAttemptCallers, readTrackedMarketplaceCallerSources,
  unpartitionedReviewReportAttemptCallers,
} from "../../../../../scripts/check-structure/marketplace-attempt-callers.mjs";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
describe("review report caller partition", () => {
  it("partitions every tracked producer, including the two reserved-stream seeds", () => {
    const callers = enumerateReviewReportAttemptCallers(readTrackedMarketplaceCallerSources(root));
    expect(callers.length).toBeGreaterThan(12);
    expect(unpartitionedReviewReportAttemptCallers(callers)).toEqual([]);
    const seed = callers.filter((caller) => caller.path.endsWith("/seed.ts"));
    expect(seed).toHaveLength(2);
    const source = readFileSync(path.join(root, "bounded-contexts/marketplace/support/runtime-support/seed.ts"), "utf8");
    for (const direction of ["buyerToSeller", "sellerToBuyer"]) {
      expect(source).toContain(`if (${direction}Review.state.reviewId === null)`);
      expect(source).toContain(`${direction}Review.committed`);
    }
    expect(source).toContain("reputationReservedSeedIds.reviews.buyerToSellerActive");
    expect(source).toContain("reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn");
  });
  it.each([
    "api.submitReview({});", "api.submitReviewReply(id, {});", "api.reportListing(id, {});", "api.reportReview(id, {});",
    'import { submitReview as send } from "./api"; send({});',
    "const { reportListing: send } = api; send({});", "const send = api.reportReview; send({});",
    'request.post("/api/marketplace/reviews", { data: {} });',
    'request.post("/api/marketplace/reviews/rev_one/reply", { data: {} });',
    'request.post("/api/marketplace/listings/lst_one/report", { data: {} });',
    '<Form method="post"><input name="intent" value="report-review" /></Form>',
  ])("rejects an arbitrary-path producer: %s", (source) => {
    const callers = enumerateReviewReportAttemptCallers([{ path: "odd/banana.tsx", source }]);
    expect(callers).toHaveLength(1);
    expect(unpartitionedReviewReportAttemptCallers(callers)).toHaveLength(1);
  });
  it("rejects missing identity and a plain-form bypass at registered paths", () => {
    const file = "bounded-contexts/marketplace/support/route-support/review-report-action.ts";
    expect(unpartitionedReviewReportAttemptCallers(enumerateReviewReportAttemptCallers([{ path: file, source: "api.reportReview(id, { reason });" }]))).toHaveLength(1);
    const ui = "bounded-contexts/marketplace/features/reviews/ui/review-report-action.tsx";
    const source = readFileSync(path.join(root, ui), "utf8");
    expect(unpartitionedReviewReportAttemptCallers(enumerateReviewReportAttemptCallers([{ path: ui, source: source.replaceAll("ReviewMutationForm", "Form") }]))).toHaveLength(1);
  });
  it("has identical built/clean partitions and detects a tree-walk mutant", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "review-report-inventory-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture, stdio: "pipe" });
    try {
      git("init");
      writeFileSync(path.join(fixture, ".gitignore"), ".react-router/\n");
      writeFileSync(path.join(fixture, "banana.ts"), "api.reportReview(id, {});");
      git("add", ".");
      const clean = enumerateReviewReportAttemptCallers(readTrackedMarketplaceCallerSources(fixture));
      expect(unpartitionedReviewReportAttemptCallers(clean)).toHaveLength(1);
      mkdirSync(path.join(fixture, ".react-router/types"), { recursive: true });
      const generated = { path: ".react-router/types/generated.ts", source: "api.submitReview({});" };
      writeFileSync(path.join(fixture, generated.path), generated.source);
      git("add", "-f", generated.path);
      expect(enumerateReviewReportAttemptCallers(readTrackedMarketplaceCallerSources(fixture))).toEqual(clean);
      expect(enumerateReviewReportAttemptCallers([{ path: "banana.ts", source: "api.reportReview(id, {});" }, generated])).not.toEqual(clean);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});
