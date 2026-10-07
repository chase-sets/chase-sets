import { expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { claimAuthorization, readLaunchManifest, validateLaunchManifest } from "./test-window-admission.mjs";
import { parsePrivateFixtures, runTestWindow } from "./test-window-main.mjs";
import { SYNTHETIC_FIXTURES, syntheticHash, syntheticManifest } from "./test-window-fixtures.mjs";
import { STRIPE_API_VERSION } from "../../infrastructure/stripe-config/index.ts";

it("AC-02 entrypoint: synthetic API version follows the infrastructure registry and publishable keys use TEST only", () => {
  expect(syntheticManifest().configuration.apiVersion).toBe(STRIPE_API_VERSION);
  for (const publishableKey of [
    "pk_live_SYNTHETIC_6733",
    "sk_test_SYNTHETIC_6733",
    "pk_test_",
    "pk_test_SYNTHETIC_6733!",
  ]) {
    const bytes = JSON.stringify({ ...SYNTHETIC_FIXTURES, publishableKey });
    const manifest = syntheticManifest();
    manifest.fixturesDigest = syntheticHash(bytes);
    expect(() => parsePrivateFixtures(bytes, manifest)).toThrow("authority-unavailable");
  }
});

it("AC-02 entrypoint: recursive closed admission rejects unknown/mismatch/expiry/unsafe J before credentials", async () => {
  const manifest = syntheticManifest();
  expect(validateLaunchManifest(manifest, manifest.heads.candidate)).toEqual(manifest);
  const mutations = [
    (m) => {
      m.extra = true;
    },
    (m) => {
      m.configuration.allow = "all";
    },
    (m) => {
      m.schedule[0].extra = true;
    },
    (m) => {
      m.heads.candidate = "a";
    },
    (m) => {
      m.proof.ciHead = "b".repeat(40);
    },
    (m) => {
      m.proof.dbConclusion = "skipped";
    },
    (m) => {
      m.configuration.accountsApi = "v1";
    },
    (m) => {
      m.configuration.policyDigest = "b".repeat(64);
    },
    (m) => {
      m.timing.expiresAt = "2000-01-01T00:00:00Z";
    },
    (m) => {
      m.timing.startsAt = "2099-01-01T00:00:00Z";
    },
    (m) => {
      m.journal.host = "staging.invalid";
    },
    (m) => {
      m.journal.shared = true;
    },
    (m) => {
      m.journal.port = 8317;
    },
    (m) => {
      m.budgets.class6PerWindow = 3;
    },
    (m) => {
      m.budgets.browser = 129;
    },
    (m) => {
      m.budgets.objects = NaN;
    },
    (m) => {
      m.noRetry = false;
    },
    (m) => {
      m.schedule[1].windowId = m.schedule[0].windowId;
    },
    (m) => {
      m.schedule[3].slots = [1];
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(manifest);
    mutate(changed);
    expect(() => validateLaunchManifest(changed, manifest.heads.candidate)).toThrow("authority-unavailable");
  }
  expect((await runTestWindow()).classification).toBe("refused");
  expect(parsePrivateFixtures(JSON.stringify(SYNTHETIC_FIXTURES), manifest)).toEqual(SYNTHETIC_FIXTURES);
  expect(() =>
    parsePrivateFixtures(JSON.stringify({ ...SYNTHETIC_FIXTURES, customerB: "cus_REPLACED_SYNTHETIC_6733" }), manifest),
  ).toThrow();
});

it("AC-02 entrypoint: digest mismatch, atomic claim race and crash/restart remain consumed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "8255-synthetic-authority-"));
  const manifest = syntheticManifest();
  manifest.paths.claim = join(directory, "consumed");
  const bytes = JSON.stringify(manifest);
  const path = join(directory, "manifest.json");
  await writeFile(path, bytes);
  await expect(readLaunchManifest(path, "0".repeat(64), manifest.heads.candidate)).rejects.toThrow();
  expect((await readLaunchManifest(path, syntheticHash(bytes), manifest.heads.candidate)).noRetry).toBe(true);
  const outcomes = await Promise.allSettled([
    claimAuthorization(manifest, syntheticHash(bytes)),
    claimAuthorization(manifest, syntheticHash(bytes)),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  await expect(claimAuthorization(manifest, syntheticHash(bytes))).rejects.toThrow();
  expect(JSON.parse(await readFile(manifest.paths.claim, "utf8")).consumed).toBe(true);
  const crashed = structuredClone(manifest);
  crashed.paths.claim = join(directory, "crashed");
  const claimModule = new URL("./test-window-admission.mjs", import.meta.url).href;
  const script = `const {claimAuthorization}=await import(${JSON.stringify(claimModule)});await claimAuthorization(${JSON.stringify(crashed)},${JSON.stringify(syntheticHash(bytes))});process.exit(7);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 15000,
  });
  expect(child.status).toBe(7);
  await expect(claimAuthorization(crashed, syntheticHash(bytes))).rejects.toThrow();
  expect(JSON.parse(await readFile(crashed.paths.claim, "utf8")).consumed).toBe(true);
});

it("AC-01 composition / AC-02 entrypoint: absolute import, bare capture and PowerShell child are zero-network and inert", async () => {
  const capture = fileURLToPath(new URL("./capture-evidence-window.mjs", import.meta.url));
  const launch = fileURLToPath(new URL("./launch-test-window.ts", import.meta.url));
  const loader = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const script = `let calls=0;globalThis.fetch=()=>{calls++;throw new Error('SYNTHETIC_NETWORK_SENTINEL')};await import(${JSON.stringify(new URL("./launch-test-window.ts", import.meta.url).href)});const {runTestWindow}=await import(${JSON.stringify(new URL("./test-window-main.mjs", import.meta.url).href)});const result=await runTestWindow();if(calls!==0||result.classification!=='refused')process.exit(9);`;
  const imported = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 15000,
  });
  expect(imported.status).toBe(0);
  for (const path of [capture, launch]) {
    const child = spawnSync(process.execPath, ["--import", loader, path], { encoding: "utf8", timeout: 15000 });
    expect(child.status).toBe(2);
    expect(JSON.parse(child.stdout).classification).toBe("refused");
  }
  const entry = fileURLToPath(new URL("./invoke-test-window.ps1", import.meta.url));
  const discovered =
    process.platform === "win32"
      ? spawnSync(join(process.env.SystemRoot, "System32", "where.exe"), ["pwsh.exe"], { encoding: "utf8" })
          .stdout.trim()
          .split(/\r?\n/)[0]
      : "/usr/bin/pwsh";
  const executable = await realpath(discovered);
  const child = spawnSync(executable, ["-NoProfile", "-File", entry], { encoding: "utf8", timeout: 15000 });
  expect(child.status).toBe(2);
  expect(JSON.parse(child.stdout).classification).toBe("refused");
});
