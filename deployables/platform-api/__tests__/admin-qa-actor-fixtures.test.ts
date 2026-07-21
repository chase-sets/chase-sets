import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAdminQaActorFixturesRunAllowed,
  assertAdminQaActorFixturesEvidenceIsSupportSafe,
  writeAdminQaActorFixturesEvidence,
  type AdminQaActorFixturesEvidence,
} from "../src/admin-qa-actor-fixtures";

describe("admin-qa actor fixtures run guardrails", () => {
  it("allows confirmed staging runs", () => {
    expect(() =>
      assertAdminQaActorFixturesRunAllowed({
        deploymentEnvironment: "staging",
        confirmation: "provision admin qa fixtures",
      }),
    ).not.toThrow();
  });

  it("rejects production runs even when confirmed", () => {
    expect(() =>
      assertAdminQaActorFixturesRunAllowed({
        deploymentEnvironment: "production",
        confirmation: "provision admin qa fixtures",
      }),
    ).toThrow("admin-qa-actor-fixtures cannot run when DEPLOYMENT_ENVIRONMENT=production.");
  });

  it("requires an explicit confirmation phrase", () => {
    expect(() =>
      assertAdminQaActorFixturesRunAllowed({
        deploymentEnvironment: "staging",
        confirmation: "yes",
      }),
    ).toThrow("ADMIN_QA_ACTOR_FIXTURES_CONFIRM must exactly equal 'provision admin qa fixtures'");
  });

  it("requires a local override outside dev, test, or staging", () => {
    expect(() =>
      assertAdminQaActorFixturesRunAllowed({
        deploymentEnvironment: "remote-dev",
        confirmation: "provision admin qa fixtures",
      }),
    ).toThrow("admin-qa-actor-fixtures requires staging, test/dev, an identified ephemeral verification namespace");

    expect(() =>
      assertAdminQaActorFixturesRunAllowed({
        deploymentEnvironment: "remote-dev",
        confirmation: "provision admin qa fixtures",
        localOverride: "true",
      }),
    ).not.toThrow();
  });

  it("allows only strictly identified ephemeral verification previews", () => {
    expect(() =>
      assertAdminQaActorFixturesRunAllowed({
        deploymentEnvironment: "preview",
        confirmation: "provision admin qa fixtures",
        ephemeralVerificationNamespace: "chase-sets-verify-12345-1",
      }),
    ).not.toThrow();
    // Merge-gate verification namespaces (#5838) share the disposable
    // in-cluster contract and are equally allowed.
    expect(() =>
      assertAdminQaActorFixturesRunAllowed({
        deploymentEnvironment: "preview",
        confirmation: "provision admin qa fixtures",
        ephemeralVerificationNamespace: "chase-sets-gate-12345-1",
      }),
    ).not.toThrow();
    for (const namespace of ["chase-sets-pr-4056", "chase-sets-gate-abc-1", "chase-sets-gate-1-1-fixture"]) {
      expect(() =>
        assertAdminQaActorFixturesRunAllowed({
          deploymentEnvironment: "preview",
          confirmation: "provision admin qa fixtures",
          ephemeralVerificationNamespace: namespace,
        }),
      ).toThrow("identified ephemeral verification namespace");
    }
  });
});

describe("admin-qa actor fixtures evidence artifact", () => {
  it("writes the support-safe evidence payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "admin-qa-actor-fixtures-"));
    const outPath = join(dir, "admin-qa-actor-fixtures-evidence.json");
    try {
      await writeAdminQaActorFixturesEvidence(outPath, supportSafeEvidence());

      const evidence = JSON.parse(await readFile(outPath, "utf8"));
      expect(evidence).toMatchObject({
        schemaVersion: "admin-qa-actor-fixtures.evidence/v1",
        type: "admin-qa-actor-fixtures.complete",
        requiredActorMatrixSize: 6,
        provisionedActorMatrixSize: 6,
      });
      expect(evidence.fixtures).toHaveLength(6);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects private identifiers before writing evidence", () => {
    expect(() =>
      assertAdminQaActorFixturesEvidenceIsSupportSafe({
        ...supportSafeEvidence(),
        fixtures: [
          {
            actorAlias: "admin-qa-owner",
            roleKey: "owner",
            signInHost: "/access/sign-in",
            createdAccount: true,
            createdUser: true,
            createdMembership: true,
            createdConsent: true,
            // @ts-expect-error intentionally injecting a leak for the test
            leakedAccountId: "acc_admin_qa_owner",
          },
        ],
      }),
    ).toThrow("Admin QA actor fixtures evidence leaked private values: account-id");
  });

  it("rejects emails before writing evidence", () => {
    expect(() =>
      assertAdminQaActorFixturesEvidenceIsSupportSafe({
        ...supportSafeEvidence(),
        environmentName: "admin-qa-owner@chasesets.test",
      }),
    ).toThrow("Admin QA actor fixtures evidence leaked private values: email");
  });
});

function supportSafeEvidence(): AdminQaActorFixturesEvidence {
  return {
    schemaVersion: "admin-qa-actor-fixtures.evidence/v1",
    type: "admin-qa-actor-fixtures.complete",
    checkedAt: "2026-07-13T00:00:00.000Z",
    environmentName: "staging",
    fixtures: [
      {
        actorAlias: "admin-qa-platform-admin",
        roleKey: "platform-admin",
        signInHost: "/access/sign-in",
        capabilities: ["customer-submit", "staff-view", "staff-manage", "staff-export"],
        createdAccount: false,
        createdUser: false,
        createdMembership: false,
        createdConsent: false,
      },
      {
        actorAlias: "admin-qa-owner",
        roleKey: "owner",
        signInHost: "/access/sign-in",
        capabilities: ["customer-submit"],
        createdAccount: false,
        createdUser: false,
        createdMembership: false,
        createdConsent: false,
      },
      {
        actorAlias: "admin-qa-manager",
        roleKey: "manager",
        signInHost: "/access/sign-in",
        capabilities: ["customer-submit"],
        createdAccount: false,
        createdUser: false,
        createdMembership: false,
        createdConsent: false,
      },
      {
        actorAlias: "admin-qa-fulfillment",
        roleKey: "fulfillment",
        signInHost: "/access/sign-in",
        capabilities: ["customer-submit"],
        createdAccount: false,
        createdUser: false,
        createdMembership: false,
        createdConsent: false,
      },
      {
        actorAlias: "admin-qa-viewer",
        roleKey: "viewer",
        signInHost: "/access/sign-in",
        capabilities: ["customer-submit"],
        createdAccount: false,
        createdUser: false,
        createdMembership: false,
        createdConsent: false,
      },
      {
        actorAlias: "admin-qa-catalog-admin",
        roleKey: "manager",
        signInHost: "/catalog/sign-in",
        capabilities: ["customer-submit"],
        createdAccount: false,
        createdUser: false,
        createdMembership: false,
        createdConsent: false,
      },
    ],
    requiredActorMatrixSize: 6,
    provisionedActorMatrixSize: 6,
    partialPermissionActorRowsNote: "note",
  };
}
