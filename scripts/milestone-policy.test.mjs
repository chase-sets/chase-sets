import { describe, expect, it } from "vitest";
import {
  MilestonePolicyError,
  compareOutcomeMilestones,
  compareOutcomeOrder,
  findOutcomeOrderTies,
  isExecutableOutcome,
  readOutcomePolicy,
  readSteeringPolicy,
} from "./milestone-policy.mjs";

const marker = (track, order, status = "committed") =>
  `<!-- outcome: ${JSON.stringify({ version: 1, track, order, status })} -->`;
const steering = (until = "until the priority question is answered") =>
  `<!-- steering: ${JSON.stringify({ version: 1, source: "https://github.com/chase-sets/chase-sets/issues/9943#issuecomment-123", until })} -->`;
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

  it("orders outcomes by order then number across tracks and groups order ties", () => {
    const commerce = milestone("M50", "Checkout", marker("commerce", 300));
    const delivery = milestone("M250", "Next work", marker("delivery", 100));
    const catalog = milestone("M5", "Catalog", marker("catalog", 100));
    const untagged = milestone("M1", "Wave 1", "");
    expect([untagged, commerce, delivery, catalog].sort(compareOutcomeOrder).map(({ id }) => id)).toEqual([
      "M5",
      "M250",
      "M50",
      "M1",
    ]);
    expect(compareOutcomeMilestones(delivery, commerce)).toBeGreaterThan(0);
    expect(compareOutcomeOrder(delivery, commerce)).toBeLessThan(0);
    expect(() => compareOutcomeOrder(delivery, { ...catalog, number: 0 })).toThrow(MilestonePolicyError);

    const candidate = milestone("M7", "Idea", marker("ops", 100, "candidate"));
    const closed = milestone("M8", "Done", marker("ops", 100), { state: "closed" });
    expect(findOutcomeOrderTies([commerce, delivery, catalog, catalog, candidate, closed, untagged])).toEqual([
      { code: "OUTCOME_ORDER_TIE", order: 100, milestones: [5, 250] },
    ]);
    expect(findOutcomeOrderTies([commerce, delivery])).toEqual([]);
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

  it("reads one steering marker and rejects duplicate, malformed or invalid ones", () => {
    const valid = milestone("M1", "Wave 1", steering());
    const parsed = readSteeringPolicy(valid);
    expect(parsed).toEqual({
      version: 1,
      source: "https://github.com/chase-sets/chase-sets/issues/9943#issuecomment-123",
      until: "until the priority question is answered",
    });
    expect(Object.isFrozen(parsed)).toBe(true);

    const cases = [
      ["duplicate", steering() + steering(), "STEERING_METADATA_DUPLICATE"],
      ["malformed", '<!-- steering: {"version":1 ', "STEERING_METADATA_MALFORMED"],
      [
        "unknown key",
        '<!-- steering: {"version":1,"source":"https://github.com/chase-sets/chase-sets/issues/9943#issuecomment-123","until":"x","extra":true} -->',
        "STEERING_METADATA_INVALID",
      ],
      ["wrong version", steering().replace('"version":1', '"version":2'), "STEERING_METADATA_INVALID"],
      [
        "invalid source",
        steering().replace(
          "https://github.com/chase-sets/chase-sets/issues/9943#issuecomment-123",
          "https://example.com/ruling",
        ),
        "STEERING_METADATA_INVALID",
      ],
      ["empty until", steering("").replace('"until":""', '"until":""'), "STEERING_METADATA_INVALID"],
      ["long until", steering("x".repeat(501)), "STEERING_METADATA_INVALID"],
    ];
    for (const [name, description, code] of cases) {
      expect(() => readSteeringPolicy(milestone("M1", `Wave 1 ${name}`, description))).toThrowError(
        expect.objectContaining({ code }),
      );
    }
  });

  it("outcome metadata reads unchanged beside a steering marker", () => {
    const withoutSteering = milestone("M1", "Wave 1", marker("commerce", 100));
    const withSteering = milestone("M1", "Wave 1", `${marker("commerce", 100)}\n${steering()}`);
    expect(readOutcomePolicy(withSteering)).toEqual(readOutcomePolicy(withoutSteering));
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
