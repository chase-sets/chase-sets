import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { loadStripeProviderConfig } from "../infrastructure/platform-runtime/config-schema.ts";
import { createStripePaymentProcessorGateway } from "../infrastructure/stripe-payments/index.ts";
import registry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };
import {
  applyPlatformSecretManifest,
  applyManagedPostgresCaSecret,
  buildManagedPostgresCaSecretManifest,
  buildManagedPostgresDatabaseEnv,
  buildNamespaceManifest,
  buildPlatformSecretBundle,
  buildPlatformSecretManifest,
  collectPlatformSecretKeys,
  deriveOtlpWriteToken,
  managedPostgresPodCaPath,
  summarizePlatformSecret,
} from "./platform-kubernetes-secret.mjs";
import {
  buildPlatformHelmValues,
  isDatabaseSecretKey,
  platformHelmPreviewPostgresName,
} from "./render-platform-helm-values.mjs";
import {
  admitPostgresClientConnection,
  managedPostgresPodCaPath as runtimePodCaPath,
  previewPostgresHostEnvName,
} from "../infrastructure/event-core-postgres/pool.ts";

const stagingPodEnv = { DEPLOYMENT_ENVIRONMENT: "staging", KUBERNETES_SERVICE_HOST: "10.245.0.1" };
const runnerEnvForPodUrls = { GITHUB_ACTIONS: "true", RUNNER_TEMP: "/home/runner/work/_temp" };

const sampleValues = {
  global: {
    existingSecretName: "chase-sets-platform-runtime",
  },
  components: {
    api: {
      env: [
        { name: "NODE_ENV", value: "production" },
        { name: "DATABASE_URL_CHECKOUT", secret: true, secretKey: "DATABASE_URL_CHECKOUT" },
      ],
    },
    worker: {
      env: [
        { name: "DATABASE_URL_CHECKOUT", secret: true, secretKey: "DATABASE_URL_CHECKOUT" },
        { name: "STRIPE_SECRET_KEY", secret: true, secretKey: "STRIPE_SECRET_KEY" },
      ],
    },
  },
};

const previewProviderSecretNames = [
  "SCRYDEX_API_KEY",
  "SCRYDEX_TEAM_ID",
  "SES_AWS_ACCESS_KEY_ID",
  "SES_AWS_SECRET_ACCESS_KEY",
  "SES_SOURCE_ARN",
];

const previewProviderValues = {
  global: { existingSecretName: "chase-sets-platform-runtime" },
  components: {
    api: {
      env: previewProviderSecretNames.map((name) => ({ name, secret: true, secretKey: name })),
    },
  },
};

describe("platform Kubernetes secret", () => {
  it("threads only the Secret-apply steps; chart identity does not gate keyring reconciliation", () => {
    let sinks = 0;
    for (const name of [
      "platform-pr",
      "platform-merge-gate-verification",
      "platform-ephemeral-verification",
      "platform-production",
    ]) {
      const workflow = parseYaml(readFileSync(`.github/workflows/${name}.yml`, "utf8"));
      for (const job of Object.values(workflow.jobs))
        for (const step of job.steps ?? []) {
          if (!/^Apply .*Kubernetes runtime secrets$/.test(step.name ?? "")) continue;
          sinks++;
          for (const secretName of ["CHANNELS_CREDENTIAL_KEYRING_JSON"]) {
            expect(step.env[secretName]).toBe(`\${{ secrets.${secretName} || '' }}`);
            expect(step.run).not.toContain(secretName);
            expect(job.env ?? {}).not.toHaveProperty(secretName);
          }
          expect(step.if ?? "").not.toMatch(/chart|helm|changed|fingerprint/i);
          expect(step.run).toMatch(/platform-kubernetes-secret/);
        }
    }
    expect(sinks).toBe(5);
    const reset = parseYaml(readFileSync(".github/workflows/platform-staging-reset.yml", "utf8"));
    const runs = Object.values(reset.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");
    expect(runs).toContain("gh workflow run platform-production.yml");
    expect(runs).not.toContain("CHANNELS_CREDENTIAL_KEYRING_JSON");
    expect(readFileSync(".github/workflows/platform-staging-reset.yml", "utf8")).not.toContain(
      "CATALOG_OPERATOR_SESSION_KEYRING_JSON",
    );
  });
  it("reconciles a rotated keyring on the same values through stdin only", async () => {
    const values = buildPlatformHelmValues();
    const env = Object.fromEntries(collectPlatformSecretKeys(values).map((key) => [key, ""]));
    const calls = [],
      inputs = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          inputs.push(chunk.toString());
          callback();
        },
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    };
    for (const marker of ["synthetic-old-keyring", "synthetic-new-keyring"]) {
      await applyPlatformSecretManifest({
        values,
        env: { ...env, CHANNELS_CREDENTIAL_KEYRING_JSON: marker },
        spawn,
        kubectlPath: "synthetic-kubectl",
      });
    }
    expect(calls).toHaveLength(2);
    expect(
      inputs.map((input) => Buffer.from(JSON.parse(input).data.CHANNELS_CREDENTIAL_KEYRING_JSON, "base64").toString()),
    ).toEqual(["synthetic-old-keyring", "synthetic-new-keyring"]);
    expect(JSON.stringify(calls)).not.toMatch(/synthetic-(old|new)-keyring/);
  });
  it.each(["CHANNELS_CREDENTIAL_KEYRING_JSON"])("includes optional %s without its value in a summary", (secretName) => {
    const values = buildPlatformHelmValues();
    expect(collectPlatformSecretKeys(values)).toEqual(expect.arrayContaining(["CHANNELS_CREDENTIAL_KEYRING_JSON"]));
    const env = Object.fromEntries(collectPlatformSecretKeys(values).map((key) => [key, "synthetic-value"]));
    env[secretName] = "synthetic-custody-marker";
    const manifest = buildPlatformSecretManifest({ values, env, namespace: "synthetic" });
    expect(Buffer.from(manifest.data[secretName], "base64").toString()).toBe("synthetic-custody-marker");
    expect(JSON.stringify(summarizePlatformSecret({ values, namespace: "synthetic" }))).not.toContain(
      "synthetic-custody-marker",
    );
    env[secretName] = "";
    expect(buildPlatformSecretManifest({ values, env, namespace: "synthetic" }).data[secretName]).toBe("");
  });
  it("collects unique secret keys from Helm values", () => {
    expect(collectPlatformSecretKeys(sampleValues)).toEqual(["DATABASE_URL_CHECKOUT", "STRIPE_SECRET_KEY"]);
  });

  describe("production Payments webhook overlap key", () => {
    const key = "STRIPE_WEBHOOK_SECRET_PREVIOUS";
    const current = "whsec_synthetic_current";
    const previous = "whsec_synthetic_previous";

    it("admits just the production Secret-apply step and renders an optional API Secret reference", () => {
      const workflow = parseYaml(readFileSync(".github/workflows/platform-production.yml", "utf8"));
      expect(workflow.jobs["deploy-production"].environment).toBe("production");
      const uses = Object.entries(workflow.jobs).flatMap(([id, job]) => [
        ...(Object.hasOwn(job.env ?? {}, key) ? [[id, "job"]] : []),
        ...(job.steps ?? []).filter((step) => Object.hasOwn(step.env ?? {}, key)).map((step) => [id, step.name]),
      ]);
      expect(uses).toEqual([["deploy-production", "Apply production Kubernetes runtime secrets"]]);
      const step = workflow.jobs["deploy-production"].steps.find((candidate) =>
        Object.hasOwn(candidate.env ?? {}, key),
      );
      expect(step.env[key]).toBe(`\${{ secrets.${key} }}`);
      expect(step.run).toContain("--deployment-environment production");
      const authority = JSON.parse(
        readFileSync(".github/authority/platform-production/deploy-production.json", "utf8"),
      );
      expect(authority.grants.filter((grant) => grant.secretName === key)).toEqual([
        {
          file: ".github/workflows/platform-production.yml",
          jobId: "deploy-production",
          stepAnchor: "name:Apply production Kubernetes runtime secrets#36",
          secretName: key,
          purpose: "application-runtime",
        },
      ]);
      const values = parseYaml(readFileSync("infrastructure/helm/platform/values.yaml", "utf8"));
      const api = values.components["platform-api"].env;
      expect(api.filter((entry) => entry.name === "STRIPE_WEBHOOK_SECRET" || entry.name === key)).toEqual([
        { name: "STRIPE_WEBHOOK_SECRET", secret: true, secretKey: "STRIPE_WEBHOOK_SECRET" },
        { name: key, secret: true, secretKey: key, optional: true },
      ]);
      expect(values.components["platform-worker"].env.some((entry) => entry.name === key)).toBe(false);
    });

    it.each([undefined, "", previous])(
      "installs and verifies only the configured Payments keys (%s)",
      async (overlap) => {
        const values = buildPlatformHelmValues({ deploymentEnvironment: "production" });
        const options = { values, deploymentEnvironment: "production", observabilityEnabled: false };
        const env = Object.fromEntries(
          collectPlatformSecretKeys(values, { ...options, env: {} }).map((name) => [name, ""]),
        );
        Object.assign(env, {
          STRIPE_SECRET_KEY: "sk_live_synthetic_server",
          STRIPE_PUBLISHABLE_KEY: "pk_live_synthetic_public",
          STRIPE_WEBHOOK_SECRET: current,
          STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_synthetic_connect",
          ...(overlap !== undefined ? { [key]: overlap } : {}),
        });
        const manifest = buildPlatformSecretManifest({ ...options, env });
        expect(manifest.kind).toBe("Secret");
        expect(Object.hasOwn(manifest.data, key)).toBe(Boolean(overlap));
        expect(collectPlatformSecretKeys(values, { deploymentEnvironment: "staging", env })).not.toContain(key);
        try {
          for (const name of [
            "STRIPE_SECRET_KEY",
            "STRIPE_PUBLISHABLE_KEY",
            "STRIPE_WEBHOOK_SECRET",
            "STRIPE_CONNECT_WEBHOOK_SECRET",
            key,
            "STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS",
            "STRIPE_API_BASE_URL",
            "STRIPE_CONNECT_ACCOUNTS_API",
          ]) {
            // Model the API container's Secret-backed env; Kubernetes omits missing optional keys.
            const ref = values.components["platform-api"].env.find((entry) => entry.name === name && entry.secret);
            const value = ref && manifest.data[ref.secretKey];
            vi.stubEnv(name, value ? Buffer.from(value, "base64").toString("utf8") : undefined);
          }
          const config = loadStripeProviderConfig({
            productionLike: true,
            deploymentEnvironment: "production",
            productionMissingConfigError:
              "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_CONNECT_WEBHOOK_SECRET are required for Stripe payment processing and Connect money movement in production.",
          });
          expect(config.paymentProcessor.previousWebhookSecrets).toEqual(overlap ? [previous] : []);
          expect(config.moneyMovement.previousWebhookSecrets).toEqual([]);
          const gateway = createStripePaymentProcessorGateway(config.paymentProcessor);
          const timestamp = Math.floor(Date.now() / 1000);
          const rawBody = JSON.stringify({
            id: "evt_synthetic_overlap",
            type: "payment_intent.canceled",
            api_version: registry.apiVersion,
            livemode: true,
            created: timestamp,
            data: {
              object: { id: "pi_synthetic_overlap", status: "canceled", metadata: { payment_id: "pay_synthetic" } },
            },
          });
          const signedWith = (secret) => {
            const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
            return gateway.parseWebhook({ rawBody, signatureHeader: `t=${timestamp},v1=${digest}` });
          };
          await expect(signedWith(current)).resolves.toMatchObject({ eventId: "evt_synthetic_overlap" });
          if (overlap) await expect(signedWith(previous)).resolves.toMatchObject({ eventId: "evt_synthetic_overlap" });
          else await expect(signedWith(previous)).rejects.toThrow("Stripe webhook signature verification failed");
          await expect(signedWith("whsec_synthetic_unrelated")).rejects.toThrow(
            "Stripe webhook signature verification failed",
          );
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );
  });

  describe("optional evidence-window admission key", () => {
    const windowKey = "EVIDENCE_WINDOW_ADMISSION_SECRET";
    const optionalEntry = { name: windowKey, secret: true, secretKey: windowKey, optional: true };
    const valuesWithWindowKey = {
      ...sampleValues,
      components: {
        api: { env: [...sampleValues.components.api.env, optionalEntry] },
        worker: { env: [...sampleValues.components.worker.env, optionalEntry] },
      },
    };
    const deployEnv = { DATABASE_URL_CHECKOUT: "postgres-url-marker", STRIPE_SECRET_KEY: "stripe-key-marker" };

    it("neither collects, supplies nor preserves the window key while unrelated secrets stay collected", () => {
      expect(collectPlatformSecretKeys(valuesWithWindowKey)).toEqual(["DATABASE_URL_CHECKOUT", "STRIPE_SECRET_KEY"]);
      const manifest = buildPlatformSecretManifest({
        values: valuesWithWindowKey,
        env: { ...deployEnv, [windowKey]: "window-secret-marker" },
      });
      expect(Object.keys(manifest.data).sort()).toEqual(["DATABASE_URL_CHECKOUT", "STRIPE_SECRET_KEY"]);
      expect(JSON.stringify(manifest)).not.toContain(Buffer.from("window-secret-marker").toString("base64"));
      expect(summarizePlatformSecret({ values: valuesWithWindowKey, env: deployEnv }).keys).not.toContain(windowKey);
    });

    it("keeps every unflagged secret required", () => {
      expect(() =>
        buildPlatformSecretManifest({ values: valuesWithWindowKey, env: { [windowKey]: "window-secret-marker" } }),
      ).toThrow("Missing Kubernetes secret environment value(s): DATABASE_URL_CHECKOUT, STRIPE_SECRET_KEY.");
    });

    it("flags the canonical api and worker entries optional and excludes them from the deploy inventory", () => {
      const values = buildPlatformHelmValues();
      for (const name of ["platform-api", "platform-worker"]) {
        expect(values.components[name].env.filter((entry) => entry.name === windowKey)).toEqual([optionalEntry]);
      }
      const optionalNames = Object.values(values.components).flatMap((component) =>
        component.env.filter((entry) => entry.optional !== undefined).map((entry) => entry.name),
      );
      expect(optionalNames).toEqual([windowKey, "STRIPE_WEBHOOK_SECRET_PREVIOUS", windowKey]);
      expect(collectPlatformSecretKeys(values)).not.toContain(windowKey);
    });
  });

  it("preserves the canonical 54-key managed database URL inventory", () => {
    const urlKeys = collectPlatformSecretKeys(buildPlatformHelmValues()).filter(isDatabaseSecretKey);
    expect(urlKeys).toHaveLength(54);
    expect(new Set(urlKeys).size).toBe(54);
  });

  it("derives the collector token without changing the application OTLP header contract", () => {
    expect(deriveOtlpWriteToken("X-Other=value,X-Chase-Sets-Observability-Token=shared-write-token")).toBe(
      "shared-write-token",
    );
    expect(() => deriveOtlpWriteToken("X-Other=value")).toThrow("X-Chase-Sets-Observability-Token");
  });

  it("adds a derived collector token only for long-lived Kubernetes environments", () => {
    const values = {
      ...sampleValues,
      observability: { exporter: { secretKey: "CHASE_SETS_OTLP_TOKEN" } },
    };
    expect(collectPlatformSecretKeys(values, { deploymentEnvironment: "preview" })).not.toContain(
      "CHASE_SETS_OTLP_TOKEN",
    );
    expect(collectPlatformSecretKeys(values, { deploymentEnvironment: "staging" })).toContain("CHASE_SETS_OTLP_TOKEN");
    expect(
      collectPlatformSecretKeys(values, { deploymentEnvironment: "staging", observabilityEnabled: "false" }),
    ).not.toContain("CHASE_SETS_OTLP_TOKEN");

    const manifest = buildPlatformSecretManifest({
      values,
      deploymentEnvironment: "staging",
      env: {
        DATABASE_URL_CHECKOUT: "postgres://checkout-secret",
        STRIPE_SECRET_KEY: "sk_test_secret",
        OTEL_EXPORTER_OTLP_HEADERS: "X-Chase-Sets-Observability-Token=shared-write-token",
      },
    });
    expect(Buffer.from(manifest.data.CHASE_SETS_OTLP_TOKEN, "base64").toString("utf8")).toBe("shared-write-token");
  });

  it("builds a Kubernetes Secret without exposing plaintext values", () => {
    const manifest = buildPlatformSecretManifest({
      values: sampleValues,
      namespace: "staging",
      env: {
        DATABASE_URL_CHECKOUT: "postgres://checkout-secret",
        STRIPE_SECRET_KEY: "sk_test_secret",
      },
    });

    expect(manifest).toMatchObject({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: "chase-sets-platform-runtime",
        namespace: "staging",
      },
      type: "Opaque",
    });
    expect(manifest.data.DATABASE_URL_CHECKOUT).toBe(Buffer.from("postgres://checkout-secret").toString("base64"));
    expect(manifest.data.STRIPE_SECRET_KEY).toBe(Buffer.from("sk_test_secret").toString("base64"));
    expect(JSON.stringify(manifest)).not.toContain("sk_test_secret");
  });

  it("builds the namespace manifest used before namespaced secrets", () => {
    expect(buildNamespaceManifest("production")).toMatchObject({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "production",
        labels: {
          "app.kubernetes.io/name": "chase-sets-platform",
          "app.kubernetes.io/managed-by": "github-actions",
        },
      },
    });
    expect(buildNamespaceManifest()).toBeNull();
  });

  it("requires the CI environment to define every chart secret key", () => {
    expect(() =>
      buildPlatformSecretManifest({
        values: sampleValues,
        env: {
          DATABASE_URL_CHECKOUT: "postgres://checkout-secret",
        },
      }),
    ).toThrow("STRIPE_SECRET_KEY");
  });

  it.each(previewProviderSecretNames)("fails closed when %s is omitted", (missingName) => {
    const env = Object.fromEntries(previewProviderSecretNames.map((name) => [name, `synthetic-${name}`]));
    delete env[missingName];

    expect(() => buildPlatformSecretManifest({ values: previewProviderValues, env })).toThrow(
      `Missing Kubernetes secret environment value(s): ${missingName}.`,
    );
  });

  it("synthesizes disposable preview Postgres secrets and database URLs", () => {
    const bundle = buildPlatformSecretBundle({
      values: {
        ...sampleValues,
        previewPostgres: {
          secretName: "chase-sets-preview-postgres",
          service: { port: 5432 },
          superuserSecretKey: "POSTGRES_PASSWORD",
          applicationSecretKey: "APP_DATABASE_PASSWORD",
        },
      },
      namespace: "chase-sets-pr-123",
      release: "chase-sets-pr-123",
      deploymentEnvironment: "preview",
      secretKeys: [
        "DATABASE_URL_CHECKOUT",
        "DATABASE_URL_CATALOG_WAITER",
        "PLATFORM_CONTROL_DATABASE_URL",
        "PLATFORM_PREVIEW_POSTGRES_ADMIN_URL",
        "STRIPE_SECRET_KEY",
      ],
      env: {
        PREVIEW_POSTGRES_SUPERUSER_PASSWORD: "super-secret",
        PREVIEW_POSTGRES_APPLICATION_PASSWORD: "app-secret",
        STRIPE_SECRET_KEY: "sk_test_secret",
      },
    });

    expect(bundle.previewPostgresSecret).toMatchObject({
      kind: "Secret",
      metadata: {
        name: "chase-sets-preview-postgres",
        namespace: "chase-sets-pr-123",
      },
      data: {
        POSTGRES_PASSWORD: Buffer.from("super-secret").toString("base64"),
        APP_DATABASE_PASSWORD: Buffer.from("app-secret").toString("base64"),
      },
    });
    // The in-cluster preview Postgres does not serve SSL and the shared pool
    // factory force-upgrades non-local hosts without an explicit sslmode, so
    // every synthesized preview URL must state sslmode=disable.
    expect(Buffer.from(bundle.runtimeSecret.data.PLATFORM_PREVIEW_POSTGRES_ADMIN_URL, "base64").toString("utf8")).toBe(
      "postgresql://postgres:super-secret@chase-sets-pr-123-chase-sets-platform-preview-postgres:5432/postgres?sslmode=disable",
    );
    expect(Buffer.from(bundle.runtimeSecret.data.DATABASE_URL_CHECKOUT, "base64").toString("utf8")).toBe(
      "postgresql://cs_preview_checkout:app-secret@chase-sets-pr-123-chase-sets-platform-preview-postgres:5432/chase_sets_preview_checkout?sslmode=disable",
    );
    expect(Buffer.from(bundle.runtimeSecret.data.DATABASE_URL_CATALOG_WAITER, "base64").toString("utf8")).toBe(
      "postgresql://cs_preview_catalog:app-secret@chase-sets-pr-123-chase-sets-platform-preview-postgres:5432/chase_sets_preview_catalog?sslmode=disable",
    );
    expect(JSON.stringify(bundle)).not.toContain("super-secret");
    expect(JSON.stringify(bundle)).not.toContain("app-secret");
    const previewUrl = Buffer.from(bundle.runtimeSecret.data.DATABASE_URL_CATALOG_WAITER, "base64").toString("utf8");
    // The chart renders the same release's Service name into the pod.
    const previewPod = {
      DEPLOYMENT_ENVIRONMENT: "preview",
      KUBERNETES_SERVICE_HOST: "10.245.0.1",
      [previewPostgresHostEnvName]: platformHelmPreviewPostgresName({ releaseName: "chase-sets-pr-123" }),
    };
    expect(admitPostgresClientConnection(previewUrl, previewPod).transport).toBe("plaintext-preview");
    expect(() =>
      admitPostgresClientConnection(previewUrl, {
        ...previewPod,
        [previewPostgresHostEnvName]: platformHelmPreviewPostgresName({ releaseName: "chase-sets-pr-124" }),
      }),
    ).toThrow("remote-postgres-sslmode-downgraded");
    for (const environment of ["staging", "production"]) {
      expect(() =>
        admitPostgresClientConnection(previewUrl, { ...previewPod, DEPLOYMENT_ENVIRONMENT: environment }),
      ).toThrow("remote-postgres-sslmode-downgraded");
    }
  });

  it("names the #7512 pod mount as the only runtime CA path", () => {
    expect(managedPostgresPodCaPath).toBe("/var/run/secrets/chase-sets/managed-postgres/ca.crt");
    expect(runtimePodCaPath).toBe(managedPostgresPodCaPath);
  });

  it("keeps the Terraform managed URL locals on the same verify-full pod query", () => {
    const locals = readFileSync("infrastructure/digitalocean/platform/locals.tf", "utf8");
    expect(locals).toContain(
      `managed_postgres_pod_url_query = "sslmode=verify-full&sslrootcert=\${urlencode("${managedPostgresPodCaPath}")}&uselibpqcompat=true"`,
    );
    expect(locals).not.toMatch(/sslmode=(?:require|prefer|allow|verify-ca)\b/u);
    expect(locals.match(/"postgresql:\/\/%s:%s@%s:%d\/%s\?%s",/gu)).toHaveLength(3);
    expect(locals.match(/^ {6}local\.managed_postgres_pod_url_query,$/gmu)).toHaveLength(3);
  });

  it("never rewrites non-preview database URLs to sslmode=disable", () => {
    const bundle = buildPlatformSecretBundle({
      values: sampleValues,
      namespace: "staging",
      deploymentEnvironment: "staging",
      env: {
        DATABASE_URL_CHECKOUT:
          "postgresql://cs_staging_checkout:managed@private-db.ondigitalocean.com:25061/chase_sets_staging_checkout?sslmode=require",
        STRIPE_SECRET_KEY: "sk_test_secret",
      },
    });

    expect(Buffer.from(bundle.runtimeSecret.data.DATABASE_URL_CHECKOUT, "base64").toString("utf8")).toBe(
      "postgresql://cs_staging_checkout:managed@private-db.ondigitalocean.com:25061/chase_sets_staging_checkout?sslmode=require",
    );
    expect(bundle.previewPostgresSecret).toBeNull();
    const decodedSecretValues = Object.values(bundle.runtimeSecret.data).map((value) =>
      Buffer.from(value, "base64").toString("utf8"),
    );
    expect(decodedSecretValues.join("\n")).not.toContain("sslmode=disable");
  });

  it("exports pooled staging query URLs while listener, waiter, work-signal, and bootstrap URLs stay direct", () => {
    const databaseEnv = buildManagedPostgresDatabaseEnv({
      terraformState: managedPostgresTerraformState(),
      environment: "staging",
      queryConnectionMode: "pooled",
      secretKeys: [
        "BOOTSTRAP_DATABASE_URL_CATALOG",
        "BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL",
        "DATABASE_URL_CATALOG",
        "DATABASE_URL_CATALOG_WAITER",
        "PLATFORM_CONTROL_DATABASE_URL",
        "PLATFORM_WORK_SIGNAL_DATABASE_URL",
        "WORKER_LISTENER_DATABASE_URL_CATALOG",
      ],
    });

    const podTrust = `?sslmode=verify-full&sslrootcert=${encodeURIComponent(managedPostgresPodCaPath)}&uselibpqcompat=true`;
    expect(databaseEnv).toEqual({
      BOOTSTRAP_DATABASE_URL_CATALOG: `postgresql://cs_staging_catalog:catalog-direct-password@staging-db.example:25060/chase_sets_staging_catalog${podTrust}`,
      BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL: `postgresql://cs_staging_control:control-direct-password@staging-db.example:25060/chase_sets_staging_control${podTrust}`,
      DATABASE_URL_CATALOG: `postgresql://cs_staging_catalog:catalog-direct-password@staging-pool.example:25061/catalog-runtime${podTrust}`,
      DATABASE_URL_CATALOG_WAITER: `postgresql://cs_staging_catalog_wake:catalog-wake-password@staging-db.example:25060/chase_sets_staging_catalog${podTrust}`,
      PLATFORM_CONTROL_DATABASE_URL: `postgresql://cs_staging_control:control-direct-password@staging-pool.example:25061/control-runtime${podTrust}`,
      PLATFORM_WORK_SIGNAL_DATABASE_URL: `postgresql://cs_staging_control:control-direct-password@staging-db.example:25060/chase_sets_staging_control${podTrust}`,
      WORKER_LISTENER_DATABASE_URL_CATALOG: `postgresql://cs_staging_catalog_wake:catalog-wake-password@staging-db.example:25060/chase_sets_staging_catalog${podTrust}`,
    });
    for (const url of Object.values(databaseEnv)) {
      expect(admitPostgresClientConnection(url, stagingPodEnv).transport).toBe("verified-managed");
      expect(() => admitPostgresClientConnection(url, runnerEnvForPodUrls)).toThrow(
        "remote-postgres-rootcert-path-unexpected",
      );
    }
  });

  it("applies the secret manifest through kubectl stdin", async () => {
    const writes = [];
    const child = new EventEmitter();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString("utf8"));
        callback();
      },
    });
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    };

    const result = await applyPlatformSecretManifest({
      kubectlPath: "kubectl",
      spawn,
      manifest: buildPlatformSecretManifest({
        values: sampleValues,
        env: {
          DATABASE_URL_CHECKOUT: "postgres://checkout-secret",
          STRIPE_SECRET_KEY: "sk_test_secret",
        },
      }),
    });

    expect(result).toEqual({ name: "chase-sets-platform-runtime", namespace: null, keyCount: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "kubectl",
      args: [
        "apply",
        "--server-side",
        "--force-conflicts",
        "--field-manager",
        "chase-sets-platform-runtime",
        "-f",
        "-",
      ],
    });
    expect(calls[0].options.stdio).toEqual(["pipe", "inherit", "inherit"]);
    expect(writes.join("")).toContain('"kind":"Secret"');
  });

  it("applies the namespace before a namespaced secret manifest", async () => {
    const writes = [];
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          writes.push(chunk.toString("utf8"));
          callback();
        },
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    };

    const result = await applyPlatformSecretManifest({
      kubectlPath: "kubectl",
      spawn,
      manifest: buildPlatformSecretManifest({
        values: sampleValues,
        namespace: "production",
        env: {
          DATABASE_URL_CHECKOUT: "postgres://checkout-secret",
          STRIPE_SECRET_KEY: "sk_test_secret",
        },
      }),
    });

    expect(result).toEqual({ name: "chase-sets-platform-runtime", namespace: "production", keyCount: 2 });
    expect(calls.map((call) => call.args)).toEqual([
      ["apply", "-f", "-"],
      ["apply", "--server-side", "--force-conflicts", "--field-manager", "chase-sets-platform-runtime", "-f", "-"],
    ]);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain('"kind":"Namespace"');
    expect(writes[0]).toContain('"name":"production"');
    expect(writes[1]).toContain('"kind":"Secret"');
    expect(writes[1]).toContain('"namespace":"production"');
    expect(writes.join("")).not.toContain("sk_test_secret");
  });

  it("prints only a redacted dry-run summary", () => {
    expect(summarizePlatformSecret({ values: sampleValues, namespace: "production" })).toEqual({
      name: "chase-sets-platform-runtime",
      namespace: "production",
      keyCount: 2,
      keys: ["DATABASE_URL_CHECKOUT", "STRIPE_SECRET_KEY"],
    });
  });

  it("server-side applies only the managed Postgres CA key under its dedicated manager", async () => {
    const calls = [];
    const writes = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          writes.push(chunk.toString("utf8"));
          callback();
        },
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    };
    const certificate = Buffer.from("synthetic-ca-bytes", "utf8");
    await applyManagedPostgresCaSecret({
      namespace: "chase-sets-platform",
      certificate,
      resourceVersion: "synthetic-123",
      kubectlPath: "C:/synthetic/kubectl-double.exe",
      spawn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "C:/synthetic/kubectl-double.exe",
      args: ["apply", "--server-side", "--field-manager", "chase-sets-managed-postgres-ca", "-f", "-"],
    });
    const applied = JSON.parse(writes[0]);
    expect(applied.metadata.name).toBe("chase-sets-platform-runtime");
    expect(applied.metadata.namespace).toBe("chase-sets-platform");
    expect(applied.metadata.resourceVersion).toBe("synthetic-123");
    expect(applied.data["managed-postgres-ca.crt"]).toBe(certificate.toString("base64"));
  });

  it("reads only the existing Secret resourceVersion before the one-key server-side apply", async () => {
    const calls = [];
    const certificate = Buffer.from("synthetic-ca-bytes", "utf8");
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
      queueMicrotask(() => {
        if (args[0] === "get") child.stdout.emit("data", "synthetic-456");
        child.emit("close", 0);
      });
      return child;
    };

    await applyManagedPostgresCaSecret({
      namespace: "chase-sets-platform",
      certificate,
      kubectlPath: "C:/synthetic/kubectl-double.exe",
      spawn,
    });

    expect(calls.map(({ args }) => args)).toEqual([
      [
        "get",
        "secret",
        "chase-sets-platform-runtime",
        "--namespace",
        "chase-sets-platform",
        "--output",
        "jsonpath={.metadata.resourceVersion}",
      ],
      ["apply", "--server-side", "--field-manager", "chase-sets-managed-postgres-ca", "-f", "-"],
    ]);
  });
});

function managedPostgresTerraformState() {
  const indexedResource = (type, name, entries) => ({
    type,
    name,
    instances: Object.entries(entries).map(([indexKey, attributes]) => ({ index_key: indexKey, attributes })),
  });

  return {
    resources: [
      {
        type: "digitalocean_database_cluster",
        name: "postgres",
        instances: [{ attributes: { host: "staging-db.example", port: 25060 } }],
      },
      indexedResource("digitalocean_database_db", "contexts", {
        catalog: { name: "chase_sets_staging_catalog" },
        control: { name: "chase_sets_staging_control" },
      }),
      indexedResource("digitalocean_database_user", "contexts", {
        catalog: { name: "cs_staging_catalog", password: "catalog-direct-password" },
        control: { name: "cs_staging_control", password: "control-direct-password" },
      }),
      indexedResource("digitalocean_database_user", "wake_listeners", {
        catalog: { name: "cs_staging_catalog_wake", password: "catalog-wake-password" },
      }),
      indexedResource("digitalocean_database_connection_pool", "contexts", {
        catalog: {
          name: "catalog-runtime",
          mode: "transaction",
          host: "staging-pool.example",
          port: 25061,
          user: "cs_staging_catalog",
          password: "",
        },
        control: {
          name: "control-runtime",
          mode: "transaction",
          host: "staging-pool.example",
          port: 25061,
          user: "cs_staging_control",
          password: "",
        },
      }),
    ],
  };
}
