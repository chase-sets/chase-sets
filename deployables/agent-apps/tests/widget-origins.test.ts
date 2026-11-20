import { describe, expect, it } from "vitest";
import { expectUcpCapture } from "@chase-sets/platform-runtime/ucp-schema-test-support";
import { readWidgetOrigins } from "../src/widget-origins";
import recorded from "./fixtures/staging-search-catalog.json";

describe("Agent Apps runtime inputs", () => {
  it("fails closed when the served widget has no valid origin metadata", () => {
    const origin = "https://marketplace.example";
    expect(readWidgetOrigins(encodeURIComponent(JSON.stringify([origin])))).toEqual([origin]);
    for (const content of [undefined, "", "%", "[]", "42", JSON.stringify([origin, "http://foreign.example"])]) {
      expect(readWidgetOrigins(content)).toEqual([]);
    }
  });

  it("keeps the recorded staging result on the pinned catalog contract", () => {
    expectUcpCapture(recorded.toolResult.structuredContent, { operation: "search_catalog", kind: "resource" });
    expect(recorded.toolResult.structuredContent.products).toHaveLength(2);
    expect(recorded.capture.releaseSha).toMatch(/^[a-f0-9]{40}$/);
  });
});
