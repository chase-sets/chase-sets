import { describe, expect, it } from "vitest";
import { policy, validateTcgplayerHostCredentialPolicy } from "./tcgplayer-host-credential-guard.mjs";

const root = process.cwd();
const REPOSITORY_SCAN_TEST_TIMEOUT_MS = 120_000;

function scan(entries) {
  return validateTcgplayerHostCredentialPolicy({
    repoRoot: root,
    files: Object.keys(entries),
    contents: entries,
  });
}

describe("TCGplayer host and credential boundary", () => {
  it(
    "passes the post-A tracked baseline and repeats with the same digest",
    { timeout: REPOSITORY_SCAN_TEST_TIMEOUT_MS },
    async () => {
      const { scanTcgplayerHostCredentialPolicy } = await import("./tcgplayer-host-credential-guard.mjs");
      const first = await scanTcgplayerHostCredentialPolicy({ repoRoot: root });
      const second = await scanTcgplayerHostCredentialPolicy({ repoRoot: root });
      expect(first.violations).toEqual([]);
      expect(second).toEqual(first);
      expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
      const unusedCredentialExceptions = Object.entries(policy.credentialExceptions).flatMap(([file, tokens]) =>
        tokens
          .filter(
            (token) =>
              !first.inventory.some(
                (row) =>
                  row.rule === "credential" && row.file === file && row.token.toLowerCase() === token.toLowerCase(),
              ),
          )
          .map((token) => `${file} ${token}`),
      );
      const unusedHostExceptions = Object.keys(policy.hostExceptions).filter(
        (file) => !first.inventory.some((row) => row.rule === "host" && row.file === file && row.symbol === "allowed"),
      );
      const unusedBrowserPaths = Object.keys(policy.browserHosts).filter(
        (file) => !first.inventory.some((row) => row.rule === "host" && row.file === file && row.symbol === "allowed"),
      );
      expect([...unusedCredentialExceptions, ...unusedHostExceptions, ...unusedBrowserPaths]).toEqual([]);
    },
  );

  it("fails an unexcepted credential token mutant without exposing a value", () => {
    const result = scan({ "bounded-contexts/example/runtime.ts": "const value = TCGAuthTicket=planted-secret;" });
    expect(result.violations).toEqual(["bounded-contexts/example/runtime.ts:1 credential token TCGAuthTicket"]);
    expect(result.violations.join("\n")).not.toContain("planted-secret");
  });

  it("fails every banned token spelling outside its exact path exception", () => {
    for (const token of policy.credentialTokens) {
      const file =
        token === "chrome.cookies"
          ? "deployables/tcgplayer-connector-extension/src/host.ts"
          : "bounded-contexts/example/runtime.ts";
      const result = scan({ [file]: `const value = ${token};` });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain(`credential token ${token}`);
    }
  });

  it("fails a non-test runtime host and accepts only exact attribution and citation lines", () => {
    const denied = scan({ "bounded-contexts/example/runtime.ts": 'const url = "https://api.tcgplayer.com";' });
    expect(denied.violations).toEqual(["bounded-contexts/example/runtime.ts:1 TCGplayer host"]);
    for (const [file, lines] of Object.entries(policy.hostExceptions)) {
      expect(scan({ [file]: lines.join("\n") }).violations).toEqual([]);
      expect(scan({ [file]: 'const sourceUrl = "https://API.TCGPLAYER.COM";' }).violations).toEqual([
        `${file}:1 TCGplayer host`,
      ]);
    }
    const adapter = "bounded-contexts/catalog/features/source-observations/api/providers/tcgplayer/adapter.ts";
    expect(scan({ [adapter]: `${policy.hostExceptions[adapter][1]}\nfetch(sourceUrl);` }).violations).toEqual([
      `${adapter}:2 unapproved operator outbound target`,
    ]);
  });

  it("requires an exact parser allowlist change for a synthetic host exception", () => {
    const parserPath = "bounded-contexts/channels/features/connector-feed/api/handoff-parser.ts";
    const sourceUrl = 'const sourceUrl = "https://www.tcgplayer.com/x";';
    expect(scan({ [parserPath]: sourceUrl }).violations).toEqual([`${parserPath}:1 TCGplayer host`]);

    const changedPolicy = structuredClone(policy);
    changedPolicy.hostExceptions[parserPath] = [sourceUrl];
    expect(
      validateTcgplayerHostCredentialPolicy({
        repoRoot: root,
        files: [parserPath],
        contents: { [parserPath]: sourceUrl },
        policy: changedPolicy,
      }).violations,
    ).toEqual([]);
    expect(
      validateTcgplayerHostCredentialPolicy({
        repoRoot: root,
        files: [parserPath],
        contents: { [parserPath]: 'const url = "https://www.tcgplayer.com/x";' },
        policy: changedPolicy,
      }).violations,
    ).toEqual([`${parserPath}:1 TCGplayer host`]);

    const wildcardPolicy = structuredClone(policy);
    wildcardPolicy.hostExceptions["bounded-contexts/channels/features/connector-feed/api/*"] = [sourceUrl];
    expect(
      validateTcgplayerHostCredentialPolicy({
        repoRoot: root,
        files: [parserPath],
        contents: { [parserPath]: sourceUrl },
        policy: wildcardPolicy,
      }).violations,
    ).toEqual([`${parserPath}:1 TCGplayer host`]);
    const siblingPolicy = structuredClone(policy);
    siblingPolicy.hostExceptions["bounded-contexts/channels/features/connector-feed/api/other-parser.ts"] = [sourceUrl];
    expect(
      validateTcgplayerHostCredentialPolicy({
        repoRoot: root,
        files: [parserPath],
        contents: { [parserPath]: sourceUrl },
        policy: siblingPolicy,
      }).violations,
    ).toEqual([`${parserPath}:1 TCGplayer host`]);
  });

  it("does not scan tests, fixtures, or docs as runtime; pins existing browser endpoints", () => {
    const result = scan({
      "bounded-contexts/example/tests/host.test.ts": 'const url = "https://api.tcgplayer.com";',
      "bounded-contexts/example/fixtures/host.ts": 'const url = "https://api.tcgplayer.com";',
      "deployables/tcgplayer-connector-extension/src/host-registry.ts": 'const origin = "https://store.tcgplayer.com";',
      "deployables/tcgplayer-operator-extension/src/tcgplayer-set-name-endpoint.ts":
        'const host = "https://mpapi.tcgplayer.com";',
      "bounded-contexts/example/docs/host.ts": 'const url = "https://api.tcgplayer.com";',
    });
    expect(result.violations).toEqual([]);
  });

  it.each([
    "deployables/site-worker/src/poll.ts",
    "infrastructure/jobs/helper.ps1",
    "scripts/workflow-helper.mjs",
    ".github/actions/provider/entrypoint.sh",
    ".github/actions/provider/action.yml",
    ".github/authority/providers.yml",
    ".github/workflows/catalog.yml",
    "deployables/tcgplayer-operator-extension/src/other.ts",
  ])("denies a mixed-case provider host in %s", (file) => {
    expect(scan({ [file]: 'PROVIDER="https://MpApi.TcGpLaYeR.CoM/v2"' }).violations).toEqual([
      `${file}:1 TCGplayer host`,
    ]);
  });

  it.each([
    [
      "deployables/worker/src/poll.ts",
      'import { lookup } from "../../tcgplayer-operator-extension/src/tcgplayer-set-name-endpoint";',
    ],
    [
      "infrastructure/jobs/poll.ts",
      'const run = () => import("../../deployables/tcgplayer-connector-extension/src/compose");',
    ],
    [
      "scripts/workflow-helper.cjs",
      'const run = require("../deployables/tcgplayer-operator-extension/src/background");',
    ],
    [
      "scripts/workflow-helper.mjs",
      'import { createTcgplayerLiveExportExecutor as run } from "@chase-sets/channels/client";',
    ],
    [
      ".github/actions/provider/action.yml",
      "run: node --import tsx ./deployables/tcgplayer-operator-extension/src/background.ts",
    ],
    [
      ".github/workflows/catalog.yml",
      "run: |\n  node \\\n    ./bounded-contexts/channels/features/connector-client/integrations/order-authority-probe/worker.js",
    ],
    [".github/workflows/catalog.yml", "uses: ./deployables/tcgplayer-operator-extension"],
  ])("denies a browser-only module dependency in %s", (file, source) => {
    expect(scan({ [file]: source }).violations).toHaveLength(1);
    expect(scan({ [file]: source }).violations[0]).toMatch(/extension-only module$/);
  });

  it("requires fixed destinations in the operator path instead of forwarding any request URL", () => {
    const runtime = "bounded-contexts/catalog/features/operator-session/api/poll-worker.ts";
    const transport = "bounded-contexts/catalog/features/operator-session/domain/extension/transport.ts";
    const diagnostics = scan({
      [runtime]: "const send = (payload) => fetch(payload.url);",
      [transport]: "async function send(request) { return await fetcher(request.url); }",
      "deployables/tcgplayer-operator-extension/src/background.ts":
        'import { fetchTcgplayerSetNames } from "./tcgplayer-set-name-endpoint";',
    }).violations;
    expect(diagnostics).toEqual([
      `${runtime}:1 unapproved operator outbound target`,
      `${transport}:1 unapproved operator outbound target`,
    ]);
    expect(scan({ [transport]: `fetcher(${policy.operatorOutboundTargets[transport][0]});` }).violations).toEqual([]);
  });

  it("does not grant generated-artifact or unlisted extension-directory bypasses", () => {
    const result = scan({
      "artifacts/generated/platform.js": "const value = TCGAuthTicket;",
      "bounded-contexts/channels/features/connector-client/integrations/other/worker.js":
        'const url = "https://api.tcgplayer.com";',
    });
    expect(result.violations).toEqual([
      "artifacts/generated/platform.js:1 credential token TCGAuthTicket",
      "bounded-contexts/channels/features/connector-client/integrations/other/worker.js:1 TCGplayer host",
    ]);
  });

  it("requires exact path and symbol policy entries, never wildcard exceptions", () => {
    expect(Object.keys(policy.credentialExceptions).some((path) => /[*?\[\]]/.test(path))).toBe(false);
    expect(Object.keys(policy.hostExceptions).some((path) => /[*?\[\]]/.test(path))).toBe(false);
    expect(Object.keys(policy.browserHosts).some((path) => /[*?\[\]]/.test(path))).toBe(false);
  });
  it("admits only the market observation privacy test's exact credential absence assertion entry", () => {
    const file =
      "bounded-contexts/catalog/features/operator-session/tests/operator-session-observation-privacy.test.ts";
    expect(policy.credentialExceptions[file]).toEqual(["TCGAuthTicket"]);
    expect(scan({ [file]: 'expect(evidence).not.toContain("TCGAuthTicket=synthetic");' }).violations).toEqual([]);
    expect(
      scan({ [file.replace("privacy", "other")]: 'expect(evidence).not.toContain("TCGAuthTicket=synthetic");' })
        .violations,
    ).toHaveLength(1);
  });
});
