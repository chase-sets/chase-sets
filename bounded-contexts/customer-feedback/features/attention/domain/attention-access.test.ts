import { describe, expect, it } from "vitest";
import { canAccessFeedbackAttention, feedbackAttentionExportAllowed } from "../api/access";

describe("feedback attention server access", () => {
  it("keeps viewing separate from mutation, notification, and export gates", () => {
    const viewer = { permissions: ["support.view"] };
    const manager = { permissions: ["support.manage"] };
    expect(canAccessFeedbackAttention(viewer, "view")).toBe(true);
    expect(canAccessFeedbackAttention(viewer, "manage")).toBe(false);
    expect(canAccessFeedbackAttention(viewer, "notify")).toBe(false);
    expect(feedbackAttentionExportAllowed(viewer)).toBe(false);
    expect(canAccessFeedbackAttention(manager, "manage")).toBe(true);
    expect(canAccessFeedbackAttention(manager, "notify")).toBe(true);
    expect(feedbackAttentionExportAllowed(manager)).toBe(true);
    const notifier = { permissions: ["support.notify"] };
    expect(canAccessFeedbackAttention(notifier, "view")).toBe(true);
    expect(canAccessFeedbackAttention(notifier, "notify")).toBe(true);
    expect(canAccessFeedbackAttention(notifier, "manage")).toBe(false);
    expect(canAccessFeedbackAttention(notifier, "export")).toBe(false);
  });
});
