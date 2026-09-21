import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
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
      topologySpreadConstraints: [
        { maxSkew: 1, topologyKey: "kubernetes.io/hostname", whenUnsatisfiable: "ScheduleAnyway" },
      ],
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
      topologySpreadConstraints: [
        { maxSkew: 1, topologyKey: "kubernetes.io/hostname", whenUnsatisfiable: "ScheduleAnyway" },
      ],
      podLabels: {},
    },
    "platform-bootstrap": {
      enabled: true,
      kind: "job",
      replicas: 1,
      command: "pnpm --filter @chase-sets/app-platform-api run bootstrap:production",
      env: [{ name: "STRIPE_SECRET_KEY", secret: true, secretKey: "STRIPE_SECRET_KEY" }],
      resources: {},
      topologySpreadConstraints: [],
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

// Captured verbatim from a live render of the production overlay at the head
// that introduced the seam (#8099):
//
//   helm template chase-sets-platform infrastructure/helm/platform \
//     -f infrastructure/helm/platform/values.yaml \
//     -f infrastructure/helm/platform/values.production.yaml
//
// `test:scripts` has no helm binary -- the chart render runs in the Platform
// PR workflow's Helm job -- so the render is pinned here as a fixture, the
// same way the live-render shapes are pinned in
// render-platform-helm-values.test.mjs.
const helmTemplateSpreadFixture = [
  "      topologySpreadConstraints:",
  "        - maxSkew: 1",
  "          topologyKey: kubernetes.io/hostname",
  "          whenUnsatisfiable: ScheduleAnyway",
  "          labelSelector:",
  "            matchLabels:",
  "              app.kubernetes.io/name: chase-sets-platform",
  "              app.kubernetes.io/instance: chase-sets-platform",
  "              app.kubernetes.io/component: public-web",
  "      containers:",
  '        - name: "public-web"',
  "      topologySpreadConstraints:",
  "        - maxSkew: 1",
  "          topologyKey: kubernetes.io/hostname",
  "          whenUnsatisfiable: ScheduleAnyway",
  "          labelSelector:",
  "            matchLabels:",
  "              app.kubernetes.io/name: chase-sets-platform",
  "              app.kubernetes.io/instance: chase-sets-platform",
  "              app.kubernetes.io/component: platform-worker",
  "      containers:",
  '        - name: "platform-worker"',
].join("\n");

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

  it("keeps the hostname spread seam in the values it hands to `helm template` (#8099)", () => {
    const values = buildPlatformHelmLocalBootValues({ values: sampleValues });

    // Local boot zeroes resources so the proof fits a laptop. It must not also
    // drop the spread: these values go straight into `helm template`, so
    // losing the seam here would silently stop the boot proof from covering
    // it while every assertion above still passed.
    expect(values.components["public-web"].resources).toEqual({});
    expect(values.components["public-web"].topologySpreadConstraints).toEqual([
      { maxSkew: 1, topologyKey: "kubernetes.io/hostname", whenUnsatisfiable: "ScheduleAnyway" },
    ]);
    expect(values.components["platform-bootstrap"].topologySpreadConstraints).toEqual([]);

    const rendered = renderPlatformHelmLocalBootValues({ values: sampleValues });
    expect(rendered).toContain("topologySpreadConstraints:");
    expect(rendered).toContain('topologyKey: "kubernetes.io/hostname"');
    expect(rendered).toContain('whenUnsatisfiable: "ScheduleAnyway"');
    // The values file never names a labelSelector; the chart supplies it.
    expect(rendered).not.toContain("labelSelector");

    // What helm actually made of that seam: one constraint per Deployment,
    // each selecting only its own component. A shared or global selector --
    // the failure mode a `global.affinity`-based spread would have had -- would
    // collapse these two blocks onto the same component label.
    const renderedComponents = [...helmTemplateSpreadFixture.matchAll(/app\.kubernetes\.io\/component: (\S+)/g)].map(
      (match) => match[1],
    );
    expect(renderedComponents).toEqual(["public-web", "platform-worker"]);
    expect(helmTemplateSpreadFixture).toContain("maxSkew: 1");
    expect(helmTemplateSpreadFixture).toContain("whenUnsatisfiable: ScheduleAnyway");

    // The fixture is only trustworthy while the chart still derives the
    // selector from the component's own selectorLabels rather than accepting
    // one from values.
    const helperTemplate = readFileSync(
      path.join(process.cwd(), "infrastructure", "helm", "platform", "templates", "_helpers.tpl"),
      "utf8",
    );
    expect(helperTemplate).toContain('{{- define "chase-sets-platform.topologySpreadConstraints" -}}');
    expect(helperTemplate).toContain('{{ toYaml (omit . "labelSelector") | nindent 4 | trim }}');
    expect(helperTemplate).toContain(
      '{{- $selectorLabels := include "chase-sets-platform.selectorLabels" (dict "root" .root "name" .name) -}}',
    );
  });
});
