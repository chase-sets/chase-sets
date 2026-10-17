import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { test } from "@playwright/test";
import { responsiveEvidenceArtifactPaths } from "../../../infrastructure/playwright-evidence/index.ts";
import sourceManifest from "../../../infrastructure/playwright-evidence/responsive-evidence-manifest.json" with { type: "json" };

// Browserless retry scenarios for the retried-capture probe in
// scripts/validate-responsive-evidence-artifacts.test.mjs. Every capture writes
// its runtime manifest where responsiveEvidenceArtifactPaths puts it, with
// synthetic measurements and a screenshot payload naming the writing attempt.
// Artifact paths and the config digest bind to the probe's temporary repository
// root, as captureResponsiveEvidence binds them to the checkout.
const probeRoot = process.env.RESPONSIVE_EVIDENCE_RETRY_PROBE_ROOT;
if (!probeRoot) throw new Error("RESPONSIVE_EVIDENCE_RETRY_PROBE_ROOT is required.");
const claim = sourceManifest.claims.find(
  (candidate) => candidate.id === process.env.RESPONSIVE_EVIDENCE_RETRY_PROBE_CLAIM,
);
if (!claim) throw new Error("RESPONSIVE_EVIDENCE_RETRY_PROBE_CLAIM must name a source-manifest claim.");

const scenarios = {
  "retried-pass": () => {
    test(claim.testTitle, async () => {
      await capture();
      failFirstAttempt();
    });
  },
  "two-tests": () => {
    test(claim.testTitle, async () => {
      await capture();
    });
    test(`second test ${claim.testTitle}`, async () => {
      await capture();
      failFirstAttempt();
    });
  },
  "two-captures-one-attempt": () => {
    test(claim.testTitle, async () => {
      await capture();
      await capture("second-capture");
    });
  },
  "failed-final-attempt": () => {
    test(claim.testTitle, async () => {
      await capture();
      throw new Error(`retry probe: attempt ${test.info().retry} fails after capture.`);
    });
  },
  "earlier-attempt-only": () => {
    test(claim.testTitle, async () => {
      if (test.info().retry > 0) return;
      await capture();
      failFirstAttempt();
    });
  },
};

const scenario = process.env.RESPONSIVE_EVIDENCE_RETRY_PROBE_SCENARIO;
if (!Object.hasOwn(scenarios, scenario)) throw new Error(`Unknown retry probe scenario '${scenario}'.`);
scenarios[scenario]();

function failFirstAttempt() {
  if (test.info().retry === 0) throw new Error("retry probe: attempt 0 fails after capture.");
}

async function capture(subdirectory) {
  const testInfo = test.info();
  const rulePaths = responsiveEvidenceArtifactPaths(testInfo, claim.id);
  const [screenshot, manifest] = [rulePaths.screenshot, rulePaths.manifest].map((file) =>
    subdirectory ? path.join(path.dirname(file), subdirectory, path.basename(file)) : file,
  );
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(screenshot, `responsive evidence retry probe attempt ${testInfo.retry}\n`, "utf8");
  const runtime = {
    contract: "responsive-evidence-runtime",
    schemaVersion: 2,
    claimId: claim.id,
    route: { ...claim.route, observed: claim.route.path },
    fixture: claim.fixture,
    viewport: claim.viewport,
    target: {
      identity: claim.target.identity,
      selector: claim.target.selector,
      populatedSelector: claim.target.populatedSelector,
    },
    assertions: claim.measurements.map((measurement) => ({
      identity: measurement.identity,
      property: measurement.property,
      expected: measurement.assertion,
      actual: measurement.assertion.equals ?? measurement.assertion.minimum ?? measurement.assertion.maximum,
    })),
    artifacts: {
      screenshot: { path: repositoryPath(screenshot), sha256: await fileSha256(screenshot) },
      manifest: { path: repositoryPath(manifest) },
      sourceClaimSha256: sha256(JSON.stringify(claim)),
      playwrightConfig: {
        path: "playwright.config.ts",
        sha256: await fileSha256(path.join(probeRoot, "playwright.config.ts")),
      },
    },
  };
  await writeFile(manifest, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
}

function repositoryPath(file) {
  return path.relative(probeRoot, file).replaceAll("\\", "/");
}

async function fileSha256(file) {
  return sha256(await readFile(file));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
