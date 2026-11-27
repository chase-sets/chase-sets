import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import {
  CORTEN_POLICY_PAGE,
  cortenPendingAccessors,
  cortenPostureGates,
  findCortenPolicyPostureViolations,
  findPublicPolicyPostureViolations,
  readCortenPolicyPostureSources,
  readPublicPolicyPostureSources,
  validatePublicPolicyPosture,
} from "./public-policy-posture.mjs";

const catalogPath = "bounded-contexts/public-presence/features/policies/ui/localization/locales/en.ts";
const cortenPolicyPath = "deployables/corten-pilot/public/src/policy.rs";

function pageRecord() {
  return {
    relativePath: CORTEN_POLICY_PAGE,
    source: readFileSync(path.join(repoRoot, ...CORTEN_POLICY_PAGE.split("/")), "utf8"),
  };
}

describe("public policy publication posture guard", () => {
  it("scans the real policies ui root and the Corten public app clean", async () => {
    const result = await validatePublicPolicyPosture({ repoRoot });

    expect(result.violations).toEqual([]);
    expect(result.guardedFiles).toEqual([catalogPath]);
    expect(result.cortenGuardedFiles).toEqual(expect.arrayContaining([CORTEN_POLICY_PAGE, cortenPolicyPath]));
    expect(result.cortenGuardedFiles).not.toContain("deployables/corten-pilot/public/src/tests.rs");
  });

  it("selects each pending accessor exactly once in the real policy page and keeps both posture gates", () => {
    const { source } = pageRecord();
    for (const accessor of cortenPendingAccessors) {
      expect(source.split(`.${accessor}(`).length - 1, accessor).toBe(1);
    }
    for (const gate of cortenPostureGates) {
      expect(source).toContain(gate);
    }
  });

  it("rejects a pending accessor selected in another Corten module", async () => {
    const probePath = "deployables/corten-pilot/public/src/views/future_policy.rs";
    const sources = await readCortenPolicyPostureSources({ repoRoot });
    const result = findCortenPolicyPostureViolations([
      ...sources,
      {
        relativePath: probePath,
        source: "fn banner(t: PolicyMsg) -> &'static str {\n    t.terms_counsel_pending_title()\n}",
      },
    ]);

    expect(result.violations).toEqual([
      expect.stringContaining(`${probePath}:2: pending publication copy 'terms_counsel_pending_title'`),
    ]);
  });

  it("rejects the policy page selecting a pending accessor twice or never", () => {
    const page = pageRecord();
    const doubled = findCortenPolicyPostureViolations([
      {
        ...page,
        source: `${page.source}\nfn stale(t: PolicyMsg) -> &'static str { t.policies_metadata_effective_pending() }\n`,
      },
    ]);
    expect(doubled.violations).toEqual([
      expect.stringContaining("must select 'policies_metadata_effective_pending' exactly once; found 2"),
    ]);

    const dropped = findCortenPolicyPostureViolations([
      { ...page, source: page.source.replace("t.terms_counsel_pending_title()", "t.terms_print()") },
    ]);
    expect(dropped.violations).toEqual([
      expect.stringContaining("must select 'terms_counsel_pending_title' exactly once; found 0"),
    ]);
  });

  it("rejects a policy page that shows pending copy without the effective-date gate", () => {
    for (const gate of cortenPostureGates) {
      const page = pageRecord();
      const result = findCortenPolicyPostureViolations([{ ...page, source: page.source.replace(gate, "if true {") }]);
      expect(result.violations).toEqual([expect.stringContaining(`lost the posture gate '${gate}'`)]);
    }
  });

  it("fails closed when the Corten policy page is missing", () => {
    const result = findCortenPolicyPostureViolations([{ relativePath: cortenPolicyPath, source: "" }]);
    expect(result.violations).toEqual([expect.stringContaining("the Corten policy page is missing")]);
  });

  it("ignores Corten test modules", () => {
    const result = findCortenPolicyPostureViolations([
      pageRecord(),
      { relativePath: "deployables/corten-pilot/public/src/tests.rs", source: "t.terms_counsel_pending_title();" },
    ]);
    expect(result.violations).toEqual([]);
  });

  it("distinguishes literal catalog declarations from TypeScript code that selects pending copy", async () => {
    const [catalog] = await readPublicPolicyPostureSources({ repoRoot });
    expect(findPublicPolicyPostureViolations([catalog]).violations).toEqual([]);

    const selecting = findPublicPolicyPostureViolations([
      {
        ...catalog,
        source: `${catalog.source}\nexport const copy = policiesEnglishTranslations["publicPresence.info.terms.metadata.effectivePending"];\n`,
      },
    ]);
    expect(selecting.violations).not.toEqual([]);
    expect(selecting.violations[0]).toContain(catalogPath);

    const unowned = findPublicPolicyPostureViolations([
      {
        relativePath: catalogPath,
        source: 'export const en = { "publicPresence.info.unowned.metadata.effectivePending": "x" } as const;',
      },
    ]);
    expect(unowned.violations).not.toEqual([]);
  });

  it("rejects arbitrary-path pending literals in TypeScript without relying on filename vocabulary", () => {
    const futurePath = "bounded-contexts/public-presence/features/policies/ui/anything.tsx";
    const result = findPublicPolicyPostureViolations([
      { relativePath: futurePath, source: 'export const stale = "Effective date pending counsel approval";' },
    ]);

    expect(result.guardedFiles).toContain(futurePath);
    expect(result.violations).toEqual([
      expect.stringContaining(`${futurePath}:1: pending publication copy 'Effective date pending counsel approval'`),
    ]);
  });
});
