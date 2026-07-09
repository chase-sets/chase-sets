import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  applyPlatformSecretManifest,
  buildNamespaceManifest,
  buildPlatformSecretBundle,
  buildPlatformSecretManifest,
  collectPlatformSecretKeys,
  summarizePlatformSecret,
} from "./platform-kubernetes-secret.mjs";

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

describe("platform Kubernetes secret", () => {
  it("collects unique secret keys from Helm values", () => {
    expect(collectPlatformSecretKeys(sampleValues)).toEqual(["DATABASE_URL_CHECKOUT", "STRIPE_SECRET_KEY"]);
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
    expect(calls[0]).toMatchObject({ command: "kubectl", args: ["apply", "-f", "-"] });
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
      ["apply", "-f", "-"],
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
});
