import { describe, expect, it } from "vitest";
import {
  MilestonePolicyError,
  compareOutcomeMilestones,
  isExecutableOutcome,
  readOutcomePolicy,
} from "./milestone-policy.mjs";

const marker = (track, order, status = "committed") =>
  `<!-- outcome: ${JSON.stringify({ version: 1, track, order, status })} -->`;
const milestone = (id, title, description, overrides = {}) => ({
  id,
  number: Number(id.replace(/\D/g, "")) || 1,
  title,
  description,
  state: "open",
  ...overrides,
});

describe("milestone outcome policy", () => {
  it("orders inserted and reordered outcomes without title or creation-number coupling", () => {
    const later = milestone("M30", "Checkout", marker("commerce", 300));
    const inserted = milestone("M99", "Trust review", marker("commerce", 200));
    const renamed = milestone("M10", "Renamed after creation", marker("commerce", 100));
    expect([later, inserted, renamed].sort(compareOutcomeMilestones).map(({ id }) => id)).toEqual([
      "M10",
      "M99",
      "M30",
    ]);
    expect(readOutcomePolicy({ ...renamed, title: "Any title" })).toEqual(readOutcomePolicy(renamed));
  });

  it("rejects malformed, duplicate, and shape-invalid managed metadata", () => {
    const cases = [
      marker("commerce", 1) + marker("commerce", 2),
      '<!-- outcome: {"version":1 ',
      '<!-- outcome: {"version":1,"track":"Commerce","order":1,"status":"committed"} -->',
      '<!-- outcome: {"version":1,"track":"commerce","order":1,"status":"committed","extra":true} -->',
    ];
    for (const description of cases) {
      expect(() => readOutcomePolicy(milestone("M1", "Wave 1", description))).toThrow(MilestonePolicyError);
    }
  });

  it("excludes candidates and closed outcomes from executable policy", () => {
    expect(isExecutableOutcome(milestone("M1", "Idea", marker("commerce", 1, "candidate")))).toBe(false);
    expect(isExecutableOutcome(milestone("M2", "Delivery", marker("commerce", 2)))).toBe(true);
    expect(isExecutableOutcome(milestone("M3", "Done", marker("commerce", 3), { state: "closed" }))).toBe(false);
  });

  it.each(["Wave 9", "Mobile 4", "Operations"])("never treats an untagged %s title as an outcome", (title) => {
    for (const description of [undefined, null, "", "Exit gates: #123"]) {
      const untagged = milestone("M1", title, description);
      expect(readOutcomePolicy(untagged)).toBeNull();
      expect(isExecutableOutcome(untagged)).toBe(false);
    }
  });
});
