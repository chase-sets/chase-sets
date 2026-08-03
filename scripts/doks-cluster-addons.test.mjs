import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyAllowedNormalizedDeltas,
  assertDryRunMatchesGolden,
  assertGoldenProvenance,
  createDanglingCommit,
  dryRunEnvironments,
  emptyAllowedNormalizedDeltas,
  initializePlannerFixtureRepository,
  normalizeCheckoutRootOnly,
  normalizeDryRunOutput,
  originMainRef,
  readCommittedGoldens,
  repositoryGitInventory,
  runGit,
  runRealDryRun,
  withFixtureShallowBoundary,
  withTemporaryDirectory,
} from "./doks-cluster-addons-golden.test-helper.mjs";
import {
  applyDoksDnsTokenSecret,
  buildDoksDnsTokenSecretManifest,
  doksDnsTokenSecretName,
  doksDnsTokenSecretNamespace,
  loadBalancerName,
  parseDoksIngressChartVersion,
  pinned,
  planClusterAddons,
  readDoksIngressChartVersion,
} from "./doks-cluster-addons.mjs";

const ingressNginxValues = readFileSync(
  resolve("infrastructure", "helm", "doks-ingress", "ingress-nginx-values.yaml"),
  "utf8",
);

const repositoryRoot = realpathSync(resolve("."));
const goldenProvenance = "dae5e288572b52a559654343ec229f3a988c4b07";
const historicalNonexistentProvenance = "93172b2173e40bdd0089c63a28b58cd86466a6b9";
const committedGoldens = readCommittedGoldens(repositoryRoot);
const movingMainRef = "refs/remotes/fixture/moving-main";

describe("doks cluster addons planner", () => {
  it("reads the local chart version through the shared parser", () => {
    const chartPath = resolve("infrastructure", "helm", "doks-ingress", "Chart.yaml");
    const chartSource = readFileSync(chartPath, "utf8");

    expect(readDoksIngressChartVersion()).toBe(parseDoksIngressChartVersion(chartSource));
  });

  it("reads an injected chart path without mutating the tracked chart", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "doks-ingress-chart-version-"));
    const fixturePath = join(fixtureRoot, "Chart.yaml");
    try {
      writeFileSync(fixturePath, "apiVersion: v2\nname: fixture\nversion: 9.8.7\n", "utf8");
      expect(readDoksIngressChartVersion(fixturePath)).toBe("9.8.7");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("parses only one unambiguous top-level Chart.yaml version scalar", () => {
    const accepted = [
      ["version: 1.2.3\n", "1.2.3"],
      ["version:   1.2.3   \n", "1.2.3"],
      ["version: '1.2.3'\n", "1.2.3"],
      ['version: "1.2.3"\n', "1.2.3"],
      ["version: 1.2.3 # release version\n", "1.2.3"],
      ['version: "1.2.3" # release version\n', "1.2.3"],
    ];
    for (const [source, expected] of accepted) {
      expect(parseDoksIngressChartVersion(source)).toBe(expected);
    }

    const rejected = [
      "name: fixture\n",
      "version:\n",
      "version: 1.2.3\nversion: 2.0.0\n",
      "metadata:\n  version: 1.2.3\n",
      "# version: 1.2.3\n",
    ];
    for (const source of rejected) {
      expect(() => parseDoksIngressChartVersion(source)).toThrow("DOKS_INGRESS_CHART_VERSION_UNPARSABLE");
    }
  });

  it("does not duplicate the current local chart version literal", () => {
    expect(readFileSync(resolve("scripts", "doks-cluster-addons.mjs"), "utf8")).not.toContain("0.1.0");
  });

  it("keeps every script import dependency-free and backed by Node built-ins", () => {
    const source = readFileSync(resolve("scripts", "doks-cluster-addons.mjs"), "utf8");
    const importSpecifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)].map(
      (match) => match[1] ?? match[2],
    );

    expect(importSpecifiers.length).toBeGreaterThan(0);
    expect(importSpecifiers.every((specifier) => specifier.startsWith("node:"))).toBe(true);
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

describe("DOKS add-on dry-run ancestry-safe golden contract", () => {
  let syntheticSuiteRoot;
  let captureFixture;
  let movingMainFixture;

  beforeAll(() => {
    syntheticSuiteRoot = realpathSync(mkdtempSync(join(repositoryRoot, ".doks-golden-suite-")));
    try {
      const fixtureRoot = join(syntheticSuiteRoot, "planner");
      const fixture = initializePlannerFixtureRepository({
        root: fixtureRoot,
        sourceGitRoot: repositoryRoot,
        sourceSha: goldenProvenance,
        goldens: committedGoldens,
        advanceCount: 2,
      });
      runGit(["update-ref", "--stdin"], fixtureRoot, {
        input: [`update ${movingMainRef} ${fixture.mainSha}`, `update ${originMainRef} ${fixture.baseSha}`, ""].join(
          "\n",
        ),
      });
      captureFixture = {
        root: fixtureRoot,
        baseSha: fixture.baseSha,
        mainSha: fixture.baseSha,
      };
      movingMainFixture = {
        root: fixtureRoot,
        baseRef: movingMainRef,
        ...fixture,
      };
    } catch (error) {
      rmSync(syntheticSuiteRoot, { recursive: true, force: true });
      throw error;
    }
  });

  afterAll(() => {
    rmSync(syntheticSuiteRoot, { recursive: true, force: true });
    expect(existsSync(syntheticSuiteRoot)).toBe(false);
  });

  it("matches the staging and production immutable goldens through the real CLI", () => {
    for (const environment of dryRunEnvironments) {
      assertDryRunMatchesGolden({
        environment,
        golden: committedGoldens[environment],
        actual: runRealDryRun({ repositoryRoot, environment }),
      });
    }
  });

  it("records an explicit zero-entry normalized-delta allowlist", () => {
    expect(emptyAllowedNormalizedDeltas).toEqual([]);
  });

  it("verifies the recorded main-ancestor provenance and reconstructs both goldens", () => {
    expect(() =>
      assertGoldenProvenance({
        gitRoot: repositoryRoot,
        provenanceSha: goldenProvenance,
        goldens: committedGoldens,
        baseRef: originMainRef,
      }),
    ).not.toThrow();
  });

  it("reaches the named nonexistent-provenance-object failure for the historical bad SHA", () => {
    expect(() =>
      assertGoldenProvenance({
        gitRoot: repositoryRoot,
        provenanceSha: historicalNonexistentProvenance,
        goldens: committedGoldens,
        baseRef: originMainRef,
      }),
    ).toThrow(`golden-provenance-object-does-not-exist: ${historicalNonexistentProvenance}`);
  });

  it("reaches the distinct not-an-ancestor failure in a non-shallow fixture", () => {
    const danglingSha = createDanglingCommit(captureFixture.root);

    expect(runGit(["rev-parse", "--is-shallow-repository"], captureFixture.root)).toBe("false");
    expect(() =>
      assertGoldenProvenance({
        gitRoot: captureFixture.root,
        provenanceSha: danglingSha,
        goldens: committedGoldens,
        baseRef: originMainRef,
      }),
    ).toThrow(`golden-provenance-not-an-ancestor: ${danglingSha} -> ${originMainRef}`);
  });

  it("survives planner-unrelated moving-main advances that reject the predecessor predicate", () => {
    expect(movingMainFixture.baseSha).not.toBe(movingMainFixture.mainSha);
    expect(() =>
      assertGoldenProvenance({
        gitRoot: movingMainFixture.root,
        provenanceSha: movingMainFixture.baseSha,
        goldens: committedGoldens,
        baseRef: movingMainFixture.baseRef,
      }),
    ).not.toThrow();

    const predecessorMergeBase = runGit(["merge-base", "HEAD", movingMainFixture.baseRef], movingMainFixture.root);
    expect(predecessorMergeBase).toBe(movingMainFixture.mainSha);
    expect(predecessorMergeBase).not.toBe(movingMainFixture.baseSha);
  });

  it("canonicalizes Windows and posix repository-token separators while the predecessor does not", () => {
    const escapedRoot = JSON.stringify(repositoryRoot).slice(1, -1);
    const windowsShape = `{"command":"--values ${escapedRoot}\\\\infrastructure\\\\helm\\\\doks-ingress\\\\values.yaml"}\n`;
    const posixShape = `{"command":"--values ${escapedRoot}/infrastructure/helm/doks-ingress/values.yaml"}\n`;

    expect(normalizeDryRunOutput(windowsShape, repositoryRoot)).toBe(normalizeDryRunOutput(posixShape, repositoryRoot));
    expect(normalizeCheckoutRootOnly(windowsShape, repositoryRoot)).not.toBe(
      normalizeCheckoutRootOnly(posixShape, repositoryRoot),
    );
  });

  it("does not absorb annotation escapes or an absolute path outside the repository token", () => {
    const annotationDrift = committedGoldens.staging.replace("service\\\\.beta", "service\\\\.betx");
    expect(() =>
      assertDryRunMatchesGolden({
        environment: "staging",
        golden: committedGoldens.staging,
        actual: normalizeDryRunOutput(annotationDrift, repositoryRoot),
      }),
    ).toThrow("dry-run-parity-mismatch: staging line 23");

    const outsidePathDrift = committedGoldens.staging.replace(
      "--atomic --wait --timeout 10m",
      "--values C:\\\\outside\\\\must-remain-visible.yaml --atomic --wait --timeout 10m",
    );
    expect(() =>
      assertDryRunMatchesGolden({
        environment: "staging",
        golden: committedGoldens.staging,
        actual: normalizeDryRunOutput(outsidePathDrift, repositoryRoot),
      }),
    ).toThrow("dry-run-parity-mismatch: staging line 23");

    const embeddedRepositoryToken = "prefix<repo>\\\\must-remain-visible";
    expect(normalizeDryRunOutput(embeddedRepositoryToken, repositoryRoot)).toBe(embeddedRepositoryToken);
  });

  it("rejects an adversarial planner-and-golden rebaseline that the predecessor admits", () => {
    const originalFragment = "<repo>/infrastructure/helm/doks-ingress --namespace cert-manager";
    const rebaselinedFragment =
      "<repo>/infrastructure/helm/doks-ingress --values <repo>/infrastructure/helm/doks-ingress/values.yaml --namespace cert-manager";
    const adversarialGoldens = {
      ...committedGoldens,
      staging: committedGoldens.staging.replace(originalFragment, rebaselinedFragment),
    };

    expect(adversarialGoldens.staging).not.toBe(committedGoldens.staging);
    expect(() =>
      assertGoldenProvenance({
        gitRoot: captureFixture.root,
        provenanceSha: captureFixture.baseSha,
        goldens: adversarialGoldens,
        baseRef: originMainRef,
      }),
    ).toThrow("golden-provenance-reconstruction-mismatch: staging line");

    expect(() =>
      assertDryRunMatchesGolden({
        environment: "staging",
        golden: adversarialGoldens.staging,
        actual: adversarialGoldens.staging,
      }),
    ).not.toThrow();
    expect(runGit(["cat-file", "-t", captureFixture.baseSha], captureFixture.root)).toBe("commit");
    expect(runGit(["merge-base", "HEAD", originMainRef], captureFixture.root)).toBe(captureFixture.baseSha);
  });

  it.each(dryRunEnvironments)("reaches the %s line diff when one captured golden byte drifts", (environment) => {
    const actual = runRealDryRun({ repositoryRoot, environment });
    const driftedGolden = committedGoldens[environment].replace(
      `"environment": "${environment}"`,
      `"environment": "${environment}x"`,
    );
    expect(() => assertDryRunMatchesGolden({ environment, golden: driftedGolden, actual })).toThrow(
      `dry-run-parity-mismatch: ${environment} line 2`,
    );
  });

  it.each(dryRunEnvironments)("reaches the %s line diff when one command token is added", (environment) => {
    const actual = runRealDryRun({ repositoryRoot, environment }).replace("--force-update", "--force-update --debug");
    expect(() => assertDryRunMatchesGolden({ environment, golden: committedGoldens[environment], actual })).toThrow(
      `dry-run-parity-mismatch: ${environment} line 7`,
    );
  });

  it("rejects an unallowlisted normalized delta", () => {
    const actual = runRealDryRun({ repositoryRoot, environment: "production" }).replace(
      "--force-update",
      "--force-update --debug",
    );
    expect(() =>
      assertDryRunMatchesGolden({ environment: "production", golden: committedGoldens.production, actual }),
    ).toThrow("dry-run-parity-mismatch: production line 7");
  });

  it("permits a temporary exact normalized-delta allowlist entry", () => {
    const goldenFragment = "helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update";
    const currentFragment = `${goldenFragment} --debug`;
    const actual = runRealDryRun({ repositoryRoot, environment: "staging" }).replace(goldenFragment, currentFragment);
    expect(() =>
      assertDryRunMatchesGolden({
        environment: "staging",
        golden: committedGoldens.staging,
        actual,
        allowlist: [
          {
            name: "test-only ingress repo debug token",
            decision: "synthetic proof for #6166; not committed policy",
            goldenFragment,
            currentFragment,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects an allowlist entry whose golden fragment is absent", () => {
    expect(() =>
      applyAllowedNormalizedDeltas(committedGoldens.staging, [
        {
          name: "absent fragment",
          decision: "synthetic proof for #6166; not committed policy",
          goldenFragment: "this fragment is not present",
          currentFragment: "replacement",
        },
      ]),
    ).toThrow("dry-run-allowlist-invalid-entry: absent fragment");
  });

  it("rejects an allowlist entry whose golden fragment is non-unique", () => {
    expect(() =>
      applyAllowedNormalizedDeltas(committedGoldens.staging, [
        {
          name: "non-unique fragment",
          decision: "synthetic proof for #6166; not committed policy",
          goldenFragment: "--atomic",
          currentFragment: "--atomic --debug",
        },
      ]),
    ).toThrow("dry-run-allowlist-invalid-entry: non-unique fragment");
  });

  it("fails closed with a named guard error outside a Git repository", () => {
    let nonGitRoot;
    withTemporaryDirectory("doks-golden-non-git-", (root) => {
      nonGitRoot = root;
      expect(() =>
        assertGoldenProvenance({
          gitRoot: root,
          provenanceSha: goldenProvenance,
          goldens: committedGoldens,
          baseRef: originMainRef,
        }),
      ).toThrow("golden-provenance-not-a-git-repository");
    });
    expect(existsSync(nonGitRoot)).toBe(false);
  });

  it("fails closed with a named guard error when the origin/main authority is missing", () => {
    const missingRef = "refs/remotes/origin/does-not-exist";
    expect(() =>
      assertGoldenProvenance({
        gitRoot: repositoryRoot,
        provenanceSha: goldenProvenance,
        goldens: committedGoldens,
        baseRef: missingRef,
      }),
    ).toThrow(`golden-provenance-base-ref-missing: ${missingRef}`);
  });

  it("classifies non-reachability as shallow-undecidable when the visible main root is a boundary", () => {
    withFixtureShallowBoundary(captureFixture.root, captureFixture.mainSha, () => {
      const danglingSha = createDanglingCommit(captureFixture.root, "shallow undecidable local commit");

      expect(runGit(["rev-parse", "--is-shallow-repository"], captureFixture.root)).toBe("true");
      expect(runGit(["cat-file", "-t", danglingSha], captureFixture.root)).toBe("commit");
      expect(() =>
        assertGoldenProvenance({
          gitRoot: captureFixture.root,
          provenanceSha: danglingSha,
          goldens: committedGoldens,
          baseRef: originMainRef,
        }),
      ).toThrow(`golden-provenance-ancestry-undecidable-shallow: ${danglingSha} -> ${originMainRef}`);
    });
    expect(runGit(["rev-parse", "--is-shallow-repository"], captureFixture.root)).toBe("false");
  });

  it("passes in a shallow repository when the provenance ancestry answer is positive", () => {
    withFixtureShallowBoundary(captureFixture.root, captureFixture.mainSha, () => {
      expect(runGit(["rev-parse", "--is-shallow-repository"], captureFixture.root)).toBe("true");
      expect(() =>
        assertGoldenProvenance({
          gitRoot: captureFixture.root,
          provenanceSha: captureFixture.mainSha,
          goldens: committedGoldens,
          baseRef: originMainRef,
        }),
      ).not.toThrow();
    });
    expect(runGit(["rev-parse", "--is-shallow-repository"], captureFixture.root)).toBe("false");
  });

  it("removes a successful reconstruction root without changing refs or worktrees", () => {
    const before = repositoryGitInventory(repositoryRoot);
    const reconstructionRoots = [];
    assertGoldenProvenance({
      gitRoot: repositoryRoot,
      provenanceSha: goldenProvenance,
      goldens: committedGoldens,
      baseRef: originMainRef,
      onReconstructionRoot: (root) => reconstructionRoots.push(root),
    });

    expect(reconstructionRoots).toHaveLength(1);
    expect(reconstructionRoots.every((root) => !existsSync(root))).toBe(true);
    expect(repositoryGitInventory(repositoryRoot)).toEqual(before);
  });

  it("removes a failing reconstruction root without changing refs or worktrees", () => {
    const before = repositoryGitInventory(repositoryRoot);
    const reconstructionRoots = [];
    const failingGoldens = {
      ...committedGoldens,
      production: committedGoldens.production.replace('"environment": "production"', '"environment": "productionx"'),
    };
    expect(() =>
      assertGoldenProvenance({
        gitRoot: repositoryRoot,
        provenanceSha: goldenProvenance,
        goldens: failingGoldens,
        baseRef: originMainRef,
        onReconstructionRoot: (root) => reconstructionRoots.push(root),
      }),
    ).toThrow("golden-provenance-reconstruction-mismatch: production line 2");

    expect(reconstructionRoots).toHaveLength(1);
    expect(reconstructionRoots.every((root) => !existsSync(root))).toBe(true);
    expect(repositoryGitInventory(repositoryRoot)).toEqual(before);
  });
});
