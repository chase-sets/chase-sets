import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  "BRIEF_QUALITY_PROFILE",
  "BRIEF_QUALITY_INTENT_SURFACES",
  "BRIEF_QUALITY_G0",
  "BRIEF_QUALITY_FOOTPRINT_SHAPE",
  "BRIEF_QUALITY_UI_STATES",
  "BRIEF_QUALITY_DATA_PATH",
  "BRIEF_QUALITY_CONTRACT_COMPATIBILITY",
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
  profile: "QUALITY_PROFILE: product-feature",
  scope: "## Scope fence\n\nIn scope: bounded lint changes.\n\nNon-goals: no runtime or provider changes.",
  intent: intentDeclaration,
  footprint: "## Footprint & chain\n\n- `scripts/brief-lint.mjs`",
  simplest: "## Simplest shape\n\nExtend the existing Markdown scan with v2 declarations.",
  notBuilt: "## Not built\n\n| Not built | Reason |\n|---|---|\n| Second parser | Existing scan owns Markdown. |",
  ui: "## UI states and design-system sources\n\nnone — no UI surface changes.",
  data: "## Data-path envelope\n\nnone — no data path changes.",
  compatibility: "## Contract compatibility\n\nnone — no schema, event, or contract changes.",
  glossary: "## Glossary impact\n\nnone — no new or renamed public names.",
};

function conformingBrief(overrides = {}) {
  return [
    "# Context\n\nBounded planning lint change.",
    overrides.profile ?? qualitySections.profile,
    overrides.scope ?? qualitySections.scope,
    overrides.intent ?? qualitySections.intent,
    overrides.footprint ?? qualitySections.footprint,
    overrides.simplest ?? qualitySections.simplest,
    overrides.notBuilt ?? qualitySections.notBuilt,
    overrides.ui ?? qualitySections.ui,
    overrides.data ?? qualitySections.data,
    overrides.compatibility ?? qualitySections.compatibility,
    overrides.glossary ?? qualitySections.glossary,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function nonQualityResult(body) {
  const result = lintBrief(body);
  return { ...result, findings: result.findings.filter((finding) => !qualityFindingCodes.has(finding.code)) };
}

function codes(body) {
  return nonQualityResult(body).findings.map((finding) => finding.code);
}

function qualityCodes(body) {
  return lintBrief(body).findings.map((finding) => finding.code);
}

describe("brief body byte limit", () => {
  it("accepts exactly 12 × 1024 UTF-8 bytes and rejects one byte more", () => {
    expect(nonQualityResult("a".repeat(BRIEF_MAX_BYTES))).toMatchObject({ bytes: BRIEF_MAX_BYTES, findings: [] });
    expect(codes("a".repeat(BRIEF_MAX_BYTES + 1))).toContain("BRIEF_BODY_BYTES");
  });

  it("measures a Unicode boundary in UTF-8 bytes rather than JavaScript characters", () => {
    const exact = `${"a".repeat(BRIEF_MAX_BYTES - 4)}💡`;
    expect(exact.length).toBeLessThan(BRIEF_MAX_BYTES);
    expect(nonQualityResult(exact)).toMatchObject({ bytes: BRIEF_MAX_BYTES, findings: [] });
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

  it("runs the actual public CLI with enforcing zero and one exits", () => {
    const cliPath = path.join(repoRoot, "scripts/brief-lint.mjs");
    const pass = spawnSync(process.execPath, [cliPath, "-"], { encoding: "utf8", input: conformingBrief() });
    expect(pass).toMatchObject({ status: 0, stderr: "" });
    expect(pass.stdout).toContain("Brief lint passed");

    const fail = spawnSync(process.execPath, [cliPath, "-"], {
      encoding: "utf8",
      input: conformingBrief({ profile: "QUALITY_PROFILE:" }),
    });
    expect(fail.status).toBe(1);
    expect(fail.stderr).toContain("BRIEF_QUALITY_PROFILE");
  });
});

describe("ready-10 quality-surface declarations", () => {
  it.each(["prototype", "product-feature", "core-library", "hot-path", "migration", "contract"])(
    "accepts the installed %s profile",
    (profile) => expect(qualityCodes(conformingBrief({ profile: `QUALITY_PROFILE: ${profile}` }))).toEqual([]),
  );

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
          compatibility: [
            "## Contract compatibility",
            "",
            "| Changed contract | Compatibility posture | Removed path |",
            "|---|---|---|",
            "| Brief declaration | Breaking for future registrations | v1 declaration |",
          ].join("\n"),
          glossary: [
            "## Glossary impact",
            "",
            "| Public term | Owning glossary or contract |",
            "|---|---|",
            "| Quality profile | `contracts/quality-v2.md` |",
          ].join("\n"),
        }),
      ),
    ).toEqual([]);
  });

  it("accepts alternate Markdown section syntax independent of the parent section", () => {
    const alternate = [
      "Context\n=======\n\nBounded planning lint change.",
      "QUALITY_PROFILE: core-library",
      "Scope fence\n-----------\n\nNon-goals: no runtime changes.",
      "## Arbitrary valid planning section",
      "Intent surfaces:\n\n| Acceptance criterion | Exercised surface |\n|---|---|\n| AC1 | CLI |",
      "Footprint & chain\n-----------------\n\n- `scripts/brief-lint.mjs`",
      "Simplest shape:\n\nExtend the existing scan.",
      "Not built:\n\n| Not built | Reason |\n|---|---|\n| Parser | Existing scan owns it. |",
      "UI states and design-system sources:\n\nnone — no UI surface changes.",
      "Data-path envelope\n------------------\n\nnone — no data path changes.",
      "Contract compatibility\n----------------------\n\nnone — no schema, event, or contract changes.",
      "Glossary impact\n---------------\n\nnone — no new or renamed public names.",
    ].join("\n\n");
    expect(qualityCodes(alternate)).toEqual([]);
  });

  it.each([
    ["missing quality profile", { profile: "" }, "BRIEF_QUALITY_PROFILE"],
    ["empty quality profile", { profile: "QUALITY_PROFILE:" }, "BRIEF_QUALITY_PROFILE"],
    ["unknown quality profile", { profile: "QUALITY_PROFILE: service" }, "BRIEF_QUALITY_PROFILE"],
    [
      "duplicate quality profile",
      { profile: "QUALITY_PROFILE: core-library\nQUALITY_PROFILE: contract" },
      "BRIEF_QUALITY_PROFILE",
    ],
    ["fenced pseudo-profile", { profile: "```text\nQUALITY_PROFILE: core-library\n```" }, "BRIEF_QUALITY_PROFILE"],
    ["indented-code pseudo-profile", { profile: "    QUALITY_PROFILE: core-library" }, "BRIEF_QUALITY_PROFILE"],
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
    ["missing simplest shape", { simplest: "" }, "BRIEF_QUALITY_G0"],
    [
      "multi-line simplest shape",
      { simplest: "## Simplest shape\n\nExtend the existing scan\nwith another parser." },
      "BRIEF_QUALITY_G0",
    ],
    ["missing not-built declaration", { notBuilt: "" }, "BRIEF_QUALITY_G0"],
    [
      "blank not-built reason",
      { notBuilt: "## Not built\n\n| Not built | Reason |\n|---|---|\n| Second parser | |" },
      "BRIEF_QUALITY_G0",
    ],
    [
      "not-built payload outside its heading boundary",
      {
        notBuilt:
          "## Not built\n\n## Arbitrary peer\n\n| Not built | Reason |\n|---|---|\n| Second parser | Existing scan owns it. |",
      },
      "BRIEF_QUALITY_G0",
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
    [
      "malformed compatibility none form",
      { compatibility: "Contract compatibility:\n\nnone" },
      "BRIEF_QUALITY_CONTRACT_COMPATIBILITY",
    ],
    [
      "blank compatibility posture",
      {
        compatibility:
          "## Contract compatibility\n\n| Changed contract | Compatibility posture | Removed path |\n|---|---|---|\n| Brief | | v1 |",
      },
      "BRIEF_QUALITY_CONTRACT_COMPATIBILITY",
    ],
    ["malformed glossary none form", { glossary: "Glossary impact:\n\nnone" }, "BRIEF_QUALITY_GLOSSARY_IMPACT"],
    [
      "incomplete glossary table",
      {
        glossary:
          "## Glossary impact\n\n| Public term | Owner |\n|---|---|\n| Quality profile | `contracts/quality-v2.md` |",
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
      "BRIEF_QUALITY_PROFILE",
      "BRIEF_QUALITY_INTENT_SURFACES",
      "BRIEF_QUALITY_G0",
      "BRIEF_QUALITY_FOOTPRINT_SHAPE",
      "BRIEF_QUALITY_UI_STATES",
      "BRIEF_QUALITY_DATA_PATH",
      "BRIEF_QUALITY_CONTRACT_COMPATIBILITY",
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
    "SCOPE",
    "ROBUSTNESS",
    "DEPTH",
    "READABILITY",
    "TESTS",
    "OBSERVABILITY",
    "SECURITY",
    "PERFORMANCE",
    "ROLLOUT",
    "CONSISTENCY",
    "EXPERIENCE",
    "LANGUAGE",
  ];
  const profileRows = [
    "| SCOPE | Med | High | High | High | High | High |",
    "| ROBUSTNESS | Low | Med | High | Med | High | High |",
    "| DEPTH | Med | Med | High | Med | Low | High |",
    "| READABILITY | Low | Med | High | Med | Med | Med |",
    "| TESTS | Low | Med | High | High | High | High |",
    "| OBSERVABILITY | Low | Med | Med | High | High | High |",
    "| SECURITY | Med | High | Med | Med | High | High |",
    "| PERFORMANCE | Low | Low | Med | High | Med | Low |",
    "| ROLLOUT | Low | Med | High | Med | High | High |",
    "| CONSISTENCY | Low | Med | High | Med | Med | High |",
    "| EXPERIENCE | Low | High | Low | Low | Low | Low |",
    "| LANGUAGE | Med | High | High | Med | Med | High |",
  ];
  const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8");
  const pairSection = (source) =>
    source.slice(source.indexOf("| Key | Pair |"), source.indexOf("\n\nUse the contract"));
  const pairKeys = (source) => [...pairSection(source).matchAll(/^\| ([A-Z]+) \|/gm)].map((match) => match[1]);
  const hasCanonicalPairs = (source) => {
    const section = pairSection(source);
    return (
      JSON.stringify(pairKeys(source)) === JSON.stringify(qualityKeys) &&
      section.includes("| Key | Pair | Too little blocks when | Too much blocks when | Evidence |")
    );
  };

  it("keeps the v2 declarations and drafting-only ready-10 rule identical in both issue standards", () => {
    const sources = issueStandardPaths.map(read);
    expect(sources[0]).toBe(sources[1]);
    for (const token of [
      "1. **Quality profile.**",
      "2. **AC exercised surfaces.**",
      "3. **G0, footprint, and non-goals.**",
      "4. **UI states and design-system sources.**",
      "5. **Data-path envelope.**",
      "6. **Contract compatibility.**",
      "7. **Glossary impact.**",
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

  it("keeps G0, profile weights, and the canonical twelve two-sided pairs identical in both mirrors", () => {
    const sources = pressureTestPaths.map(read);
    expect(sources[0]).toBe(sources[1]);
    expect(sources[0]).toContain("QUALITY_PROFILE");
    expect(sources[0]).toContain("G0: PASS <not-built list verified> | BLOCK_REPLAN <simpler shape>");
    expect(profileRows.every((row) => sources[0].split(row).length === 2)).toBe(true);
    expect(pairKeys(sources[0])).toEqual(qualityKeys);
  });

  it("detects profile-weight drift", () => {
    const source = read(pressureTestPaths[0]);
    const hasCanonicalWeights = (value) =>
      value.includes("| Key | prototype | product-feature | core-library | hot-path | migration | contract |") &&
      profileRows.every((row) => value.split(row).length === 2);
    for (const mutation of [
      source.replace("| Key | prototype | product-feature | core-library |", "| Key | prototype | core-library |"),
      source.replace(
        profileRows[0],
        profileRows[0].replace("| High | High | High | High | High |", "| Low | High | High | High | High |"),
      ),
      source.replace(
        "| ROBUSTNESS | Low | Med | High | Med | High | High |",
        "| ROBUSTNESS | Low | Med | Extreme | Med | High | High |",
      ),
    ]) {
      expect(hasCanonicalWeights(mutation)).toBe(false);
    }
  });

  it("rejects omitted, duplicated, reordered, renamed, and one-sided pair declarations", () => {
    const source = read(pressureTestPaths[0]);
    const scopeLine = pairSection(source)
      .split("\n")
      .find((line) => line.startsWith("| SCOPE |"));
    const robustnessLine = pairSection(source)
      .split("\n")
      .find((line) => line.startsWith("| ROBUSTNESS |"));
    for (const mutation of [
      source.replace(`${scopeLine}\n`, ""),
      source.replace(scopeLine, `${scopeLine}\n${scopeLine}`),
      source.replace(`${scopeLine}\n${robustnessLine}`, `${robustnessLine}\n${scopeLine}`),
      source.replace(scopeLine, scopeLine.replace("| SCOPE |", "| PURPOSE |")),
      source.replace(
        "| Key | Pair | Too little blocks when | Too much blocks when | Evidence |",
        "| Key | Pair | Too little blocks when | Evidence |",
      ),
    ]) {
      expect(hasCanonicalPairs(mutation)).toBe(false);
    }
  });
});
