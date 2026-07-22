import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDoksDnsTokenSecret,
  buildDoksDnsTokenSecretManifest,
  canonicalValuesChecksum,
  clusterAddonsAreUpToDate,
  configurationMarkerForStep,
  doksDnsTokenSecretName,
  doksDnsTokenSecretNamespace,
  dryRunOutput,
  installStepsWithConfigurationMarkers,
  loadBalancerName,
  materialOverridesFromCommand,
  parseReleaseHistory,
  parseReleaseMetadata,
  pinned,
  planClusterAddons,
  requiredClusterAddons,
} from "./doks-cluster-addons.mjs";

const ingressNginxValues = readFileSync(
  resolve("infrastructure", "helm", "doks-ingress", "ingress-nginx-values.yaml"),
  "utf8",
);

describe("doks cluster addons planner", () => {
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

  describe("steady-state release preflight", () => {
    // Recorded from Helm v3.15.4 against the production DOKS releases on
    // 2026-07-22. Keep the provider's exact JSON field names and separate
    // chart/version fields; history intentionally has a different shape.
    const recordedHelm3154Metadata = {
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

    const recordedHelm3154History = {
      "ingress-nginx": {
        revision: 65,
        updated: "2026-07-22T04:41:21.556635702Z",
        status: "deployed",
        chart: "ingress-nginx-4.11.3",
        app_version: "1.11.3",
        description: "Upgrade complete",
      },
      "cert-manager": {
        revision: 66,
        updated: "2026-07-22T04:41:35.740925828Z",
        status: "deployed",
        chart: "cert-manager-v1.16.2",
        app_version: "v1.16.2",
        description: "Upgrade complete",
      },
      "argo-rollouts": {
        revision: 64,
        updated: "2026-07-22T04:41:43.294727581Z",
        status: "deployed",
        chart: "argo-rollouts-2.41.0",
        app_version: "v1.9.0",
        description: "Upgrade complete",
      },
      "chase-sets-doks-ingress": {
        revision: 64,
        updated: "2026-07-22T04:41:46.787941022Z",
        status: "deployed",
        chart: "chase-sets-doks-ingress-0.1.0",
        app_version: "0.1.0",
        description: "Upgrade complete",
      },
    };

    function expectedReleaseValues(releaseName, environment) {
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

    function deployedReleaseResponses(environment = "staging", overrides = {}) {
      const required = requiredClusterAddons({ environment });
      return new Map(
        required.flatMap((release) => [
          [
            `metadata:${release.releaseName}:${release.namespace}`,
            overrides[release.releaseName]?.metadataOutput ??
              JSON.stringify({
                ...recordedHelm3154Metadata[release.releaseName],
                ...overrides[release.releaseName]?.metadata,
              }),
          ],
          [
            `values:${release.releaseName}:${release.namespace}`,
            overrides[release.releaseName]?.valuesOutput ??
              JSON.stringify(
                overrides[release.releaseName]?.values ?? expectedReleaseValues(release.releaseName, environment),
              ),
          ],
          [
            `history:${release.releaseName}:${release.namespace}`,
            overrides[release.releaseName]?.historyOutput ??
              JSON.stringify([
                {
                  ...recordedHelm3154History[release.releaseName],
                  description: release.configurationMarker,
                  ...overrides[release.releaseName]?.history,
                },
              ]),
          ],
        ]),
      );
    }

    function helmReader(responses) {
      return async (_command, args) => {
        const type = args[0] === "history" ? "history" : args[1];
        const releaseName = args[0] === "history" ? args[1] : args[2];
        const namespace = args[0] === "history" ? args[3] : args[4];
        const key = `${type}:${releaseName}:${namespace}`;
        const response = responses.get(key);
        if (response instanceof Error) {
          throw response;
        }
        if (response === undefined) {
          throw new Error(`missing response for ${key}`);
        }
        return response;
      };
    }

    it("parses Helm v3.15.4 metadata and history using their distinct provider shapes", () => {
      const metadata = parseReleaseMetadata(JSON.stringify(recordedHelm3154Metadata["cert-manager"]));
      const history = parseReleaseHistory(JSON.stringify([recordedHelm3154History["cert-manager"]]));

      expect(metadata).toMatchObject({ chart: "cert-manager", version: "v1.16.2", appVersion: "v1.16.2" });
      expect(history).toMatchObject({ chart: "cert-manager-v1.16.2", app_version: "v1.16.2" });
    });

    it("skips Helm mutations when every release has the pinned metadata, material values, and marker", async () => {
      const responses = deployedReleaseResponses("production");
      const calls = [];
      const upToDate = await clusterAddonsAreUpToDate({
        environment: "production",
        runCommand: async (command, args) => {
          calls.push([command, args]);
          return helmReader(responses)(command, args);
        },
      });

      expect(upToDate).toBe(true);
      expect(calls).toHaveLength(requiredClusterAddons({ environment: "production" }).length * 3);
      expect(calls).toContainEqual([
        "helm",
        ["get", "metadata", "ingress-nginx", "--namespace", "ingress-nginx", "--output", "json"],
      ]);
      expect(calls).toContainEqual([
        "helm",
        ["history", "cert-manager", "--namespace", "cert-manager", "--max", "1", "--output", "json"],
      ]);
      expect(calls.every(([, args]) => !args.includes("upgrade") && !args.includes("repo"))).toBe(true);
    });

    it("falls through when a deployed chart version differs from the pinned metadata", async () => {
      const responses = deployedReleaseResponses("staging", {
        "cert-manager": { metadata: { version: "v1.16.1" } },
      });
      await expect(clusterAddonsAreUpToDate({ runCommand: helmReader(responses) })).resolves.toBe(false);
    });

    it("falls through when a required release is missing", async () => {
      const responses = deployedReleaseResponses();
      responses.delete("metadata:argo-rollouts:argo-rollouts");
      await expect(clusterAddonsAreUpToDate({ runCommand: helmReader(responses) })).resolves.toBe(false);
    });

    it("falls through when Helm metadata cannot be read or is malformed", async () => {
      const readFailure = deployedReleaseResponses();
      readFailure.set("metadata:ingress-nginx:ingress-nginx", new Error("cluster unavailable"));
      await expect(clusterAddonsAreUpToDate({ runCommand: helmReader(readFailure) })).resolves.toBe(false);

      const malformed = deployedReleaseResponses();
      malformed.set("metadata:ingress-nginx:ingress-nginx", '{"name":"ingress-nginx"}');
      await expect(clusterAddonsAreUpToDate({ runCommand: helmReader(malformed) })).resolves.toBe(false);
    });

    it("falls through when Helm values or history cannot be read or parsed", async () => {
      const valuesReadFailure = deployedReleaseResponses();
      valuesReadFailure.set("values:ingress-nginx:ingress-nginx", new Error("values unavailable"));
      await expect(clusterAddonsAreUpToDate({ runCommand: helmReader(valuesReadFailure) })).resolves.toBe(false);

      const malformedValues = deployedReleaseResponses("staging", {
        "ingress-nginx": { valuesOutput: "[]" },
      });
      await expect(clusterAddonsAreUpToDate({ runCommand: helmReader(malformedValues) })).resolves.toBe(false);

      const historyReadFailure = deployedReleaseResponses();
      historyReadFailure.set("history:ingress-nginx:ingress-nginx", new Error("history unavailable"));
      await expect(clusterAddonsAreUpToDate({ runCommand: helmReader(historyReadFailure) })).resolves.toBe(false);

      const malformedHistory = deployedReleaseResponses("staging", {
        "ingress-nginx": { historyOutput: "[]" },
      });
      await expect(clusterAddonsAreUpToDate({ runCommand: helmReader(malformedHistory) })).resolves.toBe(false);
    });

    it("falls through when the release marker is missing, malformed, or stale", async () => {
      for (const description of [
        "",
        "chase-sets-doks-addons:v1:not-a-sha",
        `chase-sets-doks-addons:v1:${"0".repeat(64)}`,
      ]) {
        const responses = deployedReleaseResponses("staging", {
          "ingress-nginx": { history: { description } },
        });
        await expect(clusterAddonsAreUpToDate({ runCommand: helmReader(responses) })).resolves.toBe(false);
      }
    });

    it("falls through when material values disagree with the expected environment plan", async () => {
      const wrongLoadBalancer = deployedReleaseResponses("production", {
        "ingress-nginx": { values: expectedReleaseValues("ingress-nginx", "staging") },
      });
      await expect(
        clusterAddonsAreUpToDate({ environment: "production", runCommand: helmReader(wrongLoadBalancer) }),
      ).resolves.toBe(false);

      const wrongIssuers = deployedReleaseResponses("staging", {
        "chase-sets-doks-ingress": {
          values: {
            clusterIssuers: { production: { dns01: { enabled: false, dnsZones: ["chasesets.com"] } } },
            previewWildcardCertificate: { enabled: false },
          },
        },
      });
      await expect(
        clusterAddonsAreUpToDate({ environment: "staging", runCommand: helmReader(wrongIssuers) }),
      ).resolves.toBe(false);
    });

    it("keeps the staging and production dry-run output byte-for-byte on the preflight-free install contract", () => {
      for (const environment of ["staging", "production"]) {
        const expected = JSON.stringify(
          {
            environment,
            loadBalancerName: loadBalancerName(environment),
            steps: planClusterAddons({ environment }).map((step) => ({
              name: step.name,
              command: step.command.join(" "),
            })),
          },
          null,
          2,
        );
        const output = dryRunOutput({ environment });
        expect(output).toBe(expected);
        expect(output).not.toContain("--description");
        expect(output).not.toContain("chase-sets-doks-addons:v1:");
      }
    });

    it("fingerprints every values file and material override while excluding operational timeouts", () => {
      for (const environment of ["staging", "production"]) {
        const defaultRequirements = requiredClusterAddons({ environment });
        const timeoutSteps = planClusterAddons({ environment, installTimeout: "99m", issuerTimeout: "77m" });
        const timeoutRequirements = requiredClusterAddons({ environment, steps: timeoutSteps });
        expect(timeoutRequirements.map((release) => release.configurationMarker)).toEqual(
          defaultRequirements.map((release) => release.configurationMarker),
        );

        for (const release of defaultRequirements) {
          const pinnedRelease = Object.values(pinned).find((entry) => entry.releaseName === release.releaseName);
          expect(canonicalValuesChecksum(pinnedRelease.valuesFile)).toMatch(/^[a-f0-9]{64}$/);
          expect(release.configurationMarker).toMatch(/^chase-sets-doks-addons:v1:[a-f0-9]{64}$/);
        }
      }
    });

    it("changes the marker for every material --set or --set-string value", () => {
      for (const environment of ["staging", "production"]) {
        for (const step of planClusterAddons({ environment }).filter((candidate) =>
          candidate.command.includes("upgrade"),
        )) {
          const release = Object.values(pinned).find(
            (candidate) => candidate.releaseName === step.command[step.command.indexOf("--install") + 1],
          );
          const marker = configurationMarkerForStep(step, [release.valuesFile]);
          const overrides = materialOverridesFromCommand(step.command);
          for (const override of overrides) {
            const changedStep = { ...step, command: [...step.command] };
            const assignmentIndex = changedStep.command.indexOf(override.assignment);
            changedStep.command[assignmentIndex] =
              `${override.assignment.slice(0, override.assignment.indexOf("=") + 1)}opposite`;
            expect(configurationMarkerForStep(changedStep, [release.valuesFile])).not.toBe(marker);
          }
        }
      }
    });

    it("records every configuration marker only on real upgrade/install commands", () => {
      const dryRunSteps = planClusterAddons({ environment: "production" });
      const installSteps = installStepsWithConfigurationMarkers(dryRunSteps);

      expect(dryRunSteps.flatMap((step) => step.command).join(" ")).not.toContain("chase-sets-doks-addons:v1:");
      for (const release of requiredClusterAddons({ environment: "production" })) {
        const installStep = installSteps.find(
          (step) => step.command.includes("upgrade") && step.command.includes(release.releaseName),
        );
        expect(installStep.command).toEqual(expect.arrayContaining(["--description", release.configurationMarker]));
      }
    });
  });
});
