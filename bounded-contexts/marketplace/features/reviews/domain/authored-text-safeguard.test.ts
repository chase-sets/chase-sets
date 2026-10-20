import { describe, expect, it, vi } from "vitest";
import {
  assertSafeAuthoredText,
  AuthoredTextRejectedError,
  authoredTextRejectionCodes,
  findAuthoredTextRejection,
} from "./authored-text-safeguard";
import { decideReview, evolveReview, initialReviewState, type ReviewEvent, type ReviewState } from "./domain";

const SECRET_MARKER = "SECRET-MARKER-7281";

const acceptedText: readonly (readonly [string, string])[] = [
  ["plain prose", "Great seller, fast shipping!"],
  ["line breaks and tabs", "Line one\nLine two\r\n\tIndented line"],
  ["non-Latin scripts, symbols and emoji", "Envío rápido 🚀 素晴らしい売り手 — 5/5 ★ Отлично"],
  [
    "emoji joiner sequences",
    "Family 👨\u200D👩\u200D👧 and flag 🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
  ],
  ["zero-width non-joiner inside a word", "می\u200Cخواهم"],
  ["right-to-left text with direction marks", "שלום\u200F עולם مرحبا\u200E"],
  ["one https link", "Photos at https://example.com/cards/1."],
  ["two distinct https links", "https://a.example/x and https://b.example/y"],
  ["same host with different paths", "https://a.example/one https://a.example/two"],
  [
    "colons in ordinary prose",
    "Note: fast. Rating:5/5 at 10:30, re:shipping. Tracking data: delivered. File: on record",
  ],
  ["mailto and tel are not script or data schemes", "Reach me via the order page, not mailto:x or tel:1"],
  ["a word that merely contains a scheme name", "Seejavascript:later and metadata:intact"],
];

const rejectedText: readonly (readonly [string, string, string])[] = [
  ["NUL", "Nice\u0000seller", "text_control_character"],
  ["bell", "\u0007Bell", "text_control_character"],
  ["terminal escape sequence", "\u001b[31mred", "text_control_character"],
  ["delete", "Fine\u007f", "text_control_character"],
  ["C1 next line", "Fine\u0085seller", "text_control_character"],
  ["right-to-left override", "Great \u202Eevil", "text_direction_override"],
  ["left-to-right embedding", "\u202Aembedded\u202C", "text_direction_override"],
  ["direction isolates", "\u2066isolate\u2069", "text_direction_override"],
  ["javascript scheme", "javascript:alert(1)", "text_unsafe_link"],
  ["mixed-case javascript scheme", "Click JaVaScRiPt:alert(1)", "text_unsafe_link"],
  ["fullwidth javascript scheme", "ｊａｖａｓｃｒｉｐｔ：alert(1)", "text_unsafe_link"],
  ["zero-width split javascript scheme", "java\u200Bscript:alert(1)", "text_unsafe_link"],
  ["soft-hyphen split javascript scheme", "java\u00ADscript:alert(1)", "text_unsafe_link"],
  ["bracketed javascript scheme", "<javascript:alert(1)>", "text_unsafe_link"],
  ["data scheme", "data:text/html;base64,PHNjcmlwdD4=", "text_unsafe_link"],
  ["vbscript scheme", "vbscript:msgbox(1)", "text_unsafe_link"],
  ["blob scheme", "blob:https://example.com/id", "text_unsafe_link"],
  ["file scheme", "file:///etc/passwd", "text_unsafe_link"],
  ["http link", "See http://example.com", "text_unsafe_link"],
  ["ftp link", "ftp://files.example/card.png", "text_unsafe_link"],
  ["javascript with slashes", "javascript://%0aalert(1)", "text_unsafe_link"],
  ["repeated https link", "https://spam.example/buy https://spam.example/buy", "text_duplicate_link"],
  [
    "repeated link differing by host case and trailing slash",
    "https://Spam.Example/buy and https://spam.example/buy/",
    "text_duplicate_link",
  ],
  [
    "repeated link differing by punctuation and fragment",
    "https://a.example/x#1, https://a.example/x#2.",
    "text_duplicate_link",
  ],
  [
    "repeated link after fullwidth normalization",
    "https://ｓｐａｍ.example/buy https://spam.example/buy",
    "text_duplicate_link",
  ],
  ["repeated link inside one token", "https://a.example/x,https://a.example/x", "text_duplicate_link"],
];

describe("issue-5258-marketplace-ac2 authored text safeguard matrix", () => {
  it.each(acceptedText)("accepts %s", (_name, text) => {
    expect(findAuthoredTextRejection(text)).toBeNull();
    expect(() => assertSafeAuthoredText("review-feedback", text)).not.toThrow();
  });

  it.each(rejectedText)("rejects %s with its closed code", (_name, text, code) => {
    expect(findAuthoredTextRejection(text)).toBe(code);
  });

  it("publishes exactly the closed deterministic rejection codes", () => {
    expect(authoredTextRejectionCodes).toEqual([
      "text_control_character",
      "text_direction_override",
      "text_unsafe_link",
      "text_duplicate_link",
    ]);
    expect(new Set(rejectedText.map(([, , code]) => code))).toEqual(new Set(authoredTextRejectionCodes));
  });

  it("reports the first failing check in a fixed order", () => {
    expect(findAuthoredTextRejection("\u0000 \u202E javascript:x https://a.example https://a.example")).toBe(
      "text_control_character",
    );
    expect(findAuthoredTextRejection("\u202E javascript:x https://a.example https://a.example")).toBe(
      "text_direction_override",
    );
    expect(findAuthoredTextRejection("https://a.example https://a.example javascript:x")).toBe("text_unsafe_link");
  });

  it("treats absent text as nothing to judge", () => {
    expect(() => assertSafeAuthoredText("review-feedback", null)).not.toThrow();
    expect(() => assertSafeAuthoredText("review-feedback", undefined)).not.toThrow();
    expect(() => assertSafeAuthoredText("review-feedback", "")).not.toThrow();
  });

  it("does not re-judge a value carried forward unchanged from the stored value", () => {
    const legacy = "Legacy \u202Etext";
    expect(() => assertSafeAuthoredText("listing-evidence-alt-text", legacy, legacy)).not.toThrow();
    expect(() => assertSafeAuthoredText("listing-evidence-alt-text", legacy, "Another stored value")).toThrow(
      AuthoredTextRejectedError,
    );
  });

  it("throws a closed error that names the field and code but never the authored text", () => {
    let caught: unknown;
    try {
      assertSafeAuthoredText("review-response-feedback", `${SECRET_MARKER} javascript:alert(1)`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuthoredTextRejectedError);
    const rejection = caught as AuthoredTextRejectedError;
    expect(rejection.field).toBe("review-response-feedback");
    expect(rejection.code).toBe("text_unsafe_link");
    expect(rejection.message).not.toContain(SECRET_MARKER);
    expect(JSON.stringify({ ...rejection, message: rejection.message })).not.toContain(SECRET_MARKER);
  });

  it("parses each link of one whitespace-free run of many distinct links once", () => {
    const adversarial = Array.from({ length: 20_000 }, (_, index) => `,https://h${index}.example`).join("");
    const NativeURL = URL;
    let parses = 0;
    let parsedCharacters = 0;
    vi.stubGlobal(
      "URL",
      class CountingURL extends NativeURL {
        public constructor(input: string | URL, base?: string | URL) {
          parses += 1;
          parsedCharacters += String(input).length;
          super(input, base);
        }
      },
    );
    try {
      expect(findAuthoredTextRejection(adversarial)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }

    // A link ends where the next scheme starts, so the parser reads each input
    // character at most once; a span running to the end of the run would not.
    expect(parses).toBe(20_000);
    expect(parsedCharacters).toBeLessThanOrEqual(adversarial.length);
  });
});

const UNSAFE_FEEDBACK = "Great seller javascript:alert(1)";
const LEGACY_FEEDBACK = "Legacy feedback \u202Ereversed";

function submitReviewCommand(feedback: string | null) {
  return {
    type: "SubmitReview",
    reviewId: "rev_1" as never,
    orderId: "ord_1" as never,
    authorAccountId: "acc_buyer" as never,
    subjectAccountId: "acc_seller" as never,
    authorRole: "buyer",
    rating: 5,
    feedback,
    submittedAt: "2026-04-02T00:00:00.000Z",
    reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
  } as const;
}

function legacySubmittedReview(feedback: string): ReviewEvent {
  return {
    type: "marketplace.review.submitted",
    data: {
      reviewId: "rev_1" as never,
      orderId: "ord_1" as never,
      authorAccountId: "acc_buyer" as never,
      subjectAccountId: "acc_seller" as never,
      authorRole: "buyer",
      rating: 5,
      feedback,
      submittedAt: "2026-04-02T00:00:00.000Z",
      reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
    },
  } as ReviewEvent;
}

function replay(events: readonly ReviewEvent[], state: ReviewState = initialReviewState) {
  return events.reduce(evolveReview, state);
}

function rejection(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error instanceof AuthoredTextRejectedError ? { field: error.field, code: error.code } : error;
  }
  return null;
}

describe("issue-5258-marketplace-ac2 review decider safeguard", () => {
  it("rejects unsafe Review Feedback on submission with no event", () => {
    expect(rejection(() => decideReview(initialReviewState, submitReviewCommand(UNSAFE_FEEDBACK)))).toEqual({
      field: "review-feedback",
      code: "text_unsafe_link",
    });
    expect(
      decideReview(initialReviewState, submitReviewCommand("Fast shipping, see https://example.com/p")),
    ).toHaveLength(2);
  });

  it("rejects newly authored unsafe feedback on update but carries stored legacy feedback forward", () => {
    const legacyState = replay([legacySubmittedReview(LEGACY_FEEDBACK)]);

    expect(
      rejection(() =>
        decideReview(legacyState, {
          type: "UpdateReview",
          rating: 4,
          feedback: "Edited \u0007",
          updatedAt: "2026-04-02T01:00:00.000Z",
        }),
      ),
    ).toEqual({ field: "review-feedback", code: "text_control_character" });
    expect(
      decideReview(legacyState, {
        type: "UpdateReview",
        rating: 4,
        feedback: LEGACY_FEEDBACK,
        updatedAt: "2026-04-02T01:00:00.000Z",
      }),
    ).toHaveLength(1);
  });

  it("rejects an unsafe Review Response with no event", () => {
    const revealed = replay([
      legacySubmittedReview("Fine"),
      {
        type: "marketplace.review.revealed",
        data: { reviewId: "rev_1" as never, revealedAt: "2026-04-03T00:00:00.000Z", reason: "window-expired" },
      },
    ]);
    const reply = (feedback: string) =>
      decideReview(revealed, {
        type: "SubmitReviewReply",
        replyId: "rvr_1",
        subjectAccountId: "acc_seller",
        feedback,
        submittedAt: "2026-04-04T00:00:00.000Z",
      });

    expect(rejection(() => reply("Thanks https://x.example/a https://x.example/a"))).toEqual({
      field: "review-response-feedback",
      code: "text_duplicate_link",
    });
    expect(reply("Thanks for the kind words.")).toHaveLength(1);
  });

  it("replays legacy Review, update, and Response events byte-for-byte without judging them", () => {
    const legacyReply = "Legacy reply ftp://files.example \u0007";
    const state = replay([
      legacySubmittedReview(LEGACY_FEEDBACK),
      {
        type: "marketplace.review.updated",
        data: {
          reviewId: "rev_1" as never,
          rating: 3,
          feedback: "Updated https://a.example https://a.example",
          updatedAt: "2026-04-02T01:00:00.000Z",
        },
      },
      {
        type: "marketplace.review.revealed",
        data: { reviewId: "rev_1" as never, revealedAt: "2026-04-03T00:00:00.000Z", reason: "window-expired" },
      },
      {
        type: "marketplace.review.reply-submitted",
        data: {
          reviewId: "rev_1" as never,
          replyId: "rvr_1",
          subjectAccountId: "acc_seller",
          feedback: legacyReply,
          submittedAt: "2026-04-04T00:00:00.000Z",
        },
      },
    ]);

    expect(state.feedback).toBe("Updated https://a.example https://a.example");
    expect(state.replyFeedback).toBe(legacyReply);
  });
});
