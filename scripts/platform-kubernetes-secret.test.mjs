import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  applyPlatformSecretManifest,
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

  it("prints only a redacted dry-run summary", () => {
    expect(summarizePlatformSecret({ values: sampleValues, namespace: "production" })).toEqual({
      name: "chase-sets-platform-runtime",
      namespace: "production",
      keyCount: 2,
      keys: ["DATABASE_URL_CHECKOUT", "STRIPE_SECRET_KEY"],
    });
  });
});
