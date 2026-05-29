import { describe, expect, it } from "vitest";
import { publicPresenceHasTranslation, publicPresenceT } from "../support/ui-support/public-presence-translator";

describe("public presence translator", () => {
  it("resolves public presence copy without the global localization runtime", () => {
    expect(publicPresenceHasTranslation("publicPresence.brand")).toBe(true);
    expect(publicPresenceT("publicPresence.brand")).toBe("Chase Sets");
  });

  it("keeps missing keys explicit", () => {
    expect(publicPresenceHasTranslation("adminWeb.app.title")).toBe(false);
    expect(publicPresenceT("adminWeb.app.title")).toBe("[missing:en:adminWeb.app.title]");
  });
});
