import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyDoksDnsTokenSecret,
  buildDoksDnsTokenSecretManifest,
  doksDnsTokenSecretName,
  doksDnsTokenSecretNamespace,
  loadBalancerName,
  localChartVersion,
  pinned,
  planClusterAddons,
} from "./doks-cluster-addons.mjs";

const ingressNginxValues = readFileSync(
  resolve("infrastructure", "helm", "doks-ingress", "ingress-nginx-values.yaml"),
  "utf8",
);

describe("doks cluster addons planner", () => {
  it("reads the local chart version from Chart.yaml rather than duplicating it", () => {
    const chartYaml = readFileSync(resolve("infrastructure", "helm", "doks-ingress", "Chart.yaml"), "utf8");
    expect(localChartVersion).toBe(chartYaml.match(/^version:\s*(.+)$/m)?.[1]);
    expect(readFileSync(resolve("scripts", "doks-cluster-addons.mjs"), "utf8")).not.toContain('version: "0.1.0"');
  });

  it("tracks a modified Chart.yaml on a fresh module evaluation", async () => {
    const chartYamlPath = resolve("infrastructure", "helm", "doks-ingress", "Chart.yaml");
    const original = readFileSync(chartYamlPath, "utf8");
    writeFileSync(chartYamlPath, original.replace(/^version:\s*.+$/m, "version: 0.1.1"), "utf8");
    try {
      const moduleUrl = pathToFileURL(resolve("scripts", "doks-cluster-addons.mjs")).href;
      const output = await new Promise((resolveOutput, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "--eval", `import { localChartVersion } from \"${moduleUrl}\"; console.log(localChartVersion);`]);
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolveOutput(stdout.trim()) : reject(new Error(`child exited ${code}`))));
      });
      expect(output).toBe("0.1.1");
    } finally {
      writeFileSync(chartYamlPath, original, "utf8");
    }
  });

  it("plans repos, controller, cert-manager, and issuers in order", () => {
    const steps = planClusterAddons({ environment: "staging" });
    expect(steps.map((step) => step.name)).toEqual([
      "add ingress-nginx repo",
      "add cert-manager repo",
      "add Argo repo",
      "refresh repos",
      "install ingress-nginx controller and DigitalOcean load balancer",
      "install cert-manager",
      "install Argo Rollouts controller and CRDs",
      "install ACME cluster issuers",
    ]);
  });

  it("installs cert-manager before the cluster issuers that need its CRDs", () => {
    const steps = planClusterAddons({ environment: "staging" });
    const certManagerIndex = steps.findIndex((step) => step.name === "install cert-manager");
    const issuerIndex = steps.findIndex((step) => step.name === "install ACME cluster issuers");
    expect(certManagerIndex).toBeGreaterThanOrEqual(0);
    expect(issuerIndex).toBeGreaterThan(certManagerIndex);
  });

  it("pins upstream chart versions", () => {
    const steps = planClusterAddons({ environment: "staging" });
    const ingress = steps.find((step) => step.name.startsWith("install ingress-nginx"));
    const certManager = steps.find((step) => step.name === "install cert-manager");
    const argoRollouts = steps.find((step) => step.name === "install Argo Rollouts controller and CRDs");
    expect(ingress.command).toContain(pinned.ingressNginx.version);
    expect(certManager.command).toContain(pinned.certManager.version);
    expect(argoRollouts.command).toContain(pinned.argoRollouts.version);
    expect(pinned.argoRollouts.appVersion).toBe("v1.9.0");
  });

  it("names the DigitalOcean load balancer per environment", () => {
    expect(loadBalancerName("staging")).toBe("chase-sets-staging-doks-ingress");
    expect(loadBalancerName("production")).toBe("chase-sets-production-doks-ingress");

    const staging = planClusterAddons({ environment: "staging" });
    const controller = staging.find((step) => step.name.startsWith("install ingress-nginx"));
    expect(controller.command.join(" ")).toContain("=chase-sets-staging-doks-ingress");

    const production = planClusterAddons({ environment: "production" });
    const productionController = production.find((step) => step.name.startsWith("install ingress-nginx"));
    expect(productionController.command.join(" ")).toContain("=chase-sets-production-doks-ingress");
  });

  it("pairs the DOKS REGIONAL_NETWORK load balancer with hostPort ingress targets", () => {
    // Live #4680 evidence showed the DOKS 1.36 CCM forces REGIONAL_NETWORK and
    // re-stamps the annotation within seconds. REGIONAL_NETWORK is same-port L4
    // passthrough, so controller pods must bind host :80/:443 for LB targets.
    expect(ingressNginxValues).toContain('service.beta.kubernetes.io/do-loadbalancer-type: "REGIONAL_NETWORK"');
    expect(ingressNginxValues).toMatch(/\n  hostPort:\n    enabled: true\n/);
    expect(ingressNginxValues).toContain("externalTrafficPolicy: Local");
    expect(ingressNginxValues).toContain("DOKS 1.36 CCM coerces this Service to REGIONAL_NETWORK");
  });

  it("keeps load balancer and ingress-nginx PROXY protocol disabled for REGIONAL_NETWORK", () => {
    expect(ingressNginxValues).not.toContain("service.beta.kubernetes.io/do-loadbalancer-enable-proxy-protocol");
    expect(ingressNginxValues).toContain('use-proxy-protocol: "false"');
    expect(ingressNginxValues).not.toContain('use-proxy-protocol: "true"');
  });

  it("installs every helm release atomically so a failed release rolls back", () => {
    const steps = planClusterAddons({ environment: "staging" });
    for (const step of steps.filter((entry) => entry.command.includes("upgrade"))) {
      expect(step.command).toContain("--atomic");
      expect(step.command).toContain("--wait");
    }
  });

  it("rejects unsupported environments", () => {
    expect(() => planClusterAddons({ environment: "preview" })).toThrow("environment must be one of");
  });

  // #4857: only the staging DOKS cluster hosts previews, so only a staging
  // install enables the shared *.preview.chasesets.com wildcard Certificate
  // (previewWildcardCertificate) on the ClusterIssuer release. Installing it
  // a second time onto production would double ACME issuance for no reader.
  it("enables the shared preview wildcard certificate only for the staging install", () => {
    const staging = planClusterAddons({ environment: "staging" });
    const stagingIssuers = staging.find((step) => step.name === "install ACME cluster issuers");
    expect(stagingIssuers.command).toEqual(
      expect.arrayContaining(["--set", "previewWildcardCertificate.enabled=true"]),
    );

    const production = planClusterAddons({ environment: "production" });
    const productionIssuers = production.find((step) => step.name === "install ACME cluster issuers");
    expect(productionIssuers.command).not.toContain("previewWildcardCertificate.enabled=true");
  });

  it("scopes the DNS-01 solver to previews on staging and the live zone on production", () => {
    const stagingIssuers = planClusterAddons({ environment: "staging" }).find(
      (step) => step.name === "install ACME cluster issuers",
    );
    const productionIssuers = planClusterAddons({ environment: "production" }).find(
      (step) => step.name === "install ACME cluster issuers",
    );

    expect(stagingIssuers.command).toEqual(
      expect.arrayContaining([
        "--set",
        "clusterIssuers.production.dns01.enabled=true",
        "--set-string",
        "clusterIssuers.production.dns01.dnsZones[0]=preview.chasesets.com",
      ]),
    );
    expect(productionIssuers.command).toEqual(
      expect.arrayContaining([
        "--set",
        "clusterIssuers.production.dns01.enabled=true",
        "--set-string",
        "clusterIssuers.production.dns01.dnsZones[0]=chasesets.com",
      ]),
    );
  });

  describe("DOKS DNS-01 token secret", () => {
    it("base64-encodes the token into an Opaque Secret in the cert-manager namespace", () => {
      const manifest = buildDoksDnsTokenSecretManifest("do_fake_token_value", "production");

      expect(manifest).toMatchObject({
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: doksDnsTokenSecretName,
          namespace: doksDnsTokenSecretNamespace,
          labels: { "app.kubernetes.io/component": "production-dns01" },
        },
        type: "Opaque",
      });
      expect(manifest.data["access-token"]).toBe(Buffer.from("do_fake_token_value", "utf8").toString("base64"));
      // The manifest never carries the raw token value in plaintext.
      expect(JSON.stringify(manifest)).not.toContain("do_fake_token_value");
    });

    it("refuses to build a secret manifest without a token instead of applying an empty credential", () => {
      expect(() => buildDoksDnsTokenSecretManifest("")).toThrow("DIGITALOCEAN_ACCESS_TOKEN is required");
      expect(() => buildDoksDnsTokenSecretManifest(undefined)).toThrow("DIGITALOCEAN_ACCESS_TOKEN is required");
      expect(() => buildDoksDnsTokenSecretManifest("   ")).toThrow("DIGITALOCEAN_ACCESS_TOKEN is required");
    });

    it("applies the secret by piping it to kubectl stdin, never as a command-line argument", async () => {
      const calls = [];
      const spawn = (command, args) => {
        const child = new EventEmitter();
        child.stdin = { end: (input) => calls.push({ command, args, input }) };
        queueMicrotask(() => child.emit("close", 0));
        return child;
      };

      const applied = await applyDoksDnsTokenSecret({ token: "do_fake_token_value", environment: "production", spawn });

      expect(applied).toEqual({ name: doksDnsTokenSecretName, namespace: doksDnsTokenSecretNamespace });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe("kubectl");
      expect(calls[0].args).toEqual(["apply", "-f", "-"]);
      expect(calls[0].args.join(" ")).not.toContain("do_fake_token_value");
      expect(JSON.parse(calls[0].input).data["access-token"]).toBe(
        Buffer.from("do_fake_token_value", "utf8").toString("base64"),
      );
    });
  });

  it("never prints a real token into --dry-run output (the token secret is applied outside the printed plan)", () => {
    // The dry-run path returns before any DIGITALOCEAN_ACCESS_TOKEN read, so
    // the printed step commands can never contain token material regardless
    // of what is set in the environment.
    const steps = planClusterAddons({ environment: "staging" });
    const serialized = JSON.stringify(steps.map((step) => ({ name: step.name, command: step.command.join(" ") })));
    expect(serialized).not.toContain("digitalocean-dns-token");
    expect(serialized.toLowerCase()).not.toContain("access-token");
  });
});
