import { describe, expect, it } from "vitest";
import { t } from "./translator";

describe("Policies translator", () => {
  it("interpolates publication metadata and leaves out-of-slice keys unresolved", () => {
    expect(t("publicPresence.info.policies.metadata.effective", { effectiveAt: "2026-11-22" })).toBe(
      "Effective date: 2026-11-22",
    );
    expect(t("publicPresence.info.terms.metadata.version", { version: "v1" })).toBe("Version v1");
    expect(t("publicPresence.brand")).toBe("[missing:en:publicPresence.brand]");
  });
});
