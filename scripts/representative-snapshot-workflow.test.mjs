import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { releaseQualificationScopeRegistry } from "./release-qualification-scope.mjs";
import { checkWorkflowSpacesEvidenceCredentials } from "./workflow-provider-credentials.mjs";

const workflowFile = ".github/workflows/representative-catalog-snapshot.yml";
const workflow = readFileSync(resolve(workflowFile), "utf8");
const devSystem = readFileSync(resolve("scripts/dev-system.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const publishStepName = "Publish representative snapshot set";

function stripPublishCredential(source, credential) {
  const start = source.indexOf(`      - name: ${publishStepName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n      - ", start + 1);
  const step = source.slice(start, end);
  const stripped = step.replace(new RegExp(`^ {10}${credential}:.*\\r?\\n`, "m"), "");
  expect(stripped).not.toBe(step);
  return source.slice(0, start) + stripped + source.slice(end);
}

describe("representative Catalog snapshot publish workflow", () => {
  it("is manual-only, confirmation-guarded, and registered as release qualification", () => {
    expect(workflow).toMatch(/^on:\r?\n  workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^  (?:push|pull_request|schedule|workflow_run):/m);
    expect(workflow).toContain("inputs.confirm != 'publish representative snapshot'");
    expect(workflow).toContain('--confirm "publish representative snapshot"');
    expect(releaseQualificationScopeRegistry.workflows["representative-catalog-snapshot.yml"]).toBe("release");
  });

  it("allows the four-hour replay inside a five-hour snapshot job without raising PR DB ceilings", () => {
    expect(workflow).toMatch(
      /name: Publish Coordinated Representative Snapshot\r?\n    runs-on: ubuntu-latest\r?\n    timeout-minutes: 300/,
    );
    const platformPr = readFileSync(resolve(".github/workflows/platform-pr.yml"), "utf8");
    expect(platformPr).toMatch(/name: DB Profile Tests[\s\S]*?timeout-minutes: 45/);
  });

  it("threads only the scoped seed-pack credential pair into the provider-touching publish step", () => {
    const result = checkWorkflowSpacesEvidenceCredentials(workflow, { workflowFile });

    expect(result.violations).toEqual([]);
    expect(result.checkedSteps).toEqual([
      expect.objectContaining({
        name: publishStepName,
        requiredEnv: ["SEED_PACKS_SPACES_ACCESS_ID", "SEED_PACKS_SPACES_SECRET_KEY"],
        scripts: ["scripts/representative-snapshot.mjs"],
      }),
    ]);
    expect(workflow).not.toMatch(/^ {6}SEED_PACKS_SPACES_(?:ACCESS_ID|SECRET_KEY):/m);
  });

  it.each(["SEED_PACKS_SPACES_ACCESS_ID", "SEED_PACKS_SPACES_SECRET_KEY"])(
    "withheld-creds negative control names the missing step-local credential: %s",
    (credential) => {
      const stripped = stripPublishCredential(workflow, credential);
      const result = checkWorkflowSpacesEvidenceCredentials(stripped, { workflowFile });

      expect(result.passed).toBe(false);
      expect(result.violations).toEqual([
        expect.stringContaining(
          `step '${publishStepName}' uses dedicated Spaces evidence credentials but does not declare step env: ${credential}`,
        ),
      ]);
    },
  );
});

describe("representative snapshot dev-system wiring", () => {
  it("keeps representative restore explicit and the full replay fallback always available", () => {
    expect(packageJson.scripts["dev:db:refresh"]).toBe("node ./scripts/dev-system.mjs refresh");
    expect(devSystem).toContain('modeArguments.includes("--representative")');
    expect(devSystem).toContain('modeArguments.includes("--replay")');
    expect(devSystem).toContain("--replay requires --representative and refresh mode.");
    expect(devSystem).toContain('"./representative-snapshot.mjs"');
    expect(devSystem).toContain("critical-bootstrap,catalog-integration-bootstrap,representative-catalog");
    expect(devSystem).toContain('mode !== "refresh" || !representativeRefresh');
    expect(devSystem).toContain("await runBootstrap(targetName, null, true)");
    const snapshot = readFileSync(resolve("scripts/representative-snapshot.mjs"), "utf8");
    expect(snapshot).toContain('"refresh", "--representative", "--replay"');
    expect(snapshot).toContain('"./dev-system.mjs", import.meta.url)), "bootstrap"');
  });
});
