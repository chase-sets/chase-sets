import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildDoksIngressValues,
  buildPlatformHelmProductionValues,
  buildPlatformHelmStagingValues,
  buildPlatformHelmValues,
} from "./render-platform-helm-values.mjs";
import { buildHelmUpgradeArgs, parseArgs, platformKubernetesWorkloads } from "./platform-kubernetes-deployment.mjs";
import { classifyChanges } from "./change-scope.mjs";

const read = (file) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const workflowText = read(".github/workflows/platform-production.yml");
const workflow = parse(workflowText);
const digest = "sha256:" + "a".repeat(64);
const image = `registry.digitalocean.com/chase-sets/chase-sets-corten-admin@${digest}`;
const options = {
  image: `registry.digitalocean.com/chase-sets/chase-sets-platform:release@${digest}`,
  cortenAdminImage: image,
  envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging", OBSERVABILITY_ENABLED: "false" },
  env: { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" },
  managedPostgresCaSha256: "b".repeat(64),
};

describe("Corten admin staging deployment", () => {
  it("preserves every production job byte-for-byte at the deployment baseline", () => {
    const expected = {
      "reconcile-production-marker": "6e7171774b3d654c0dcd81d993140ebcfb0bf8436d05c7a5809c7137b5f2c317",
      "reconcile-managed-postgres-ca-production": "2a089333675961592792931dc522f4a8725e1f4b2f8688a0a7ecbb5a3246f389",
      "deploy-production": "740c6e8e5d18ec54356e2e7cda6d58939318e3afead34c4b2b9803622b50acd9",
      "notify-production-deploy-incident": "45ba7ca357af41620cb066784a2ef94c80741725d98aa98a6520f3b049166262",
      "notify-production-rollback-incident": "6620994b81902ec45da29e5b3f049a1e49b2e9a2483d1b6acf6663584272710e",
    };
    const headings = [...workflowText.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)];
    expect(
      Object.keys(workflow.jobs)
        .filter((name) => name.includes("production"))
        .sort(),
    ).toEqual(Object.keys(expected).sort());
    for (const [index, heading] of headings.entries()) {
      if (!(heading[1] in expected)) continue;
      const bytes = workflowText.slice(heading.index, headings[index + 1]?.index);
      expect(createHash("sha256").update(bytes).digest("hex"), heading[1]).toBe(expected[heading[1]]);
    }
  });

  it("preserves the production values at the deployment baseline", () => {
    for (const [file, digest] of Object.entries({
      "values.yaml": "58dc4aa5304a62ff7079e72896aac8b8b3e86d41cf72b61581443961331b8ac3",
      "values.production.yaml": "71515689eabc8c257834810ef7fbb65b4f69cc71e054055c9005a08c6dffb81e",
    })) {
      expect(
        createHash("sha256")
          .update(read(`infrastructure/helm/platform/${file}`))
          .digest("hex"),
      ).toBe(digest);
    }
  });

  it.each([
    "Dockerfile.corten-admin",
    "Dockerfile.corten-admin.dockerignore",
    "deployables/corten-pilot/Cargo.toml",
    "deployables/corten-pilot/Cargo.lock",
    "deployables/corten-pilot/admin/src/main.rs",
    "deployables/corten-pilot/platform/src/api.rs",
    "deployables/corten-pilot/scripts/export.mjs",
  ])("selects Platform Deploy for a pilot image input: %s", (file) => {
    expect(classifyChanges({ changedFiles: [file], workspaces: [] }).deployRequired).toBe(true);
  });

  it("keeps the pilot out of base, production and preview values", () => {
    expect(buildPlatformHelmValues().components).not.toHaveProperty("admin-corten");
    expect(buildPlatformHelmProductionValues().components).not.toHaveProperty("admin-corten");
    expect(read("infrastructure/helm/platform/values.preview.yaml")).not.toContain("admin-corten");
    for (const environment of ["production", "preview"]) {
      expect(
        platformKubernetesWorkloads({ envOverrides: { DEPLOYMENT_ENVIRONMENT: environment } }).deployments,
      ).not.toContain("chase-sets-platform-chase-sets-platform-admin-corten");
    }
    expect(
      buildDoksIngressValues({
        environment: "production",
        env: { PRODUCTION_DOKS_INGRESS_TARGET: "192.0.2.1" },
      }).hosts.some(({ host }) => host.includes("corten")),
    ).toBe(false);
    const dns = read("infrastructure/digitalocean/platform/locals.tf");
    expect(dns).toMatch(/app_serving_record_names = local\.is_staging \? toset\(\[\s*"admin-corten"/);
    expect(dns.slice(dns.indexOf("]) : local.is_production ? toset(concat("))).not.toContain('"admin-corten"');
  });

  it("declares the health, host, HTTPS, origin and existing-secret runtime contract", () => {
    const component = buildPlatformHelmStagingValues().components["admin-corten"];
    expect(component).toMatchObject({
      enabled: true,
      kind: "service",
      replicas: 1,
      port: 8080,
      service: { port: 8080 },
      healthPath: "/health/ready",
      livenessPath: "/health/live",
      readinessProbe: { timeoutSeconds: 2 },
      command: "exec /usr/local/bin/corten-pilot-admin",
    });
    const env = Object.fromEntries(component.env.map(({ name, value }) => [name, value]));
    expect(env).toMatchObject({
      HOST: "0.0.0.0",
      PORT: "8080",
      HOSTS: "admin-corten.staging.chasesets.com",
      PUBLIC_PROTO: "https",
      PROXIES: "",
      CHASE_SETS_INTERNAL_API_ORIGIN: "",
      PLATFORM_API_ORIGIN: "",
      ADMIN_WEB_ORIGIN: "https://admin.staging.chasesets.com",
      CHASE_SETS_MARKETPLACE_ORIGIN: "https://marketplace.staging.chasesets.com",
    });
    expect(component.env.filter(({ secret }) => secret)).toEqual([
      { name: "PLATFORM_INTERNAL_AUTH_SECRET", secret: true, secretKey: "PLATFORM_INTERNAL_AUTH_SECRET" },
    ]);
    expect(env).not.toHaveProperty("CHASE_SETS_TRUST_FORWARDED_HEADERS");
    expect(platformKubernetesWorkloads(options).deployments).toContain(
      "chase-sets-platform-chase-sets-platform-admin-corten",
    );
  });

  it("renders the staging Deployment, Service and TLS host without changing production workloads", () => {
    const nativeHelm = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;
    const render = (overlay, extra = []) => {
      const args = ["template", "chase-sets-platform", "infrastructure/helm/platform", "--values", overlay, ...extra];
      const output = execFileSync(
        nativeHelm ? "helm" : "docker",
        nativeHelm
          ? args
          : [
              "run",
              "--rm",
              "--label",
              "agent.owner=codex",
              "--label",
              "agent.task=corten-admin-staging-test",
              "-v",
              `${process.cwd()}:/repo`,
              "-w",
              "/repo",
              "ghcr.io/chase-sets/ci-mirror-helm:3.15.4@sha256:105741fa6621ed9a3ea944066de78bb27d4b9bb93a56ce8e7cb4d621e1e4bbf2",
              ...args,
            ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
      return output
        .split(/^---\s*$/m)
        .map((part) => parse(part))
        .filter(Boolean);
    };
    const args = buildHelmUpgradeArgs({ ...options, env: { ...options.env, DOKS_INGRESS_TARGET: "192.0.2.1" } });
    const staged = render("infrastructure/helm/platform/values.staging.yaml", args.slice(args.indexOf("--values") + 2));
    const name = "chase-sets-platform-chase-sets-platform-admin-corten";
    const deployment = staged.find((item) => item.kind === "Deployment" && item.metadata.name === name);
    const container = deployment.spec.template.spec.containers[0];
    expect(container.image).toBe(image);
    expect(container.readinessProbe.httpGet.path).toBe("/health/ready");
    expect(container.readinessProbe.timeoutSeconds).toBe(2);
    expect(container.livenessProbe.httpGet.path).toBe("/health/live");
    expect(container.env.find(({ name }) => name === "CHASE_SETS_INTERNAL_API_ORIGIN").value).toBe(
      "http://chase-sets-platform-chase-sets-platform-platform-api:8080",
    );
    expect(container.env.find(({ name }) => name === "PLATFORM_API_ORIGIN").value).toBe(
      container.env.find(({ name }) => name === "CHASE_SETS_INTERNAL_API_ORIGIN").value,
    );
    expect(staged.find((item) => item.kind === "Service" && item.metadata.name === name).spec.ports[0].port).toBe(8080);
    const ingress = staged.find(
      (item) =>
        item.kind === "Ingress" && item.spec.rules.some(({ host }) => host === "admin-corten.staging.chasesets.com"),
    );
    expect(ingress.spec.tls[0].hosts).toContain("admin-corten.staging.chasesets.com");
    expect(
      ingress.spec.rules.find(({ host }) => host === "admin-corten.staging.chasesets.com").http.paths.at(-1).backend
        .service.name,
    ).toBe(name);
    const productionArgs = buildHelmUpgradeArgs({
      ...options,
      cortenAdminImage: undefined,
      envOverrides: { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false" },
      env: { ...options.env, PRODUCTION_DOKS_INGRESS_TARGET: "192.0.2.1" },
    });
    expect(
      render(
        "infrastructure/helm/platform/values.production.yaml",
        productionArgs.slice(productionArgs.indexOf("--values") + 2),
      ).some((item) => item.metadata.name === name),
    ).toBe(false);
    expect(() =>
      render("infrastructure/helm/platform/values.staging.yaml", ["--set", "doksIngress.enabled=true"]),
    ).toThrow("component.image is required");
  });

  it("pins the pilot image only on staging and refuses mutable or wrong-repository references", () => {
    expect(buildHelmUpgradeArgs(options)).toContain(`components.admin-corten.image=${image}`);
    expect(parseArgs(["deploy", "--corten-admin-image", image], {}).cortenAdminImage).toBe(image);
    for (const environment of ["production", "preview"]) {
      expect(() => buildHelmUpgradeArgs({ ...options, envOverrides: { DEPLOYMENT_ENVIRONMENT: environment } })).toThrow(
        "staging-only",
      );
    }
    expect(() => buildHelmUpgradeArgs({ ...options, cortenAdminImage: image.split("@")[0] + ":latest" })).toThrow();
    expect(() =>
      buildHelmUpgradeArgs({ ...options, cortenAdminImage: image.replace("corten-admin", "platform") }),
    ).toThrow();
    const helper = read("infrastructure/helm/platform/templates/_helpers.tpl");
    expect(helper).toContain('if hasKey $component "image"');
    expect(helper).toContain('required "component.image is required for separately built components" $component.image');
  });

  it("builds exported assets before the locked Rust binary from pinned existing mirrors", () => {
    const dockerfile = read("Dockerfile.corten-admin");
    const mirrors = JSON.parse(read("scripts/ci-image-sources.json")).sources;
    for (const reference of [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1])) {
      expect(mirrors.some(({ mirror, tag, digest }) => reference === `${mirror}:${tag}@${digest}`)).toBe(true);
    }
    expect(dockerfile.indexOf("pnpm run deps:install")).toBeLessThan(
      dockerfile.indexOf("node --import tsx deployables/corten-pilot/scripts/export.mjs"),
    );
    expect(dockerfile.indexOf("scripts/export.mjs")).toBeLessThan(
      dockerfile.indexOf("cargo build --release --locked -p corten-pilot-admin"),
    );
    expect(dockerfile).toContain("USER node");
    expect(read(".dockerignore")).toContain("\ndeployables/corten-pilot\n");
    expect(read("Dockerfile.corten-admin.dockerignore")).not.toContain("\ndeployables/corten-pilot\n");
  });

  it("requires pilot readiness in both staging ingress wait and admin smoke", () => {
    const steps = workflow.jobs["deploy-staging"].steps;
    const url = "https://admin-corten.staging.chasesets.com/health/ready";
    expect(steps.find(({ name }) => name === "Wait for staging ingress URLs").run).toContain(url);
    const smoke = steps.find(({ name }) => name === "Smoke check").run;
    expect(smoke).toContain(`--url "${url}"`);
    expect(smoke).toContain("node ./scripts/platform-ingress-wait.mjs");
    expect(smoke).toContain("--expect-status 200");
    expect(smoke).toContain('"https://${admin_domain}"');
  });

  it("uses the existing release writer admission and passes its immutable output only to staging", () => {
    const build = workflow.jobs["build-image"];
    const step = build.steps.find(({ id }) => id === "corten_admin_image");
    expect(build.environment).toBe("staging");
    expect(step.run).toContain("digitalocean-registry-gc-gate.mjs assert-writable");
    expect(step.run.indexOf("assert-writable")).toBeLessThan(step.run.indexOf("--push --tag"));
    expect(step.run).toContain("--file Dockerfile.corten-admin");
    expect(step.run).toContain("image=${image}@${digest}");
    const deploy = workflow.jobs["deploy-staging"].steps.find(({ id }) => id === "staging_kubernetes_deploy");
    expect(deploy.env.CORTEN_ADMIN_IMAGE).toBe("${{ needs.build-image.outputs.corten_admin_image }}");
    expect(deploy.run).toContain('--corten-admin-image "$CORTEN_ADMIN_IMAGE"');
    expect(deploy.run).toContain("PROXIES=${ingress_pod_cidrs}");
    expect(deploy.run).toContain('metadata.annotations["network.cilium.io/ipv4-pod-cidr"]');
    expect(deploy.run).toContain("ADMIN_WEB_ORIGIN=https://${admin_domain}");
  });

  describe("ingress pod CIDR discovery", () => {
    const deploy = workflow.jobs["deploy-staging"].steps.find(({ id }) => id === "staging_kubernetes_deploy");
    const filter = deploy.run.match(/ingress_pod_cidrs=[\s\S]*?'([^']+)'/)[1];
    const annotation = (cidr) => ({ "network.cilium.io/ipv4-pod-cidr": cidr });
    const node = (name, spec = {}, annotations = {}) => ({ metadata: { name, annotations }, spec });
    const discover = (items, nodes = ["synthetic-ingress-node"]) =>
      spawnSync("jq", ["-er", "--argjson", "nodes", JSON.stringify(nodes), filter], {
        input: JSON.stringify({ items }),
        encoding: "utf8",
      });

    it.each([{}, { podCIDRs: null }, { podCIDRs: [] }, { podCIDR: "", podCIDRs: [] }])(
      "reads Cilium annotations when spec has no pod CIDRs: %j",
      (spec) => {
        const result = discover([node("synthetic-ingress-node", spec, annotation("192.0.2.0/25"))]);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("192.0.2.0/25");
      },
    );

    it("prefers spec CIDRs, deduplicates and sorts only ingress nodes for PROXIES", () => {
      const result = discover(
        [
          node(
            "synthetic-ingress-node",
            { podCIDRs: ["2001:db8::/64", "192.0.2.0/25"] },
            annotation("198.51.100.0/24"),
          ),
          node("synthetic-ingress-node-2", {}, annotation("192.0.2.0/25")),
          node("synthetic-other-node"),
        ],
        ["synthetic-ingress-node", "synthetic-ingress-node-2"],
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("192.0.2.0/25,2001:db8::/64");
    });

    it.each([undefined, ""])("fails closed if any ingress node has no CIDR (annotation %j)", (cidr) => {
      const result = discover(
        [
          node("synthetic-ingress-node", {}, annotation("192.0.2.0/25")),
          node("synthetic-ingress-node-2", { podCIDRs: [] }, annotation(cidr)),
        ],
        ["synthetic-ingress-node", "synthetic-ingress-node-2"],
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Missing pod CIDR for ingress node: synthetic-ingress-node-2");
    });

    it("fails closed if an ingress node is absent from the node list", () => {
      const result = discover([]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Missing pod CIDR for ingress node: synthetic-ingress-node");
    });
  });
});
