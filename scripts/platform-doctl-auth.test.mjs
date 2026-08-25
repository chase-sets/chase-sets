import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyDeploymentRootCause } from "./platform-deploy-incident.mjs";
import {
  CANONICAL_AUTH_EVIDENCE_PATH,
  PLATFORM_DOCTL_AUTH_SCHEMA,
  classifyDoctlAuthTerminal,
  runPlatformDoctlAuth,
  validateCanonicalAuthEvidence,
} from "./platform-doctl-auth.mjs";

const fixtureAuthority = "http://127.0.0.1:28464";
const fixedPrefix = "Error: Unable to use supplied token to access API: GET http://127.0.0.1:28464";
const rawFixtures = Object.freeze({
  s408: [
    "8f10ba87d7c69e5e89e06f93b7af0ce43308bb191aef9bfc1444b8d30f29f7e7",
    `${fixedPrefix}/s408/v1/oauth/token/info: 408 synthetic\n`,
  ],
  s429: [
    "75d2d9bdc6943fa9db38803ff34e8eacdff6c197ed94254e4232b5b1e6696903",
    `${fixedPrefix}/s429/v1/oauth/token/info: 429 synthetic\n`,
  ],
  s500: [
    "a7ed25a00996892fcdbcf04b50798cd7abddd728087d301a3a72895fd4f2adb5",
    `${fixedPrefix}/s500/v1/oauth/token/info: 500 synthetic\n`,
  ],
  s502: [
    "f61938a000a13ad81dc076625d54936ee84e3129dd91fd35dfb0f7434b86c098",
    `${fixedPrefix}/s502/v1/oauth/token/info: 502 synthetic\n`,
  ],
  s503: [
    "a7036b42fc5839382dcbedfe090654a34ab7b1f00ecd69c3ac0996364ea19461",
    `${fixedPrefix}/s503/v1/oauth/token/info: 503 synthetic\n`,
  ],
  s504: [
    "bb642d2f85ace3ac85f37095fc33506f879ef7ddcb00aed09ab1d4f54c118a74",
    `${fixedPrefix}/s504/v1/oauth/token/info: 504 <html>gateway timeout</html>\n`,
  ],
  s400: [
    "ba56f8da5dbaf98942adb0bdb1917e029b5940632a62b0fe359a023b5c897eef",
    `${fixedPrefix}/s400/v1/oauth/token/info: 400 synthetic\n`,
  ],
  s401: [
    "2b18e57c412b4cbb45a82d585f11e75251ca30a39270b564cd81e7e0dba2cccf",
    `${fixedPrefix}/s401/v1/oauth/token/info: 401 synthetic\n`,
  ],
  s403: [
    "516bef3a877b0dbb983a444ee2309470b159c53ddfd25edf512a2e3db65db07f",
    `${fixedPrefix}/s403/v1/oauth/token/info: 403 synthetic\n`,
  ],
  s404: [
    "f8424f776ce13ba2c496ffa5c1ec805273568499c909e7c2b411543ba5a41e20",
    `${fixedPrefix}/s404/v1/oauth/token/info: 404 synthetic\n`,
  ],
  s409: [
    "e8b4dfa7140e68d4450bdfdb5b787c8fb867fc20c501b858e6ebb5d2c50466de",
    `${fixedPrefix}/s409/v1/oauth/token/info: 409 synthetic\n`,
  ],
  malformed: [
    "1b1388f552f3e527ead4e6465488d8f51cefdd00cd57d3be1e3525422830640a",
    "Error: Unable to use supplied token to access API: invalid character '<' looking for beginning of value\n",
  ],
  refused: [
    "84481f7b5c0156dab9796cb44f09cb69490638cd44abf5e15e10d12a4c3c6ad5",
    'Error: Unable to use supplied token to access API: Get "http://127.0.0.1:28465/v1/oauth/token/info": dial tcp 127.0.0.1:28465: connect: connection refused\n',
  ],
  dns: [
    "9eacf22228fa020bc914d4d4806db9eceb7fc9d56b57c4a276c78ab3a80e8312",
    'Error: Unable to use supplied token to access API: Get "https://doctl-fixture-7458.invalid/v1/oauth/token/info": dial tcp: lookup doctl-fixture-7458.invalid on 10.255.255.254:53: no such host\n',
  ],
  tls: [
    "76843906a1e65e40e4366f919882230f24fab093961934df2b37fa7d4e8ea41a",
    'Error: Unable to use supplied token to access API: Get "https://127.0.0.1:28464/v1/oauth/token/info": tls: first record does not look like a TLS handshake\n',
  ],
});

function syntheticExecutable(directory) {
  const executable = join(directory, "synthetic-doctl");
  writeFileSync(executable, "synthetic test double\n");
  chmodSync(executable, 0o755);
  return resolve(executable);
}

function makeClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++));
}

async function withRunner(test) {
  const directory = mkdtempSync(join(tmpdir(), "platform-doctl-auth-"));
  try {
    await test(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function result(stderr, exitCode = 1) {
  return { exitCode, signal: null, stdout: "malicious-output-token", stderr, timedOut: false };
}

describe("platform doctl authentication", () => {
  it("byte-binds the frozen exact-artifact terminal streams", () => {
    for (const [name, [hash, stream]] of Object.entries(rawFixtures)) {
      expect(createHash("sha256").update(stream, "utf8").digest("hex"), name).toBe(hash);
      expect(stream).toMatch(/\n$/u);
    }
  });

  it("recognizes only the closed captured parser partition", () => {
    for (const name of ["s408", "s429", "s500", "s502", "s503", "s504"]) {
      expect(classifyDoctlAuthTerminal(rawFixtures[name][1], `${fixtureAuthority}/${name}`)).toMatchObject({
        class: "transient-http",
      });
    }
    expect(classifyDoctlAuthTerminal(rawFixtures.refused[1], "http://127.0.0.1:28465").class).toBe(
      "transient-transport",
    );
    expect(classifyDoctlAuthTerminal(rawFixtures.dns[1], "https://doctl-fixture-7458.invalid").class).toBe(
      "transient-transport",
    );
    expect(classifyDoctlAuthTerminal(rawFixtures.tls[1], "https://127.0.0.1:28464").class).toBe("transient-transport");
    for (const name of ["s404", "s409", "malformed"]) {
      expect(classifyDoctlAuthTerminal(rawFixtures[name][1], `${fixtureAuthority}/${name}`).class).toBe(
        "indeterminate",
      );
    }
    expect(
      classifyDoctlAuthTerminal(
        `${fixedPrefix}/s504/v1/oauth/token/info: 504 synthetic\nextra\n`,
        `${fixtureAuthority}/s504`,
      ).class,
    ).toBe("transient-http");
  });

  it("retries only the closed exact staged-doctl fixture partition and releases once", async () => {
    await withRunner(async (directory) => {
      const calls = [];
      const sleeps = [];
      const logs = [];
      const outputs = [result(rawFixtures.s504[1]), result("", 0)];
      const run = await runPlatformDoctlAuth({
        executable: syntheticExecutable(directory),
        outPath: join(directory, "record.json"),
        validationAuthority: `${fixtureAuthority}/s504`,
        env: {
          HOME: "caller-home",
          XDG_CONFIG_HOME: "caller-xdg",
          DIGITALOCEAN_ACCESS_TOKEN: "synthetic-secret",
          KUBECONFIG: "must-not-pass",
          AWS_SECRET_ACCESS_KEY: "must-not-pass",
        },
        runChild: async (input) => {
          calls.push(input);
          return outputs.shift();
        },
        now: makeClock(),
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        log: (line) => logs.push(line),
      });
      expect(run.outcome).toBe("succeeded");
      expect(calls).toHaveLength(2);
      expect(
        calls.every((call) => JSON.stringify(call.args) === JSON.stringify(["--http-retry-max", "0", "auth", "init"])),
      ).toBe(true);
      expect(calls[0].env).toEqual({
        HOME: "caller-home",
        XDG_CONFIG_HOME: "caller-xdg",
        DIGITALOCEAN_ACCESS_TOKEN: "synthetic-secret",
      });
      expect(sleeps).toEqual([5_000]);
      expect(logs.join("\n")).not.toContain("malicious-output-token");
      expect(logs.join("\n")).not.toContain("synthetic-secret");
    });
  });

  it("persistent transient validation exhausts one bounded authority without mutation or fragmentation", async () => {
    await withRunner(async (directory) => {
      const calls = [];
      const run = await runPlatformDoctlAuth({
        executable: syntheticExecutable(directory),
        outPath: join(directory, "record.json"),
        validationAuthority: `${fixtureAuthority}/s504`,
        env: { HOME: "caller", DIGITALOCEAN_ACCESS_TOKEN: "token" },
        runChild: async (input) => {
          calls.push(input);
          return result(rawFixtures.s504[1]);
        },
        now: makeClock(),
        sleep: async () => {},
      });
      expect(run.outcome).toBe("transient-exhausted");
      expect(calls).toHaveLength(3);
      expect(run.record.steps).toHaveLength(1);
      expect(
        classifyDeploymentRootCause({
          phase: "production-deploy",
          steps: run.record.steps,
          diagnostics: [{ unrelated: "volatile HTML and runner IP" }],
        }),
      ).toMatchObject({
        rootCauseCode: "unknown",
        affectedComponent: "digitalocean-auth",
        phase: "unknown",
        providerReason:
          "DoctlAuthTransientExhausted: Staged doctl token validation exhausted transient provider availability.",
        rootCauseSignature: "2c521e79fae8",
      });
    });
  });

  it("definitive and indeterminate exact grammar fails immediately", async () => {
    const definitive = [rawFixtures.s400[1], rawFixtures.s401[1], rawFixtures.s403[1]];
    for (const stderr of definitive) {
      const name = /\/s(400|401|403)\//u.exec(stderr)?.[1];
      expect(classifyDoctlAuthTerminal(stderr, `${fixtureAuthority}/s${name}`).class).toBe("definitive");
    }
    expect(
      classifyDoctlAuthTerminal(`${fixedPrefix}/s404/v1/oauth/token/info: 504 synthetic\n`, `${fixtureAuthority}/s400`)
        .class,
    ).toBe("indeterminate");
    expect(classifyDoctlAuthTerminal("Error: 504 inside arbitrary HTML\n", fixtureAuthority).class).toBe(
      "indeterminate",
    );
    await withRunner(async (directory) => {
      let calls = 0;
      const run = await runPlatformDoctlAuth({
        executable: syntheticExecutable(directory),
        outPath: join(directory, "record.json"),
        validationAuthority: `${fixtureAuthority}/s404`,
        env: { HOME: "caller", DIGITALOCEAN_ACCESS_TOKEN: "token" },
        runChild: async () => {
          calls += 1;
          return result(rawFixtures.s404[1]);
        },
        now: makeClock(),
        sleep: async () => {
          throw new Error("must not sleep");
        },
      });
      expect(run.outcome).toBe("indeterminate-failed");
      expect(calls).toBe(1);
    });
  });

  it("successful auth persists only the downstream caller-visible doctl profile", async () => {
    await withRunner(async (directory) => {
      const callerHome = join(directory, "home");
      const callerXdg = join(directory, "xdg");
      const outPath = join(directory, "record.json");
      let childEnvironment;
      const run = await runPlatformDoctlAuth({
        executable: syntheticExecutable(directory),
        outPath,
        env: {
          HOME: callerHome,
          XDG_CONFIG_HOME: callerXdg,
          DIGITALOCEAN_ACCESS_TOKEN: "synthetic-token",
          KUBECONFIG: "forbidden",
          STRIPE_SECRET_KEY: "forbidden",
        },
        runChild: async ({ env }) => {
          childEnvironment = env;
          mkdirSync(callerXdg, { recursive: true });
          writeFileSync(join(callerXdg, "profile-sentinel"), "persisted", { flag: "w" });
          return result("", 0);
        },
        now: makeClock(),
      });
      expect(run.outcome).toBe("succeeded");
      expect(childEnvironment.HOME).toBe(callerHome);
      expect(childEnvironment.XDG_CONFIG_HOME).toBe(callerXdg);
      expect(childEnvironment).not.toHaveProperty("KUBECONFIG");
      expect(childEnvironment).not.toHaveProperty("STRIPE_SECRET_KEY");
      expect(readFileSync(join(callerXdg, "profile-sentinel"), "utf8")).toBe("persisted");
    });
  });

  it("canonical auth evidence is recursively closed bounded secret-free and classifier exact", async () => {
    await withRunner(async (directory) => {
      const outPath = join(directory, "record.json");
      const run = await runPlatformDoctlAuth({
        executable: syntheticExecutable(directory),
        outPath,
        env: { HOME: "caller", DIGITALOCEAN_ACCESS_TOKEN: "never-record-this-token" },
        runChild: async () => result("", 0),
        now: makeClock(),
      });
      const bytes = readFileSync(outPath);
      expect(bytes.at(0)).not.toBe(0xef);
      expect(bytes.at(-1)).toBe(10);
      expect(bytes.length).toBeLessThanOrEqual(8192);
      expect(bytes.toString("utf8")).not.toContain("never-record-this-token");
      expect(validateCanonicalAuthEvidence(run.record)).toEqual({ valid: true });
      const mutant = structuredClone(run.record);
      mutant.telemetry[0].unknown = true;
      expect(validateCanonicalAuthEvidence(mutant).valid).toBe(false);
      expect(run.record.schemaVersion).toBe(PLATFORM_DOCTL_AUTH_SCHEMA);
      expect(CANONICAL_AUTH_EVIDENCE_PATH).toBe("artifacts/release-health/production-doctl-auth-validation.json");
    });
  });

  it("uses one exact staged doctl request authority and preserves workflow topology", () => {
    const workflow = readFileSync(".github/workflows/platform-production.yml", "utf8");
    const authStep = workflow.slice(
      workflow.indexOf("      - name: Validate staged doctl authentication"),
      workflow.indexOf("\n      - ", workflow.indexOf("      - name: Validate staged doctl authentication") + 1),
    );
    expect(authStep).toContain('node ./scripts/platform-doctl-auth.mjs --doctl "$RUNNER_TEMP/doctl"');
    expect(authStep).not.toContain("--access-token");
    expect(workflow.match(/name: Validate staged doctl authentication/g)).toHaveLength(1);
    expect(workflow).toContain("steps.doctl_auth.outcome == 'success'");
    expect(workflow).toContain("steps.production_kubernetes_context.outcome == 'success'");
    const classifier = workflow.slice(
      workflow.indexOf("      - name: Classify production deployment failure"),
      workflow.indexOf("\n      - ", workflow.indexOf("      - name: Classify production deployment failure") + 1),
    );
    expect(classifier.indexOf("production-doctl-auth-validation.json")).toBeLessThan(
      classifier.indexOf("production-kubernetes-deploy-diagnostics.json"),
    );
    expect(workflow).toContain("if-no-files-found: error");
  });
});
