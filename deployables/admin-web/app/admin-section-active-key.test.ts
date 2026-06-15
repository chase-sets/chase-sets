import { describe, expect, it } from "vitest";
import { resolveActiveKey } from "./admin-section-active-key";

const catalogConfig = {
  defaultActiveKey: "dimensions",
  activeKeys: {
    "reference-types": "reference-records",
    integrations: "integrations-import",
    "integrations/providers": "integrations-providers",
    "integrations/governance": "integrations-governance",
    "integrations/release": "integrations-release",
  },
} as const;

describe("resolveActiveKey", () => {
  it("maps a nested surface path to its child nav key, most-specific first", () => {
    expect(resolveActiveKey("/catalog/integrations", catalogConfig)).toBe("integrations-import");
    expect(resolveActiveKey("/catalog/integrations/providers", catalogConfig)).toBe("integrations-providers");
    expect(resolveActiveKey("/catalog/integrations/governance", catalogConfig)).toBe("integrations-governance");
    expect(resolveActiveKey("/catalog/integrations/release", catalogConfig)).toBe("integrations-release");
  });

  it("keeps a deep-linked surface active when extra trailing/query segments are present", () => {
    expect(resolveActiveKey("/catalog/integrations/release/", catalogConfig)).toBe("integrations-release");
  });

  it("falls back to a single-segment alias mapping for detail routes", () => {
    expect(resolveActiveKey("/catalog/reference-types/ref_1", catalogConfig)).toBe("reference-records");
  });

  it("uses the first sub-segment when no alias matches", () => {
    expect(resolveActiveKey("/catalog/dimensions", catalogConfig)).toBe("dimensions");
    expect(resolveActiveKey("/catalog/blueprints/bp_1", catalogConfig)).toBe("blueprints");
  });

  it("falls back to the section default when no surface segment is present", () => {
    expect(resolveActiveKey("/catalog", catalogConfig)).toBe("dimensions");
  });
});
