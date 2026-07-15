import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOW_RATING_RESOLUTION_THRESHOLD,
  REVIEW_PROBLEM_CATEGORIES,
  REVIEW_RESOLUTION_ANALYTICS_EVENT,
  intakeFlowForProblemCategory,
  isReviewProblemCategory,
  resolutionTriggerReason,
  shouldRouteToResolution,
  trackReviewResolutionEvent,
} from "./review-resolution";

describe("review resolution routing decision", () => {
  it("routes a low rating into resolution even without a problem indicator", () => {
    for (let rating = 1; rating <= LOW_RATING_RESOLUTION_THRESHOLD; rating += 1) {
      expect(shouldRouteToResolution({ rating, problemCategories: [] })).toBe(true);
    }
  });

  it("does not route a high rating with no problem indicator", () => {
    expect(shouldRouteToResolution({ rating: 5, problemCategories: [] })).toBe(false);
    expect(shouldRouteToResolution({ rating: 3, problemCategories: [] })).toBe(false);
  });

  it("routes any structured problem indicator regardless of a high rating", () => {
    expect(shouldRouteToResolution({ rating: 5, problemCategories: ["authenticity"] })).toBe(true);
  });

  it("classifies the trigger reason for analytics without inspecting free text", () => {
    expect(resolutionTriggerReason({ rating: 1, problemCategories: [] })).toBe("low-rating");
    expect(resolutionTriggerReason({ rating: 5, problemCategories: ["damaged"] })).toBe("problem-indicator");
    expect(resolutionTriggerReason({ rating: 1, problemCategories: ["damaged"] })).toBe(
      "low-rating-and-problem-indicator",
    );
    expect(resolutionTriggerReason({ rating: 5, problemCategories: [] })).toBe("none");
  });

  it("maps every problem category to a canonical intake flow", () => {
    for (const category of REVIEW_PROBLEM_CATEGORIES) {
      expect(intakeFlowForProblemCategory(category)).toMatch(/[a-z-]+/);
    }
    expect(intakeFlowForProblemCategory("not-received")).toBe("product-not-received");
    expect(intakeFlowForProblemCategory("authenticity")).toBe("authenticity-concern");
  });

  it("guards unknown category strings", () => {
    expect(isReviewProblemCategory("damaged")).toBe(true);
    expect(isReviewProblemCategory("free-text-sentiment")).toBe(false);
  });
});

describe("review resolution analytics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches privacy-safe funnel events without throwing when window is absent", () => {
    vi.stubGlobal("window", undefined);
    expect(() => trackReviewResolutionEvent("review_resolution_interstitial_shown")).not.toThrow();
  });

  it("emits a custom event and pushes to the data layer with only safe properties", () => {
    const dispatched: CustomEvent[] = [];
    const dataLayer: Array<Record<string, unknown>> = [];
    vi.stubGlobal("window", {
      dispatchEvent: (event: CustomEvent) => {
        dispatched.push(event);
        return true;
      },
      dataLayer,
    });

    trackReviewResolutionEvent("review_resolution_case_routed", { triggerCategory: "damaged" });

    expect(dispatched[0]?.type).toBe(REVIEW_RESOLUTION_ANALYTICS_EVENT);
    expect(dispatched[0]?.detail).toMatchObject({
      event: "review_resolution_case_routed",
      triggerCategory: "damaged",
    });
    expect(dataLayer[0]).toMatchObject({ event: "review_resolution_case_routed" });
  });
});
