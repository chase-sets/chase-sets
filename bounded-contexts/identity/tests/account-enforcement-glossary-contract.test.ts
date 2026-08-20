import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function glossaryRegions(source: string) {
  const shippedStart = source.indexOf("## Identity Concepts");
  const plannedStart = source.indexOf("## Planned Account Capabilities And Channel Connections");
  if (shippedStart < 0 || plannedStart < 0 || plannedStart <= shippedStart) {
    throw new Error("Identity glossary region boundaries are missing or out of order.");
  }
  return {
    shipped: source.slice(shippedStart, plannedStart),
    planned: source.slice(plannedStart),
  };
}

describe("Account Enforcement glossary contract", () => {
  const source = readFileSync(path.join(import.meta.dirname, "..", "GLOSSARY.md"), "utf8");
  const regions = glossaryRegions(source);

  it("defines both exact terms only in the shipped Identity Concepts region", () => {
    expect(regions.shipped.match(/^### Account Enforcement Action$/gm)).toHaveLength(1);
    expect(regions.shipped.match(/^### Account Enforcement Reason$/gm)).toHaveLength(1);
    expect(regions.planned).not.toMatch(/^### Account Enforcement (Action|Reason)$/m);
  });

  it("distinguishes immutable identity, open restriction, and provenance from authority", () => {
    const action = regions.shipped.slice(
      regions.shipped.indexOf("### Account Enforcement Action"),
      regions.shipped.indexOf("### Account Enforcement Reason"),
    );
    const reason = regions.shipped.slice(
      regions.shipped.indexOf("### Account Enforcement Reason"),
      regions.shipped.indexOf("### Founders Cohort"),
    );

    expect(action).toMatch(/immutable Identity fact/);
    expect(action).toMatch(/never-reused `enf_` identity/);
    expect(action).toMatch(/open Account Enforcement Action is only the restriction currently determining/);
    expect(action).toMatch(/latest action fact is therefore distinct from the current open restriction/);
    expect(reason).toMatch(/closed provenance code/);
    expect(reason).toMatch(/never grants authority/);
    expect(`${action}\n${reason}`).not.toMatch(/authorizes? listing removal|graduated (warning|restriction) ladder/i);
  });
});
