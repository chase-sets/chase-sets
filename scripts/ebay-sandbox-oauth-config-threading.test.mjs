import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  buildPlatformHelmValues,
  buildPlatformHelmStagingValues,
  buildPlatformHelmProductionValues,
} from "./render-platform-helm-values.mjs";
import {
  buildPlatformSecretManifest,
  collectPlatformSecretKeys,
  summarizePlatformSecret,
} from "./platform-kubernetes-secret.mjs";
const read = (path) => readFileSync(path, "utf8");
const mapping = {
  EBAY_APPLICATION_CLIENT_ID: "EBAY_SANDBOX_APP_ID",
  EBAY_APPLICATION_CLIENT_SECRET: "EBAY_SANDBOX_CERT_ID",
  EBAY_OAUTH_RUNAME: "EBAY_SANDBOX_RUNAME",
};
describe("ebay-sandbox-oauth-config-threading", () => {
  it("maps existing Sandbox secrets into platform-api only, preserving other application authority", () => {
    const base = buildPlatformHelmValues();
    const staging = buildPlatformHelmStagingValues();
    for (const [id, component] of Object.entries(staging.components)) {
      const env = component.env ?? base.components[id].env;
      for (const [name, secretKey] of Object.entries(mapping)) {
        expect(env.filter((entry) => entry.secretKey === secretKey)).toEqual(
          id === "platform-api" ? [{ name, secret: true, secretKey }] : [],
        );
      }
    }
    for (const values of [base, buildPlatformHelmProductionValues()])
      for (const component of Object.values(values.components)) {
        const env = component.env ?? [];
        expect(env.some((entry) => Object.values(mapping).includes(entry.secretKey))).toBe(false);
        expect(env.some((entry) => entry.name === "EBAY_OAUTH_RUNAME")).toBe(false);
      }
    expect(read("deployables/platform-api/src/main.ts")).toContain(
      "ebayOAuthConfiguration: config.ebayOAuthConfiguration",
    );
    for (const name of Object.keys(mapping)) {
      expect(read("deployables/platform-api/src/config.ts")).toContain(`process.env.${name}`);
      expect(read("deployables/platform-api/.env.example").split(/\r?\n/)).toContain(`${name}=`);
    }
  });
  it("uses only the existing staging secrets in the owning secret-apply step", () => {
    const workflow = parse(read(".github/workflows/platform-production.yml"));
    const authority = JSON.parse(read(".github/authority/platform-production/deploy-staging.json"));
    const step = workflow.jobs["deploy-staging"].steps.find(
      (step) => step.name === "Apply staging Kubernetes runtime secrets",
    );
    for (const secretName of Object.values(mapping)) {
      expect(step.env[secretName]).toBe(`\${{ secrets.${secretName} || '' }}`);
      expect(
        authority.grants.some(
          (grant) =>
            grant.secretName === secretName && grant.stepAnchor === "name:Apply staging Kubernetes runtime secrets#35",
        ),
      ).toBe(true);
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        expect(job.env ?? {}).not.toHaveProperty(secretName);
        for (const other of job.steps ?? [])
          if (jobId !== "deploy-staging" || other.name !== step.name)
            expect(other.env ?? {}).not.toHaveProperty(secretName);
      }
    }
  });
  it("withholds each mapped value without diagnostics exposing the sentinel", () => {
    const values = buildPlatformHelmValues({ deploymentEnvironment: "staging" }),
      names = collectPlatformSecretKeys(values);
    for (const name of Object.values(mapping)) {
      const env = Object.fromEntries(names.map((key) => [key, ""]));
      env[name] = "synthetic-private-sentinel";
      expect(Buffer.from(buildPlatformSecretManifest({ values, env }).data[name], "base64").toString()).toBe(env[name]);
      expect(JSON.stringify(summarizePlatformSecret({ values }))).not.toContain(env[name]);
      env[name] = "";
      expect(buildPlatformSecretManifest({ values, env }).data[name]).toBe("");
    }
  });
});
