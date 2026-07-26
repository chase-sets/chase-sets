import { describe, expect, it } from "vitest";
import {
  END_MARKER,
  isEpic,
  isRefined,
  renderRoadmapStatus,
  spliceIntoBody,
  START_MARKER,
  summarizeWaves,
} from "./roadmap-status.mjs";

const NOW = Date.parse("2026-07-26T00:00:00Z");
const RECENT = "2026-07-24T00:00:00Z";
const OLD = "2026-06-01T00:00:00Z";

const WAVE_1 = { title: "Wave 1", due_on: "2026-07-31T00:00:00Z" };
const WAVE_2 = { title: "Wave 2", due_on: "2026-08-12T00:00:00Z" };
const DEFERRED = { title: "Deferred / Incubation", due_on: null };

function slice(number, milestone, state, labels, created_at = OLD) {
  return { number, milestone, state, labels: labels.map((name) => ({ name })), created_at };
}

describe("roadmap status", () => {
  it("identifies epics and refined slices", () => {
    expect(isEpic(slice(1, WAVE_1, "open", ["kind:epic"]))).toBe(true);
    expect(isEpic(slice(2, WAVE_1, "open", ["kind:product"]))).toBe(false);

    expect(isRefined(slice(3, WAVE_1, "open", ["priority:p1", "area:catalog"]))).toBe(true);
    expect(isRefined(slice(4, WAVE_1, "open", ["priority:p1"]))).toBe(false);
    expect(isRefined(slice(5, null, "open", ["priority:p1", "area:catalog"]))).toBe(false);
  });

  it("counts slices per wave and excludes epics from the counts", () => {
    const issues = [
      slice(1, WAVE_1, "closed", ["kind:product"]),
      slice(2, WAVE_1, "open", ["priority:p0", "area:catalog"]),
      slice(3, WAVE_1, "open", ["kind:tech-debt"]),
      slice(10, null, "open", ["kind:epic"]),
    ];
    const { rows } = summarizeWaves({ milestones: [WAVE_1], issues, nowMs: NOW });
    expect(rows[0].total).toBe(3);
    expect(rows[0].closed).toBe(1);
    expect(rows[0].open).toBe(2);
    expect(rows[0].percent).toBe(33);
    expect(rows[0].refinedOpen).toBe(1);
  });

  it("surfaces scope growth inside the window", () => {
    const issues = [
      slice(1, WAVE_1, "open", ["kind:product"], OLD),
      slice(2, WAVE_1, "open", ["kind:product"], RECENT),
      slice(3, WAVE_1, "open", ["kind:product"], RECENT),
    ];
    const { rows } = summarizeWaves({ milestones: [WAVE_1], issues, nowMs: NOW });
    expect(rows[0].addedRecently).toBe(2);
  });

  it("assigns an epic to the earliest wave among its children", () => {
    const issues = [slice(10, null, "open", ["kind:epic"]), slice(11, null, "open", ["kind:epic"])];
    const epicChildren = new Map([
      [
        10,
        [
          { state: "closed", milestone: WAVE_2 },
          { state: "closed", milestone: WAVE_1 },
        ],
      ],
      [11, [{ state: "open", milestone: WAVE_2 }]],
    ]);
    const { rows } = summarizeWaves({ milestones: [WAVE_1, WAVE_2], issues, epicChildren, nowMs: NOW });
    expect(rows[0].epicsTotal).toBe(1);
    expect(rows[0].epicsComplete).toBe(1);
    expect(rows[1].epicsTotal).toBe(1);
    expect(rows[1].epicsComplete).toBe(0);
  });

  it("never counts a childless epic as complete", () => {
    const issues = [slice(10, null, "open", ["kind:epic"])];
    const epicChildren = new Map([[10, []]]);
    const { rows } = summarizeWaves({ milestones: [WAVE_1], issues, epicChildren, nowMs: NOW });
    expect(rows[0].epicsTotal).toBe(0);
    expect(rows[0].epicsComplete).toBe(0);
  });

  it("marks parked and operational milestones as not executable", () => {
    const issues = [slice(1, DEFERRED, "open", ["kind:product"])];
    const { rows } = summarizeWaves({ milestones: [DEFERRED], issues, nowMs: NOW });
    expect(rows[0].executable).toBe(false);

    const markdown = renderRoadmapStatus({ rows, windowDays: 7 });
    expect(markdown).toContain("not executable");
    // Parked work must not dilute the refined-percentage signal.
    expect(markdown).toContain("**0 open slices**");
  });

  it("renders a marker-delimited block", () => {
    const issues = [slice(1, WAVE_1, "open", ["priority:p0", "area:catalog"])];
    const { rows } = summarizeWaves({ milestones: [WAVE_1], issues, nowMs: NOW });
    const markdown = renderRoadmapStatus({ rows, windowDays: 7 });
    expect(markdown.startsWith(START_MARKER)).toBe(true);
    expect(markdown.trimEnd().endsWith(END_MARKER)).toBe(true);
    expect(markdown).toContain("| Wave 1 | 2026-07-31 |");
  });

  it("splices into a body that opts in with markers", () => {
    const body = `intro\n${START_MARKER}\nstale\n${END_MARKER}\noutro`;
    const next = spliceIntoBody(body, `${START_MARKER}\nfresh\n${END_MARKER}`);
    expect(next).toBe(`intro\n${START_MARKER}\nfresh\n${END_MARKER}\noutro`);
  });

  it("refuses to rewrite a body without markers", () => {
    expect(spliceIntoBody("no markers here", "block")).toBeNull();
    expect(spliceIntoBody(`${END_MARKER} before ${START_MARKER}`, "block")).toBeNull();
    expect(spliceIntoBody(null, "block")).toBeNull();
  });
});
