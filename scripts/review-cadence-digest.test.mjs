import { describe, expect, it } from "vitest";
import {
  buildCadenceDigest,
  classifyCadenceComment,
  DEFAULT_LEDGER_COMMENT_LIMIT,
  DEFAULT_REVIEW_PASS_LIMIT,
} from "./review-cadence-digest.mjs";

describe("review cadence digest", () => {
  it("classifies comprehensive review passes", () => {
    expect(classifyCadenceComment("Twenty-ninth Comprehensive Review Update — no new issue was needed")).toBe(
      "review-pass",
    );
    expect(classifyCadenceComment("30th comprehensive review")).toBe("review-pass");
  });

  it("classifies ledger-style evidence comments", () => {
    expect(classifyCadenceComment("Evidence update: record this row in the #1116 launch matrix")).toBe("ledger");
    expect(classifyCadenceComment("Latest-main correction: deploy run superseded")).toBe("ledger");
    expect(classifyCadenceComment("current-main revalidation required before closure")).toBe("ledger");
  });

  it("leaves ordinary comments unclassified", () => {
    expect(classifyCadenceComment("LGTM, merging after CI")).toBe("other");
    expect(classifyCadenceComment("The review of this PR found a bug in the cart totals")).toBe("other");
  });

  it("stays clean within limits", () => {
    const digest = buildCadenceDigest([
      { body: "Weekly comprehensive review: closed #1, delivered #2", html_url: "u1" },
      { body: "normal discussion", html_url: "u2" },
    ]);
    expect(digest.flagged).toBe(false);
    expect(digest.reviewPassCount).toBe(1);
    expect(digest.markdown).toContain("Clean");
  });

  it("flags when review passes exceed the weekly cap", () => {
    const digest = buildCadenceDigest([
      { body: "29th Comprehensive Review Update", html_url: "u1" },
      { body: "30th Comprehensive Review Update", html_url: "u2" },
    ]);
    expect(digest.flagged).toBe(true);
    expect(digest.markdown).toContain("Flagged");
    expect(digest.markdown).toContain("u1");
  });

  it("flags ledger comment storms", () => {
    const comments = Array.from({ length: DEFAULT_LEDGER_COMMENT_LIMIT + 1 }, (_, index) => ({
      body: `Evidence update ${index}: add to the launch matrix`,
      html_url: `u${index}`,
    }));
    const digest = buildCadenceDigest(comments);
    expect(digest.flagged).toBe(true);
    expect(digest.ledgerCommentCount).toBe(DEFAULT_LEDGER_COMMENT_LIMIT + 1);
  });

  it("exposes the default limits", () => {
    expect(DEFAULT_REVIEW_PASS_LIMIT).toBe(1);
    expect(DEFAULT_LEDGER_COMMENT_LIMIT).toBe(10);
  });
});
