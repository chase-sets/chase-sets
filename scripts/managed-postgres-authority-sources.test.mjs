import { execFile } from "node:child_process";
import { GIT_LISTING_MAX_BUFFER } from "./lib/git-listing.mjs";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHORITY_ROOT,
  MANIFEST_PATH,
  generateManagedPostgresAuthority,
  validateManagedPostgresAuthoritySources,
  writeManagedPostgresAuthorityManifest,
} from "./managed-postgres-authority-sources.mjs";
import {
  parseNameStatusZ,
  parseVerifyStaticChain,
  runVerifyStaticScoped,
  selectVerifyStaticLinks,
} from "./verify-static-scoped.mjs";
import { ALWAYS_RUN, VERIFY_STATIC_SURFACES } from "./verify-static-surfaces.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
// Immutable pre-migration oracle for #8289; never derive expectations from candidate sources or ingress.
const migrationBase = "d6ac09c6422d6505b537d5c38e7259277083b918";
const sourceCli = "scripts/managed-postgres-authority-sources.mjs";
const guardCli = "scripts/managed-postgres-authority-guard.mjs";
const schemaPath = "scripts/managed-postgres-authority-manifest.schema.json";
const workflowPath = ".github/workflows/platform-production.yml";
const fragmentPath = `${AUTHORITY_ROOT}/platform-production/deploy.json`;
const boundaryTarget = "./.github/actions/export-managed-postgres-authority";
// Rule for later grant changes: `migrationBase` and its 1609-grant assertion never move. A slice that adds grants
// appends its literal reviewed records to this delta; a slice that removes grants lists them as an explicit reviewed
// removal list, in that slice's own PR. Never derive either list from the candidate. Re-baselining needs its own slice.
const reviewedCatalogDelta = [
  // #9221 delta: the Catalog Completion Report workflow's three export-boundary grants.
  {
    file: ".github/workflows/catalog-completion-report.yml",
    jobId: "completion-report",
    stepAnchor: "uses:./.github/actions/export-managed-postgres-authority",
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "managed-postgres-boundary",
  },
  {
    file: ".github/workflows/catalog-completion-report.yml",
    jobId: "completion-report",
    stepAnchor: "uses:./.github/actions/export-managed-postgres-authority",
    secretName: "SPACES_ACCESS_ID",
    purpose: "managed-postgres-boundary",
  },
  {
    file: ".github/workflows/catalog-completion-report.yml",
    jobId: "completion-report",
    stepAnchor: "uses:./.github/actions/export-managed-postgres-authority",
    secretName: "SPACES_SECRET_KEY",
    purpose: "managed-postgres-boundary",
  },
];
// #10591 reviewed additions: the DOKS version-change preflight's step-local credentials.
const doksVersionChangePreflightDelta = [
  "DIGITALOCEAN_ACCESS_TOKEN",
  "SPACES_ACCESS_ID",
  "SPACES_SECRET_KEY",
  "DIGITALOCEAN_ACCESS_TOKEN",
].map((secretName) => ({
  file: ".github/workflows/platform-doks-foundation.yml",
  jobId: "apply",
  stepAnchor: "name:Preflight DOKS version change#8",
  secretName,
  purpose: "terraform-infra",
}));
// #10356 threads the preview runtime provider secrets into the ephemeral verification apply step.
const previewRuntimeSecretsDelta = [
  "SCRYDEX_API_KEY",
  "SCRYDEX_TEAM_ID",
  "SES_AWS_ACCESS_KEY_ID",
  "SES_AWS_SECRET_ACCESS_KEY",
  "SES_SOURCE_ARN",
].map((secretName) => ({
  file: ".github/workflows/platform-ephemeral-verification.yml",
  jobId: "verify-release",
  stepAnchor: "name:Apply verification Kubernetes runtime secrets#14",
  secretName,
  purpose: "terraform-infra",
}));
// #9268 delta: the staging preview DNS-01 token converge step in deploy-staging and the on-demand restore workflow.
const previewWildcardWorkflow = ".github/workflows/platform-preview-wildcard-tls.yml";
const previewWildcardJob = "restore-preview-wildcard-tls";
const reviewedPreviewWildcardDelta = [
  {
    file: ".github/workflows/platform-production.yml",
    jobId: "deploy-staging",
    stepAnchor: "name:Converge staging preview DNS-01 token and renewal#29",
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "digitalocean-ops",
  },
  {
    file: previewWildcardWorkflow,
    jobId: previewWildcardJob,
    stepAnchor: "name:Configure staging Kubernetes context#5",
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "digitalocean-ops",
  },
  {
    file: previewWildcardWorkflow,
    jobId: previewWildcardJob,
    stepAnchor: "name:Configure staging Kubernetes context#5",
    secretName: "SPACES_ACCESS_ID",
    purpose: "spaces-evidence",
  },
  {
    file: previewWildcardWorkflow,
    jobId: previewWildcardJob,
    stepAnchor: "name:Configure staging Kubernetes context#5",
    secretName: "SPACES_SECRET_KEY",
    purpose: "spaces-evidence",
  },
  {
    file: previewWildcardWorkflow,
    jobId: previewWildcardJob,
    stepAnchor: "name:Converge staging preview DNS-01 token and renewal#6",
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "digitalocean-ops",
  },
];
// #9591 threads the canonical staging Admin keys into only the count preparation run and receipt-validation steps.
const catalogCountPreparationDelta = [
  {
    file: ".github/workflows/catalog-staging-count-preparation.yml",
    jobId: "prepare-counts",
    stepAnchor: "name:Prepare governed Scrydex counts#3",
    secretName: "CATALOG_ADMIN_E2E_PASSWORD",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/catalog-staging-count-preparation.yml",
    jobId: "prepare-counts",
    stepAnchor: "name:Prepare governed Scrydex counts#3",
    secretName: "PLATFORM_ADMIN_EMAIL",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/catalog-staging-count-preparation.yml",
    jobId: "prepare-counts",
    stepAnchor: "name:Prepare governed Scrydex counts#3",
    secretName: "PLATFORM_ADMIN_PASSWORD",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/catalog-staging-count-preparation.yml",
    jobId: "prepare-counts",
    stepAnchor: "name:Validate count preparation receipt#4",
    secretName: "CATALOG_ADMIN_E2E_PASSWORD",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/catalog-staging-count-preparation.yml",
    jobId: "prepare-counts",
    stepAnchor: "name:Validate count preparation receipt#4",
    secretName: "PLATFORM_ADMIN_EMAIL",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/catalog-staging-count-preparation.yml",
    jobId: "prepare-counts",
    stepAnchor: "name:Validate count preparation receipt#4",
    secretName: "PLATFORM_ADMIN_PASSWORD",
    purpose: "application-runtime",
  },
];
// #9964 delta: the idle draft retirement job builds its own staging kubeconfig the way the preview sweep does.
const idleDraftRetirementJob = "retire-idle-draft-previews";
const idleDraftRetirementContextStep = "name:Configure staging Kubernetes context for idle draft retirement#5";
const idleDraftRetirementDelta = [
  {
    file: ".github/workflows/platform-preview-cleanup.yml",
    jobId: idleDraftRetirementJob,
    stepAnchor: "uses:digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f",
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "digitalocean-ops",
  },
  {
    file: ".github/workflows/platform-preview-cleanup.yml",
    jobId: idleDraftRetirementJob,
    stepAnchor: idleDraftRetirementContextStep,
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "digitalocean-ops",
  },
  {
    file: ".github/workflows/platform-preview-cleanup.yml",
    jobId: idleDraftRetirementJob,
    stepAnchor: idleDraftRetirementContextStep,
    secretName: "SPACES_ACCESS_ID",
    purpose: "spaces-evidence",
  },
  {
    file: ".github/workflows/platform-preview-cleanup.yml",
    jobId: idleDraftRetirementJob,
    stepAnchor: idleDraftRetirementContextStep,
    secretName: "SPACES_SECRET_KEY",
    purpose: "spaces-evidence",
  },
];
// #9587 threads the canonical staging Admin keys into only the isolated count lifecycle run and receipt-validation steps.
const catalogCountLifecycleDelta = [
  {
    file: ".github/workflows/catalog-staging-provider-uat.yml",
    jobId: "scope-sync-count-lifecycle",
    stepAnchor: "name:Capture count lifecycle without confirmation#4",
    secretName: "CATALOG_ADMIN_E2E_PASSWORD",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/catalog-staging-provider-uat.yml",
    jobId: "scope-sync-count-lifecycle",
    stepAnchor: "name:Capture count lifecycle without confirmation#4",
    secretName: "PLATFORM_ADMIN_EMAIL",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/catalog-staging-provider-uat.yml",
    jobId: "scope-sync-count-lifecycle",
    stepAnchor: "name:Capture count lifecycle without confirmation#4",
    secretName: "PLATFORM_ADMIN_PASSWORD",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/catalog-staging-provider-uat.yml",
    jobId: "scope-sync-count-lifecycle",
    stepAnchor: "name:Validate exact runner-scanned receipt#5",
    secretName: "CATALOG_ADMIN_E2E_PASSWORD",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/catalog-staging-provider-uat.yml",
    jobId: "scope-sync-count-lifecycle",
    stepAnchor: "name:Validate exact runner-scanned receipt#5",
    secretName: "PLATFORM_ADMIN_EMAIL",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/catalog-staging-provider-uat.yml",
    jobId: "scope-sync-count-lifecycle",
    stepAnchor: "name:Validate exact runner-scanned receipt#5",
    secretName: "PLATFORM_ADMIN_PASSWORD",
    purpose: "application-runtime",
  },
];
// #10003 threads the canonical staging Admin keys into only the isolated cache-only Scrydex capture and its
// sealed-receipt validation steps.
const scrydexCacheCaptureDelta = [
  "name:Capture Scrydex option cache without refresh#4",
  "name:Validate exact runner-sealed capture#5",
].flatMap((stepAnchor) =>
  ["CATALOG_ADMIN_E2E_PASSWORD", "PLATFORM_ADMIN_EMAIL", "PLATFORM_ADMIN_PASSWORD"].map((secretName) => ({
    file: ".github/workflows/catalog-staging-provider-uat.yml",
    jobId: "scrydex-cache-capture",
    stepAnchor,
    secretName,
    purpose: "application-runtime",
  })),
);
// #10462 threads the canonical staging Admin keys into only the isolated coordinate-preview capture step.
const scrydexCoordinatePreviewDelta = ["name:Capture Scrydex coordinate preview#4"].flatMap((stepAnchor) =>
  ["CATALOG_ADMIN_E2E_PASSWORD", "PLATFORM_ADMIN_EMAIL", "PLATFORM_ADMIN_PASSWORD"].map((secretName) => ({
    file: ".github/workflows/catalog-staging-provider-uat.yml",
    jobId: "scrydex-coordinate-preview",
    stepAnchor,
    secretName,
    purpose: "application-runtime",
  })),
);
const scrydexOptionRefreshDelta = ["name:Run bounded Scrydex force refresh#4"].flatMap((stepAnchor) =>
  ["CATALOG_ADMIN_E2E_PASSWORD", "PLATFORM_ADMIN_EMAIL", "PLATFORM_ADMIN_PASSWORD"].map((secretName) => ({
    file: ".github/workflows/catalog-staging-provider-uat.yml",
    jobId: "scrydex-force-refresh-bounded",
    stepAnchor,
    secretName,
    purpose: "application-runtime",
  })),
);
// #9962 adds the read-only preview-pool census workflow's provider authority grants.
const productionMemoryProbeDelta = [
  ["name:Configure production read context#6", "DIGITALOCEAN_ACCESS_TOKEN", "digitalocean-ops"],
  ["name:Configure production read context#6", "SPACES_ACCESS_ID", "spaces-evidence"],
  ["name:Configure production read context#6", "SPACES_SECRET_KEY", "spaces-evidence"],
  ["name:Capture production web memory#7", "PROMETHEUS_QUERY_TOKEN", "spaces-evidence"],
].map(([stepAnchor, secretName, purpose]) => ({
  file: ".github/workflows/platform-production-memory-probe.yml",
  jobId: "capture",
  stepAnchor,
  secretName,
  purpose,
}));

const previewPoolCensusDelta = [
  ["name:Configure staging Kubernetes context (read-only)#5", "DIGITALOCEAN_ACCESS_TOKEN", "digitalocean-ops"],
  ["name:Configure staging Kubernetes context (read-only)#5", "SPACES_ACCESS_ID", "spaces-evidence"],
  ["name:Configure staging Kubernetes context (read-only)#5", "SPACES_SECRET_KEY", "spaces-evidence"],
  [
    "uses:digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f",
    "DIGITALOCEAN_ACCESS_TOKEN",
    "digitalocean-ops",
  ],
  [
    "uses:digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f",
    "DIGITALOCEAN_ACCESS_TOKEN",
    "digitalocean-ops",
  ],
  ["uses:digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f", "SPACES_ACCESS_ID", "spaces-evidence"],
  ["uses:digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f", "SPACES_SECRET_KEY", "spaces-evidence"],
  [
    "uses:hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e",
    "DIGITALOCEAN_ACCESS_TOKEN",
    "digitalocean-ops",
  ],
  ["uses:hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e", "SPACES_ACCESS_ID", "spaces-evidence"],
  ["uses:hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e", "SPACES_SECRET_KEY", "spaces-evidence"],
].map(([stepAnchor, secretName, purpose]) => ({
  file: ".github/workflows/platform-preview-pool-census.yml",
  jobId: "census",
  stepAnchor,
  secretName,
  purpose,
}));
// #9293 adds only the two deployment values at the five existing Secret-apply sinks.
const ebayAccountDeletionDelta = [
  {
    file: ".github/workflows/platform-ephemeral-verification.yml",
    jobId: "verify-release",
    stepAnchor: "name:Apply verification Kubernetes runtime secrets#14",
    secretName: "EBAY_ACCOUNT_DELETION_ENDPOINT",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-ephemeral-verification.yml",
    jobId: "verify-release",
    stepAnchor: "name:Apply verification Kubernetes runtime secrets#14",
    secretName: "EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-merge-gate-verification.yml",
    jobId: "verify",
    stepAnchor: "name:Apply gate Kubernetes runtime secrets#11",
    secretName: "EBAY_ACCOUNT_DELETION_ENDPOINT",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-merge-gate-verification.yml",
    jobId: "verify",
    stepAnchor: "name:Apply gate Kubernetes runtime secrets#11",
    secretName: "EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-pr.yml",
    jobId: "preview-deploy-smoke",
    stepAnchor: "name:Apply preview Kubernetes runtime secrets#13",
    secretName: "EBAY_ACCOUNT_DELETION_ENDPOINT",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-pr.yml",
    jobId: "preview-deploy-smoke",
    stepAnchor: "name:Apply preview Kubernetes runtime secrets#13",
    secretName: "EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-production.yml",
    jobId: "deploy-production",
    stepAnchor: "name:Apply production Kubernetes runtime secrets#33",
    secretName: "EBAY_ACCOUNT_DELETION_ENDPOINT",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-production.yml",
    jobId: "deploy-production",
    stepAnchor: "name:Apply production Kubernetes runtime secrets#33",
    secretName: "EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-production.yml",
    jobId: "deploy-staging",
    stepAnchor: "name:Apply staging Kubernetes runtime secrets#33",
    secretName: "EBAY_ACCOUNT_DELETION_ENDPOINT",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-production.yml",
    jobId: "deploy-staging",
    stepAnchor: "name:Apply staging Kubernetes runtime secrets#33",
    secretName: "EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN",
    purpose: "application-runtime",
  },
];
// Adds the staging-only receipt actor grant at the existing Secret-apply sink.
const ebayReceiptLookupStagingActorDelta = [
  {
    file: ".github/workflows/platform-production.yml",
    jobId: "deploy-staging",
    stepAnchor: "name:Apply staging Kubernetes runtime secrets#33",
    secretName: "EBAY_RECEIPT_LOOKUP_STAGING_ACTOR_JSON",
    purpose: "application-runtime",
  },
];
// #9912 delta: the daily credential health check's rotation App key and its step-local liveness secrets.
const credentialHealthWorkflow = ".github/workflows/platform-credential-health.yml";
const credentialHealthDelta = [
  {
    file: credentialHealthWorkflow,
    jobId: "metadata",
    stepAnchor: "uses:actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
    secretName: "CREDENTIAL_ROTATION_APP_PRIVATE_KEY",
    purpose: "credential-rotation",
  },
  ...[
    "DIGITALOCEAN_ACCESS_TOKEN",
    "DIGITALOCEAN_READONLY_TOKEN",
    "DIGITALOCEAN_REGISTRY_TOKEN",
    "ENVIRONMENT_SECRETS_TOKEN",
    "PROJECTS_TOKEN",
    "RELEASE_EVIDENCE_SPACES_ACCESS_ID",
    "RELEASE_EVIDENCE_SPACES_SECRET_KEY",
    "SEED_PACKS_SPACES_ACCESS_ID",
    "SEED_PACKS_SPACES_SECRET_KEY",
    "SPACES_ACCESS_ID",
    "SPACES_SECRET_KEY",
  ].map((secretName) => ({
    file: credentialHealthWorkflow,
    jobId: "liveness",
    stepAnchor: "name:Check credential liveness#2",
    secretName,
    purpose: "credential-rotation",
  })),
];
// #10045 delta: the staging cluster add-on dispatch's state-read context step and its step-local DigitalOcean token.
const stagingClusterAddonsWorkflow = ".github/workflows/platform-staging-cluster-addons.yml";
const stagingClusterAddonsJob = "apply-staging-cluster-addons";
const stagingClusterAddonsDelta = [
  ...[
    ["DIGITALOCEAN_ACCESS_TOKEN", "digitalocean-ops"],
    ["SPACES_ACCESS_ID", "spaces-evidence"],
    ["SPACES_SECRET_KEY", "spaces-evidence"],
  ].map(([secretName, purpose]) => ({
    file: stagingClusterAddonsWorkflow,
    jobId: stagingClusterAddonsJob,
    stepAnchor: "name:Configure staging Kubernetes context#7",
    secretName,
    purpose,
  })),
  ...[
    "name:Probe DigitalOcean token presence#9",
    "name:Apply staging cluster add-ons#10",
    "name:Scan evidence for the DigitalOcean token#13",
  ].map((stepAnchor) => ({
    file: stagingClusterAddonsWorkflow,
    jobId: stagingClusterAddonsJob,
    stepAnchor,
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "digitalocean-ops",
  })),
];
// #9800 reviewed delta: the protected Collections anonymous-owner redaction runner's database boundary grants.
const collectionsAnonymousOwnerRedactionDelta = [
  "DIGITALOCEAN_ACCESS_TOKEN",
  "SPACES_ACCESS_ID",
  "SPACES_SECRET_KEY",
].map((secretName) => ({
  file: ".github/workflows/collections-anonymous-owner-redaction.yml",
  jobId: "cutover",
  stepAnchor: "uses:./.github/actions/export-managed-postgres-authority",
  secretName,
  purpose: "managed-postgres-boundary",
}));
// #10224 reviewed delta: the staging evidence window job's and its cleanup observer's grants. Both share the
// staging boundary and Kubernetes-context grants; only the window's three read-only Stripe steps take the key.
const stagingEvidenceWindowDelta = [
  [".github/workflows/platform-staging-evidence-window.yml", "staging-evidence-window", 7],
  [".github/workflows/platform-staging-evidence-window-cleanup.yml", "evidence-window-cleanup", 6],
].flatMap(([file, jobId, contextStep]) => [
  {
    file,
    jobId,
    stepAnchor: "uses:digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f",
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "digitalocean-ops",
  },
  ...["SPACES_ACCESS_ID", "SPACES_SECRET_KEY", "DIGITALOCEAN_ACCESS_TOKEN"].map((secretName) => ({
    file,
    jobId,
    stepAnchor: "uses:./.github/actions/export-managed-postgres-authority",
    secretName,
    purpose: "managed-postgres-boundary",
  })),
  ...[
    ["SPACES_ACCESS_ID", "spaces-evidence"],
    ["SPACES_SECRET_KEY", "spaces-evidence"],
    ["DIGITALOCEAN_ACCESS_TOKEN", "digitalocean-ops"],
  ].map(([secretName, purpose]) => ({
    file,
    jobId,
    stepAnchor: `name:Configure staging Kubernetes context#${contextStep}`,
    secretName,
    purpose,
  })),
  ...(jobId === "staging-evidence-window"
    ? [
        "Install admission, restart runtimes, create the journal login and arm the observer#9",
        "Attest the Stripe test account, fixtures and webhook delivery#10",
        "Recapture the binding and open one window#11",
      ].map((step) => ({
        file,
        jobId,
        stepAnchor: `name:${step}`,
        secretName: "STRIPE_SECRET_KEY",
        purpose: "marketplace-ops",
      }))
    : []),
]);
// #10210 reviewed delta: the read-only Collections cutover authority capture's boundary, kubeconfig and state-pull grants.
const collectionsCutoverAuthorityCaptureDelta = [
  ["name:Capture Collections cutover authority#8", "SPACES_ACCESS_ID", "spaces-evidence"],
  ["name:Capture Collections cutover authority#8", "SPACES_SECRET_KEY", "spaces-evidence"],
  ["name:Configure Kubernetes context#7", "DIGITALOCEAN_ACCESS_TOKEN", "digitalocean-ops"],
  ["name:Configure Kubernetes context#7", "SPACES_ACCESS_ID", "spaces-evidence"],
  ["name:Configure Kubernetes context#7", "SPACES_SECRET_KEY", "spaces-evidence"],
  [
    "uses:./.github/actions/export-managed-postgres-authority",
    "DIGITALOCEAN_ACCESS_TOKEN",
    "managed-postgres-boundary",
  ],
  ["uses:./.github/actions/export-managed-postgres-authority", "SPACES_ACCESS_ID", "managed-postgres-boundary"],
  ["uses:./.github/actions/export-managed-postgres-authority", "SPACES_SECRET_KEY", "managed-postgres-boundary"],
].map(([stepAnchor, secretName, purpose]) => ({
  file: ".github/workflows/collections-cutover-authority-capture.yml",
  jobId: "capture",
  stepAnchor,
  secretName,
  purpose,
}));
// #9721 reviewed removal: the retired mandate verifier's URL, auth-token and timeout grants at its five forwarding
// sinks, plus #9876's six retired TCGplayer cookie grants, as zero-based record indices in the immutable `migrationBase` manifest. Secret names are not repeated here so
// the issue's literal sweep stays exact; parity below binds each index to the generated manifest and source fragments.
const reviewedRetiredVerifierRemovals = new Set([
  210, 211, 212, 263, 264, 265, 398, 428, 429, 430, 709, 710, 711, 712, 956, 957, 958, 959, 1391, 1419, 1483,
]);
// #9268 reviewed step insertions: positional `#N` anchors at or after each inserted step's final 1-based position
// shift by one, applied in order. Reviewed record identity (file, job, step name, secret, purpose) never changes.
// An inserted `uses` step also shifts that action's occurrence anchors at or after its occurrence; no suffix is #1.
const uploadArtifact = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const reviewedStepInsertions = [
  // #10591: preflight and inspected-plan steps ahead of the DOKS apply path.
  { file: ".github/workflows/platform-doks-foundation.yml", jobId: "apply", position: 8 },
  { file: ".github/workflows/platform-doks-foundation.yml", jobId: "apply", position: 11 },
  // #10259: scheduled batch download, batch resolution and target-number steps ahead of destroy-preview cleanup.
  { file: ".github/workflows/platform-preview-cleanup.yml", jobId: "destroy-preview", position: 7 },
  { file: ".github/workflows/platform-preview-cleanup.yml", jobId: "destroy-preview", position: 8 },
  { file: ".github/workflows/platform-preview-cleanup.yml", jobId: "destroy-preview", position: 9 },
  { file: ".github/workflows/platform-production.yml", jobId: "deploy-staging", position: 28 },
  { file: ".github/workflows/platform-production.yml", jobId: "deploy-staging", position: 52 },
  { file: ".github/workflows/platform-production.yml", jobId: "deploy-staging", position: 28 },
  // #10235: the staging and production Agent Grant revocation activation steps and their status uploads.
  { file: ".github/workflows/platform-production.yml", jobId: "deploy-staging", position: 54 },
  {
    file: ".github/workflows/platform-production.yml",
    jobId: "deploy-staging",
    position: 55,
    uses: uploadArtifact,
    occurrence: 8,
  },
  { file: ".github/workflows/platform-production.yml", jobId: "deploy-production", position: 56 },
  {
    file: ".github/workflows/platform-production.yml",
    jobId: "deploy-production",
    position: 57,
    uses: uploadArtifact,
    occurrence: 6,
  },
];
const previewStateRetirementDelta = [
  ["DIGITALOCEAN_ACCESS_TOKEN", "terraform-infra"],
  ["SPACES_ACCESS_ID", "terraform-infra"],
  ["SPACES_SECRET_KEY", "terraform-infra"],
  ["DIGITALOCEAN_ACCESS_TOKEN", "terraform-infra"],
  ["SPACES_ACCESS_ID", "terraform-infra"],
  ["SPACES_SECRET_KEY", "terraform-infra"],
].map(([secretName, purpose]) => ({
  file: ".github/workflows/platform-preview-cleanup.yml",
  jobId: "destroy-preview",
  stepAnchor: "name:Retire empty preview Terraform state#17",
  secretName,
  purpose,
}));

function applyReviewedStepInsertions(record) {
  return reviewedStepInsertions.reduce((current, insertion) => {
    if (current.file !== insertion.file || current.jobId !== insertion.jobId) return current;
    const named = /^(name:.*#)(\d+)$/.exec(current.stepAnchor);
    if (named) {
      const index = Number(named[2]);
      return index >= insertion.position ? { ...current, stepAnchor: `${named[1]}${index + 1}` } : current;
    }
    const used = /^uses:([^#]+)(?:#(\d+))?$/.exec(current.stepAnchor);
    if (!used || used[1] !== insertion.uses) return current;
    const occurrence = Number(used[2] ?? 1);
    return occurrence >= insertion.occurrence
      ? { ...current, stepAnchor: `uses:${used[1]}#${occurrence + 1}` }
      : current;
  }, record);
}

// Advisory qualification reuses the reviewed gate grants; only step positions move.
function applyQualificationStepInsertions(record) {
  const insertions = [
    { file: ".github/workflows/platform-merge-gate-verification.yml", jobId: "verify", positions: [2, 8, 11, 12] },
    { file: ".github/workflows/platform-merge-gate-verification.yml", jobId: "stranded-fixture-drill", positions: [2] },
    { file: ".github/workflows/platform-pr.yml", jobId: "docker-image", positions: [9, 10, 11, 12, 13, 14] },
  ];
  const insertion = insertions.find(({ file, jobId }) => file === record.file && jobId === record.jobId);
  const match = /^(name:.*#)(\d+)$/.exec(record.stepAnchor);
  if (!insertion || !match) return record;
  const position = insertion.positions.reduce(
    (index, inserted) => (index >= inserted ? index + 1 : index),
    Number(match[2]),
  );
  return { ...record, stepAnchor: `${match[1]}${position}` };
}

const qualificationCleanupDelta = [
  {
    file: ".github/workflows/platform-merge-qualification-observer.yml",
    jobId: "cleanup",
    stepAnchor: "name:Configure observer Kubernetes context#8",
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "digitalocean-ops",
  },
  {
    file: ".github/workflows/platform-merge-qualification-observer.yml",
    jobId: "cleanup",
    stepAnchor: "name:Delete exact gate provider webhooks#10",
    secretName: "EASYPOST_API_KEY",
    purpose: "marketplace-ops",
  },
  {
    file: ".github/workflows/platform-merge-qualification-observer.yml",
    jobId: "cleanup",
    stepAnchor: "name:Delete exact gate provider webhooks#10",
    secretName: "STRIPE_SECRET_KEY",
    purpose: "marketplace-ops",
  },
  {
    file: ".github/workflows/platform-merge-qualification-observer.yml",
    jobId: "cleanup",
    stepAnchor: "name:Persist cancelled post-identity attempt#11",
    secretName: "RELEASE_EVIDENCE_SPACES_ACCESS_ID",
    purpose: "release-evidence",
  },
  {
    file: ".github/workflows/platform-merge-qualification-observer.yml",
    jobId: "cleanup",
    stepAnchor: "name:Persist cancelled post-identity attempt#11",
    secretName: "RELEASE_EVIDENCE_SPACES_SECRET_KEY",
    purpose: "release-evidence",
  },
  {
    file: ".github/workflows/platform-merge-qualification-observer.yml",
    jobId: "cleanup",
    stepAnchor: "name:Validate observer cleanup credentials#5",
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "digitalocean-ops",
  },
  {
    file: ".github/workflows/platform-merge-qualification-observer.yml",
    jobId: "cleanup",
    stepAnchor: "name:Validate observer cleanup credentials#5",
    secretName: "EASYPOST_API_KEY",
    purpose: "marketplace-ops",
  },
  {
    file: ".github/workflows/platform-merge-qualification-observer.yml",
    jobId: "cleanup",
    stepAnchor: "name:Validate observer cleanup credentials#5",
    secretName: "RELEASE_EVIDENCE_SPACES_ACCESS_ID",
    purpose: "release-evidence",
  },
  {
    file: ".github/workflows/platform-merge-qualification-observer.yml",
    jobId: "cleanup",
    stepAnchor: "name:Validate observer cleanup credentials#5",
    secretName: "RELEASE_EVIDENCE_SPACES_SECRET_KEY",
    purpose: "release-evidence",
  },
  {
    file: ".github/workflows/platform-merge-qualification-observer.yml",
    jobId: "cleanup",
    stepAnchor: "name:Validate observer cleanup credentials#5",
    secretName: "STRIPE_SECRET_KEY",
    purpose: "marketplace-ops",
  },
  {
    file: ".github/workflows/platform-merge-qualification-observer.yml",
    jobId: "cleanup",
    stepAnchor: "uses:digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f",
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "digitalocean-ops",
  },
];
// #10396: deploy-production's inline Kubernetes context step moved into the shared marker recovery
// composite, and the isolated marker-only job receives only the composite and registry-identity grants.
const productionMarkerRecoveryRetiredAnchor = "name:Configure production Kubernetes context#25";
const productionMarkerRecoveryDelta = [
  ...["DIGITALOCEAN_ACCESS_TOKEN", "SPACES_ACCESS_ID", "SPACES_SECRET_KEY"].flatMap((secretName) =>
    ["deploy-production", "reconcile-production-marker"].map((jobId) => ({
      file: ".github/workflows/platform-production.yml",
      jobId,
      stepAnchor: "uses:./.github/actions/production-marker-recovery-context",
      secretName,
      purpose: "terraform-infra",
    })),
  ),
  ...[
    "name:Derive source registry identity#6",
    "uses:digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f",
  ].map((stepAnchor) => ({
    file: ".github/workflows/platform-production.yml",
    jobId: "reconcile-production-marker",
    stepAnchor,
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "terraform-infra",
  })),
];
// #9450 adds the existing scoped registry credentials to the new fail-closed
// writer-gate invocations; these are deliberate authority additions, not a snapshot refresh.
const registryGarbageCollectionGateCredentialDelta = [
  [".github/workflows/platform-pr.yml", "preview-deploy-smoke", "name:Build and push platform image#9"],
  [".github/workflows/platform-production.yml", "build-image", "name:Build release image#5"],
  [".github/workflows/platform-production.yml", "build-image", "name:Push release image#8"],
  [".github/workflows/platform-production.yml", "deploy-production", "name:Mark production release#53"],
  [
    ".github/workflows/platform-production.yml",
    "reconcile-production-marker",
    "name:Reconcile retained production marker#8",
  ],
].map(([file, jobId, stepAnchor]) => ({
  file,
  jobId,
  stepAnchor,
  secretName: "DIGITALOCEAN_ACCESS_TOKEN",
  purpose: "terraform-infra",
}));
// #9450 also resolves the registry before cleanup; migrate the existing cleanup
// grant and add the new provider-touching resolver grant to the expected corpus.
const registryCleanupResolverDelta = [
  {
    file: ".github/workflows/platform-registry-cleanup.yml",
    jobId: "cleanup",
    stepAnchor: "name:Resolve registry identity#5",
    secretName: "DIGITALOCEAN_REGISTRY_TOKEN",
    purpose: "digitalocean-ops",
  },
];
function applyRegistryCleanupStepInsertion(record) {
  return record.file === ".github/workflows/platform-registry-cleanup.yml" &&
    record.jobId === "cleanup" &&
    record.stepAnchor === "name:Cleanup registry tags#7"
    ? { ...record, stepAnchor: "name:Cleanup registry tags#8" }
    : record;
}
const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function write(root, path, contents) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}

async function writeJson(root, path, value) {
  await write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(root, path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function trackSources(root) {
  await execFileAsync("git", ["-c", "core.ignorecase=false", "add", "-A", "--", AUTHORITY_ROOT], { cwd: root });
}

async function materializeImmutableMigrationInput(original) {
  const root = await mkdtemp(join(tmpdir(), "managed-postgres-authority-migration-"));
  roots.push(root);
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
  const { stdout } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "--name-only", migrationBase, "--", ".github/workflows", AUTHORITY_ROOT],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: GIT_LISTING_MAX_BUFFER },
  );
  for (const path of stdout.split("\n").filter(Boolean)) {
    const file = await execFileAsync("git", ["show", `${migrationBase}:${path}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    await write(root, path, file.stdout);
  }
  const expectedOwners = new Map();
  for (const record of original.grants) {
    const owner = `${AUTHORITY_ROOT}/${basename(record.file).replace(/\.ya?ml$/, "")}/${record.jobId}.json`;
    expectedOwners.set(owner, [...(expectedOwners.get(owner) ?? []), record]);
  }
  for (const [owner, grants] of expectedOwners) await writeJson(root, owner, { grants });
  await trackSources(root);
  return root;
}

function grant(overrides = {}) {
  return {
    file: workflowPath,
    jobId: "deploy",
    stepAnchor: "step:1",
    secretName: "A_SECRET",
    purpose: "application-runtime",
    ...overrides,
  };
}

function dockerConsumer(overrides = {}) {
  return {
    file: workflowPath,
    jobId: "deploy",
    stepAnchor: "step:1",
    pathMapping: "/tmp/ca:/etc/ssl/ca.pem",
    ...overrides,
  };
}

async function fixture(fragment = { grants: [grant()] }) {
  const root = await mkdtemp(join(tmpdir(), "managed-postgres-authority-sources-"));
  roots.push(root);
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
  await writeJson(root, workflowPath, { jobs: { deploy: { "runs-on": "ubuntu-latest", steps: [] } } });
  await writeJson(root, fragmentPath, fragment);
  await trackSources(root);
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(join(repositoryRoot, schemaPath), join(root, schemaPath));
  return root;
}

async function boundaryFixture() {
  const grants = ["SPACES_ACCESS_ID", "SPACES_SECRET_KEY", "DIGITALOCEAN_ACCESS_TOKEN"].map((secretName) =>
    grant({ secretName, stepAnchor: `uses:${boundaryTarget}`, purpose: "managed-postgres-boundary" }),
  );
  const root = await fixture({ grants });
  await writeJson(root, workflowPath, {
    jobs: {
      deploy: {
        "runs-on": "ubuntu-latest",
        steps: [
          {
            uses: boundaryTarget,
            env: Object.fromEntries(grants.map(({ secretName }) => [secretName, `\${{ secrets.${secretName} }}`])),
            with: { environment: "staging", contexts: "catalog", "connection-mode": "pooled" },
          },
          { name: "Remove managed Postgres CA", if: "always()", run: 'rm -f -- "$PGSSLROOTCERT"' },
        ],
      },
    },
  });
  await writeJson(root, `${boundaryTarget.slice(2)}/action.yml`, {
    runs: { using: "composite", steps: [{ shell: "bash", run: "echo bounded" }] },
  });
  return root;
}

async function addWorkflow(root) {
  const file = ".github/workflows/unfamiliar-zone/new-owner.yaml";
  const source = `${AUTHORITY_ROOT}/new-owner/probe.json`;
  const record = grant({ file, jobId: "probe", secretName: "SYNTHETIC_NEW_SECRET" });
  await writeJson(root, file, {
    jobs: {
      probe: {
        "runs-on": "ubuntu-latest",
        steps: [{ env: { TOKEN: "${{ secrets.SYNTHETIC_NEW_SECRET }}" }, run: "echo bounded" }],
      },
    },
  });
  await writeJson(root, source, { grants: [record] });
  await trackSources(root);
  return { file, source, record };
}

async function runCli(script, root, args = []) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [join(repositoryRoot, script), "--repository-root", root, ...args],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
  }
}

async function runGuard(root, args = []) {
  const result = await runCli(guardCli, root, args);
  return { ...result, report: JSON.parse(result.stdout) };
}

async function snapshot(root, prefix = "") {
  const files = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, path));
    else files[path] = await readFile(join(root, path), "utf8");
  }
  return files;
}

// Sort object keys independently of generator tuple sorting; retain every occurrence.
function multiset(records) {
  return records
    .map((record) =>
      JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))),
    )
    .sort();
}

function expectParity(expected, actual) {
  expect(actual.schemaVersion).toBe(expected.schemaVersion);
  expect(multiset(actual.grants)).toEqual(multiset(expected.grants));
  expect(multiset(actual.dockerConsumers ?? [])).toEqual(multiset(expected.dockerConsumers ?? []));
}

describe("managed Postgres authority source generator", () => {
  it("authority source migration preserves all reviewed records", async () => {
    const { stdout } = await execFileAsync("git", ["show", `${migrationBase}:${MANIFEST_PATH}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    const original = JSON.parse(stdout);
    expect(original.grants).toHaveLength(1609);
    expect(original.dockerConsumers ?? []).toEqual([]);

    const historicalRoot = await materializeImmutableMigrationInput(original);
    const historicalGenerated = await generateManagedPostgresAuthority(historicalRoot);
    expectParity(original, historicalGenerated);

    for (const index of reviewedRetiredVerifierRemovals) expect(original.grants[index]).toBeDefined();
    const retainedOriginalGrants = original.grants.filter((_, index) => !reviewedRetiredVerifierRemovals.has(index));
    expect(retainedOriginalGrants).toHaveLength(original.grants.length - reviewedRetiredVerifierRemovals.size);
    const generated = await generateManagedPostgresAuthority(repositoryRoot);
    const canonical = await readJson(repositoryRoot, MANIFEST_PATH);
    const expected = {
      ...original,
      grants: [
        ...[...retainedOriginalGrants, ...reviewedCatalogDelta]
          .map(applyReviewedStepInsertions)
          .map(applyRegistryCleanupStepInsertion),
        ...doksVersionChangePreflightDelta,
        ...previewRuntimeSecretsDelta,
        ...reviewedPreviewWildcardDelta,
        ...ebayAccountDeletionDelta,
        ...ebayAccountDeletionDelta.map((entry) => ({
          ...entry,
          secretName:
            entry.secretName === "EBAY_ACCOUNT_DELETION_ENDPOINT"
              ? "EBAY_APPLICATION_CLIENT_ID"
              : "EBAY_APPLICATION_CLIENT_SECRET",
        })),
        ...ebayReceiptLookupStagingActorDelta,
        ...catalogCountPreparationDelta,
        ...idleDraftRetirementDelta,
        ...catalogCountLifecycleDelta,
        ...scrydexCacheCaptureDelta,
        ...scrydexCoordinatePreviewDelta,
        ...scrydexOptionRefreshDelta,
        ...previewPoolCensusDelta,
        ...productionMemoryProbeDelta,
        ...credentialHealthDelta,
        ...stagingClusterAddonsDelta,
        ...collectionsAnonymousOwnerRedactionDelta,
        ...stagingEvidenceWindowDelta,
        ...collectionsCutoverAuthorityCaptureDelta,
        ...qualificationCleanupDelta,
        ...previewStateRetirementDelta,
      ]
        .map(applyQualificationStepInsertions)
        .filter(
          (record) =>
            !(
              record.file === ".github/workflows/platform-production.yml" &&
              record.jobId === "deploy-production" &&
              record.stepAnchor === productionMarkerRecoveryRetiredAnchor
            ),
        )
        .concat(productionMarkerRecoveryDelta)
        .concat(registryGarbageCollectionGateCredentialDelta)
        .concat(registryCleanupResolverDelta),
    };
    // Exact stable-record multiset parity below is the authority; a whole-corpus total would only re-conflict.
    const isCatalogKeyring = ({ secretName }) => secretName === "CATALOG_OPERATOR_SESSION_KEYRING_JSON";
    expect(generated.grants.filter(isCatalogKeyring)).toEqual([]);
    expectParity(expected, generated);
    expectParity(expected, canonical);
    expect(canonical).toEqual(generated);
    expect(generated).not.toHaveProperty("dockerConsumers");

    const expectedOwners = new Map();
    for (const record of expected.grants) {
      const owner = `${AUTHORITY_ROOT}/${basename(record.file).replace(/\.ya?ml$/, "")}/${record.jobId}.json`;
      expectedOwners.set(owner, [...(expectedOwners.get(owner) ?? []), record]);
    }
    expectedOwners.set(`${AUTHORITY_ROOT}/platform-production-lock-monitor/monitor-production-release-lock.json`, []);
    const sources = await snapshot(repositoryRoot, AUTHORITY_ROOT);
    expect(Object.keys(sources).sort()).toEqual([...expectedOwners.keys()].sort());
    for (const [owner, records] of expectedOwners) {
      expect(multiset(JSON.parse(sources[owner]).grants)).toEqual(multiset(records));
    }

    const repeatedIndex = generated.grants.findIndex(
      (record, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(record)) < index,
    );
    expect(repeatedIndex).toBeGreaterThan(0);
    const mutations = [
      { ...generated, grants: generated.grants.slice(1) },
      { ...generated, grants: [...generated.grants, grant({ secretName: "SYNTHETIC_EXTRA_SECRET" })] },
      { ...generated, grants: generated.grants.filter((_, index) => index !== repeatedIndex) },
      { ...generated, grants: [...generated.grants, generated.grants[repeatedIndex]] },
      {
        ...generated,
        grants: generated.grants.map((record, index) => (index === 0 ? { ...record, purpose: "alerting" } : record)),
      },
      {
        ...generated,
        grants: generated.grants.filter((record) => JSON.stringify(record) !== JSON.stringify(reviewedCatalogDelta[0])),
      },
      {
        ...generated,
        grants: [...generated.grants, { ...reviewedCatalogDelta[0], stepAnchor: "name:Apply sixth Catalog grant#99" }],
      },
      ...["file", "jobId", "stepAnchor", "secretName"].map((key) => ({
        ...generated,
        grants: generated.grants.map((record, index) =>
          index === repeatedIndex ? { ...record, [key]: `${record[key]}-renamed` } : record,
        ),
      })),
    ];
    for (const mutation of mutations) expect(() => expectParity(expected, mutation)).toThrow();

    const populated = {
      schemaVersion: 1,
      grants: [grant(), grant()],
      dockerConsumers: [dockerConsumer(), dockerConsumer({ pathMapping: "/var/ca:/etc/ssl/ca.pem" }), dockerConsumer()],
    };
    const root = await fixture({ grants: populated.grants, dockerConsumers: populated.dockerConsumers });
    const populatedResult = await generateManagedPostgresAuthority(root);
    expectParity(populated, populatedResult);
    for (const dockerConsumers of [
      populatedResult.dockerConsumers.slice(1),
      [...populatedResult.dockerConsumers, dockerConsumer()],
      [dockerConsumer({ pathMapping: "/wrong:/mapping" })],
    ]) {
      expect(() => expectParity(populated, { ...populatedResult, dockerConsumers })).toThrow();
    }
    await writeJson(root, fragmentPath, { grants: [grant()], dockerConsumers: [] });
    expect(await generateManagedPostgresAuthority(root)).not.toHaveProperty("dockerConsumers");
  });

  it("missing authority fragment cannot authorize ingress", async () => {
    const root = await boundaryFixture();
    const added = await addWorkflow(root);
    expect((await runCli(sourceCli, root)).exitCode).toBe(0);
    expect((await runGuard(root)).report.violations).toEqual([]);
    const yamlBefore = await readFile(join(root, added.file), "utf8");
    await rm(join(root, added.source));
    expect((await runCli(sourceCli, root)).exitCode).toBe(0);
    expect((await runCli(sourceCli, root, ["--check"])).exitCode).toBe(0);
    expect(await readFile(join(root, added.file), "utf8")).toBe(yamlBefore);
    expect((await readJson(root, MANIFEST_PATH)).grants).not.toContainEqual(added.record);
    const result = await runGuard(root);
    expect(result.exitCode).toBe(1);
    expect(result.report.ingressCoverage).toBe("3/4");
    expect(result.report.violations).toEqual([
      {
        code: "unmanifested-secret-ingress",
        file: added.file,
        jobId: "probe",
        stepAnchor: "step:1",
      },
    ]);
  });

  it("discovers tracked JSON only and refuses freshness bypass by removing all sources", async () => {
    const root = await boundaryFixture();
    await writeManagedPostgresAuthorityManifest(root);
    const before = await readJson(root, MANIFEST_PATH);
    await write(root, `${AUTHORITY_ROOT}/untracked/job.json`, "{invalid");
    await write(root, `${AUTHORITY_ROOT}/README.md`, "Not authorization data.\n");
    await execFileAsync("git", ["add", "--", `${AUTHORITY_ROOT}/README.md`], { cwd: root });
    expect(await generateManagedPostgresAuthority(root)).toEqual(before);
    expect((await runGuard(root)).exitCode).toBe(0);
    await rm(join(root, AUTHORITY_ROOT), { recursive: true });
    expect(await writeManagedPostgresAuthorityManifest(root, { check: true })).toBe(false);
    const stale = await runGuard(root);
    expect(stale.exitCode).toBe(1);
    expect(stale.report.violations.map(({ code }) => code)).toContain("authority-source-invalid");
    expect(await readJson(root, MANIFEST_PATH)).toEqual(before);
    await writeManagedPostgresAuthorityManifest(root);
    expect(await readJson(root, MANIFEST_PATH)).toEqual({ schemaVersion: 1, grants: [] });
    const empty = await runGuard(root);
    expect(empty.exitCode).toBe(1);
    expect(empty.report.violations.map(({ code }) => code)).toContain("unmanifested-secret-ingress");
  });

  describe("authority source validation and scoped selection fail closed", () => {
    const invalidFragments = [
      ["null source", null, "source shape"],
      ["array source", [], "source shape"],
      ["unknown root key", { grants: [], unexpected: true }, "source shape"],
      ["non-array grants", { grants: {} }, "source shape"],
      ["non-array consumers", { grants: [], dockerConsumers: {} }, "source shape"],
      ...[
        null,
        [],
        "grant",
        { ...grant(), unexpected: true },
        { ...grant(), secretName: "invalid-name" },
        { ...grant(), purpose: "unreviewed" },
      ].map((value, index) => [`malformed grant ${index}`, { grants: [value] }, "authority"]),
      ...Object.keys(grant()).flatMap((key) => [
        [
          `missing grant ${key}`,
          { grants: [Object.fromEntries(Object.entries(grant()).filter(([name]) => name !== key))] },
          "record shape",
        ],
        [`nested grant ${key}`, { grants: [{ ...grant(), [key]: {} }] }, "record shape"],
        [`empty grant ${key}`, { grants: [{ ...grant(), [key]: "" }] }, "record shape"],
      ]),
      ...Object.keys(dockerConsumer()).flatMap((key) => [
        [
          `missing consumer ${key}`,
          {
            grants: [],
            dockerConsumers: [Object.fromEntries(Object.entries(dockerConsumer()).filter(([name]) => name !== key))],
          },
          "record shape",
        ],
        [
          `nested consumer ${key}`,
          { grants: [], dockerConsumers: [{ ...dockerConsumer(), [key]: [] }] },
          "record shape",
        ],
      ]),
      ["null consumer", { grants: [], dockerConsumers: [null] }, "record shape"],
      [
        "unknown consumer key",
        { grants: [], dockerConsumers: [{ ...dockerConsumer(), unexpected: true }] },
        "record shape",
      ],
      ["wrong workflow", { grants: [grant({ file: ".github/workflows/other.yml" })] }, "owner mismatch"],
      ["wrong job", { grants: [grant({ jobId: "other" })] }, "owner mismatch"],
      ["wrong consumer owner", { grants: [], dockerConsumers: [dockerConsumer({ jobId: "other" })] }, "owner mismatch"],
    ];
    it.each(invalidFragments)("rejects %s without writing", async (_label, fragment, message) => {
      const root = await fixture(fragment);
      const before = await snapshot(root);
      const result = await validateManagedPostgresAuthoritySources(root, { checkManifest: false });
      expect(result.valid).toBe(false);
      expect(result.errors.join("; ")).toContain(message);
      await expect(generateManagedPostgresAuthority(root)).rejects.toThrow(/source validation failed/);
      await expect(writeManagedPostgresAuthorityManifest(root)).rejects.toThrow(/source validation failed/);
      expect(await snapshot(root)).toEqual(before);
    });

    it.each([
      ["invalid JSON", async (root) => write(root, fragmentPath, "{broken"), "not valid JSON"],
      [
        "orphaned job",
        async (root) =>
          rename(join(root, fragmentPath), join(root, `${AUTHORITY_ROOT}/platform-production/absent.json`)),
        "job is orphaned",
      ],
      ["orphaned workflow", async (root) => rm(join(root, workflowPath)), "not a workflow"],
      [
        "non-workflow owner",
        async (root) => {
          await rm(join(root, workflowPath));
          await writeJson(root, ".github/actions/platform-production/action.yml", {
            runs: { using: "composite", steps: [] },
          });
        },
        "not a workflow",
      ],
      [
        "owner case mismatch",
        async (root) => {
          const source = join(root, `${AUTHORITY_ROOT}/platform-production`);
          const intermediate = join(root, `${AUTHORITY_ROOT}/platform-production-renamed`);
          await rename(source, intermediate);
          await rename(intermediate, join(root, `${AUTHORITY_ROOT}/Platform-Production`));
        },
        "case mismatch",
      ],
      [
        "ambiguous extension",
        async (root) => copyFile(join(root, workflowPath), join(root, ".github/workflows/platform-production.yaml")),
        "ambiguous workflow basename",
      ],
      [
        "ambiguous nested basename",
        async (root) =>
          write(root, ".github/workflows/nested/platform-production.yml", await readFile(join(root, workflowPath))),
        "ambiguous workflow basename",
      ],
      [
        "ambiguous case",
        async (root) => copyFile(join(root, workflowPath), join(root, ".github/workflows/Platform-Production.yaml")),
        "ambiguous workflow basename casing",
      ],
      [
        "cross-fragment duplicate grants",
        async (root) => {
          await writeJson(root, workflowPath, { jobs: { deploy: {}, other: {} } });
          await writeJson(root, `${AUTHORITY_ROOT}/platform-production/other.json`, { grants: [grant()] });
        },
        "owner mismatch",
      ],
      [
        "cross-fragment duplicate consumers",
        async (root) => {
          await writeJson(root, workflowPath, { jobs: { deploy: {}, other: {} } });
          await writeJson(root, fragmentPath, { grants: [], dockerConsumers: [dockerConsumer()] });
          await writeJson(root, `${AUTHORITY_ROOT}/platform-production/other.json`, {
            grants: [],
            dockerConsumers: [dockerConsumer()],
          });
        },
        "owner mismatch",
      ],
      [
        "nested source path",
        async (root) =>
          writeJson(root, `${AUTHORITY_ROOT}/nested/platform-production/deploy.json`, { grants: [grant()] }),
        "must be <workflow-basename>",
      ],
      [
        "invalid workflow YAML",
        async (root) => write(root, workflowPath, "jobs: [unterminated"),
        "workflow cannot be parsed",
      ],
    ])("rejects %s", async (_label, mutate, message) => {
      const root = await fixture();
      await mutate(root);
      await trackSources(root);
      const result = await validateManagedPostgresAuthoritySources(root, { checkManifest: false });
      expect(result.valid).toBe(false);
      expect(result.errors.join("; ")).toContain(message);
      await expect(generateManagedPostgresAuthority(root)).rejects.toThrow(/source validation failed/);
    });

    it("sorts every tuple field by code unit across shuffled sources and records", async () => {
      const grants = [];
      const dockerConsumers = [];
      for (const owner of ["Z-owner", "a-owner"])
        for (const jobId of ["Z_job", "a_job"])
          for (const stepAnchor of ["Z", "a"]) {
            const file = `.github/workflows/${owner}.yml`;
            for (const secretName of ["Z_SECRET", "a_SECRET"])
              for (const purpose of ["alerting", "application-runtime"])
                grants.push(grant({ file, jobId, stepAnchor, secretName, purpose }));
            for (const pathMapping of ["/Z:/ca", "/a:/ca"])
              dockerConsumers.push(dockerConsumer({ file, jobId, stepAnchor, pathMapping }));
          }
      const results = [];
      for (const reverse of [false, true]) {
        const root = await fixture({ grants: [] });
        const ordered = reverse ? [...grants].reverse() : grants;
        const consumers = reverse ? [...dockerConsumers].reverse() : dockerConsumers;
        const owners = [...new Set(ordered.map(({ file, jobId }) => `${file}\0${jobId}`))];
        for (const owner of owners) {
          const [file, jobId] = owner.split("\0");
          await writeJson(root, file, { jobs: { Z_job: {}, a_job: {} } });
          await writeJson(root, `${AUTHORITY_ROOT}/${basename(file, ".yml")}/${jobId}.json`, {
            grants: ordered.filter((r) => r.file === file && r.jobId === jobId),
            dockerConsumers: consumers.filter((r) => r.file === file && r.jobId === jobId),
          });
        }
        await trackSources(root);
        results.push(await generateManagedPostgresAuthority(root));
      }
      const grantTuples = grants
        .map(({ file, jobId, stepAnchor, secretName, purpose }) =>
          [file, jobId, stepAnchor, secretName, purpose].join("\0"),
        )
        .sort();
      const dockerTuples = dockerConsumers
        .map(({ file, jobId, stepAnchor, pathMapping }) => [file, jobId, stepAnchor, pathMapping].join("\0"))
        .sort();
      expect(results[0].grants.map((r) => [r.file, r.jobId, r.stepAnchor, r.secretName, r.purpose].join("\0"))).toEqual(
        grantTuples,
      );
      expect(results[0].dockerConsumers.map((r) => [r.file, r.jobId, r.stepAnchor, r.pathMapping].join("\0"))).toEqual(
        dockerTuples,
      );
      expect(results[1]).toEqual(results[0]);
    });

    it("authority source validation and scoped selection fail closed", async () => {
      const root = await boundaryFixture();
      expect((await runCli(sourceCli, root)).exitCode).toBe(0);
      expect((await runCli(sourceCli, root, ["--check"])).exitCode).toBe(0);
      expect((await runGuard(root)).exitCode).toBe(0);
      await addWorkflow(root);
      expect((await validateManagedPostgresAuthoritySources(root, { checkManifest: false })).valid).toBe(true);
      const before = await snapshot(root);
      const validation = await validateManagedPostgresAuthoritySources(root);
      expect(validation.errors).toEqual(["canonical manifest is stale; regenerate from authority fragments"]);
      expect(await writeManagedPostgresAuthorityManifest(root, { check: true })).toBe(false);
      expect((await runCli(sourceCli, root, ["--check"])).exitCode).toBe(1);
      const direct = await runGuard(root);
      expect(direct.exitCode).toBe(1);
      expect(direct.report.violations.map(({ code }) => code)).toContain("authority-source-invalid");
      expect(await snapshot(root)).toEqual(before);
      expect((await runCli(sourceCli, root)).exitCode).toBe(0);
      expect((await runCli(sourceCli, root, ["--check"])).exitCode).toBe(0);
      expect((await runGuard(root)).exitCode).toBe(0);
    });

    it.each([
      ["added source", `A\0${fragmentPath}\0`],
      ["edited source", `M\0${fragmentPath}\0`],
      ["deleted source", `D\0${fragmentPath}\0`],
      ["renamed source", `R100\0${fragmentPath}\0${AUTHORITY_ROOT}/new-owner/probe.json\0`],
      ["renamed out of sources", `R100\0${fragmentPath}\0elsewhere/reviewed.json\0`],
      ["arbitrary executable", "M\0unknown-zone/entry.mjs\0"],
    ])("selects generator and independent guard for %s", async (_label, diff) => {
      const pkg = await readJson(repositoryRoot, "package.json");
      const chain = parseVerifyStaticChain(pkg);
      const selected = selectVerifyStaticLinks({
        chain,
        changedFiles: parseNameStatusZ(diff),
        repoRoot: repositoryRoot,
      });
      expect(VERIFY_STATIC_SURFACES["check:managed-postgres-authority"].classification).toBe(ALWAYS_RUN);
      expect(chain.map(({ name }) => name)).toContain("check:managed-postgres-authority");
      expect(selected.selected.map(({ name }) => name)).toContain("check:managed-postgres-authority");
      expect(pkg.scripts["check:managed-postgres-authority"]).toBe(`node ./${guardCli}`);

      const root = await boundaryFixture();
      await writeManagedPostgresAuthorityManifest(root);
      await addWorkflow(root);
      const visited = [];
      const status = await runVerifyStaticScoped({
        repoRoot: repositoryRoot,
        env: { CHANGED_FILES_JSON: JSON.stringify(parseNameStatusZ(diff)) },
        readPackageJson: () => pkg,
        stdout: () => {},
        stderr: () => {},
        runLink: async ({ name }) => {
          visited.push(name);
          // Exercise the selected authority command; unrelated static guards are outside this fixture.
          if (name !== "check:managed-postgres-authority") return 0;
          return (await runCli(guardCli, root)).exitCode;
        },
      });
      expect(visited).toContain("check:managed-postgres-authority");
      expect(status).toBe(1);
    });
  });

  it("new workflow authority uses only its owner fragment", async () => {
    const root = await boundaryFixture();
    expect((await runCli(sourceCli, root)).exitCode).toBe(0);
    const before = await snapshot(root);
    const added = await addWorkflow(root);
    expect((await runCli(sourceCli, root)).exitCode).toBe(0);
    const after = await snapshot(root);
    expect(
      Object.keys(after)
        .filter((path) => !(path in before))
        .sort(),
    ).toEqual([added.file, added.source].sort());
    for (const path of Object.keys(before).filter((path) => path !== MANIFEST_PATH))
      expect(after[path]).toBe(before[path]);
    expectParity(
      { schemaVersion: 1, grants: [...JSON.parse(before[MANIFEST_PATH]).grants, added.record] },
      JSON.parse(after[MANIFEST_PATH]),
    );
    const result = await runGuard(root);
    expect(result.exitCode).toBe(0);
    expect(result.report.violations).toEqual([]);
    expect(result.report.ingressCoverage).toBe("4/4");
    expect(result.report.manifestGrantCount).toBe(4);
  });

  it("rejects the retired manifest writer flag without canonical or source writes", async () => {
    const root = await boundaryFixture();
    await writeManagedPostgresAuthorityManifest(root);
    await addWorkflow(root);
    const before = await snapshot(root);
    const result = await runCli(guardCli, root, ["--generate-manifest"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--generate-manifest has been retired");
    expect(await snapshot(root)).toEqual(before);
    const guardSource = await readFile(join(repositoryRoot, guardCli), "utf8");
    for (const retired of ["writeSuggestedManifest", "suggestedManifestForReport", "suggestedPurpose"])
      expect(guardSource).not.toContain(retired);
  });
});
