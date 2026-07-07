import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  applyPlatformHelmLocalBoot,
  buildPlatformHelmLocalBootValues,
  platformHelmLocalBootWorkloads,
  renderPlatformHelmLocalBootValues,
  summarizePlatformHelmLocalBoot,
} from "./platform-helm-local-boot.mjs";

const sampleValues = {
  global: {
    image: {
      registry: "registry.digitalocean.com",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: "latest",
      digest: "",
      pullPolicy: "IfNotPresent",
    },
    existingSecretName: "chase-sets-platform-runtime",
    podLabels: {},
  },
  components: {
    "public-web": {
      enabled: true,
      kind: "service",
      replicas: 2,
      command: "pnpm --filter @chase-sets/app-public-web run start",
      env: [
        { name: "PORT", value: "8080" },
        { name: "CHASE_SETS_DISCORD_INVITE_URL", secret: true, secretKey: "CHASE_SETS_DISCORD_INVITE_URL" },
      ],
      resources: { requests: { cpu: "100m" } },
      podLabels: {},
      port: 8080,
      healthPath: "/",
    },
    "platform-worker": {
      enabled: true,
      kind: "worker",
      replicas: 2,
      command: "pnpm --filter @chase-sets/app-platform-worker run start:production",
      env: [{ name: "DATABASE_URL_CHECKOUT", secret: true, secretKey: "DATABASE_URL_CHECKOUT" }],
      resources: {},
      podLabels: {},
    },
    "platform-bootstrap": {
      enabled: true,
      kind: "job",
      replicas: 1,
      command: "pnpm --filter @chase-sets/app-platform-api run bootstrap:production",
      env: [{ name: "STRIPE_SECRET_KEY", secret: true, secretKey: "STRIPE_SECRET_KEY" }],
      resources: {},
      podLabels: {},
      job: {
        activeDeadlineSeconds: 890,
        quiesce: {
          enabled: true,
          targetComponents: ["platform-worker"],
        },
      },
    },
  },
};

describe("platform Helm local boot", () => {
  it("derives dev-safe boot values from the generated chart values", () => {
    const values = buildPlatformHelmLocalBootValues({ values: sampleValues });

    expect(values.global.image).toMatchObject({
      registry: "docker.io",
      registryName: "library",
      repository: "node",
      tag: "24-alpine",
    });
    expect(values.global.existingSecretName).toBe("chase-sets-platform-local-boot");
    expect(values.components["public-web"].replicas).toBe(1);
    expect(values.components["public-web"].command).toContain("http.createServer");
    expect(values.components["platform-worker"].command).toContain("local boot proof ready");
    expect(values.components["platform-bootstrap"].command).toContain("local boot proof complete");
    expect(values.components["platform-bootstrap"].job.activeDeadlineSeconds).toBe(890);
    expect(values.components["platform-bootstrap"].job.quiesce.enabled).toBe(false);
    expect(values.components["platform-worker"].env).toEqual([
      { name: "DATABASE_URL_CHECKOUT", value: "postgres://local-boot:not-used@localhost:5432/local_boot" },
    ]);
  });

  it("renders local boot values without Kubernetes Secret references", () => {
    const rendered = renderPlatformHelmLocalBootValues({ values: sampleValues });

    expect(rendered).toContain('repository: "node"');
    expect(rendered).toContain('value: "local-boot-placeholder"');
    expect(rendered).not.toContain("secretKeyRef");
    expect(rendered).not.toContain("secret: true");
  });

  it("summarizes the workload names waited by the boot proof", () => {
    expect(
      summarizePlatformHelmLocalBoot({
        values: buildPlatformHelmLocalBootValues({ values: sampleValues }),
        namespace: "local-proof",
        release: "proof",
      }),
    ).toEqual({
      namespace: "local-proof",
      release: "proof",
      image: "docker.io/library/node:24-alpine",
      deployments: ["proof-chase-sets-platform-public-web", "proof-chase-sets-platform-platform-worker"],
      jobs: ["proof-chase-sets-platform-platform-bootstrap"],
    });
  });

  it("applies the rendered manifest and waits for deployments and jobs", async () => {
    const calls = [];
    const stdinWrites = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          stdinWrites.push(chunk.toString("utf8"));
          callback();
        },
      });
      queueMicrotask(() => {
        if (options.stdio[1] === "pipe") {
          child.stdout.end("kind: Namespace\n");
        }
        child.emit("close", 0);
      });
      return child;
    };

    const values = buildPlatformHelmLocalBootValues({ values: sampleValues });
    const result = await applyPlatformHelmLocalBoot({
      values,
      manifest: "kind: List\n",
      namespace: "local-proof",
      release: "proof",
      timeout: "15s",
      spawn,
    });

    expect(result).toEqual({
      namespace: "local-proof",
      release: "proof",
      ...platformHelmLocalBootWorkloads({ values, release: "proof" }),
    });
    expect(calls.map((call) => call.args)).toEqual([
      ["create", "namespace", "local-proof", "--dry-run=client", "-o", "yaml"],
      ["apply", "-f", "-"],
      ["apply", "-n", "local-proof", "-f", "-"],
      ["rollout", "status", "deployment/proof-chase-sets-platform-public-web", "-n", "local-proof", "--timeout=15s"],
      [
        "rollout",
        "status",
        "deployment/proof-chase-sets-platform-platform-worker",
        "-n",
        "local-proof",
        "--timeout=15s",
      ],
      [
        "wait",
        "--for=condition=Complete",
        "job/proof-chase-sets-platform-platform-bootstrap",
        "-n",
        "local-proof",
        "--timeout=15s",
      ],
    ]);
    expect(stdinWrites.join("\n")).toContain("kind: Namespace");
    expect(stdinWrites.join("\n")).toContain("kind: List");
  });
});
