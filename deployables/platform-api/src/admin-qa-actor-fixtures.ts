#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createFilesystemObjectStorage, createS3ObjectStorage, type ObjectStorage } from "@chase-sets/object-storage";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import {
  ADMIN_QA_ACTOR_FIXTURES,
  provisionAdminQaActorFixtures,
  type AdminQaActorFixtureResult,
} from "@chase-sets/identity/server";
import { apiContextRegistry } from "./generated/api-context-registry";
import { createPlatformApiHost } from "./app";
import {
  loadConfig,
  type PlatformApiCatalogAssetStorageConfig,
  type PlatformApiListingPhotoStorageConfig,
} from "./config";
import { closePlatformApiPools, createPlatformApiPools } from "./database-pools";
import { createFakeMoneyMovementGateway, createFakePaymentProcessorGateway } from "./test-support/provider-gateways";

const CONFIRMATION_PHRASE = "provision admin qa fixtures";
const ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_VERSION = "admin-qa-actor-fixtures.evidence/v1";
const BASELINE_DATA_PROFILES = ["critical-bootstrap", "catalog-integration-bootstrap"] as const;

export type AdminQaActorFixturesEvidence = Readonly<{
  schemaVersion: typeof ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_VERSION;
  type: "admin-qa-actor-fixtures.complete";
  checkedAt: string;
  environmentName: string | null;
  fixtures: readonly AdminQaActorFixtureResult[];
  requiredActorMatrixSize: number;
  provisionedActorMatrixSize: number;
  partialPermissionActorRowsNote: string;
}>;

export function assertAdminQaActorFixturesRunAllowed(
  input: Readonly<{
    deploymentEnvironment: string | null | undefined;
    confirmation: string | null | undefined;
    localOverride?: string | null | undefined;
    ephemeralVerificationNamespace?: string | null | undefined;
  }>,
): void {
  if (input.deploymentEnvironment === "production") {
    throw new Error("admin-qa-actor-fixtures cannot run when DEPLOYMENT_ENVIRONMENT=production.");
  }
  if (input.confirmation !== CONFIRMATION_PHRASE) {
    throw new Error(
      `ADMIN_QA_ACTOR_FIXTURES_CONFIRM must exactly equal '${CONFIRMATION_PHRASE}' before admin-qa actor fixtures can be provisioned.`,
    );
  }

  const environmentName = input.deploymentEnvironment ?? "dev";
  if (environmentName === "staging" || environmentName === "test" || environmentName === "dev") {
    return;
  }
  if (input.localOverride === "true") {
    return;
  }
  // Disposable verification namespaces on the staging DOKS cluster: the
  // post-production ephemeral verifier and the merge-gate verifier. Canonical
  // namespace shapes live in scripts/ephemeral-verification-namespace.mjs.
  if (
    environmentName === "preview" &&
    /^chase-sets-(?:verify|gate)-\d+-\d+$/u.test(input.ephemeralVerificationNamespace ?? "")
  ) {
    return;
  }

  throw new Error(
    "admin-qa-actor-fixtures requires staging, test/dev, an identified ephemeral verification namespace, or ADMIN_QA_ACTOR_FIXTURES_ALLOW_LOCAL=true.",
  );
}

export async function runAdminQaActorFixtures(): Promise<void> {
  const config = loadConfig();
  assertAdminQaActorFixturesRunAllowed({
    deploymentEnvironment: config.deploymentEnvironment,
    confirmation: process.env.ADMIN_QA_ACTOR_FIXTURES_CONFIRM,
    localOverride: process.env.ADMIN_QA_ACTOR_FIXTURES_ALLOW_LOCAL,
    ephemeralVerificationNamespace: process.env.EPHEMERAL_VERIFICATION_NAMESPACE,
  });

  const pools = createPlatformApiPools(config);
  try {
    await bootstrapPlatformControlPlane(pools.control);
    const paymentProcessorGateway = createFakePaymentProcessorGateway();
    const runtime = createPlatformApiHost({
      pools,
      runtimeProfile: config.runtimeProfile,
      hostPorts: {
        processorGateway: paymentProcessorGateway,
        paymentProcessorPublicConfiguration: paymentProcessorGateway.getPublicConfiguration(),
        moneyMovementGateway: createFakeMoneyMovementGateway(),
        catalogAssetStorage: createObjectStorage(config.catalogAssetStorage),
        listingPhotoStorage: createObjectStorage(config.listingPhotoStorage),
      },
    });

    await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, {
      enabledDataProfiles: [...BASELINE_DATA_PROFILES],
      environmentName: config.deploymentEnvironment ?? null,
      runtimeProfile: config.runtimeProfile,
    });

    const identityServices = getIdentityServices(runtime.services);
    const fixtures = await provisionAdminQaActorFixtures(identityServices);

    const evidence: AdminQaActorFixturesEvidence = {
      schemaVersion: ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_VERSION,
      type: "admin-qa-actor-fixtures.complete",
      checkedAt: new Date().toISOString(),
      environmentName: config.deploymentEnvironment ?? null,
      fixtures,
      requiredActorMatrixSize: ADMIN_QA_ACTOR_FIXTURES.length,
      provisionedActorMatrixSize: fixtures.length,
      partialPermissionActorRowsNote:
        "The 4 single-permission actor matrix rows (security.manage, memberships.view, postage-policies.view, " +
        "public-presence.view) are not provisioned as separate staging identities: Identity grants whole roles, " +
        "not scoped single-permission memberships. Those rows stay local-only regression guardrails per " +
        "docs/runbooks/admin-shell-smoke-matrix.md until a scoped permission grant primitive exists. Customer " +
        "feedback submission is session-subject capability customer-submit; staff feedback view/manage/export is " +
        "available only to the platform-admin fixture.",
    };

    console.log(JSON.stringify(evidence));
    await writeAdminQaActorFixturesEvidence(process.env.ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_OUT, evidence);
  } finally {
    await closePlatformApiPools(pools);
  }
}

export async function writeAdminQaActorFixturesEvidence(
  outPath: string | null | undefined,
  evidence: AdminQaActorFixturesEvidence,
): Promise<void> {
  const normalizedOutPath = outPath?.trim();
  if (!normalizedOutPath) {
    return;
  }

  assertAdminQaActorFixturesEvidenceIsSupportSafe(evidence);
  await mkdir(dirname(normalizedOutPath), { recursive: true });
  await writeFile(normalizedOutPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

const ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_ACCOUNT_PATTERN = /\bacc_admin_qa_[A-Za-z0-9_-]+\b/g;
const ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_USER_PATTERN = /\busr_admin_qa_[A-Za-z0-9_-]+\b/g;
const ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_MEMBERSHIP_PATTERN = /\bmbr_admin_qa_[A-Za-z0-9_-]+\b/g;

export function assertAdminQaActorFixturesEvidenceIsSupportSafe(evidence: AdminQaActorFixturesEvidence): void {
  const serialized = JSON.stringify(evidence);
  const leaks = [
    ...matchLeakNames(serialized, ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_ACCOUNT_PATTERN, "account-id"),
    ...matchLeakNames(serialized, ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_USER_PATTERN, "user-id"),
    ...matchLeakNames(serialized, ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_MEMBERSHIP_PATTERN, "membership-id"),
    ...matchLeakNames(serialized, ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_EMAIL_PATTERN, "email"),
  ];
  if (leaks.length > 0) {
    throw new Error(`Admin QA actor fixtures evidence leaked private values: ${leaks.join(", ")}`);
  }
}

function matchLeakNames(serialized: string, pattern: RegExp, name: string): string[] {
  pattern.lastIndex = 0;
  return pattern.test(serialized) ? [name] : [];
}

function createObjectStorage(
  config: PlatformApiCatalogAssetStorageConfig | PlatformApiListingPhotoStorageConfig,
): ObjectStorage {
  return config.kind === "s3" ? createS3ObjectStorage(config) : createFilesystemObjectStorage(config);
}

function getIdentityServices(
  services: Readonly<Record<string, unknown>>,
): Parameters<typeof provisionAdminQaActorFixtures>[0] {
  const identity = services.identity;
  if (
    !identity ||
    typeof identity !== "object" ||
    !("db" in identity) ||
    !("accounts" in identity) ||
    !("users" in identity) ||
    !("memberships" in identity) ||
    !("consents" in identity)
  ) {
    throw new Error("Admin QA actor fixtures require mounted Identity services.");
  }

  return identity as Parameters<typeof provisionAdminQaActorFixtures>[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runAdminQaActorFixtures().catch((error) => {
    console.error("Admin QA actor fixtures provisioning failed.", error);
    process.exit(1);
  });
}
