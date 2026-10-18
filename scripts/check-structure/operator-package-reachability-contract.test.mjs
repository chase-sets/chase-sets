import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readProse = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ");
const skillPaths = [".agents/skills/delivery/SKILL.md", ".claude/skills/delivery/SKILL.md"];
const gateLink = "../../.agents/skills/delivery/SKILL.md#operator-package-target-reachability";
const runbooks = [
  "docs/runbooks/marketplace-production-promotion.md",
  "docs/runbooks/tcgplayer-automation-operations.md",
  "docs/runbooks/channels-pilot-operations.md",
];

const lifecycleRules = [
  "Before packaging `READY` or `READY_FOR_TODD`, capture every target in the complete window inventory.",
  "The package host checklist must recapture every target at host signal and again at window-open re-verification; do not reuse packaging or signal observations.",
  "A production deploy started after any capture voids that capture, even if it later succeeds at the same SHA; hold readiness and recapture after completion.",
];
const evidenceRules = [
  "Inventory every origin/path a window step opens or its tooling calls, including sign-in hops, extension/API endpoints and external provider entry points.",
  "Each target names environment, origin/path, expected status and final URL, observation UTC, bound release SHA/image, owning deploy run/job, and effective profile/serving switches as that executed job logged them, matching current Environment values.",
  "For external providers, mark release/deploy/profile/Environment fields not-applicable, not inferred from a Chase Sets release.",
  "Bind deployment authority to the exact owning executed deployment job, not an enclosing green run, trigger job or skipped operation; missing, skipped or ambiguous authority is non-authority.",
  "Capture DNS, TLS verification and every HTTP hop privately, including a same-origin unregistered control path and the response comparison; cite the private evidence locations, not secrets or raw account/provider data.",
];
const refusalRules = [
  ["Missing DNS", "STOP; a working alternate hostname cannot stand in for the declared target."],
  ["TLS failure or verification-disabled probe", "STOP; never disable certificate verification to obtain a response."],
  [
    "HTTP 404/5xx",
    "STOP for screen 404 or any 5xx; only the non-mutating API mount exception below can resolve API 404/405.",
  ],
  [
    "Observed status differing from the declared expected status (outside the API mount exception)",
    "STOP; capture the declared expected status before readiness.",
  ],
  [
    "Final origin/path differing from the declared one",
    "STOP; a homepage or undeclared identity redirect does not prove the route.",
  ],
  [
    "Response indistinguishable from a same-origin unregistered control path (landing/soft-404/SPA shell)",
    "STOP; 200 alone is not route proof.",
  ],
  ["Incompatible or pending posture", "STOP; shipped serving capability is not activation."],
  [
    "Missing/incomplete/reused observation",
    "STOP; retain failures and unknowns, never substitute old or post-hoc captures.",
  ],
  ["Release mismatch", "STOP; SHA, image, executed deploy job and effective/current switches must reconcile."],
  ["Deploy in progress", "STOP; wait for completion and capture afresh, not during deployment."],
];
const authorityRules = [
  "Refuse both package READY and host signal on any failure or unknown below; window-open re-verification also stops the window.",
  "Sign-in routing counts only with a same-origin or declared identity-origin hop that returns 200, plus route registration and hosting profile at the exact release; it proves neither authenticated screen nor data.",
  "Never send a mutating request for reachability.",
  "An API endpoint whose non-mutating probe is 404/405 or matches the control instead needs exact-release mount and hosting-profile evidence, with the residual recorded; without that evidence refuse readiness.",
  "This API exception does not excuse a screen 404, 5xx, DNS/TLS failure, release mismatch or posture failure.",
  "Authenticated checks use existing custody/Phase A authority, never secret collection or new login.",
  "Reachability is necessary, not an execution GO, account admission, public launch or certification of private data.",
];
const deletedWorkSpecificFragments = [
  "#7728",
  "#9374-production",
  "Consumer Target Inventory",
  "Historical negative",
  "Whether to set `PRODUCTION_MARKETPLACE_SERVED=true`",
  "f5cbef2cb094a1935841c1a10db0310ac0284442",
  "sha256:d84315b643922527a44633ce43a26c349fb06d49de662bc4d1570c59294bacea",
  "38406890844/115345684026",
  "459dc3fd",
  "PRODUCT_QUESTION",
];

function assertRules(text, rules) {
  for (const rule of rules) expect(text, `missing reachability rule: ${rule}`).toContain(rule);
}

function assertRefusals(text) {
  assertRules(text, authorityRules);
  for (const [failure, disposition] of refusalRules) expect(text).toContain(`| ${failure} | ${disposition} |`);
}

it("rejects a refusal fixture that retains STOP but weakens the release binding", () => {
  const fixture = [
    ...authorityRules,
    ...refusalRules.map(([failure, disposition]) => `| ${failure} | ${disposition} |`),
  ].join(" ");
  expect(() => assertRefusals(fixture)).not.toThrow();
  const mutant = fixture.replace(
    "STOP; SHA, image, executed deploy job and effective/current switches must reconcile.",
    "STOP only on SHA; image or deploy-job mismatch may CONTINUE.",
  );
  expect(() => assertRefusals(mutant)).toThrow();
});

describe.each(skillPaths)("operator package reachability: %s", (path) => {
  const text = readProse(path);

  it("gates packaging, host signal and window-open with fresh complete target evidence", () => {
    expect(text).toContain("## Operator-Package Target Reachability");
    assertRules(text, lifecycleRules);
    assertRules(text, evidenceRules);
  });

  it("refuses every failed or unknown target without granting sign-in or mutation authority", () => {
    assertRefusals(text);
  });

  it("removes stale package-specific targets and historical evidence", () => {
    for (const fragment of deletedWorkSpecificFragments) {
      expect(text, `stale work-specific fragment remains: ${fragment}`).not.toContain(fragment);
    }
  });

  it("labels served-not-public success synthetic and rejects reused captures", () => {
    assertRules(text, [
      "Synthetic positive (not live evidence)",
      "Every inventoried target resolves DNS, verifies TLS and routes as declared, differs from its control, and has complete fresh observations at packaging, signal and window-open.",
      "Synthetic release/image and owning executed deploy job match every Chase Sets target and current Environment values: `PRODUCTION_MARKETPLACE_SERVED=true`, `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false`, effective profile `proof`, invitation admission and indexing disabled.",
      "Both readiness gates pass only in this synthetic control; no execution GO or public-launch authority follows.",
      "Reused-capture negative (synthetic)",
      "Reusing the synthetic packaging observations at signal FAILS host signal; reusing signal observations at window-open STOPS the window.",
      "Even unchanged release/posture and formerly passing targets do not make reused observations fresh.",
    ]);
  });

});

describe("operator runbook reachability references", () => {
  it("names the registered Admin catalog-item target in the channels pilot inventory", () => {
    expect(readProse("docs/runbooks/channels-pilot-operations.md")).toContain("Admin `/catalog/catalog-items/<id>`");
  });

  it.each(runbooks)("uses the shared gate rather than a separate readiness rule: %s", (path) => {
    const text = readProse(path);
    expect(text).toContain(gateLink);
    assertRules(text, ["READY", "host signal", "window-open"]);
  });
});
