import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BacklogClassificationInputError,
  classified,
  isEpic,
  isExecutableMilestone,
  isTrackingOnly,
  refined,
} from "./backlog-classify.mjs";

const EXECUTABLE_MILESTONE = "Wave 1";
const FULL_LABELS = ["priority:p1", "area:ops", "kind:tech-debt"];

function input(overrides = {}) {
  return {
    number: 6169,
    state: "open",
    labels: FULL_LABELS,
    issueTypeName: "Slice",
    milestoneTitle: EXECUTABLE_MILESTONE,
    blockedByCount: 0,
    hasParent: false,
    ...overrides,
  };
}

describe("validated backlog classification contract", () => {
  it.each([
    ["number", "6169"],
    ["state", "unknown"],
    ["labels", ["priority:p1", null]],
    ["issueTypeName", 1],
    ["milestoneTitle", false],
    ["blockedByCount", -1],
    ["hasParent", null],
  ])("rejects a mistyped or unknown %s", (field, value) => {
    expect(() => classified(input({ [field]: value }))).toThrowError(
      expect.objectContaining({ name: "BacklogClassificationInputError", field }),
    );
  });

  it.each(["number", "state", "labels", "issueTypeName", "milestoneTitle", "blockedByCount", "hasParent"])(
    "rejects a missing %s",
    (field) => {
      const candidate = input();
      delete candidate[field];
      expect(() => classified(candidate)).toThrowError(
        expect.objectContaining({ name: "BacklogClassificationInputError", field }),
      );
    },
  );

  it("rejects a null or non-object input with the named error", () => {
    for (const candidate of [null, undefined, []]) {
      expect(() => classified(candidate)).toThrow(BacklogClassificationInputError);
    }
  });

  it("performs no network I/O", () => {
    const source = readFileSync(new URL("./backlog-classify.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bgraphql\s*\(/i);
  });
});

describe("classification behavior", () => {
  it("defines refined as exactly classified", () => {
    for (const candidate of [
      input(),
      input({ labels: FULL_LABELS.slice(0, 2) }),
      input({ labels: [...FULL_LABELS, "status:tracking-only"] }),
      input({ milestoneTitle: null }),
    ]) {
      expect(refined(candidate)).toBe(classified(candidate));
    }
  });

  it("requires every label family and an executable milestone", () => {
    expect(classified(input())).toBe(true);
    expect(classified(input({ labels: ["priority:p1", "area:ops"] }))).toBe(false);
    expect(classified(input({ milestoneTitle: null }))).toBe(false);
    expect(classified(input({ milestoneTitle: "Operations" }))).toBe(false);
    expect(classified(input({ milestoneTitle: "Deferred / Incubation" }))).toBe(false);
  });

  it("excludes tracking-only work and closed issues", () => {
    expect(classified(input({ labels: [...FULL_LABELS, "status:tracking-only"] }))).toBe(false);
    expect(isTrackingOnly(input({ labels: [...FULL_LABELS, "status:tracking-only"] }))).toBe(true);
    expect(classified(input({ state: "closed" }))).toBe(false);
  });

  it("preserves native type precedence and the untyped Epic fallback", () => {
    expect(classified(input({ issueTypeName: "Epic" }))).toBe(false);
    expect(isEpic(input({ issueTypeName: "Epic" }))).toBe(true);
    expect(classified(input({ issueTypeName: null, labels: [...FULL_LABELS, "kind:epic"] }))).toBe(false);
    expect(isEpic(input({ issueTypeName: null, labels: [...FULL_LABELS, "kind:epic"] }))).toBe(true);
    expect(classified(input({ issueTypeName: "Slice", labels: [...FULL_LABELS, "kind:epic"] }))).toBe(true);
  });

  it("fails closed for an unknown native issue type", () => {
    expect(classified(input({ issueTypeName: "Unknown" }))).toBe(false);
    expect(classified(input({ milestoneTitle: "" }))).toBe(false);
  });

  it("reports parent state without making it a classification gate", () => {
    expect(classified(input({ hasParent: false }))).toBe(true);
    expect(refined(input({ hasParent: false }))).toBe(true);
    expect(classified(input({ hasParent: true }))).toBe(true);
    expect(refined(input({ hasParent: true }))).toBe(true);
  });
});

describe("canonical executable milestone predicate", () => {
  it.each([
    "Wave 1 — Synthetic Platform Outcome",
    "Mobile 1 — Synthetic Store Outcome",
    "Mobile 2 — Synthetic Device Outcome",
    "Mobile 3 — Synthetic Release Outcome",
    "Synthetic Outcome ∷ Aurora-2042 / usable result",
  ])("accepts arbitrary open outcome title %s", (milestoneTitle) => {
    expect(isExecutableMilestone(milestoneTitle)).toBe(true);
    expect(classified(input({ milestoneTitle }))).toBe(true);
  });

  it.each([null, "", "Deferred / Incubation", "Operations", false])(
    "fails closed for non-executable milestone value %s",
    (milestoneTitle) => {
      expect(isExecutableMilestone(milestoneTitle)).toBe(false);
    },
  );
});

describe("locked predecessor comparison corpus", () => {
  function priorRoadmap(candidate) {
    return (
      candidate.state === "open" &&
      !isEpic(candidate) &&
      candidate.milestoneTitle !== null &&
      candidate.labels.some((label) => label.startsWith("priority:")) &&
      candidate.labels.some((label) => label.startsWith("area:"))
    );
  }

  function priorBoard(candidate) {
    return (
      candidate.state === "open" &&
      !isEpic(candidate) &&
      candidate.blockedByCount === 0 &&
      candidate.milestoneTitle !== null &&
      !["Deferred / Incubation", "Operations"].includes(candidate.milestoneTitle) &&
      candidate.labels.some((label) => label.startsWith("priority:")) &&
      candidate.labels.some((label) => label.startsWith("area:")) &&
      candidate.labels.some((label) => label.startsWith("kind:"))
    );
  }

  const familyCorpus = [];
  for (const priority of [false, true]) {
    for (const area of [false, true]) {
      for (const kind of [false, true]) {
        familyCorpus.push({
          name: `families-p${Number(priority)}a${Number(area)}k${Number(kind)}`,
          candidate: input({
            labels: [
              ...(priority ? ["priority:p1"] : []),
              ...(area ? ["area:ops"] : []),
              ...(kind ? ["kind:tech-debt"] : []),
            ],
          }),
        });
      }
    }
  }

  const corpus = [
    ...familyCorpus,
    {
      name: "tracking-only",
      candidate: input({ labels: [...FULL_LABELS, "status:tracking-only"] }),
    },
    {
      name: "non-executable-milestone",
      candidate: input({ milestoneTitle: "Operations" }),
    },
    {
      name: "typed-slice-stale-epic-label",
      candidate: input({ labels: [...FULL_LABELS, "kind:epic"] }),
    },
    {
      name: "untyped-legacy-epic",
      candidate: input({ issueTypeName: null, labels: [...FULL_LABELS, "kind:epic"] }),
    },
  ];

  const intentionalDeltas = [
    {
      fixture: "families-p1a1k0",
      predecessor: "roadmap",
      before: true,
      after: false,
      reason: "kind family is now required",
    },
    {
      fixture: "tracking-only",
      predecessor: "roadmap",
      before: true,
      after: false,
      reason: "tracking-only work is continuity metadata, not backlog",
    },
    {
      fixture: "tracking-only",
      predecessor: "board",
      before: true,
      after: false,
      reason: "tracking-only work keeps its current board value",
    },
    {
      fixture: "non-executable-milestone",
      predecessor: "roadmap",
      before: true,
      after: false,
      reason: "non-executable milestones are excluded by the shared contract",
    },
  ];

  it("enumerates every intentional old-versus-new classification delta and no others", () => {
    const observed = [];
    for (const { name, candidate } of corpus) {
      const after = classified(candidate);
      for (const [predecessor, before] of [
        ["roadmap", priorRoadmap(candidate)],
        ["board", priorBoard(candidate)],
      ]) {
        if (before === after) continue;
        const locked = intentionalDeltas.find(
          (delta) =>
            delta.fixture === name &&
            delta.predecessor === predecessor &&
            delta.before === before &&
            delta.after === after,
        );
        if (!locked) {
          throw new Error(`Unlisted classification delta: ${name}/${predecessor} ${before} -> ${after}`);
        }
        observed.push(locked);
      }
    }

    expect(observed).toEqual(intentionalDeltas);
  });
});
