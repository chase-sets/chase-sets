import { describe, expect, it } from "vitest";
import { DISCOVERY_ALIAS_SEARCH_ENV_VAR, aliasSearchContributionEnabled } from "./alias-rollout";

describe("alias search rollout kill-switch", () => {
  it("defaults to enabled when the env var is unset", () => {
    expect(aliasSearchContributionEnabled({})).toBe(true);
  });

  it.each(["disabled", "off", "false", "0", "kill", "DISABLED", " Off "])(
    "disables alias contribution for %s",
    (value) => {
      expect(aliasSearchContributionEnabled({ [DISCOVERY_ALIAS_SEARCH_ENV_VAR]: value })).toBe(false);
    },
  );

  it.each(["enabled", "on", "true", "open", ""])("stays enabled for %s", (value) => {
    expect(aliasSearchContributionEnabled({ [DISCOVERY_ALIAS_SEARCH_ENV_VAR]: value })).toBe(true);
  });
});
