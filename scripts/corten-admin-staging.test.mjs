import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildDoksIngressValues,
  buildPlatformHelmStagingValues,
  buildPlatformHelmValues,
} from "./render-platform-helm-values.mjs";
import {
  ADVISORY_CORTEN_PILOT_COMPONENTS,
  buildDeploymentEvidence,
  buildHelmUpgradeArgs,
  parseArgs,
  platformKubernetesWorkloads,
  recordStagingAdminApp,
  withheldCortenPilots,
} from "./platform-kubernetes-deployment.mjs";
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
      // Moved for the production admin switch: PRODUCTION_ADMIN_APP, the staged Corten admin image, best-effort PROXIES.
      "deploy-production": "1839392f04347528f1c5cedc10be1258157b6340772cc35c7802c674d846f3a4",
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
      "values.yaml": "fc374d3d46b6998cf31a553f16edbdbfd10e1c194f5e0c9e8e3ba1871dccbf6c",
      "values.production.yaml": "653442bfb787b2701df3afccdc816f912f3bb658f063ba9b1a24d2627d59f37c",
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

  it("keeps the pilot out of base and preview values, and out of production's hosts and DNS", () => {
    expect(buildPlatformHelmValues().components).not.toHaveProperty("admin-corten");
    expect(read("infrastructure/helm/platform/values.preview.yaml")).not.toContain("admin-corten");
    expect(
      platformKubernetesWorkloads({ envOverrides: { DEPLOYMENT_ENVIRONMENT: "preview" } }).deployments,
    ).not.toContain("chase-sets-platform-chase-sets-platform-admin-corten");
    // Production takes over admin.chasesets.com itself (corten-admin-production.test.mjs); it has no pilot host.
    expect(
      buildDoksIngressValues({
        environment: "production",
        env: { PRODUCTION_DOKS_INGRESS_TARGET: "192.0.2.1", PRODUCTION_ADMIN_APP: "admin-corten" },
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
      HOSTS: "admin-corten.staging.chasesets.com,admin.staging.chasesets.com",
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

  it("pins the pilot image only on staging and production and refuses mutable or wrong-repository references", () => {
    expect(buildHelmUpgradeArgs(options)).toContain(`components.admin-corten.image=${image}`);
    expect(parseArgs(["deploy", "--corten-admin-image", image], {}).cortenAdminImage).toBe(image);
    expect(() => buildHelmUpgradeArgs({ ...options, envOverrides: { DEPLOYMENT_ENVIRONMENT: "preview" } })).toThrow(
      "corten-admin-image is staging and production only.",
    );
    // Production under its default (admin-web) does not deploy the pilot, whatever image it was given.
    const production = buildHelmUpgradeArgs({ ...options, envOverrides: { DEPLOYMENT_ENVIRONMENT: "production" } });
    expect(production.filter((arg) => String(arg).startsWith("components.admin-corten."))).toEqual([
      "components.admin-corten.enabled=false",
    ]);
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

  it("requires pilot readiness in both staging ingress wait and admin smoke unless admin-web serves admin", () => {
    const steps = workflow.jobs["deploy-staging"].steps;
    const url = "https://admin-corten.staging.chasesets.com/health/ready";
    const adminApp = "${{ steps.staging_kubernetes_deploy.outputs.admin_app }}";
    const gate = 'if [ "$ADMIN_APP" != "admin-web" ]; then';
    const wait = steps.find(({ name }) => name === "Wait for staging ingress URLs");
    expect(wait.env.ADMIN_APP).toBe(adminApp);
    // Under admin-web the pilot is not deployed at all, so no image can bring it back into the wait or smoke.
    expect(wait.env).not.toHaveProperty("CORTEN_ADMIN_IMAGE");
    expect(wait.run).toContain(`${gate}\n  ingress_urls+=("${url}")\nfi`);
    expect(wait.run.split(url)).toHaveLength(2);
    const smoke = steps.find(({ name }) => name === "Smoke check");
    expect(smoke.env.ADMIN_APP).toBe(adminApp);
    expect(smoke.env).not.toHaveProperty("CORTEN_ADMIN_IMAGE");
    expect(smoke.run).toContain(
      `${gate}\n  node ./scripts/platform-ingress-wait.mjs \\\n    --attempts 1 \\\n    --expect-status 200 \\\n    --url "${url}"\nfi`,
    );
    expect(smoke.run.split(url)).toHaveLength(2);
    // The gates read the deploy step's resolved app, never the raw variable, so they agree with the ingress.
    for (const step of [wait, smoke]) {
      expect(step.run).not.toMatch(/\$\{?STAGING_ADMIN_APP/);
      expect(step.run).not.toContain("CORTEN_ADMIN_IMAGE");
    }
    // Each conditional gate names the rule that makes the pilot advisory.
    const pointer =
      "# admin-corten runs only while it serves admin.staging; under STAGING_ADMIN_APP=admin-web it is not deployed (withheldCortenPilots).";
    const advisory = steps.find(({ name }) => name === "Advisory Corten admin smoke");
    for (const run of [wait.run, smoke.run, advisory.run]) {
      expect(run.split(pointer)).toHaveLength(2);
    }
    // The enforcing smoke runs the admin smoke against admin.staging, whichever app serves it.
    expect(smoke.env.SMOKE_REQUIRE_ADMIN).toBe("true");
    expect(smoke.run).toContain('"https://${admin_domain}"');
  });

  it("keeps the advisory admin smoke step after the Smoke check, smoking nothing and saying why", () => {
    const steps = workflow.jobs["deploy-staging"].steps;
    const names = steps.map(({ name }) => name);
    const advisory = steps.find(({ name }) => name === "Advisory Corten admin smoke");
    expect(names.indexOf("Advisory Corten admin smoke")).toBe(names.indexOf("Smoke check") + 1);
    expect(advisory["continue-on-error"]).toBe(true);
    expect(advisory.if).toBe(steps.find(({ name }) => name === "Smoke check").if);

    const secrets = Object.values(advisory.env)
      .flatMap((value) => [...String(value).matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]))
      .sort();
    expect(secrets).toEqual(
      [
        "DIGITALOCEAN_ACCESS_TOKEN",
        "PLATFORM_ADMIN_EMAIL",
        "PLATFORM_ADMIN_PASSWORD",
        "SPACES_ACCESS_ID",
        "SPACES_ACCESS_ID",
        "SPACES_SECRET_KEY",
        "SPACES_SECRET_KEY",
      ].sort(),
    );
    expect(advisory.run).not.toMatch(/PLATFORM_ADMIN_(EMAIL|PASSWORD)/);
    expect(advisory.run).not.toContain("set -x");
    expect(advisory.env).not.toHaveProperty("CORTEN_ADMIN_IMAGE");
    expect(advisory.env.ADMIN_APP).toBe("${{ steps.staging_kubernetes_deploy.outputs.admin_app }}");
    // While the pilot serves admin.staging the Smoke check smoked it with the admin required. Under admin-web the
    // pilot is not deployed, so there is nothing to smoke; either way the step only says which case applied.
    expect(advisory.run).toBe(
      [
        "set -euo pipefail",
        "# admin-corten runs only while it serves admin.staging; under STAGING_ADMIN_APP=admin-web it is not deployed (withheldCortenPilots).",
        'if [ "$ADMIN_APP" != "admin-web" ]; then',
        '  echo "admin-corten serves admin.staging, so the Smoke check above smoked it with the admin required."',
        "  exit 0",
        "fi",
        'echo "admin-web serves admin.staging (STAGING_ADMIN_APP=admin-web), so admin-corten is not deployed and is not smoked."',
        "",
      ].join("\n"),
    );
  });
  it("uses the existing release writer admission and passes its immutable output only to staging", () => {
    const build = workflow.jobs["build-corten-pilot-images"];
    const gate = build.steps.find(({ id }) => id === "corten_pilot_gate");
    const push = build.steps.find(({ id }) => id === "corten_pilot_push");
    const publish = build.steps.find(({ id }) => id === "corten_pilot_image");
    expect(build.environment).toBe("staging");
    expect(build.strategy).toEqual({ "fail-fast": false, matrix: { pilot: ["admin", "marketplace", "public"] } });
    expect(build.outputs.corten_admin_image).toBe("${{ steps.corten_pilot_image.outputs.corten_admin_image }}");
    // The registry admission runs before, and in a different step from, the write; a refusal skips the push.
    expect(gate.run).toContain("digitalocean-registry-gc-gate.mjs assert-writable");
    expect(gate.run).not.toContain("--push");
    expect(gate.run).not.toContain("doctl registry create");
    expect(build.steps.indexOf(gate)).toBeLessThan(build.steps.indexOf(push));
    expect(push.if).toBe("steps.corten_pilot_gate.outcome == 'success'");
    expect(push.env.IMAGE).toBe("${{ steps.corten_pilot_gate.outputs.image }}");
    expect(push.run).toContain('--file "Dockerfile.corten-${PILOT}"');
    expect(push.run).toContain('--cache-from "type=gha,scope=corten-${PILOT}-image"');
    expect(push.run).toContain('echo "image=${IMAGE}@${digest}"');
    // The reference reaches the job output only after a successful push.
    expect(publish.if).toBe("steps.corten_pilot_push.outcome == 'success'");
    expect(publish.env).toMatchObject({
      IMAGE_REF: "${{ steps.corten_pilot_push.outputs.image }}",
      PILOT: "${{ matrix.pilot }}",
    });
    expect(publish.run).toContain('echo "corten_${PILOT}_image=${IMAGE_REF}"');
    expect(
      build.steps.filter(({ run }) => String(run ?? "").includes("GITHUB_OUTPUT") && String(run).includes("corten_")),
    ).toEqual([publish]);
    const deploy = workflow.jobs["deploy-staging"].steps.find(({ id }) => id === "staging_kubernetes_deploy");
    expect(deploy.env.CORTEN_ADMIN_IMAGE).toBe("${{ needs.build-corten-pilot-images.outputs.corten_admin_image }}");
    expect(deploy.run).toContain(
      'if [ -n "$CORTEN_ADMIN_IMAGE" ]; then\n  corten_image_args+=(--corten-admin-image "$CORTEN_ADMIN_IMAGE")',
    );
    expect(deploy.run).toContain('"${corten_image_args[@]}" \\\n');
    expect(deploy.run).toContain("PROXIES=${ingress_pod_cidrs}");
    expect(deploy.run).toContain('metadata.annotations["network.cilium.io/ipv4-pod-cidr"]');
    expect(deploy.run).toContain("ADMIN_WEB_ORIGIN=https://${admin_domain}");
  });

  it("builds the pilot images beside the release image, where neither their failure nor their delay reaches production", () => {
    const jobs = workflow.jobs;
    const pilot = jobs["build-corten-pilot-images"];
    expect(pilot.needs).toEqual(jobs["build-image"].needs);
    expect(pilot.if).toBe(jobs["build-image"].if);
    // The job itself never fails: every step continues on error under its own limit, and the job's limit is
    // above their sum, so only a runner-level failure can fail it. No job-level continue-on-error is relied on.
    expect(pilot).not.toHaveProperty("continue-on-error");
    for (const step of pilot.steps) {
      expect(step["continue-on-error"], step.name ?? step.uses).toBe(true);
      expect(step["timeout-minutes"], step.name ?? step.uses).toBeGreaterThan(0);
    }
    const stepMinutes = pilot.steps.reduce((total, step) => total + step["timeout-minutes"], 0);
    expect(pilot["timeout-minutes"]).toBeGreaterThan(stepMinutes);
    expect(pilot.steps.find(({ id }) => id === "corten_pilot_push")["timeout-minutes"]).toBe(15);

    expect(jobs["deploy-staging"].needs).toEqual(["resolve-release", "build-image", "build-corten-pilot-images"]);
    expect(jobs["deploy-staging"].if).toBe(
      "!cancelled() && " +
        "needs.resolve-release.result == 'success' && " +
        "needs.build-image.result == 'success' && " +
        "needs.resolve-release.outputs.deployment_required == 'true'",
    );
    expect(jobs["deploy-staging"].if).not.toContain("always()");
    expect(JSON.stringify(jobs["deploy-staging"].if)).not.toContain("build-corten-pilot-images");

    // Deploy Production's gate is byte-for-byte unchanged, and only Deploy Staging names the pilot job.
    const heading = workflowText.indexOf("\n  deploy-production:\n");
    expect(workflowText.slice(heading, workflowText.indexOf("    environment:", heading))).toContain(
      "    needs:\n      - resolve-release\n      - deploy-staging\n    if: needs.deploy-staging.outputs.deployed == 'true'\n",
    );
    const dependants = Object.entries(jobs)
      .filter(([, job]) => [job.needs ?? []].flat().includes("build-corten-pilot-images"))
      .map(([name]) => name);
    expect(dependants).toEqual(["deploy-staging"]);
  });

  describe("pilot image steps, run in order with stubbed registry tools", () => {
    const steps = workflow.jobs["build-corten-pilot-images"].steps;
    const step = (id) => steps.find((candidate) => candidate.id === id);
    const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe" : "bash";
    const digestValue = "sha256:" + "c".repeat(64);
    // The stubs record each call. The registry has the image when $REGISTRY_HAS_IMAGE says so, or once a push ran.
    const stubs = [
      'doctl() { echo "doctl $*" >> "$CALLS"; if [ "$1 $2" = "registry get" ]; then echo chase-sets; fi; }',
      "docker() {",
      '  echo "docker $*" >> "$CALLS"',
      '  if [ "$2" = "build" ]; then touch "$PUSHED"; return 0; fi',
      '  if [ "$REGISTRY_HAS_IMAGE" != true ] && [ ! -e "$PUSHED" ]; then return 1; fi',
      '  case "$*" in *--format*) echo "$DIGEST_VALUE" ;; esac',
      "}",
      'node() { echo "node $*" >> "$CALLS"; return "$GATE_EXIT"; }',
    ].join("\n");
    // Bash's own tools first on PATH, and no ambient credential reaches the stubbed steps.
    const ambientPath = process.env.PATH ?? process.env.Path ?? "";
    const shellEnv = (extra) => {
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name.toLowerCase() !== "path" && !/(?:DIGITALOCEAN|GITHUB|TOKEN|SECRET|PASSWORD)/i.test(name),
        ),
      );
      const shellDirectory = process.platform === "win32" ? dirname(bash) : null;
      return {
        ...environment,
        ...extra,
        PATH: shellDirectory ? `${shellDirectory}${delimiter}${ambientPath}` : ambientPath,
      };
    };
    const readFile = (path) =>
      spawnSync(bash, ["-c", 'cat "$1" 2>/dev/null || true', "read", path], { encoding: "utf8", env: shellEnv({}) })
        .stdout;
    // Runs one step's script; returns its exit code and the outputs it wrote.
    const runStep = (id, env, scratch) => {
      const output = `${scratch}/output-${id}`;
      const result = spawnSync(bash, ["-c", `${stubs}\n${step(id).run}`], {
        encoding: "utf8",
        cwd: scratch,
        env: shellEnv({ ...env, GITHUB_OUTPUT: output }),
      });
      const outputs = Object.fromEntries(
        readFile(output)
          .split("\n")
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      return { status: result.status, outputs };
    };
    // The workflow's step conditions, read from the steps themselves rather than restated.
    const runsAfter = (id, outcomes) => {
      const condition = /^steps\.([a-z_]+)\.outcome == 'success'$/.exec(step(id).if);
      return outcomes[condition[1]] === "success";
    };
    const runLeg = ({ registryHasImage, gateExit }) => {
      const scratch = mkdtempSync(join(tmpdir(), "corten-pilot-image-"));
      try {
        const base = {
          CALLS: `${scratch}/calls`,
          PUSHED: `${scratch}/pushed`,
          REGISTRY_HAS_IMAGE: String(registryHasImage),
          GATE_EXIT: String(gateExit),
          DIGEST_VALUE: digestValue,
          PILOT: "admin",
          RELEASE_COMMIT: "r".repeat(40),
        };
        const outcomes = {};
        const gate = runStep("corten_pilot_gate", base, scratch);
        outcomes.corten_pilot_gate = gate.status === 0 ? "success" : "failure";
        let published = {};
        if (runsAfter("corten_pilot_push", outcomes)) {
          const push = runStep(
            "corten_pilot_push",
            { ...base, IMAGE: gate.outputs.image, IMAGE_EXISTS: gate.outputs.exists ?? "" },
            scratch,
          );
          outcomes.corten_pilot_push = push.status === 0 ? "success" : "failure";
          if (runsAfter("corten_pilot_image", outcomes)) {
            published = runStep("corten_pilot_image", { ...base, IMAGE_REF: push.outputs.image }, scratch).outputs;
          }
        }
        return { outcomes, published, calls: readFile(base.CALLS) };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    };
    const image = "registry.digitalocean.com/chase-sets/chase-sets-corten-admin:" + "r".repeat(40);

    it("publishes an image a rerun finds already pushed, without a gate or a write", () => {
      const { outcomes, published, calls } = runLeg({ registryHasImage: true, gateExit: 0 });
      expect(outcomes).toEqual({ corten_pilot_gate: "success", corten_pilot_push: "success" });
      expect(published).toEqual({ corten_admin_image: image + "@" + digestValue });
      expect(calls).not.toContain("assert-writable");
      expect(calls).not.toContain("buildx build");
    });

    it("admits, builds and publishes a new image", () => {
      const { published, calls } = runLeg({ registryHasImage: false, gateExit: 0 });
      expect(published).toEqual({ corten_admin_image: image + "@" + digestValue });
      expect(calls.indexOf("assert-writable")).toBeGreaterThan(-1);
      expect(calls.indexOf("assert-writable")).toBeLessThan(calls.indexOf("buildx build"));
    });

    it("never writes or publishes after the gate refuses", () => {
      const { outcomes, published, calls } = runLeg({ registryHasImage: false, gateExit: 1 });
      expect(outcomes).toEqual({ corten_pilot_gate: "failure" });
      expect(published).toEqual({});
      expect(calls).toContain("assert-writable");
      expect(calls).not.toContain("buildx build");
    });
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

describe("the staging admin app switch", () => {
  const withoutAdminImage = { ...options, cortenAdminImage: undefined };
  const withApp = (base, STAGING_ADMIN_APP) => ({ ...base, env: { ...base.env, STAGING_ADMIN_APP } });

  it("reads STAGING_ADMIN_APP from the staging environment's variables for the whole Deploy Staging job", () => {
    const job = workflow.jobs["deploy-staging"];
    expect(job.environment).toBe("staging");
    expect(job.env.STAGING_ADMIN_APP).toBe("${{ vars.STAGING_ADMIN_APP || '' }}");
    expect(job.outputs.admin_app).toBe("${{ steps.staging_kubernetes_deploy.outputs.admin_app }}");
    const deploy = job.steps.find(({ id }) => id === "staging_kubernetes_deploy");
    expect(deploy.run).toContain('--github-summary "$GITHUB_STEP_SUMMARY" \\\n');
    // Only the deploy step reads the variable, through the script, so one resolution decides the ingress and the gates.
    for (const step of job.steps) expect(String(step.run ?? "")).not.toMatch(/\$\{?STAGING_ADMIN_APP/);
  });

  it("keeps admin-corten off the advisory list and withholds it only while admin-web serves admin.staging", () => {
    expect(ADVISORY_CORTEN_PILOT_COMPONENTS).toEqual(["marketplace-corten", "public-corten"]);
    const staging = (env) => withheldCortenPilots({ ...options, env });
    expect(staging({})).toEqual([]);
    expect(staging({ STAGING_ADMIN_APP: "admin-corten" })).toEqual([]);
    expect(staging({ STAGING_ADMIN_APP: "admin-web" })).toEqual(["admin-corten"]);
    expect(() => staging({ STAGING_ADMIN_APP: "admin" })).toThrow("STAGING_ADMIN_APP must be one of");
  });

  it("fails a deploy without the admin image while the pilot serves admin.staging", () => {
    for (const value of [undefined, "", "admin-corten"]) {
      expect(() => buildHelmUpgradeArgs(withApp(withoutAdminImage, value))).toThrow(
        "corten-admin-image is required on staging: admin-corten is not an advisory pilot.",
      );
    }
  });

  it("renders the pilot disabled while admin-web serves admin.staging, whether or not its image was given", () => {
    // helm --wait --atomic waits for every enabled pod, so a pilot that never becomes ready would fail the rollback.
    for (const base of [withoutAdminImage, options]) {
      const args = buildHelmUpgradeArgs(withApp(base, "admin-web"));
      expect(args[args.indexOf("components.admin-corten.enabled=false") - 1]).toBe("--set");
      expect(args.filter((arg) => String(arg).startsWith("components.admin-corten."))).toEqual([
        "components.admin-corten.enabled=false",
      ]);
    }
    expect(buildHelmUpgradeArgs(options)).toContain(`components.admin-corten.image=${image}`);
    expect(buildHelmUpgradeArgs(options)).not.toContain("components.admin-corten.enabled=false");
  });

  it("refuses any other value before Helm runs", () => {
    for (const value of ["admin", "ADMIN-WEB", "public-web", "admin-corten,admin-web"]) {
      expect(() => buildHelmUpgradeArgs(withApp(options, value))).toThrow("STAGING_ADMIN_APP must be one of");
    }
  });

  it("routes admin.staging to the selected app in the Helm arguments", () => {
    const adminRoot = (STAGING_ADMIN_APP) => {
      const args = buildHelmUpgradeArgs({
        ...options,
        env: { ...options.env, DOKS_INGRESS_TARGET: "192.0.2.1", STAGING_ADMIN_APP },
      });
      const hostIndex = args.find((arg) =>
        /^doksIngress\.hosts\[\d+\]\.host=admin\.staging\.chasesets\.com$/.test(arg),
      );
      const host = hostIndex.match(/hosts\[(\d+)\]/)[1];
      const services = args.filter(
        (arg) => arg.startsWith(`doksIngress.hosts[${host}].paths[`) && arg.includes(".service="),
      );
      return services.at(-1).split("=")[1];
    };
    expect(adminRoot(undefined)).toBe("admin-corten");
    expect(adminRoot("admin-web")).toBe("admin-web");
  });

  it("says which app served admin and why, in the summary, the step output and the deploy record", () => {
    const dir = mkdtempSync(join(tmpdir(), "staging-admin-app-"));
    try {
      const record = (env) => {
        const summary = join(dir, `summary-${env.STAGING_ADMIN_APP ?? "unset"}.md`);
        const output = join(dir, `output-${env.STAGING_ADMIN_APP ?? "unset"}.txt`);
        const result = recordStagingAdminApp({ env, githubSummaryPath: summary, githubOutputPath: output });
        return { result, summary: read(summary), output: read(output) };
      };
      const unset = record({});
      expect(unset.result).toEqual({ app: "admin-corten", source: "default", adminCorten: "deployed" });
      expect(unset.summary).toContain(
        "admin.staging is served by admin-corten (STAGING_ADMIN_APP is unset, so the default applies).",
      );
      expect(unset.output).toBe("admin_app=admin-corten\nadmin_app_source=default\n");
      expect(unset.summary).not.toContain("not deployed");
      const rolledBack = record({ STAGING_ADMIN_APP: "admin-web" });
      expect(rolledBack.result).toEqual({ app: "admin-web", source: "variable", adminCorten: "not-deployed" });
      expect(rolledBack.summary).toBe(
        "### Staging admin app\n\n" +
          "admin.staging is served by admin-web (STAGING_ADMIN_APP=admin-web).\n\n" +
          "admin-corten is not deployed while admin-web serves admin.staging.\n\n",
      );
      expect(rolledBack.output).toBe("admin_app=admin-web\nadmin_app_source=variable\n");
      expect(() => record({ STAGING_ADMIN_APP: "admin" })).toThrow("STAGING_ADMIN_APP must be one of");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const evidence = (env) => buildDeploymentEvidence({ ...options, env, workloads: {} }).stagingAdminApp;
    expect(evidence({})).toEqual({ app: "admin-corten", source: "default", adminCorten: "deployed" });
    expect(evidence({ STAGING_ADMIN_APP: "admin-web" })).toEqual({
      app: "admin-web",
      source: "variable",
      adminCorten: "not-deployed",
    });
    expect(
      buildDeploymentEvidence({ ...options, envOverrides: { DEPLOYMENT_ENVIRONMENT: "production" }, workloads: {} }),
    ).not.toHaveProperty("stagingAdminApp");
    // parseArgs reads the summary path only from the flag, so no other command writes a summary by inheriting it.
    expect(parseArgs(["deploy", "--github-summary", "s.md"], {}).githubSummaryPath).toBe("s.md");
    expect(parseArgs(["deploy"], { GITHUB_STEP_SUMMARY: "s.md" }).githubSummaryPath).toBeUndefined();
  });

  it("writes the rollback steps the runbook promises", () => {
    const runbook = read("docs/runbooks/staging-admin-app.md");
    expect(runbook).toContain(
      "gh variable set STAGING_ADMIN_APP --repo chase-sets/chase-sets --env staging --body admin-web",
    );
    expect(runbook).toContain("gh variable delete STAGING_ADMIN_APP --repo chase-sets/chase-sets --env staging");
    expect(runbook).toContain("-f force_deploy=true");
    expect(read("docs/README.md")).toContain("(./runbooks/staging-admin-app.md)");
  });
});
