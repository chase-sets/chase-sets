import { describe, expect, it } from "vitest";
import { action } from "./google-shopping";

describe("Google Shopping operations route", () => {
  it("returns an explicit launch gate error for live production intents", async () => {
    const result = await action({
      request: new Request("https://admin.chasesets.test/growth/google-shopping", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "live-full-sync" }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      error: "Live Google Shopping writes remain gated by launch-readiness issue #3032.",
    });
  });
});
