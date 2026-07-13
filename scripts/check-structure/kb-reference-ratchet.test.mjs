import { describe, expect, it } from "vitest";
import { evaluateKbReferenceRatchet, hasKbDeclaration, userFacingSliceForFile } from "./kb-reference-ratchet.mjs";

describe("KB reference ratchet", () => {
  it("classifies feature UI and public route fixtures", () => {
    expect(userFacingSliceForFile("bounded-contexts/checkout/features/buy-session/ui/page.tsx")).toBe(
      "checkout/buy-session",
    );
    expect(userFacingSliceForFile("bounded-contexts/public-presence/routes/marketplace/help.tsx")).toBe(
      "public-presence/routes",
    );
    expect(userFacingSliceForFile("bounded-contexts/checkout/features/buy-session/domain/domain.ts")).toBeNull();
  });

  it("accepts an article, issue, URL, or explicit n/a declaration", () => {
    expect(hasKbDeclaration("KB: /help/buying/order-protection")).toBe(true);
    expect(hasKbDeclaration("KB: #4355")).toBe(true);
    expect(hasKbDeclaration("KB: https://example.com/help")).toBe(true);
    expect(hasKbDeclaration("KB: n/a")).toBe(true);
  });

  it("warns without failing while the initial ratchet is advisory", () => {
    const result = evaluateKbReferenceRatchet({
      changedFiles: ["bounded-contexts/checkout/features/buy-session/ui/page.tsx"],
      body: "## Summary\nCheckout UI changed.",
      mode: "warn",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it("has a documented post-launch block mode without enabling it", () => {
    const result = evaluateKbReferenceRatchet({
      changedFiles: ["bounded-contexts/checkout/features/buy-session/ui/page.tsx"],
      body: "",
      mode: "block",
    });
    expect(result.ok).toBe(false);
  });
});
