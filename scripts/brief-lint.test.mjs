import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRIEF_MAX_BYTES, lintBrief, main, parseSupersedesSection } from "./brief-lint.mjs";
import {
  ISSUE_READINESS_RULES,
  PROSPECTIVE_ISSUE_READINESS_RUN_SCHEMA_VERSION,
  consumeIssueReadinessReceipt,
  main as readinessMain,
} from "./issue-readiness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const issueReadinessFixture = JSON.parse(
  readFileSync(new URL("./fixtures/issue-readiness-v1.json", import.meta.url), "utf8"),
);
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
  "BRIEF_QUALITY_SUPERSEDED_PATHS",
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
  superseded: "## Superseded paths\n\nnone — no existing path is replaced or made redundant.",
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
    overrides.superseded ?? qualitySections.superseded,
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

function replaceIssueField(body, label, value) {
  const heading = `### ${label}`;
  const start = body.indexOf(heading);
  if (start === -1) throw new Error(`Fixture field not found: ${label}`);
  const contentStart = start + heading.length;
  const next = body.indexOf("\n### ", contentStart);
  const end = next === -1 ? body.length : next;
  return `${body.slice(0, contentStart)}\n\n${value}\n${body.slice(end)}`;
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

describe("explicit-none vocabulary", () => {
  it("shared explicit-none forms pass both checkers", () => {
    const body = replaceIssueField(
      issueReadinessFixture.readyBody,
      "Glossary impact",
      issueReadinessFixture.explicitNone.glossary,
    );

    expect(lintBrief(body).findings.map((finding) => finding.code)).not.toContain("BRIEF_QUALITY_GLOSSARY_IMPACT");
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
    expect(codes("### Don't-rebuild pointers\n\n- `scripts/a.mjs`\n    because it already exists.")).toContain(
      "BRIEF_DONT_REBUILD_POINTER_FORMAT",
    );
    expect(codes("### Don't-rebuild pointers\n\n- `scripts/a.mjs`\n\tbecause it already exists.")).toContain(
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

describe("supersedes declaration", () => {
  it("treats an absent section as an empty declaration", () => {
    expect(parseSupersedesSection("# Brief\n\nNo predecessor.\n")).toEqual({ entries: [], findings: [] });
    expect(codes(conformingBrief())).not.toContain("BRIEF_SUPERSEDES_FORMAT");
  });

  it("parses full and partial predecessor entries", () => {
    const body = "### Supersedes\n\n- #7815 full\n- #8355 partial: catalog acceptance and import evidence\n";
    expect(parseSupersedesSection(body)).toEqual({
      entries: [
        { number: 7815, coverage: "full", dropped: null },
        { number: 8355, coverage: "partial", dropped: "catalog acceptance and import evidence" },
      ],
      findings: [],
    });
    expect(codes(body)).toEqual([]);
  });

  it("keeps valid entries while reporting malformed, unknown, duplicate, and empty partial items", () => {
    const body = [
      "### Supersedes",
      "",
      "- #7815 full",
      "- #8355 partial:",
      "- #8642 adjacent",
      "- #7815 partial: duplicate predecessor",
    ].join("\n");
    const parsed = parseSupersedesSection(body);
    expect(parsed.entries).toEqual([{ number: 7815, coverage: "full", dropped: null }]);
    expect(parsed.findings).toHaveLength(3);
    expect(parsed.findings.every((finding) => finding.code === "BRIEF_SUPERSEDES_FORMAT")).toBe(true);
    expect(parsed.findings.map((finding) => finding.line)).toEqual([4, 5, 6]);
    expect(codes(body)).toEqual(["BRIEF_SUPERSEDES_FORMAT", "BRIEF_SUPERSEDES_FORMAT", "BRIEF_SUPERSEDES_FORMAT"]);
  });

  it.each([
    ["- #123", "incomplete item"],
    ["- #123 almost", "unknown coverage"],
    ["- #123 partial:", "empty partial reason"],
    ["* #123 full", "wrong list marker"],
  ])("rejects %s (%s)", (item) => {
    const parsed = parseSupersedesSection(`### Supersedes\n\n${item}\n`);
    expect(parsed.entries).toEqual([]);
    expect(parsed.findings).toMatchObject([{ code: "BRIEF_SUPERSEDES_FORMAT", line: 3 }]);
  });

  it("reports malformed duplicate items as format errors", () => {
    const parsed = parseSupersedesSection("### Supersedes\n\n- #123 full\n- #123 partial:\n");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].message).toContain("Supersedes items must be");
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

  it("requires the supersession check and removal placement even on the Issues tier in both mirrors", () => {
    const sources = [".agents", ".claude"].map((root) =>
      readFileSync(path.join(repoRoot, root, "skills/planning/SKILL.md"), "utf8"),
    );
    expect(sources[0]).toBe(sources[1]);
    for (const source of sources) {
      for (const clause of [
        "Run a **supersession check**: inventory every existing\n   path the planned change replaces or makes redundant",
        "Stage 2-light for Issues still requires this check.",
        "Place each superseded\n   path's removal in the replacing slice or in a removal slice natively dependent\n   on the switchover, in the same committed outcome, never candidate, parked or\n   unfiled work.",
        "Each removal has an owning acceptance criterion and named\n   evidence method.",
        "For Issues tier, Stage 5 performs the removal placement specified in\n   Decomposition; tier shortcuts never skip the supersession check or placement.",
      ])
        expect(source.split(clause)).toHaveLength(2);
    }
  });

  it("documents the optional Supersedes declaration in both issue standards", () => {
    const declaration =
      "**Supersedes (optional).** When this issue replaces an open predecessor,\n  declare one predecessor per item using exactly `- #<n> full` or\n  `- #<n> partial: <dropped criteria>`.";
    const sources = [".agents", ".claude"].map((root) =>
      readFileSync(path.join(repoRoot, root, "skills/planning/references/issue-standard.md"), "utf8"),
    );
    expect(sources[0]).toBe(sources[1]);
    for (const source of sources) expect(source).toContain(declaration);
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
            "| Changed contract | Compatibility posture |",
            "|---|---|",
            "| Brief declaration | Breaking for future registrations |",
          ].join("\n"),
          glossary: [
            "## Glossary impact",
            "",
            "| Public term | Owning glossary or contract |",
            "|---|---|",
            "| Quality profile | `contracts/quality-v2.md` |",
          ].join("\n"),
          superseded: [
            "## Superseded paths",
            "",
            "| Superseded path | Replacement | Removal |",
            "|---|---|---|",
            "| v1 declaration | v2 declaration | this issue |",
            "| old workflow | new workflow | #42 |",
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
      "Superseded paths\n----------------\n\nnone — no existing path is replaced or made redundant.",
    ].join("\n\n");
    expect(qualityCodes(alternate)).toEqual([]);
  });

  it("treats inert Markdown examples as absent declaration content", () => {
    const indentedIntent = conformingBrief({
      intent: [
        "## Intent surfaces",
        "",
        "    | Acceptance criterion | Exercised surface |",
        "    |---|---|",
        "    | AC1 | lintBrief |",
      ].join("\n"),
    });
    expect(qualityCodes(indentedIntent)).toContain("BRIEF_QUALITY_INTENT_SURFACES");

    for (const scope of [
      "## Scope fence\n\nIn scope: bounded lint changes.\n\n```md\nNon-goals: no runtime changes.\n```",
      "## Scope fence\n\nIn scope: bounded lint changes.\n\n    Non-goals: no runtime changes.",
      "## Scope fence\n\nIn scope: bounded lint changes.\n\n\tNon-goals: no runtime changes.",
    ]) {
      expect(qualityCodes(conformingBrief({ scope }))).toContain("BRIEF_QUALITY_FOOTPRINT_SHAPE");
    }
  });

  it("keeps a quoted standalone declaration example inert beside the real section", () => {
    const body = conformingBrief({
      scope:
        "## Scope fence\n\n> Intent surfaces:\n\nIn scope: bounded lint changes.\n\nNon-goals: no runtime changes.",
    });
    expect(qualityCodes(body)).toEqual([]);
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
          "## Contract compatibility\n\n| Changed contract | Compatibility posture |\n|---|---|\n| Brief | |",
      },
      "BRIEF_QUALITY_CONTRACT_COMPATIBILITY",
    ],
    [
      "old three-column compatibility table",
      {
        compatibility:
          "## Contract compatibility\n\n| Changed contract | Compatibility posture | Removed path |\n|---|---|---|\n| Brief | Breaking | v1 |",
      },
      "BRIEF_QUALITY_CONTRACT_COMPATIBILITY",
    ],
    ["missing superseded paths", { superseded: "" }, "BRIEF_QUALITY_SUPERSEDED_PATHS"],
    ["empty superseded paths", { superseded: "## Superseded paths" }, "BRIEF_QUALITY_SUPERSEDED_PATHS"],
    [
      "partial superseded paths table",
      {
        superseded: "## Superseded paths\n\n| Superseded path | Replacement | Removal |\n|---|---|---|\n| v1 | v2 | |",
      },
      "BRIEF_QUALITY_SUPERSEDED_PATHS",
    ],
    [
      "malformed superseded paths none form",
      { superseded: "## Superseded paths\n\nnone" },
      "BRIEF_QUALITY_SUPERSEDED_PATHS",
    ],
    [
      "superseded paths none mixed with table",
      {
        superseded:
          "## Superseded paths\n\nnone — no existing path is replaced or made redundant.\n\n| Superseded path | Replacement | Removal |\n|---|---|---|\n| v1 | v2 | this issue |",
      },
      "BRIEF_QUALITY_SUPERSEDED_PATHS",
    ],
    [
      "fenced superseded paths declaration",
      { superseded: "```md\n## Superseded paths\n\nnone — no existing path is replaced or made redundant.\n```" },
      "BRIEF_QUALITY_SUPERSEDED_PATHS",
    ],
    [
      "duplicate superseded paths declaration",
      { superseded: `${qualitySections.superseded}\n\n${qualitySections.superseded}` },
      "BRIEF_QUALITY_SUPERSEDED_PATHS",
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

  it("returns exit 1 for malformed inert-content input through the real CLI", () => {
    const cliPath = path.join(repoRoot, "scripts/brief-lint.mjs");
    const malformed = spawnSync(process.execPath, [cliPath, "-"], {
      encoding: "utf8",
      input: conformingBrief({
        intent:
          "## Intent surfaces\n\n    | Acceptance criterion | Exercised surface |\n    |---|---|\n    | AC1 | lintBrief |",
      }),
    });
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("BRIEF_QUALITY_INTENT_SURFACES");
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
      "BRIEF_QUALITY_SUPERSEDED_PATHS",
    ]);
  });
});

describe("quality-surface planning contract mirrors", () => {
  it("keeps dependent removal children committed and out of Parked in both epic standards", () => {
    const sources = [".agents", ".claude"].map((root) =>
      readFileSync(path.join(repoRoot, root, "skills/planning/references/epic-standard.md"), "utf8"),
    );
    expect(sources[0]).toBe(sources[1]);
    for (const source of sources) {
      for (const clause of [
        "A separate removal child for a path this plan itself supersedes follows its\n    switchover through a native Blocked by dependency in the chain DAG",
        "in the same committed outcome, and must not be listed under Parked.",
        "within the replacing child needs no self-dependency.",
        "remain write-once; next-round corrections use a superseding comment, not a\n    body rewrite.",
      ])
        expect(source.split(clause)).toHaveLength(2);
    }
  });
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
      "8. **Superseded paths.**",
      "`ready-10-quality-surfaces`",
      "explicitly outside the `issue-readiness/v1`",
    ]) {
      expect(sources[0].split(token)).toHaveLength(2);
    }
    for (const source of sources) {
      expect(source).toContain("`Changed contract`, `Compatibility posture`,");
      expect(source).toContain("`Superseded path | Replacement | Removal`");
      expect(source).toContain("`none — no existing path is replaced or made redundant.`");
      expect(source).toContain("is `this issue` or the native successor `#N`, identifying the owning slice.");
      expect(source).toContain("explicit acceptance criterion with a named\n   evidence method in its owning slice.");
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
    for (const source of sources) {
      expect(source.split("13. **Supersession completeness.**")).toHaveLength(2);
      for (const clause of [
        "Check only existing paths the planned change\n    itself replaces or makes redundant.",
        "Flag an omitted path, a removal lacking\n    an owning acceptance criterion and evidence method",
        "a removal deferred\n    outside the committed outcome.",
        "required acceptance, not\n    unrelated debt or a SCOPE too-much finding.",
        "Unrelated cleanup remains outside\n    scope; G0 still minimizes the implementation and evidence",
      ])
        expect(source.split(clause)).toHaveLength(2);
    }
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

describe("product pre-registration preflight", () => {
  const skillPaths = [".agents/skills/planning/SKILL.md", ".claude/skills/planning/SKILL.md"];
  const readSkills = () => skillPaths.map((relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8"));
  const SECTION_HEADING = "### Pre-registration checks";
  const LINT_COMMAND = "node ./scripts/brief-lint.mjs <path-to-brief.md>";
  const READINESS_COMMAND =
    "node ./scripts/issue-readiness.mjs --prospective-body <path-to-brief.md> --prospective-metadata <path-to-metadata.json> --checker-sha <40-character-checker-commit>";
  const LINT_ONLY_SENTENCE = "Before registration, render the prospective issue body to a Markdown file and run:";
  const LINT_ONLY_INSTRUCTION = `Before registration, render the prospective issue body to a Markdown\nfile and run:\n\n\`\`\`powershell\n${LINT_COMMAND}\n\`\`\`\n`;
  const ENTRY_PATHS = [
    "fast and full path",
    "Issues tier",
    "Epic and Milestone children",
    "host and review follow-ups",
    "replan or repair rounds",
  ];
  // Each metadata key the prospective evaluator requires, with the qualifier the
  // instruction must state for it.
  const METADATA_FIELDS = {
    repository: "`repository`",
    number: "`number`",
    state: "`state`",
    issueType: "the enabled native `issueType`",
    milestone: "the full `milestone` with its outcome-policy description",
    labels: "`labels`",
    parentNumber: "`parentNumber`",
    dependencies: "the complete native `dependencies` (Blocked by) set",
  };
  const ROUTE_CLAUSES = {
    "product-scope":
      "Every `chase-sets/chase-sets` brief runs two checks on its exact prospective tuple before the issue is created or a repaired or replanned body is adopted:",
    "both-required": "Every product path runs both checks, and neither replaces the other.",
  };
  const BOUNDARY_CLAUSES = {
    "controller-route":
      "A `chase-sets/chase-sets-controller` brief keeps the same body standard, lint and pressure test, but follows that repository's readiness and release contracts, not this eleven-rule check.",
    "controller-refusal":
      "Never move controller work into a product brief, or hide a controller footprint, to pass: the product checker refuses a footprint that names tracked controller source (`FOOTPRINT_IN_CONTROLLER_REPOSITORY`).",
  };
  const TUPLE_CLAUSES = {
    "tuple-exact":
      "Render the exact body bytes to a Markdown file and the intended metadata to a JSON file, then run both checks with the scripts of the inspected `origin/main` commit:",
    "tuple-number": "Use a disclosed positive placeholder `number` for a new issue and the actual number for a repair.",
    "tuple-truthful":
      "Mark each value as a proposal or a captured live fact; never omit or fabricate a blocker or identity to pass.",
    "checker-sha": "`--checker-sha` is the 40-character commit whose scripts ran.",
    "tuple-retention": "Retain both inputs, their SHA-256 hashes, the checker commit, and both complete outputs.",
    "tuple-invalidation": "Any edit to the body or metadata invalidates the proof: rerun both checks.",
    "issue-authored-text": "Never execute the brief's own verification text as part of either check.",
  };
  const INSPECTION_CLAUSES = {
    "lint-pass": "Lint must pass.",
    "not-exit-code": "Judge the readiness JSON, not its exit code, which is 0 even for `not-ready`:",
    "every-rule-once":
      "`checkedRules` must list each of the eleven `issue-readiness/v1` rule IDs exactly once, with its status and reason codes.",
    "dispatch-ready":
      "A brief intended to become dispatchable needs status `ready`, all eleven rules `pass`, and no reason codes.",
    "lawful-record":
      "A lawful blocked or candidate registration keeps its genuine metadata and records, before creation, each expected failure with its rule ID, exact reason codes, and lifecycle, dependency or decision reason.",
    "lawful-only": "Only these failures are lawful:",
    "lawful-placement":
      "`ready-00-placed-classified` for intentional non-runnable placement or lifecycle, listing every reason code it reports;",
    "lawful-dependency":
      "`ready-00-dependencies-resolved` with `OPEN_NATIVE_DEPENDENCY` for genuine open native blockers;",
    "lawful-decision":
      "`ready-06-decisions-resolved` with `UNRESOLVED_DECISION_DECLARED` for a linked unresolved decision that is also an open native blocker, recording both the decision and dependency diagnostics.",
    "no-other-waiver": "Every other rule must pass, and no other `ready-06` failure is waived.",
    "withhold-dispatch": "Register the issue blocked or candidate and withhold dispatch.",
    "fail-closed":
      "Any other failure, an `unknown` status or rule, malformed or incomplete output, or a missing or duplicate rule ID returns the brief to drafting.",
    authority:
      "This prospective proof grants neither dispatch authority nor a semantic pass: the fresh pressure test and a current trusted-default-branch readiness receipt (Enforcement below) still decide dispatch.",
  };
  // A sentence that names one of the checks next to skip/omit/exempt/optional or
  // lint-only vocabulary exempts a path; the guard fails closed on it anywhere.
  const CHECK_NAME =
    /\b(?:brief-lint|issue-readiness|pre-registration|lint|preflight|(?:both|two|readiness) checks?)\b/i;
  const EXEMPTION_GRANT =
    /\b(?:skip|skips|skipped|omit|omits|exempt|optional|optionally|instead of|need not|not required|only (?:the )?lint|lint(?: check)? only)\b/i;

  const activeMarkdown = (markdown) => markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const normalize = (text) => text.replace(/\s+/g, " ").trim();

  function splitFences(markdown) {
    const prose = [];
    const fenced = [];
    let fence = false;
    for (const line of markdown.split(/\r?\n/)) {
      if (/^\s*```/.test(line)) {
        fence = !fence;
        continue;
      }
      (fence ? fenced : prose).push(line);
    }
    return { prose: normalize(prose.join("\n")), fenced: fenced.map((line) => line.trim()) };
  }

  function preflightSection(active) {
    const starts = [...active.matchAll(/^### Pre-registration checks[ \t]*$/gm)];
    if (starts.length !== 1) return null;
    const bodyStart = starts[0].index + starts[0][0].length;
    const next = active.slice(bodyStart).search(/^#{1,3} /m);
    return active.slice(bodyStart, next === -1 ? active.length : bodyStart + next);
  }

  function preflightViolations(skill) {
    const active = activeMarkdown(skill);
    const section = preflightSection(active);
    const { prose, fenced } = splitFences(section ?? "");
    const once = (clause) => prose.split(clause).length === 2;
    const metadataSentence = prose.match(/The metadata names [^.]*\./)?.[0] ?? "";
    const violations = section === null ? ["section"] : [];
    if (!fenced.includes(LINT_COMMAND)) violations.push("lint-command");
    if (!fenced.includes(READINESS_COMMAND)) violations.push("readiness-command");
    for (const entryPath of ENTRY_PATHS) if (!once(entryPath)) violations.push(`entry-path:${entryPath}`);
    for (const [key, phrase] of Object.entries(METADATA_FIELDS)) {
      if (metadataSentence.split(phrase).length !== 2) violations.push(`tuple-field:${key}`);
    }
    for (const clauses of [ROUTE_CLAUSES, BOUNDARY_CLAUSES, TUPLE_CLAUSES, INSPECTION_CLAUSES]) {
      for (const [name, clause] of Object.entries(clauses)) if (!once(clause)) violations.push(name);
    }
    if (normalize(active).includes(LINT_ONLY_SENTENCE)) violations.push("lint-only");
    const sentences = splitFences(active).prose.split(/(?<=[.!?;])\s+/);
    if (sentences.some((sentence) => CHECK_NAME.test(sentence) && EXEMPTION_GRANT.test(sentence))) {
      violations.push("product-path-exemption");
    }
    return violations;
  }

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function mutate(source, from, to) {
    const pattern = typeof from === "string" ? new RegExp(escapeRegExp(from).replace(/ /g, "\\s+")) : from;
    const mutant = source.replace(pattern, () => to);
    expect(mutant, `mutation anchor not found: ${from}`).not.toBe(source);
    return mutant;
  }
  function expectClauseDeletionsRed(clauses) {
    for (const source of readSkills()) {
      for (const [name, clause] of Object.entries(clauses)) {
        expect(preflightViolations(mutate(source, clause, "")), name).toEqual([name]);
      }
    }
  }

  // Synthetic tuple inputs: identities are unmistakably synthetic, the number is
  // a disclosed placeholder, and only each case's governing variable changes.
  const CHECKER_SHA = "c".repeat(40);
  const CHECKED_AT = new Date("2026-01-01T00:00:00.000Z");
  const RULE_IDS = ISSUE_READINESS_RULES.map(({ id }) => id);
  const committedOutcome = Object.freeze({
    id: "synthetic-committed-outcome",
    number: 9001,
    title: "Synthetic committed outcome",
    description: '<!-- outcome: {"version":1,"track":"delivery","order":1,"status":"committed"} -->',
    state: "open",
  });
  const candidateOutcome = Object.freeze({
    ...committedOutcome,
    id: "synthetic-candidate-outcome",
    number: 9002,
    title: "Synthetic candidate outcome",
    description: committedOutcome.description.replace('"committed"', '"candidate"'),
  });
  const openBlocker = (number) => ({
    nodeId: `synthetic-blocker-${number}`,
    number,
    state: "open",
    updatedAt: "2026-01-01T00:00:00Z",
    issueTypeName: "Slice",
  });
  const tuple = (overrides = {}) => ({
    repository: "chase-sets/chase-sets",
    number: 1,
    state: "open",
    issueType: { nodeId: "synthetic-slice-type", name: "Slice", isEnabled: true },
    milestone: committedOutcome,
    labels: ["area:ops", "kind:tech-debt", "priority:p1"],
    parentNumber: null,
    dependencies: [],
    ...overrides,
  });
  const UNRESOLVED_DECISION =
    "The retention decision is unresolved; it is tracked in #9101 and this issue is Blocked by #9101.";
  const UNPROVEN_DECISION = "All retention decisions are settled.";
  const EVIDENCE_MARKER = "Evidence: named test `emits ready through main`";

  // The readiness fixture body plus the ready-10 declarations: lint-clean and
  // structurally ready 11/11 under the committed tuple.
  function preflightBody(fields = {}) {
    let body = replaceIssueField(
      issueReadinessFixture.readyBody,
      "Scope fence",
      "Add the structural receipt and consumer.\n\nNon-goals: do not score prose quality.",
    );
    body = replaceIssueField(body, "Glossary impact", issueReadinessFixture.explicitNone.glossary);
    for (const [label, value] of Object.entries(fields)) body = replaceIssueField(body, label, value);
    return [
      "QUALITY_PROFILE: contract",
      body.trimEnd(),
      intentDeclaration,
      qualitySections.simplest,
      qualitySections.notBuilt,
      qualitySections.ui,
      qualitySections.data,
      qualitySections.compatibility,
      qualitySections.superseded,
    ].join("\n\n");
  }
  const withoutEvidenceMarker = (body) => {
    const mutant = body.replace(EVIDENCE_MARKER, "named test `emits ready through main`");
    expect(mutant).not.toBe(body);
    return mutant;
  };

  async function runPreflight(body, metadata, { checkerArgs = ["--checker-sha", CHECKER_SHA] } = {}) {
    const metadataSource = JSON.stringify(metadata);
    const files = new Map([
      ["brief.md", body],
      ["metadata.json", metadataSource],
    ]);
    const lintLog = [];
    const lintExit = await main({
      argv: ["brief.md"],
      load: async (file) => files.get(file),
      logger: { log: (line) => lintLog.push(line), error: (line) => lintLog.push(line) },
    });
    const requests = [];
    const stdout = [];
    const stderr = [];
    const result = await readinessMain({
      argv: ["--prospective-body", "brief.md", "--prospective-metadata", "metadata.json", ...checkerArgs],
      env: {},
      client: async (...args) => {
        requests.push(args);
        throw new Error("prospective preflight reached GitHub");
      },
      readTextFile: async (file) => files.get(file),
      logger: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
      now: () => CHECKED_AT,
    });
    expect(requests).toEqual([]);
    let record = null;
    try {
      record = stdout.length === 1 ? JSON.parse(stdout[0]) : null;
    } catch {
      record = null;
    }
    return {
      body,
      metadata,
      metadataSource,
      lintExit,
      lintLog,
      readiness: { exitCode: result.exitCode, record, stdout, stderr },
    };
  }

  // The instruction's acceptance rule, applied to real lint and readiness output.
  const LAWFUL_EXPECTED_FAILURES = {
    "ready-00-placed-classified": { reasons: ["placement", "lifecycle"] },
    "ready-00-dependencies-resolved": { reasons: ["dependency"], reasonCodes: ["OPEN_NATIVE_DEPENDENCY"] },
    "ready-06-decisions-resolved": {
      reasons: ["decision"],
      reasonCodes: ["UNRESOLVED_DECISION_DECLARED"],
      requires: "ready-00-dependencies-resolved",
      blockedByDecision: true,
    },
  };
  function judgePreflight({ intent, expected = [], intendedBlockers = [] }, run) {
    const verdict = (decision, diagnostic = null) => ({ decision, diagnostic, dispatchAuthority: false });
    if (run.lintExit !== 0) return verdict("drafting", "LINT_FAILED");
    if (run.metadata.repository === "chase-sets/chase-sets-controller") return verdict("controller-contract");
    if (run.metadata.repository !== "chase-sets/chase-sets") return verdict("drafting", "REPOSITORY_UNROUTED");
    const { exitCode, record } = run.readiness;
    if (
      exitCode !== 0 ||
      record?.schemaVersion !== PROSPECTIVE_ISSUE_READINESS_RUN_SCHEMA_VERSION ||
      !Array.isArray(record.checkedRules) ||
      !Array.isArray(record.reasonCodes)
    ) {
      return verdict("drafting", "OUTPUT_INVALID");
    }
    const declared = run.metadata.dependencies.map(({ number }) => number).sort((left, right) => left - right);
    if (JSON.stringify(declared) !== JSON.stringify([...intendedBlockers].sort((left, right) => left - right))) {
      return verdict("drafting", "TUPLE_NOT_TRUTHFUL");
    }
    const ids = record.checkedRules.map(({ id }) => id);
    if (
      ids.length !== RULE_IDS.length ||
      new Set(ids).size !== ids.length ||
      RULE_IDS.some((id) => !ids.includes(id))
    ) {
      return verdict("drafting", "RULE_SET_INVALID");
    }
    if (record.status === "unknown" || record.checkedRules.some(({ status }) => !["pass", "fail"].includes(status))) {
      return verdict("drafting", "UNKNOWN");
    }
    if (intent === "dispatch" && expected.length > 0) return verdict("drafting", "DISPATCH_WITH_EXPECTED_FAILURES");
    if (intent !== "dispatch" && expected.length === 0) return verdict("drafting", "EXPECTED_FAILURES_MISSING");
    if (new Set(expected.map(({ ruleId }) => ruleId)).size !== expected.length) {
      return verdict("drafting", "EXPECTED_FAILURES_DUPLICATED");
    }
    for (const entry of expected) {
      const lawful = LAWFUL_EXPECTED_FAILURES[entry.ruleId];
      if (
        !lawful ||
        !lawful.reasons.includes(entry.reason) ||
        (lawful.reasonCodes && JSON.stringify(entry.reasonCodes) !== JSON.stringify(lawful.reasonCodes)) ||
        (lawful.requires && !expected.some(({ ruleId }) => ruleId === lawful.requires)) ||
        (lawful.blockedByDecision &&
          !run.metadata.dependencies.some(({ number, state }) => number === entry.decisionIssue && state === "open"))
      ) {
        return verdict("drafting", `EXPECTED_FAILURE_UNLAWFUL:${entry.ruleId}`);
      }
    }
    const failing = record.checkedRules.filter(({ status }) => status === "fail");
    for (const rule of failing) {
      const entry = expected.find(({ ruleId }) => ruleId === rule.id);
      if (!entry || JSON.stringify(entry.reasonCodes) !== JSON.stringify(rule.reasonCodes)) {
        return verdict("drafting", `UNEXPECTED_FAILURE:${rule.id}:${rule.reasonCodes.join(",")}`);
      }
    }
    for (const entry of expected) {
      if (!failing.some(({ id }) => id === entry.ruleId))
        return verdict("drafting", `EXPECTED_FAILURE_ABSENT:${entry.ruleId}`);
    }
    if (intent === "dispatch") {
      return record.status === "ready" && record.reasonCodes.length === 0
        ? verdict("dispatchable-registration")
        : verdict("drafting", "STATUS_INCONSISTENT");
    }
    return record.status === "not-ready"
      ? verdict("non-dispatchable-registration")
      : verdict("drafting", "STATUS_INCONSISTENT");
  }

  const dependencyFailure = (reason = "dependency") => ({
    ruleId: "ready-00-dependencies-resolved",
    reasonCodes: ["OPEN_NATIVE_DEPENDENCY"],
    reason,
  });
  const decisionFailure = {
    ruleId: "ready-06-decisions-resolved",
    reasonCodes: ["UNRESOLVED_DECISION_DECLARED"],
    reason: "decision",
    decisionIssue: 9101,
  };
  const CANDIDATE_PLACEMENT_CODES = ["ISSUE_NOT_CLASSIFIED", "MILESTONE_CANDIDATE", "MILESTONE_NOT_EXECUTABLE"];
  const lawfulStates = {
    "unblocked dispatch candidate": {
      body: preflightBody(),
      metadata: tuple(),
      plan: { intent: "dispatch" },
      decision: "dispatchable-registration",
    },
    "honest serial successor": {
      body: preflightBody(),
      metadata: tuple({ dependencies: [openBlocker(9100)] }),
      plan: { intent: "blocked", intendedBlockers: [9100], expected: [dependencyFailure()] },
      decision: "non-dispatchable-registration",
    },
    "linked unresolved-decision draft": {
      body: preflightBody({ "Decisions already made": UNRESOLVED_DECISION }),
      metadata: tuple({ dependencies: [openBlocker(9101)] }),
      plan: { intent: "blocked", intendedBlockers: [9101], expected: [dependencyFailure(), decisionFailure] },
      decision: "non-dispatchable-registration",
    },
    "legitimate candidate outcome placement": {
      body: preflightBody(),
      metadata: tuple({ milestone: candidateOutcome }),
      plan: {
        intent: "candidate",
        expected: [
          { ruleId: "ready-00-placed-classified", reasonCodes: CANDIDATE_PLACEMENT_CODES, reason: "placement" },
        ],
      },
      decision: "non-dispatchable-registration",
    },
  };

  it("planning requires both product pre-registration checks", () => {
    const sources = readSkills();
    expect(sources[0]).toBe(sources[1]);
    for (const source of sources) {
      expect(preflightViolations(source)).toEqual([]);
      expect(source.split(SECTION_HEADING)).toHaveLength(2);

      // The superseded lint-only instruction fails the guard.
      const section = source.slice(source.indexOf(SECTION_HEADING), source.indexOf("\n## Pipeline"));
      const lintOnly = mutate(source, section, LINT_ONLY_INSTRUCTION);
      expect(preflightViolations(lintOnly)).toEqual(
        expect.arrayContaining(["section", "readiness-command", "lint-only"]),
      );

      // Lint stays mandatory beside readiness, and the checker SHA is explicit.
      expect(preflightViolations(mutate(source, `${LINT_COMMAND}\n`, ""))).toEqual(["lint-command"]);
      expect(
        preflightViolations(mutate(source, READINESS_COMMAND, READINESS_COMMAND.replace(/ --checker-sha \S+$/, ""))),
      ).toEqual(["readiness-command"]);
      for (const entryPath of ENTRY_PATHS) {
        expect(preflightViolations(mutate(source, entryPath, "")), entryPath).toEqual([`entry-path:${entryPath}`]);
      }
    }
    expectClauseDeletionsRed(ROUTE_CLAUSES);
  });

  it("planning respects repository readiness boundaries", async () => {
    for (const source of readSkills()) {
      expect(preflightViolations(source)).toEqual([]);
      const prose = normalize(source);
      // Shared standard, controller-owned release, and trusted dispatch authority stay.
      expect(prose).toContain(
        "A `chase-sets/chase-sets-controller` issue uses the same brief standard and pressure test. Its milestone and release follow that repository's controller-orchestrator skill.",
      );
      expect(prose).toContain(
        "The milestone orchestrator runs the trusted-default-branch `.github/workflows/issue-readiness.yml` only for the issue being considered",
      );
      expect(preflightViolations(mutate(source, "not this eleven-rule check.", "and this eleven-rule check."))).toEqual(
        ["controller-route"],
      );
    }
    expectClauseDeletionsRed(BOUNDARY_CLAUSES);

    const controllerFootprint = preflightBody({
      "Footprint & chain": "`.orchestrator/dispatch-lane.ps1`, `scripts/next-work.mjs`. Callers: the dispatch gate.",
    });
    const product = await runPreflight(controllerFootprint, tuple());
    expect(product.lintExit).toBe(0);
    expect(product.readiness.record.checkedRules.find(({ id }) => id === "ready-05-footprint-operators")).toEqual({
      id: "ready-05-footprint-operators",
      status: "fail",
      reasonCodes: ["FOOTPRINT_IN_CONTROLLER_REPOSITORY"],
    });
    expect(judgePreflight({ intent: "dispatch" }, product)).toMatchObject({
      decision: "drafting",
      diagnostic: "UNEXPECTED_FAILURE:ready-05-footprint-operators:FOOTPRINT_IN_CONTROLLER_REPOSITORY",
    });
    expect(
      judgePreflight(
        {
          intent: "blocked",
          expected: [
            {
              ruleId: "ready-05-footprint-operators",
              reasonCodes: ["FOOTPRINT_IN_CONTROLLER_REPOSITORY"],
              reason: "placement",
            },
          ],
        },
        product,
      ),
    ).toMatchObject({ decision: "drafting", diagnostic: "EXPECTED_FAILURE_UNLAWFUL:ready-05-footprint-operators" });

    // The same controller-routed brief is not-ready under the product rules, so
    // product eleven-rule admission cannot be its authority.
    const controller = await runPreflight(
      controllerFootprint,
      tuple({ repository: "chase-sets/chase-sets-controller" }),
    );
    expect(controller.readiness.record.status).toBe("not-ready");
    expect(judgePreflight({ intent: "dispatch" }, controller)).toMatchObject({ decision: "controller-contract" });
    const controllerLintRed = await runPreflight(
      controllerFootprint.replace("QUALITY_PROFILE: contract", "QUALITY_PROFILE:"),
      tuple({ repository: "chase-sets/chase-sets-controller" }),
    );
    expect(judgePreflight({ intent: "dispatch" }, controllerLintRed)).toMatchObject({ diagnostic: "LINT_FAILED" });
  });

  it("planning binds the exact prospective tuple", async () => {
    expect(Object.keys(METADATA_FIELDS)).toEqual([
      "repository",
      "number",
      "state",
      "issueType",
      "milestone",
      "labels",
      "parentNumber",
      "dependencies",
    ]);
    for (const source of readSkills()) {
      for (const [key, phrase] of Object.entries(METADATA_FIELDS)) {
        expect(preflightViolations(mutate(source, phrase, "")), key).toEqual([`tuple-field:${key}`]);
      }
    }
    expectClauseDeletionsRed(TUPLE_CLAUSES);

    // Every key the instruction names is one the evaluator refuses to run without.
    for (const key of Object.keys(METADATA_FIELDS)) {
      const metadata = tuple();
      delete metadata[key];
      const run = await runPreflight(preflightBody(), metadata);
      expect(run.readiness, key).toMatchObject({
        exitCode: 2,
        record: null,
        stderr: ["PROSPECTIVE_METADATA_INCOMPLETE"],
      });
      expect(judgePreflight({ intent: "dispatch" }, run), key).toMatchObject({
        decision: "drafting",
        diagnostic: key === "repository" ? "REPOSITORY_UNROUTED" : "OUTPUT_INVALID",
      });
    }

    // A disclosed placeholder and an actual repair number reduce identically; a
    // non-positive number is refused.
    const placeholder = await runPreflight(preflightBody(), tuple({ number: 1 }));
    const actual = await runPreflight(preflightBody(), tuple({ number: 6253 }));
    expect(placeholder.readiness.record.subject.number).toBe(1);
    expect(actual.readiness.record.subject.number).toBe(6253);
    expect(placeholder.readiness.record.checkedRules).toEqual(actual.readiness.record.checkedRules);
    expect(judgePreflight({ intent: "dispatch" }, placeholder)).toMatchObject({
      decision: "dispatchable-registration",
    });
    const zero = await runPreflight(preflightBody(), tuple({ number: 0 }));
    expect(zero.readiness).toMatchObject({ exitCode: 2, stderr: ["ISSUE_NUMBER_INVALID"] });

    // The checker commit is explicit and 40 characters.
    for (const checkerArgs of [[], ["--checker-sha", "c".repeat(7)]]) {
      const run = await runPreflight(preflightBody(), tuple(), { checkerArgs });
      expect(run.readiness, checkerArgs.join(" ")).toMatchObject({ exitCode: 2, stderr: ["CHECKER_SHA_INVALID"] });
    }
    const upper = await runPreflight(preflightBody(), tuple(), { checkerArgs: ["--checker-sha", "C".repeat(40)] });
    expect(upper.readiness.record.provenance.checkerSha).toBe(CHECKER_SHA);

    // Retained proof binds body bytes, metadata bytes, checker and output; any
    // edit invalidates it, and an edited tuple can reduce differently.
    const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
    const retained = await runPreflight(preflightBody(), tuple());
    const proof = {
      bodySha256: sha256(retained.body),
      metadataSha256: sha256(retained.metadataSource),
      checkerSha: CHECKER_SHA,
      outputSha256: sha256(retained.readiness.stdout[0]),
    };
    const proofCurrent = ({ body, metadataSource, checkerSha }) =>
      proof.bodySha256 === sha256(body) &&
      proof.metadataSha256 === sha256(metadataSource) &&
      proof.checkerSha === checkerSha;
    expect(proofCurrent({ ...retained, checkerSha: CHECKER_SHA })).toBe(true);
    expect(proofCurrent({ ...retained, body: `${retained.body} `, checkerSha: CHECKER_SHA })).toBe(false);
    const edited = await runPreflight(preflightBody(), tuple({ dependencies: [openBlocker(9100)] }));
    expect(proofCurrent({ ...edited, checkerSha: CHECKER_SHA })).toBe(false);
    expect(sha256(edited.readiness.stdout[0])).not.toBe(proof.outputSha256);
    expect(edited.readiness.record.status).toBe("not-ready");
    expect(proofCurrent({ ...retained, checkerSha: "d".repeat(40) })).toBe(false);
  });

  it("planning distinguishes lawful non-runnable drafts from defective bodies", async () => {
    expect(RULE_IDS).toHaveLength(11);
    expectClauseDeletionsRed(INSPECTION_CLAUSES);

    for (const [name, state] of Object.entries(lawfulStates)) {
      const run = await runPreflight(state.body, state.metadata);
      expect(run.lintExit, name).toBe(0);
      expect(run.readiness.exitCode, name).toBe(0);
      const failing = run.readiness.record.checkedRules.filter(({ status }) => status !== "pass");
      expect(
        failing.map(({ id, reasonCodes }) => ({ ruleId: id, reasonCodes })),
        name,
      ).toEqual((state.plan.expected ?? []).map(({ ruleId, reasonCodes }) => ({ ruleId, reasonCodes })));
      expect(judgePreflight(state.plan, run), name).toEqual({
        decision: state.decision,
        diagnostic: null,
        dispatchAuthority: false,
      });
      expect(run.readiness.record).toMatchObject({
        claim: "structural-only-prospective",
        semanticPressureTest: "not-evaluated",
      });

      // An unrelated malformed AC is never masked by an expected lifecycle failure.
      const defective = await runPreflight(withoutEvidenceMarker(state.body), state.metadata);
      expect(judgePreflight(state.plan, defective), name).toMatchObject({
        decision: "drafting",
        diagnostic: "UNEXPECTED_FAILURE:ready-03-acceptance-evidence:AC_EVIDENCE_NOT_DISCRIMINATING",
      });
    }

    const { "unblocked dispatch candidate": ready, "honest serial successor": successor } = lawfulStates;
    const decision = lawfulStates["linked unresolved-decision draft"];
    const candidate = lawfulStates["legitimate candidate outcome placement"];
    const readyRun = await runPreflight(ready.body, ready.metadata);
    const withRecord = (run, record) => ({ ...run, readiness: { ...run.readiness, record } });
    const bypasses = [
      ["omitted blocker", successor.plan, await runPreflight(successor.body, tuple()), "TUPLE_NOT_TRUTHFUL"],
      [
        "fabricated blocker",
        { ...decision.plan, intendedBlockers: [] },
        await runPreflight(decision.body, decision.metadata),
        "TUPLE_NOT_TRUTHFUL",
      ],
      [
        "unresolved decision without an open native blocker",
        { intent: "blocked", expected: [decisionFailure] },
        await runPreflight(decision.body, tuple()),
        "EXPECTED_FAILURE_UNLAWFUL:ready-06-decisions-resolved",
      ],
      [
        "unresolved decision blocked only by an unrelated issue",
        { ...decision.plan, intendedBlockers: [9100] },
        await runPreflight(decision.body, tuple({ dependencies: [openBlocker(9100)] })),
        "EXPECTED_FAILURE_UNLAWFUL:ready-06-decisions-resolved",
      ],
      [
        "unrelated ready-06 failure",
        decision.plan,
        await runPreflight(preflightBody({ "Decisions already made": UNPROVEN_DECISION }), decision.metadata),
        "UNEXPECTED_FAILURE:ready-06-decisions-resolved:DECISION_RESOLUTION_UNPROVEN",
      ],
      [
        "unexplained placement reason",
        {
          ...candidate.plan,
          expected: [{ ...candidate.plan.expected[0], reasonCodes: CANDIDATE_PLACEMENT_CODES.slice(1) }],
        },
        await runPreflight(candidate.body, candidate.metadata),
        `UNEXPECTED_FAILURE:ready-00-placed-classified:${CANDIDATE_PLACEMENT_CODES.join(",")}`,
      ],
      [
        "unjustified expected failure",
        { ...successor.plan, expected: [dependencyFailure("convenience")] },
        await runPreflight(successor.body, successor.metadata),
        "EXPECTED_FAILURE_UNLAWFUL:ready-00-dependencies-resolved",
      ],
      [
        "arbitrary not-ready claim",
        { intent: "blocked", expected: [dependencyFailure()] },
        readyRun,
        "EXPECTED_FAILURE_ABSENT:ready-00-dependencies-resolved",
      ],
      [
        "unknown status",
        successor.plan,
        await runPreflight(`${successor.body}\n\n\`\`\`text\n`, successor.metadata),
        "UNKNOWN",
      ],
      [
        "missing rule",
        ready.plan,
        withRecord(readyRun, {
          ...readyRun.readiness.record,
          checkedRules: readyRun.readiness.record.checkedRules.slice(1),
        }),
        "RULE_SET_INVALID",
      ],
      [
        "duplicate rule",
        ready.plan,
        withRecord(readyRun, {
          ...readyRun.readiness.record,
          checkedRules: [...readyRun.readiness.record.checkedRules.slice(1), readyRun.readiness.record.checkedRules[1]],
        }),
        "RULE_SET_INVALID",
      ],
      [
        "incomplete output",
        ready.plan,
        withRecord(readyRun, { schemaVersion: readyRun.readiness.record.schemaVersion, status: "ready" }),
        "OUTPUT_INVALID",
      ],
      [
        "exit-0-only acceptance",
        ready.plan,
        await runPreflight(withoutEvidenceMarker(ready.body), ready.metadata),
        "UNEXPECTED_FAILURE:ready-03-acceptance-evidence:AC_EVIDENCE_NOT_DISCRIMINATING",
      ],
      [
        "local-as-dispatch",
        { intent: "dispatch", intendedBlockers: [9100] },
        await runPreflight(successor.body, successor.metadata),
        "UNEXPECTED_FAILURE:ready-00-dependencies-resolved:OPEN_NATIVE_DEPENDENCY",
      ],
      [
        "lint skipped",
        ready.plan,
        await runPreflight(ready.body.replace("QUALITY_PROFILE: contract", "QUALITY_PROFILE:"), ready.metadata),
        "LINT_FAILED",
      ],
    ];
    for (const [name, plan, run, diagnostic] of bypasses) {
      expect(judgePreflight(plan, run), name).toEqual({ decision: "drafting", diagnostic, dispatchAuthority: false });
    }
    expect(bypasses.find(([name]) => name === "exit-0-only acceptance")[2].readiness.exitCode).toBe(0);

    // A prospective record is never a dispatch receipt.
    expect(
      consumeIssueReadinessReceipt({
        receipt: readyRun.readiness.record,
        currentRevision: {
          repository: "chase-sets/chase-sets",
          number: 1,
          nodeId: null,
          updatedAt: null,
          milestone: committedOutcome,
        },
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "pass",
      }),
    ).toMatchObject({ decision: "reject", reasonCode: "RECEIPT_MALFORMED" });
  });

  it("planning refuses incomplete prospective readiness proof", () => {
    const exemptions = [
      ["Stage 2-light for Issues still requires this check.", " The Issues tier may omit the readiness check."],
      ["tier shortcuts never skip the supersession check or placement.", " Fast-path briefs skip the readiness check."],
      ["Repair findings before registration.", " Full-path briefs need not run both checks."],
      ["whatever the tier.", " Epic and Milestone children run lint only."],
      [
        "or Operations for machine-generated incidents;",
        " host and review follow-ups are exempt from the pre-registration checks;",
      ],
      [
        "**The pressure test is mandatory**, not tier-dependent.",
        " Replacement briefs skip the prospective readiness check.",
      ],
      ["rerun both checks.", " A repaired body needs only the lint."],
      ["(one parent per slice);", " the readiness check is optional for child issues;"],
    ];
    for (const source of readSkills()) {
      expect(preflightViolations(source)).toEqual([]);
      // Inert or prose-only command tokens are not a check.
      expect(preflightViolations(mutate(source, READINESS_COMMAND, `<!-- ${READINESS_COMMAND} -->`))).toEqual([
        "readiness-command",
      ]);
      expect(
        preflightViolations(
          mutate(
            mutate(source, `${READINESS_COMMAND}\n`, ""),
            "Lint must pass.",
            `The readiness command is \`${READINESS_COMMAND}\`. Lint must pass.`,
          ),
        ),
      ).toEqual(["readiness-command"]);
      for (const [anchor, exemption] of exemptions) {
        expect(preflightViolations(mutate(source, anchor, `${anchor}${exemption}`)), exemption).toEqual([
          "product-path-exemption",
        ]);
      }
    }
  });

  it("lint clean does not imply prospective readiness", async () => {
    const clean = await runPreflight(preflightBody(), tuple());
    expect(clean.lintExit).toBe(0);
    expect(clean.readiness.exitCode).toBe(0);
    expect(clean.readiness.record.status).toBe("ready");
    expect(clean.readiness.record.checkedRules.map(({ id, status }) => [id, status])).toEqual(
      RULE_IDS.map((id) => [id, "pass"]),
    );

    // Remove only one AC Evidence: marker; every other input stays frozen.
    const defective = await runPreflight(withoutEvidenceMarker(preflightBody()), tuple());
    expect(defective.lintExit).toBe(0);
    expect(defective.lintLog).toEqual([expect.stringContaining("Brief lint passed")]);
    expect(defective.readiness.exitCode).toBe(0);
    expect(defective.readiness.record.status).toBe("not-ready");
    expect(defective.readiness.record.reasonCodes).toEqual(["AC_EVIDENCE_NOT_DISCRIMINATING"]);
    expect(defective.readiness.record.checkedRules.filter(({ status }) => status !== "pass")).toEqual([
      { id: "ready-03-acceptance-evidence", status: "fail", reasonCodes: ["AC_EVIDENCE_NOT_DISCRIMINATING"] },
    ]);
    expect(defective.readiness.record.acceptanceDiagnostics[0]).toEqual({
      index: 1,
      status: "fail",
      reasonCode: "EVIDENCE_MARKER_MISSING",
    });
    expect(judgePreflight({ intent: "dispatch" }, defective)).toMatchObject({
      decision: "drafting",
      diagnostic: "UNEXPECTED_FAILURE:ready-03-acceptance-evidence:AC_EVIDENCE_NOT_DISCRIMINATING",
    });

    // So lint alone cannot stand in for readiness: both mirrors require both.
    for (const source of readSkills()) {
      const violations = preflightViolations(source);
      expect(violations).not.toContain("lint-command");
      expect(violations).not.toContain("readiness-command");
      expect(violations).not.toContain("lint-only");
    }
  });
});
