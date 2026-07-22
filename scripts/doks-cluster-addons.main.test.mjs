import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configurationMarkerForStep,
  loadBalancerName,
  pinned,
  planClusterAddons,
  requiredClusterAddons,
} from "./doks-cluster-addons.mjs";

const scriptPath = resolve("scripts", "doks-cluster-addons.mjs");
const temporaryRoots = [];

const fakeCommandPreload = String.raw`
const fs = require("node:fs");
const path = require("node:path");

let command = path.basename(process.argv0).replace(/\.exe$/i, "");
if (command !== "helm" && command !== "kubectl") {
  if (["get", "history", "repo", "upgrade"].includes(process.argv[1])) command = "helm";
  if (process.argv[1] === "apply") command = "kubectl";
}
if (command === "helm" || command === "kubectl") {
  const statePath = process.env.CHASE_SETS_DOKS_FAKE_STATE;
  const logPath = process.env.CHASE_SETS_DOKS_FAKE_LOG;
  const args = process.argv.slice(1);
  args[0] = path.basename(args[0]);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const append = (record) => fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
  const namespace = () => {
    const index = args.indexOf("--namespace");
    return index >= 0 ? args[index + 1] : undefined;
  };
  const matchesPrefix = (prefix) => prefix && prefix.every((value, index) => args[index] === value);

  if (command === "kubectl") {
    const input = fs.readFileSync(0, "utf8");
    const manifest = JSON.parse(input);
    const token = process.env.DIGITALOCEAN_ACCESS_TOKEN;
    append({
      command,
      args,
      stdinBytes: Buffer.byteLength(input),
      rawTokenInStdin: input.includes(token),
      tokenMatches: manifest.data["access-token"] === Buffer.from(token, "utf8").toString("base64"),
    });
    process.exit(0);
  }

  append({ command, args });
  if (matchesPrefix(state.failPrefix)) {
    process.stderr.write("planted full-path failure\n");
    process.exit(state.failCode || 97);
  }

  if (args[0] === "get" && (args[1] === "metadata" || args[1] === "values")) {
    const type = args[1];
    const releaseName = args[2];
    const key = type + ":" + releaseName + ":" + namespace();
    const response = state.responses && state.responses[key];
    if (response) {
      if (response.error) process.stderr.write(response.error + "\n");
      if (response.output !== undefined) process.stdout.write(response.output);
      process.exit(response.exitCode || 0);
    }
    const release = state.releases[releaseName + ":" + namespace()];
    if (!release) {
      process.stderr.write("Error: release: not found\n");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(release[type]));
    process.exit(0);
  }

  if (args[0] === "history") {
    const releaseName = args[1];
    const key = "history:" + releaseName + ":" + namespace();
    const response = state.responses && state.responses[key];
    if (response) {
      if (response.error) process.stderr.write(response.error + "\n");
      if (response.output !== undefined) process.stdout.write(response.output);
      process.exit(response.exitCode || 0);
    }
    const release = state.releases[releaseName + ":" + namespace()];
    if (!release) {
      process.stderr.write("Error: release: not found\n");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify([release.history]));
    process.exit(0);
  }

  if (args[0] === "upgrade") {
    const installIndex = args.indexOf("--install");
    const releaseName = args[installIndex + 1];
    const release = state.releases[releaseName + ":" + namespace()];
    if (!release) {
      process.stderr.write("fake release state is missing for " + releaseName + "\n");
      process.exit(2);
    }
    const descriptionIndex = args.indexOf("--description");
    if (descriptionIndex < 0) {
      process.stderr.write("configuration description is missing\n");
      process.exit(3);
    }
    release.metadata.revision += 1;
    release.history.revision = release.metadata.revision;
    release.history.status = "deployed";
    release.history.description = args[descriptionIndex + 1];
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.exit(0);
  }

  process.exit(0);
}
`;

function recordedHelm3154State(environment) {
  const metadata = {
    "ingress-nginx": {
      name: "ingress-nginx",
      chart: "ingress-nginx",
      version: "4.11.3",
      appVersion: "1.11.3",
      namespace: "ingress-nginx",
      revision: 65,
      status: "deployed",
      deployedAt: "2026-07-22T04:41:21Z",
    },
    "cert-manager": {
      name: "cert-manager",
      chart: "cert-manager",
      version: "v1.16.2",
      appVersion: "v1.16.2",
      namespace: "cert-manager",
      revision: 66,
      status: "deployed",
      deployedAt: "2026-07-22T04:41:35Z",
    },
    "argo-rollouts": {
      name: "argo-rollouts",
      chart: "argo-rollouts",
      version: "2.41.0",
      appVersion: "v1.9.0",
      namespace: "argo-rollouts",
      revision: 64,
      status: "deployed",
      deployedAt: "2026-07-22T04:41:43Z",
    },
    "chase-sets-doks-ingress": {
      name: "chase-sets-doks-ingress",
      chart: "chase-sets-doks-ingress",
      version: "0.1.0",
      appVersion: "0.1.0",
      namespace: "cert-manager",
      revision: 64,
      status: "deployed",
      deployedAt: "2026-07-22T04:41:46Z",
    },
  };
  const chartAndAppVersions = {
    "ingress-nginx": ["ingress-nginx-4.11.3", "1.11.3"],
    "cert-manager": ["cert-manager-v1.16.2", "v1.16.2"],
    "argo-rollouts": ["argo-rollouts-2.41.0", "v1.9.0"],
    "chase-sets-doks-ingress": ["chase-sets-doks-ingress-0.1.0", "0.1.0"],
  };
  const requirements = requiredClusterAddons({ environment });
  return {
    releases: Object.fromEntries(
      requirements.map((required) => {
        const releaseMetadata = structuredClone(metadata[required.releaseName]);
        const [chart, appVersion] = chartAndAppVersions[required.releaseName];
        return [
          `${required.releaseName}:${required.namespace}`,
          {
            metadata: releaseMetadata,
            values: expectedValues(required.releaseName, environment),
            history: {
              revision: releaseMetadata.revision,
              updated: "2026-07-22T04:41:46.787941022Z",
              status: "deployed",
              chart,
              app_version: appVersion,
              description: required.configurationMarker,
            },
          },
        ];
      }),
    ),
    responses: {},
  };
}

function expectedValues(releaseName, environment) {
  if (releaseName === "ingress-nginx") {
    return {
      controller: {
        service: {
          annotations: {
            "service.beta.kubernetes.io/do-loadbalancer-name": loadBalancerName(environment),
          },
        },
      },
    };
  }
  if (releaseName === "chase-sets-doks-ingress") {
    return {
      clusterIssuers: {
        production: {
          dns01: {
            enabled: true,
            dnsZones: [environment === "production" ? "chasesets.com" : "preview.chasesets.com"],
          },
        },
      },
      ...(environment === "staging" ? { previewWildcardCertificate: { enabled: true } } : {}),
    };
  }
  return {};
}

function createHarness(state) {
  const root = mkdtempSync(join(tmpdir(), "chase-sets-doks-main-"));
  temporaryRoots.push(root);
  const statePath = join(root, "state.json");
  const logPath = join(root, "calls.jsonl");
  const preloadPath = join(root, "fake-command-preload.cjs");
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(logPath, "");
  writeFileSync(preloadPath, fakeCommandPreload);

  for (const command of ["helm", "kubectl"]) {
    const executablePath = join(root, process.platform === "win32" ? `${command}.exe` : command);
    try {
      linkSync(process.execPath, executablePath);
    } catch {
      copyFileSync(process.execPath, executablePath);
    }
  }

  return {
    root,
    statePath,
    run(environment, extraArgs = []) {
      writeFileSync(logPath, "");
      const token = randomBytes(32).toString("hex");
      const result = spawnSync(process.execPath, [scriptPath, "--environment", environment, ...extraArgs], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
          NODE_OPTIONS: `--require=${preloadPath}`,
          CHASE_SETS_DOKS_FAKE_STATE: statePath,
          CHASE_SETS_DOKS_FAKE_LOG: logPath,
          DIGITALOCEAN_ACCESS_TOKEN: token,
        },
      });
      const log = readFileSync(logPath, "utf8")
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return {
        result,
        log,
        token,
        encodedToken: Buffer.from(token, "utf8").toString("base64"),
        state: JSON.parse(readFileSync(statePath, "utf8")),
      };
    },
  };
}

function helmMutations(log) {
  return log.filter((call) => call.command === "helm" && (call.args[0] === "repo" || call.args[0] === "upgrade"));
}

function assertSecretAppliedWithoutLeak(run) {
  const kubectlCalls = run.log.filter((call) => call.command === "kubectl");
  expect(kubectlCalls).toHaveLength(1);
  expect(kubectlCalls[0]).toMatchObject({
    args: ["apply", "-f", "-"],
    rawTokenInStdin: false,
    tokenMatches: true,
  });
  const observableOutput = `${run.result.stdout}\n${run.result.stderr}\n${JSON.stringify(run.log)}`;
  expect(observableOutput).not.toContain(run.token);
  expect(observableOutput).not.toContain(run.encodedToken);
}

function installStep(environment, releaseName) {
  return planClusterAddons({ environment }).find(
    (step) => step.command[step.command.indexOf("--install") + 1] === releaseName,
  );
}

function markerForChangedAssignment(environment, releaseName, currentAssignment, changedAssignment) {
  const step = installStep(environment, releaseName);
  const changedStep = { ...step, command: [...step.command] };
  const assignmentIndex = changedStep.command.indexOf(currentAssignment);
  if (assignmentIndex < 0) {
    throw new Error(`Assignment ${currentAssignment} was not found in ${releaseName}.`);
  }
  changedStep.command[assignmentIndex] = changedAssignment;
  const release = Object.values(pinned).find((candidate) => candidate.releaseName === releaseName);
  return configurationMarkerForStep(changedStep, [release.valuesFile]);
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe("doks cluster add-ons real CLI state machine", () => {
  it("recovers from a marker-free rollout, then skips Helm and reconciles a rotated Secret exactly once", () => {
    const state = recordedHelm3154State("production");
    for (const release of Object.values(state.releases)) {
      release.history.description = "Upgrade complete";
    }
    const harness = createHarness(state);

    const firstRollout = harness.run("production");
    expect(firstRollout.result.status).toBe(0);
    expect(firstRollout.result.stdout).toContain("DOKS cluster ingress add-ons installed for production.");
    expect(firstRollout.result.stdout).not.toContain("up to date");
    expect(helmMutations(firstRollout.log).filter((call) => call.args[0] === "upgrade")).toHaveLength(4);
    assertSecretAppliedWithoutLeak(firstRollout);

    const certManagerInstallIndex = firstRollout.log.findIndex(
      (call) => call.command === "helm" && call.args[0] === "upgrade" && call.args.includes("cert-manager"),
    );
    const secretIndex = firstRollout.log.findIndex((call) => call.command === "kubectl");
    const argoInstallIndex = firstRollout.log.findIndex(
      (call) => call.command === "helm" && call.args[0] === "upgrade" && call.args.includes("argo-rollouts"),
    );
    expect(secretIndex).toBeGreaterThan(certManagerInstallIndex);
    expect(secretIndex).toBeLessThan(argoInstallIndex);

    const dayAfterWithRotatedToken = harness.run("production");
    expect(dayAfterWithRotatedToken.result.status).toBe(0);
    expect(dayAfterWithRotatedToken.result.stdout).toContain(
      "DOKS cluster add-ons up to date for production; skipped.",
    );
    expect(helmMutations(dayAfterWithRotatedToken.log)).toHaveLength(0);
    assertSecretAppliedWithoutLeak(dayAfterWithRotatedToken);
    expect(dayAfterWithRotatedToken.token).not.toBe(firstRollout.token);
  }, 15_000);

  it("excludes operational timeouts from the steady-state gate", () => {
    const run = createHarness(recordedHelm3154State("staging")).run("staging", [
      "--install-timeout",
      "99m",
      "--issuer-timeout",
      "77m",
    ]);

    expect(run.result.status).toBe(0);
    expect(run.result.stdout).toContain("DOKS cluster add-ons up to date for staging; skipped.");
    expect(helmMutations(run.log)).toHaveLength(0);
    assertSecretAppliedWithoutLeak(run);
  });

  it.each([
    [
      "missing release",
      (state) =>
        (state.responses["metadata:ingress-nginx:ingress-nginx"] = { exitCode: 1, error: "Error: release: not found" }),
    ],
    [
      "metadata read failure",
      (state) =>
        (state.responses["metadata:ingress-nginx:ingress-nginx"] = { exitCode: 42, error: "metadata unavailable" }),
    ],
    [
      "malformed metadata",
      (state) => (state.responses["metadata:ingress-nginx:ingress-nginx"] = { output: '{"name":"ingress-nginx"}' }),
    ],
    [
      "values read failure",
      (state) =>
        (state.responses["values:ingress-nginx:ingress-nginx"] = { exitCode: 43, error: "values unavailable" }),
    ],
    ["malformed values", (state) => (state.responses["values:ingress-nginx:ingress-nginx"] = { output: "[]" })],
    [
      "history read failure",
      (state) =>
        (state.responses["history:ingress-nginx:ingress-nginx"] = { exitCode: 44, error: "history unavailable" }),
    ],
    ["malformed history", (state) => (state.responses["history:ingress-nginx:ingress-nginx"] = { output: "[]" })],
    ["chart drift", (state) => (state.releases["ingress-nginx:ingress-nginx"].metadata.chart = "other-chart")],
    ["version drift", (state) => (state.releases["cert-manager:cert-manager"].metadata.version = "1.16.2")],
    ["status drift", (state) => (state.releases["ingress-nginx:ingress-nginx"].metadata.status = "failed")],
    [
      "missing marker",
      (state) => (state.releases["ingress-nginx:ingress-nginx"].history.description = "Upgrade complete"),
    ],
    [
      "malformed marker",
      (state) => (state.releases["ingress-nginx:ingress-nginx"].history.description = "chase-sets-doks-addons:v1:bad"),
    ],
    [
      "stale marker",
      (state) =>
        (state.releases["ingress-nginx:ingress-nginx"].history.description =
          `chase-sets-doks-addons:v1:${"0".repeat(64)}`),
    ],
    ["revision drift", (state) => (state.releases["ingress-nginx:ingress-nginx"].history.revision += 1)],
  ])("falls through loudly for %s through real main and executable discovery", (_name, mutate) => {
    const state = recordedHelm3154State("production");
    mutate(state);
    state.failPrefix = ["repo", "add"];
    state.failCode = 97;
    const run = createHarness(state).run("production");

    expect(run.result.status).toBe(1);
    expect(run.result.stdout).not.toContain("up to date");
    expect(run.result.stderr).toContain('Step "add ingress-nginx repo" failed with exit code 97.');
    expect(helmMutations(run.log)).toEqual([
      expect.objectContaining({ command: "helm", args: expect.arrayContaining(["repo", "add"]) }),
    ]);
    expect(run.log.filter((call) => call.command === "kubectl")).toHaveLength(0);
  });

  it.each([
    ["staging", "load balancer", "ingress-nginx"],
    ["staging", "DNS-01 enablement", "chase-sets-doks-ingress"],
    ["staging", "DNS-01 zone", "chase-sets-doks-ingress"],
    ["staging", "preview wildcard", "chase-sets-doks-ingress"],
    ["production", "load balancer", "ingress-nginx"],
    ["production", "DNS-01 enablement", "chase-sets-doks-ingress"],
    ["production", "DNS-01 zone", "chase-sets-doks-ingress"],
  ])("falls through for the opposite %s %s value with canonical file bytes", (environment, control, releaseName) => {
    const state = recordedHelm3154State(environment);
    const releaseKey = `${releaseName}:${pinned[releaseName === "ingress-nginx" ? "ingressNginx" : "clusterIssuers"].namespace}`;
    const release = state.releases[releaseKey];
    let marker;
    if (control === "load balancer") {
      const expected = `controller.service.annotations.service\\.beta\\.kubernetes\\.io/do-loadbalancer-name=${loadBalancerName(environment)}`;
      const oppositeEnvironment = environment === "staging" ? "production" : "staging";
      const opposite = `controller.service.annotations.service\\.beta\\.kubernetes\\.io/do-loadbalancer-name=${loadBalancerName(oppositeEnvironment)}`;
      marker = markerForChangedAssignment(environment, releaseName, expected, opposite);
      release.values.controller.service.annotations["service.beta.kubernetes.io/do-loadbalancer-name"] =
        loadBalancerName(oppositeEnvironment);
    } else if (control === "DNS-01 enablement") {
      marker = markerForChangedAssignment(
        environment,
        releaseName,
        "clusterIssuers.production.dns01.enabled=true",
        "clusterIssuers.production.dns01.enabled=false",
      );
      release.values.clusterIssuers.production.dns01.enabled = false;
    } else if (control === "DNS-01 zone") {
      const expectedZone = environment === "staging" ? "preview.chasesets.com" : "chasesets.com";
      const oppositeZone = environment === "staging" ? "chasesets.com" : "preview.chasesets.com";
      marker = markerForChangedAssignment(
        environment,
        releaseName,
        `clusterIssuers.production.dns01.dnsZones[0]=${expectedZone}`,
        `clusterIssuers.production.dns01.dnsZones[0]=${oppositeZone}`,
      );
      release.values.clusterIssuers.production.dns01.dnsZones[0] = oppositeZone;
    } else {
      marker = markerForChangedAssignment(
        environment,
        releaseName,
        "previewWildcardCertificate.enabled=true",
        "previewWildcardCertificate.enabled=false",
      );
      release.values.previewWildcardCertificate.enabled = false;
    }
    release.history.description = marker;
    state.failPrefix = ["repo", "add"];
    state.failCode = 97;

    const run = createHarness(state).run(environment);
    expect(run.result.status).toBe(1);
    expect(run.result.stdout).not.toContain("up to date");
    expect(run.result.stderr).toContain('Step "add ingress-nginx repo" failed with exit code 97.');
    expect(helmMutations(run.log)).toHaveLength(1);
  });

  it.each(["ingress-nginx", "cert-manager", "argo-rollouts", "chase-sets-doks-ingress"])(
    "falls through when the %s canonical values-file bytes differ",
    (releaseName) => {
      const environment = "production";
      const state = recordedHelm3154State(environment);
      const required = requiredClusterAddons({ environment }).find((release) => release.releaseName === releaseName);
      const step = installStep(environment, releaseName);
      const pinnedRelease = Object.values(pinned).find((release) => release.releaseName === releaseName);
      const harness = createHarness(state);
      const changedValuesFile = join(harness.root, `${basename(pinnedRelease.valuesFile)}.changed`);
      writeFileSync(changedValuesFile, `${readFileSync(pinnedRelease.valuesFile, "utf8")}\n# planted drift\n`);
      state.releases[`${releaseName}:${required.namespace}`].history.description = configurationMarkerForStep(step, [
        changedValuesFile,
      ]);
      state.failPrefix = ["repo", "add"];
      state.failCode = 97;
      writeFileSync(harness.statePath, JSON.stringify(state));
      const run = harness.run(environment);

      expect(run.result.status).toBe(1);
      expect(run.result.stdout).not.toContain("up to date");
      expect(helmMutations(run.log)).toHaveLength(1);
    },
  );
});
