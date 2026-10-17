import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  buildPlatformHelmValues,
  buildPlatformHelmStagingValues,
  buildPlatformHelmProductionValues,
} from "./render-platform-helm-values.mjs";
import { buildPlatformHelmLocalBootValues } from "./platform-helm-local-boot.mjs";
import {
  collectPlatformSecretKeys,
  buildPlatformSecretManifest,
  summarizePlatformSecret,
} from "./platform-kubernetes-secret.mjs";

const names = ["EBAY_ACCOUNT_DELETION_ENDPOINT", "EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN"];
const workflows = [
  "platform-pr",
  "platform-merge-gate-verification",
  "platform-ephemeral-verification",
  "platform-production",
];
const read = (path) => readFileSync(path, "utf8");
describe("ebay-account-deletion-config-threading", () => {
  it("threads exactly both secret refs through every keyring-carrying component and environment", () => {
    const runtime = JSON.parse(read("infrastructure/helm/platform/runtime-values.json"));
    const generated = parse(read("infrastructure/helm/platform/values.yaml"));
    const base = buildPlatformHelmValues();
    for (const values of [
      runtime,
      generated,
      base,
      buildPlatformHelmStagingValues(),
      buildPlatformHelmProductionValues(),
    ]) {
      for (const [id, component] of Object.entries(values.components)) {
        const env = component.env ?? base.components[id].env;
        if (!env.some((entry) => entry.name === "CHANNELS_CREDENTIAL_KEYRING_JSON")) continue;
        for (const name of names)
          expect(env.filter((entry) => entry.name === name)).toEqual([{ name, secret: true, secretKey: name }]);
      }
    }
    for (const name of names) {
      expect(read("deployables/platform-api/.env.example").split(/\r?\n/)).toContain(`${name}=`);
      expect(read("deployables/platform-api/src/config.ts")).toContain(`process.env.${name}`);
    }
    expect(read("deployables/platform-api/src/main.ts")).toContain(
      "ebayAccountDeletionConfiguration: config.ebayAccountDeletionConfiguration",
    );
  });
  it("keeps all five authority grants and withheld workflow values closed to the Secret-apply step", () => {
    let sinks = 0;
    for (const workflow of workflows) {
      const parsed = parse(read(`.github/workflows/${workflow}.yml`));
      for (const [jobId, job] of Object.entries(parsed.jobs)) {
        for (const step of job.steps ?? []) {
          if (!Object.hasOwn(step.env ?? {}, "CHANNELS_CREDENTIAL_KEYRING_JSON")) continue;
          sinks++;
          const authority = JSON.parse(read(`.github/authority/${workflow}/${jobId}.json`));
          const keyring = authority.grants.find((grant) => grant.secretName === "CHANNELS_CREDENTIAL_KEYRING_JSON");
          for (const name of names) {
            expect(step.env[name]).toBe(`\${{ secrets.${name} || '' }}`);
            expect(step.run).not.toContain(name);
            expect(job.env ?? {}).not.toHaveProperty(name);
            expect(authority.grants.filter((grant) => grant.secretName === name)).toEqual([
              { ...keyring, secretName: name },
            ]);
          }
        }
      }
    }
    expect(sinks).toBe(5);
  });
  it.each(names)("withholds %s without leaking values or preventing Secret construction", (name) => {
    const values = buildPlatformHelmValues();
    const keys = collectPlatformSecretKeys(values);
    expect(keys).toEqual(expect.arrayContaining(names));
    const env = Object.fromEntries(keys.map((key) => [key, ""]));
    env[name] = "synthetic-private-marker";
    expect(Buffer.from(buildPlatformSecretManifest({ values, env }).data[name], "base64").toString()).toBe(env[name]);
    expect(JSON.stringify(summarizePlatformSecret({ values }))).not.toContain(env[name]);
    env[name] = "";
    expect(buildPlatformSecretManifest({ values, env }).data[name]).toBe("");
    const local = buildPlatformHelmLocalBootValues({ values });
    for (const id of ["platform-api", "platform-worker"]) {
      expect(local.components[id].env.find((entry) => entry.name === name)).toEqual({ name, value: "" });
    }
  });
});
