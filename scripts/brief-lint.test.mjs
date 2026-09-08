import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRIEF_MAX_BYTES, lintBrief, main } from "./brief-lint.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ruleLines = [
  "is at most about 12 KB of body; anything larger splits into sub-issues with native sub-issue links;",
  "carries no collision census. Collision is a controller concern, resolved from GitHub native relationships and the board, not restated in prose;",
  "lists at most five don't-rebuild pointers, each a path or symbol, not a narrative;",
  "never designates a live draft PR as read-only salvage. A reviewed draft PR is always the implementation head for its issue; salvage applies only to a branch with no push in seven days;",
  "states acceptance as observable outcomes with the proving check named once, and repeats no policy that the orchestrator or review contract already owns.",
];

const qualityFindingCodes = new Set([
  "BRIEF_QUALITY_INTENT_SURFACES",
  "BRIEF_QUALITY_FOOTPRINT_SHAPE",
  "BRIEF_QUALITY_UI_STATES",
  "BRIEF_QUALITY_DATA_PATH",
  "BRIEF_QUALITY_GLOSSARY_IMPACT",
]);

const intentDeclaration = [
  "## Intent surfaces",
  "",
  "| Acceptance criterion | Exercised surface |",
  "|---|---|",
  "| AC1 | `lintBrief` result |",
].join("\n");

const qualitySections = {
  scope: "## Scope fence\n\nIn scope: bounded lint changes.\n\nNon-goals: no runtime or provider changes.",
  intent: intentDeclaration,
  footprint: "## Footprint & chain\n\n- `scripts/brief-lint.mjs`",
  simplest: "## Simplest shape\n\nExtend the existing Markdown scan with five structural checks.",
  ui: "## UI states and design-system sources\n\nnone — no UI surface changes.",
  data: "## Data-path envelope\n\nnone — no data path changes.",
  glossary: "## Glossary impact\n\nnone — no new or renamed public names.",
};

function conformingBrief(overrides = {}) {
  return [
    "# Context\n\nBounded planning lint change.",
    overrides.scope ?? qualitySections.scope,
    overrides.intent ?? qualitySections.intent,
    overrides.footprint ?? qualitySections.footprint,
    overrides.simplest ?? qualitySections.simplest,
    overrides.ui ?? qualitySections.ui,
    overrides.data ?? qualitySections.data,
    overrides.glossary ?? qualitySections.glossary,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function legacyResult(body) {
  const result = lintBrief(body);
  return { ...result, findings: result.findings.filter((finding) => !qualityFindingCodes.has(finding.code)) };
}

function codes(body) {
  return legacyResult(body).findings.map((finding) => finding.code);
}

function qualityCodes(body) {
  return lintBrief(body).findings.map((finding) => finding.code);
}

describe("brief body byte limit", () => {
  it("accepts exactly 12 × 1024 UTF-8 bytes and rejects one byte more", () => {
    expect(legacyResult("a".repeat(BRIEF_MAX_BYTES))).toMatchObject({ bytes: BRIEF_MAX_BYTES, findings: [] });
    expect(codes("a".repeat(BRIEF_MAX_BYTES + 1))).toContain("BRIEF_BODY_BYTES");
  });

  it("measures a Unicode boundary in UTF-8 bytes rather than JavaScript characters", () => {
    const exact = `${"a".repeat(BRIEF_MAX_BYTES - 4)}💡`;
    expect(exact.length).toBeLessThan(BRIEF_MAX_BYTES);
    expect(legacyResult(exact)).toMatchObject({ bytes: BRIEF_MAX_BYTES, findings: [] });
    expect(codes(`${exact}a`)).toContain("BRIEF_BODY_BYTES");
  });
});

describe("collision census sections", () => {
  it.each(["## Collision census\n\n- scripts/a.mjs", "File-collision census\n---------------------\n\nnone"])(
    "rejects a census section expressed with Markdown headings",
    (body) => expect(codes(body)).toContain("BRIEF_COLLISION_CENSUS"),
  );

  it("allows ordinary prose that mentions the concept", () => {
    expect(
      codes("Collision risk is controller-owned; a collision census does not belong in this brief."),
    ).not.toContain("BRIEF_COLLISION_CENSUS");
  });

  it("keeps a longer fenced block open when a marker has an info string", () => {
    expect(codes("```text\n```javascript\n# Collision census\n```\n")).toEqual([]);
  });
});

describe("don't-rebuild pointers", () => {
  const pointerSection = (count) =>
    [
      "### Don't-rebuild pointers",
      "",
      ...Array.from({ length: count }, (_, index) => `- \`scripts/prior-${index}.mjs\``),
    ].join("\n");

  it("accepts five path or symbol pointers and rejects six", () => {
    expect(codes(pointerSection(5))).toEqual([]);
    expect(codes(pointerSection(6))).toContain("BRIEF_DONT_REBUILD_POINTER_COUNT");
  });

  it("counts pointers across repeated don't-rebuild sections", () => {
    const body = `${pointerSection(3)}\n\n## Scope\n\nBounded.\n\n${pointerSection(3)}`;
    expect(codes(body)).toContain("BRIEF_DONT_REBUILD_POINTER_COUNT");
  });

  it("rejects narrative masquerading as a pointer", () => {
    expect(codes("Don't-rebuild pointers:\n\n- Reuse the old script because it already works.")).toContain(
      "BRIEF_DONT_REBUILD_POINTER_FORMAT",
    );
  });

  it("validates complete Markdown list items and ends label-style sections at the next label", () => {
    expect(codes("### Don't-rebuild pointers\n\n- `scripts/a.mjs`\n  `scripts/b.mjs`")).toContain(
      "BRIEF_DONT_REBUILD_POINTER_FORMAT",
    );
    expect(codes("### Don't-rebuild pointers\n\n- `scripts/a.mjs`\n  because it already exists.")).toContain(
      "BRIEF_DONT_REBUILD_POINTER_FORMAT",
    );
    expect(
      codes(
        "Don't-rebuild pointers:\n\n- `scripts/a.mjs`\n\nScope:\n\n- Add bounded behavior.\n- Non-goal: no provider changes.",
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "rejects an indented pseudo-label and second pointer within the same item",
      "Don't-rebuild pointers:\n\n- `scripts/a.mjs`\n  Note:\n  `scripts/b.mjs`",
      "BRIEF_DONT_REBUILD_POINTER_FORMAT",
    ],
    [
      "accepts a genuine top-level label boundary",
      "Don't-rebuild pointers:\n\n- `scripts/a.mjs`\n\nScope:\n\n- bounded behavior",
      undefined,
    ],
  ])("%s", (_description, body, expected) => {
    const result = codes(body);
    if (expected) expect(result).toContain(expected);
    else expect(result).toEqual([]);
  });

  it.each([
    ["pnpm-lock.yaml", true],
    [".github/workflows/platform-pr.yml", true],
    ["scripts/inside.mjs", true],
    ["./scripts/inside.mjs", true],
    ["lintBrief#findings()", true],
    ["../scripts/outside.mjs", false],
    ["scripts/../outside.mjs", false],
    ["/scripts/absolute.mjs", false],
    ["C:/scripts/absolute.mjs", false],
    ["././scripts/inside.mjs", false],
    ["scripts/a.mjs and scripts/b.mjs", false],
    ["Thing..method", false],
  ])("classifies bounded repository paths separately from symbols: %s", (value, valid) => {
    const result = codes(`### Don't-rebuild pointers\n\n- \`${value}\``);
    if (valid) expect(result).toEqual([]);
    else expect(result).toContain("BRIEF_DONT_REBUILD_POINTER_FORMAT");
  });
});

describe("salvage wording", () => {
  it("rejects a live draft PR designated as read-only salvage", () => {
    expect(codes("Use live draft PR #42 as read-only salvage.")).toContain("BRIEF_LIVE_DRAFT_SALVAGE");
  });

  it("requires an affirmative salvage branch designation to carry the seven-day no-push fact", () => {
    expect(codes("Salvage branch: `feature/old`.")).toContain("BRIEF_SALVAGE_BRANCH_STALENESS");
    expect(codes("Salvage branch: `feature/old`, with no push in seven days.")).toEqual([]);
  });

  it("allows compliant policy prose and read-only historical artifacts", () => {
    const body = [
      "A reviewed draft PR remains the implementation head; salvage applies only to a stale branch.",
      "The closed PR #41 is a read-only historical artifact.",
      "Salvage: none.",
    ].join("\n\n");
    expect(codes(body)).toEqual([]);
  });

  it("recognizes bounded affirmative salvage forms without flagging negated policy", () => {
    for (const body of [
      "Live draft PR #42 — read-only salvage.",
      "Draft PR #42: read-only salvage.",
      "Reviewed draft PR #42 (read-only salvage).",
    ]) {
      expect(codes(body)).toContain("BRIEF_LIVE_DRAFT_SALVAGE");
    }
    for (const body of ["Branch `feature/old` is salvage.", "Use `feature/old` as a salvage branch."]) {
      expect(codes(body)).toContain("BRIEF_SALVAGE_BRANCH_STALENESS");
    }
    expect(codes("Do not use live draft PR #42 as read-only salvage.")).toEqual([]);
    expect(codes("Do not use branch `feature/old` as salvage.")).toEqual([]);
  });

  it.each([
    ["Do not rebase this work. Use live draft PR #42 as read-only salvage.", "BRIEF_LIVE_DRAFT_SALVAGE"],
    [
      "Do not use branch `feature/old` as salvage; use branch `feature/new` as salvage.",
      "BRIEF_SALVAGE_BRANCH_STALENESS",
    ],
    ["Do not use live draft PR #42 as read-only salvage.", undefined],
    ["Do not use branch `feature/old` as salvage.", undefined],
  ])("binds negation to the designation clause", (body, expected) => {
    const result = codes(body);
    if (expected) expect(result).toContain(expected);
    else expect(result).toEqual([]);
  });
});

describe("planning integration", () => {
  it("carries the ruled limits verbatim in both skill mirrors and the slice template", () => {
    const paths = [
      ".agents/skills/planning/SKILL.md",
      ".claude/skills/planning/SKILL.md",
      ".github/ISSUE_TEMPLATE/slice.yml",
    ];
    for (const relativePath of paths) {
      const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
      for (const line of ruleLines) expect(source).toContain(line);
      expect(source.replace(/\s+/g, " ")).toContain("12 × 1024 = 12,288 UTF-8 bytes");
    }
  });

  it("invokes the lint from the planning skill without adding a package script", () => {
    const source = readFileSync(path.join(repoRoot, ".agents/skills/planning/SKILL.md"), "utf8");
    expect(source).toContain("node ./scripts/brief-lint.mjs <path-to-brief.md>");
  });

  it("returns a discriminating CLI status", async () => {
    const logs = [];
    const logger = { error: (message) => logs.push(message), log: (message) => logs.push(message) };
    await expect(main({ argv: ["brief.md"], load: async () => conformingBrief(), logger })).resolves.toBe(0);
    await expect(main({ argv: ["brief.md"], load: async () => "# Collision census\n", logger })).resolves.toBe(1);
    expect(logs[0]).toContain("Brief lint passed");
    expect(logs.filter((message) => message.includes("BRIEF_COLLISION_CENSUS"))).toEqual([
      expect.stringContaining("BRIEF_COLLISION_CENSUS"),
    ]);
  });
});

describe("ready-10 quality-surface declarations", () => {
  it("accepts the explicit no-surface forms and complete applicable tables", () => {
    expect(qualityCodes(conformingBrief())).toEqual([]);
    expect(
      qualityCodes(
        conformingBrief({
          ui: [
            "## UI states and design-system sources",
            "",
            "| UI surface | Loading | Empty | Error | Success | Design-system component source |",
            "|---|---|---|---|---|---|",
            "| Search results | Skeleton | Empty state | Error banner | Result grid | `ResultsGrid` |",
          ].join("\n"),
          data: [
            "## Data-path envelope",
            "",
            "| Data path | Bound | Index expectation | Per-item I/O |",
            "|---|---|---|---|",
            "| Search scan | 100 rows | `items(search_key)` | none |",
          ].join("\n"),
          glossary: [
            "## Glossary impact",
            "",
            "| Public term | Owning glossary or contract |",
            "|---|---|",
            "| Quality surface | `contracts/quality-v1.md` |",
          ].join("\n"),
        }),
      ),
    ).toEqual([]);
  });

  it("accepts alternate Markdown section syntax independent of the parent section", () => {
    const alternate = [
      "Context\n=======\n\nBounded planning lint change.",
      "Scope fence\n-----------\n\nNon-goals: no runtime changes.",
      "## Arbitrary valid planning section",
      "Intent surfaces:\n\n| Acceptance criterion | Exercised surface |\n|---|---|\n| AC1 | CLI |",
      "Footprint & chain\n-----------------\n\n- `scripts/brief-lint.mjs`",
      "Simplest shape:\n\nExtend the existing scan.",
      "UI states and design-system sources:\n\nnone — no UI surface changes.",
      "Data-path envelope\n------------------\n\nnone — no data path changes.",
      "Glossary impact\n---------------\n\nnone — no new or renamed public names.",
    ].join("\n\n");
    expect(qualityCodes(alternate)).toEqual([]);
  });

  it.each([
    ["missing intent declaration", { intent: "" }, "BRIEF_QUALITY_INTENT_SURFACES"],
    [
      "empty intent table row",
      {
        intent: "## Intent surfaces\n\n| Acceptance criterion | Exercised surface |\n|---|---|\n| AC1 | |",
      },
      "BRIEF_QUALITY_INTENT_SURFACES",
    ],
    [
      "fenced pseudo-declaration",
      {
        intent:
          "## Notes\n\n```markdown\n## Intent surfaces\n\n| Acceptance criterion | Exercised surface |\n|---|---|\n| AC1 | CLI |\n```",
      },
      "BRIEF_QUALITY_INTENT_SURFACES",
    ],
    ["empty footprint", { footprint: "## Footprint & chain" }, "BRIEF_QUALITY_FOOTPRINT_SHAPE"],
    ["missing simplest shape", { simplest: "" }, "BRIEF_QUALITY_FOOTPRINT_SHAPE"],
    [
      "multi-line simplest shape",
      { simplest: "## Simplest shape\n\nExtend the existing scan\nwith another parser." },
      "BRIEF_QUALITY_FOOTPRINT_SHAPE",
    ],
    [
      "missing non-goals declaration",
      { scope: "## Scope fence\n\nIn scope: bounded lint changes." },
      "BRIEF_QUALITY_FOOTPRINT_SHAPE",
    ],
    [
      "renamed intent table field",
      { intent: intentDeclaration.replace("Exercised surface", "Target") },
      "BRIEF_QUALITY_INTENT_SURFACES",
    ],
    [
      "incomplete UI table under an arbitrary valid section",
      {
        ui: "## Arbitrary valid section\n\n### UI states and design-system sources\n\n| UI surface | Loading | Empty | Error | Success |\n|---|---|---|---|---|\n| Results | Wait | Empty | Error | Done |",
      },
      "BRIEF_QUALITY_UI_STATES",
    ],
    [
      "blank required UI table field",
      {
        ui: "## UI states and design-system sources\n\n| UI surface | Loading | Empty | Error | Success | Design-system component source |\n|---|---|---|---|---|---|\n| Results | Wait | Empty | Error | Done | |",
      },
      "BRIEF_QUALITY_UI_STATES",
    ],
    [
      "blank required data-path field",
      {
        data: "## Data-path envelope\n\n| Data path | Bound | Index expectation | Per-item I/O |\n|---|---|---|---|\n| Scan | 100 | | none |",
      },
      "BRIEF_QUALITY_DATA_PATH",
    ],
    ["malformed glossary none form", { glossary: "Glossary impact:\n\nnone" }, "BRIEF_QUALITY_GLOSSARY_IMPACT"],
    [
      "incomplete glossary table",
      {
        glossary:
          "## Glossary impact\n\n| Public term | Owner |\n|---|---|\n| Quality surface | `contracts/quality-v1.md` |",
      },
      "BRIEF_QUALITY_GLOSSARY_IMPACT",
    ],
    [
      "none form mixed with an applicable UI table",
      {
        ui: "## UI states and design-system sources\n\nnone — no UI surface changes.\n\n| UI surface | Loading | Empty | Error | Success | Design-system component source |\n|---|---|---|---|---|---|\n| Results | Wait | Empty | Error | Done | `Results` |",
      },
      "BRIEF_QUALITY_UI_STATES",
    ],
    [
      "duplicated declaration",
      { intent: `${intentDeclaration}\n\n${intentDeclaration}` },
      "BRIEF_QUALITY_INTENT_SURFACES",
    ],
    [
      "alternate-syntax declaration with a renamed field",
      {
        data: "Data-path envelope:\n\n| Data path | Limit | Index expectation | Per-item I/O |\n|---|---|---|---|\n| Scan | 100 | index | none |",
      },
      "BRIEF_QUALITY_DATA_PATH",
    ],
  ])("rejects %s through public lintBrief", (_description, overrides, expected) => {
    expect(qualityCodes(conformingBrief(overrides))).toContain(expected);
  });

  it("makes a missing declaration an enforcing CLI failure", async () => {
    const logs = [];
    const logger = { error: (message) => logs.push(message), log: (message) => logs.push(message) };
    await expect(main({ argv: ["brief.md"], load: async () => conformingBrief({ data: "" }), logger })).resolves.toBe(
      1,
    );
    expect(logs).toEqual([expect.stringContaining("BRIEF_QUALITY_DATA_PATH")]);
  });

  it("reports ready-10 omissions alongside an existing scanner violation", () => {
    const findings = qualityCodes("# Collision census\n");
    expect(findings).toContain("BRIEF_COLLISION_CENSUS");
    expect(findings.filter((code) => qualityFindingCodes.has(code))).toEqual([
      "BRIEF_QUALITY_INTENT_SURFACES",
      "BRIEF_QUALITY_FOOTPRINT_SHAPE",
      "BRIEF_QUALITY_UI_STATES",
      "BRIEF_QUALITY_DATA_PATH",
      "BRIEF_QUALITY_GLOSSARY_IMPACT",
    ]);
  });
});

describe("quality-surface planning contract mirrors", () => {
  const issueStandardPaths = [
    ".agents/skills/planning/references/issue-standard.md",
    ".claude/skills/planning/references/issue-standard.md",
  ];
  const pressureTestPaths = [
    ".agents/skills/planning/references/pressure-test.md",
    ".claude/skills/planning/references/pressure-test.md",
  ];
  const qualityKeys = [
    "INTENT",
    "CORRECTNESS",
    "SECURITY",
    "SURFACES",
    "SIMPLICITY",
    "DEPTH",
    "RELIABILITY",
    "PERFORMANCE",
    "EXPERIENCE",
    "LANGUAGE",
  ];
  const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8");
  const verdictKeys = (source) => [...source.matchAll(/^\| ([A-Z]+) \|/gm)].map((match) => match[1]);
  const hasCanonicalVerdict = (source) => JSON.stringify(verdictKeys(source)) === JSON.stringify(qualityKeys);

  it("keeps the five declarations and drafting-only ready-10 rule identical in both issue standards", () => {
    const sources = issueStandardPaths.map(read);
    expect(sources[0]).toBe(sources[1]);
    for (const token of [
      "1. **AC exercised surfaces.**",
      "2. **Footprint and simplest shape.**",
      "3. **UI states and design-system sources.**",
      "4. **Data-path envelope.**",
      "5. **Glossary impact.** The existing",
      "`ready-10-quality-surfaces`",
      "explicitly outside the `issue-readiness/v1`",
    ]) {
      expect(sources[0].split(token)).toHaveLength(2);
    }
    for (const id of [
      "ready-00-placed-classified",
      "ready-00-dependencies-resolved",
      ...Array.from({ length: 9 }, (_value, index) => `ready-${String(index + 1).padStart(2, "0")}`),
    ]) {
      expect(sources[0]).toContain(id);
    }
  });

  it("keeps the complete canonical ten-key verdict identical in both pressure-test mirrors", () => {
    const sources = pressureTestPaths.map(read);
    expect(sources[0]).toBe(sources[1]);
    expect(verdictKeys(sources[0])).toEqual(qualityKeys);
  });

  it("rejects omitted, duplicated, reordered, and renamed verdict keys", () => {
    const source = read(pressureTestPaths[0]);
    const intentLine =
      "| INTENT | Acceptance criteria mapped to executed probes | An acceptance criterion is unmet or has no executed probe |";
    const correctnessLine =
      "| CORRECTNESS | Executed reproductions on the exact head | Any confirmed incorrect behavior |";
    for (const mutation of [
      source.replace(`${intentLine}\n`, ""),
      source.replace(intentLine, `${intentLine}\n${intentLine}`),
      source.replace(`${intentLine}\n${correctnessLine}`, `${correctnessLine}\n${intentLine}`),
      source.replace("| INTENT |", "| PURPOSE |"),
    ]) {
      expect(hasCanonicalVerdict(mutation)).toBe(false);
    }
  });
});
