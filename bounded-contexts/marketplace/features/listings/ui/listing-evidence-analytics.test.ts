// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackListingEvidenceEvent } from "./listing-evidence-analytics";

afterEach(() => {
  window.dataLayer = undefined;
});

describe("Listing Evidence analytics", () => {
  it("emits only bounded readiness metadata without file or image data", () => {
    window.dataLayer = [];
    const listener = vi.fn();
    window.addEventListener("chase-sets:listing-evidence-analytics", listener, { once: true });

    trackListingEvidenceEvent("upload_completed", {
      surface: "listing-detail",
      complete: true,
      unmetCount: 0,
      slotCount: 3,
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(window.dataLayer).toEqual([
      {
        event: "upload_completed",
        surface: "listing-detail",
        complete: true,
        unmetCount: 0,
        slotCount: 3,
      },
    ]);
    expect(JSON.stringify(window.dataLayer)).not.toMatch(/filename|image|photoId|storage/i);
  });
});
