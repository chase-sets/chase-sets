import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

const control = await import(new URL("./selector-agent-control.mjs", import.meta.url).href);
const { JSDOM } = await import(import.meta.resolve("jsdom"));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const scratch = path.join(repo, "artifacts", "9514", "tests");
mkdirSync(scratch, { recursive: true });
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const html = `<main data-selector-orders aria-busy="false">
  <select name="dateRange"><option value="LastTwoYears" selected>Last 2 years</option><option value="LastThreeMonths">Last 90 days</option></select>
  <div data-quick-filter="ReadyToShip"><span data-filter-label> Ready   to Ship </span><span data-filter-count>8675309</span></div>
  <span data-orders-completion data-load="load-1" data-range="LastTwoYears"></span>
  <section>SYNTHETIC_PRIVATE_ROWS</section><p>all orders: 999999</p>
</main>`;
const documentFor = (markup = html) => new JSDOM(markup).window.document;
const command = (binding: { runId: string }, operation: string) => ({
  runId: binding.runId,
  policyHash: control.POLICY.hash,
  operation,
});
function fixture(mode = "S") {
  const root = mkdtempSync(path.join(scratch, "selector-capability-synthetic-"));
  const profile = path.join(root, "profile");
  mkdirSync(profile);
  const executable = path.join(root, "synthetic-chrome.exe");
  writeFileSync(executable, "SYNTHETIC EXECUTABLE, NOT A BROWSER");
  const binding = {
    evidence: "synthetic",
    runId: path.basename(root),
    mode,
    performer: "selector-agent-operator",
    verifier: "selector-agent-host-verifier",
    session: "synthetic-session",
    model: "gpt-6.1-sol/high",
    tool: "channels-selector-run-endpoint/v1",
    root,
    profile,
    profileIdentity: control.validateCleanupTarget({ root, profile }),
    executable,
    executableHash: hash(readFileSync(executable)),
    version: "synthetic-1",
    packageId: "abcdefghijklmnopabcdefghijklmnop",
    packageHash: "a".repeat(64),
    adapterHash: hash(readFileSync(new URL("./selector-agent-control.mjs", import.meta.url))),
    policyIdentity: control.POLICY.identity,
    policyHash: control.POLICY.hash,
    controlHash: hash(readFileSync(new URL("./selector-agent-control.mjs", import.meta.url))),
    startedAt: new Date().toISOString(),
    freshSignedOut: true,
  };
  let doc = documentFor();
  const calls: string[] = [];
  const browser = {
    identity: binding,
    async inspect() {
      calls.push("inspect");
      return control.inspectOrders(doc, "LastTwoYears");
    },
    async action(operation: string) {
      calls.push(operation);
      return { ok: true };
    },
    async close() {
      calls.push("close");
    },
  };
  return {
    binding,
    browser,
    calls,
    profile,
    root,
    document: () => doc,
    replace: (next: Document) => {
      doc = next;
    },
  };
}

describe("selector-agent-control-capability", () => {
  it("waits for the exact extension item to render before checking identity and removing it", async () => {
    const f = fixture("C");
    const digests = { "synthetic-package": "b".repeat(64) };
    f.binding.packageHash = hash(JSON.stringify(digests));
    let rendered = false,
      removed = false,
      url = "";
    const item = {
      count: async () => (rendered && !removed ? 1 : 0),
      waitFor: async ({ state }: { state: string }) => {
        if (state === "visible") rendered = true;
        else expect(removed).toBe(true);
      },
      locator: (selector: string) => {
        expect(selector).toBe("#removeButton");
        return {
          click: async () => {
            removed = true;
          },
        };
      },
    };
    const page = {
      goto: async (next: string) => {
        url = next;
      },
      url: () => url,
      on: () => {},
      locator: (selector: string) => {
        if (selector === `extensions-item[id="${f.binding.packageId}"]`) return item;
        expect(selector).toBe("extensions-remove-dialog");
        return { locator: () => ({ count: async () => 0 }) };
      },
    };
    const browser = control.createPlaywrightSelectorBrowser({
      context: { browser: () => ({ version: () => f.binding.version }), newPage: async () => page },
      preparation: {
        evidence: "synthetic",
        extensionId: f.binding.packageId,
        profileDirectory: f.profile,
        packageDigests: digests,
      },
      binding: f.binding,
      ordersUrl: pathToFileURL(path.join(f.root, "synthetic-orders.html")).href,
      deadline: Date.parse(f.binding.startedAt) + 900000,
    });
    expect(await browser.action("remove")).toEqual({ ok: true });
    expect(removed).toBe(true);
  });
  it("waits for the actual fixed helper API before cancel-before-begin, not navigation commit", async () => {
    const f = fixture("C");
    const digests = { "synthetic-package": "b".repeat(64) };
    f.binding.packageHash = hash(JSON.stringify(digests));
    const preparation = {
      evidence: "synthetic",
      extensionId: f.binding.packageId,
      profileDirectory: f.profile,
      packageDigests: digests,
      captureUrl: `chrome-extension://${f.binding.packageId}/capture.html`,
    };
    const ordersUrl = pathToFileURL(path.join(f.root, "synthetic-orders.html")).href;
    let url = "",
      helperReady = false;
    const doc = documentFor();
    const orders = {
      url: () => url,
      goto: async (next: string) => {
        url = next;
      },
      evaluate: async (_fn: unknown, value: { range: string; previous: unknown }) =>
        control.inspectOrders(doc, value.range, value.previous),
      locator: () => ({
        selectOption: async () => {
          doc.querySelector("[data-orders-completion]")!.setAttribute("data-load", "load-2");
        },
      }),
    };
    let helperUrl = "",
      accepted = false;
    let resolveDialog: (value: { ok: boolean; code: string }) => void = () => {};
    const native = {
      message: () =>
        "AGENT: one selector lifecycle with pre-launch T0, including sign-in and removal within T0+15 minutes? Preparation grants no execution; no raw recording or retries.",
      accept: async () => {
        accepted = true;
        resolveDialog({ ok: true, code: "scrubbed_export_created" });
      },
      dismiss: async () => {
        resolveDialog({ ok: false, code: "canceled" });
      },
    };
    let onDialog: (dialog: typeof native) => void = () => {};
    const helper = {
      url: () => helperUrl,
      goto: async (next: string) => {
        helperUrl = next;
      },
      on: (event: string, listener: (dialog: typeof native) => void) => {
        if (event === "dialog") onDialog = listener;
      },
      waitForFunction: async (predicate: () => boolean) => {
        const realm = createContext({ orderAuthorityCapture: { run: () => {}, abort: () => {} } });
        expect(new Script(`(${predicate.toString()})()`).runInContext(realm)).toBe(true);
        helperReady = true;
      },
      evaluate: async () => {
        if (!helperReady) throw new Error("synthetic_helper_not_loaded");
        return new Promise<{ ok: boolean; code: string }>((resolve) => {
          resolveDialog = resolve;
          onDialog(native);
        });
      },
    };
    let pages = 0;
    const context = {
      browser: () => ({ version: () => f.binding.version }),
      newPage: async () => (pages++ === 0 ? orders : helper),
      close: async () => {},
    };
    const browser = control.createPlaywrightSelectorBrowser({
      context,
      preparation,
      binding: f.binding,
      ordersUrl,
      deadline: Date.parse(f.binding.startedAt) + 900000,
    });
    const session = control.attachSelectorSession({ binding: f.binding, browser });
    await session.dispatch(command(f.binding, "attach"));
    expect(await session.dispatch(command(f.binding, "cancel-before-begin"))).toBeNull();
    expect(session.hostTerminal().cause).toBe("CANCELLED");
    expect(accepted).toBe(false);
  });
  it("restart never re-admits a consumed root, even after terminal closure", async () => {
    const f = fixture();
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    await session.dispatch(command(f.binding, "attach"));
    await session.dispatch(command(f.binding, "close"));
    expect(() => control.attachSelectorSession({ binding: f.binding, browser: f.browser })).toThrow(
      "selector_lifecycle_consumed",
    );
  });
  it("attaches only the exact bound Channels route and exposes no raw browser capability", async () => {
    const f = fixture();
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    expect(Object.keys(session).sort()).toEqual(["dispatch", "hostTerminal"]);
    expect(
      await session.dispatch({ runId: f.binding.runId, policyHash: control.POLICY.hash, operation: "attach" }),
    ).toEqual({ ok: true });
    expect(f.calls).toEqual([]);
    for (const key of ["profile", "executableHash", "session", "tool", "controlHash", "policyHash"]) {
      expect(() =>
        control.attachSelectorSession({ binding: { ...f.binding, [key]: "wrong" }, browser: f.browser }),
      ).toThrow();
    }
  });
  it("the authenticated run endpoint is the actual attachment path, not a CDP port", async () => {
    const f = fixture();
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    const endpoint = await control.createRunEndpoint(session, f.binding);
    try {
      const denied = await fetch(endpoint.url, { method: "POST", body: JSON.stringify(command(f.binding, "attach")) });
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe("");
      expect(session.hostTerminal().cause).toBeNull();
      const attached = await fetch(endpoint.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(command(f.binding, "attach")),
      });
      expect(await attached.json()).toEqual({ ok: true });
      const hostile = await fetch(endpoint.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ ...command(f.binding, "evaluate"), js: "SYNTHETIC_PRIVATE_ROWS" }),
      });
      expect(hostile.status).toBe(204);
      expect(await hostile.text()).toBe("");
      expect(f.calls).toEqual([]);
      expect(session.hostTerminal().cause).toBe("PROTOCOL_REFUSED");
    } finally {
      await endpoint.close();
    }
  });
});

describe("selector-agent-control-boundary", () => {
  it("rejects private, hostile, paused and caller-JS output before emission in both modes", async () => {
    for (const mode of ["C", "S"]) {
      for (const operation of [
        "CDP",
        "evaluate",
        "snapshot",
        "fetch",
        "network-events",
        "page-world-click",
        "begin-count-export",
      ]) {
        const f = fixture(mode);
        const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
        expect(
          await session.dispatch({ runId: f.binding.runId, policyHash: control.POLICY.hash, operation }),
        ).toBeNull();
        expect(f.calls).toEqual([]);
        expect(session.hostTerminal().cause).toBe("PROTOCOL_REFUSED");
      }
      const f = fixture(mode);
      const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
      expect(
        await session.dispatch({
          runId: f.binding.runId,
          policyHash: control.POLICY.hash,
          operation: "attach",
          js: "SYNTHETIC_PRIVATE_ROWS",
        }),
      ).toBeNull();
      expect(f.calls).toEqual([]);
    }
  });
  it("independent request, page-world laundering and reconstruction attempts fail on EACH exposed path", async () => {
    for (const mode of ["C", "S"] as const) {
      for (const operation of control.POLICY.operations[mode]) {
        for (const field of ["url", "js", "selector", "request", "network", "question"]) {
          const f = fixture(mode);
          const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
          expect(
            await session.dispatch({ ...command(f.binding, operation), [field]: "SYNTHETIC_PRIVATE_ROWS" }),
          ).toBeNull();
          expect(session.hostTerminal().cause).toBe("PROTOCOL_REFUSED");
          expect(f.calls).toEqual([]);
        }
      }
    }
  });
  it("pause suppresses inputs, outputs, exceptions and events without releasing capability enforcement", async () => {
    const f = fixture("C");
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    await session.dispatch(command(f.binding, "attach"));
    await session.dispatch(command(f.binding, "pause"));
    expect(await session.dispatch(command(f.binding, "capture"))).toBeNull();
    expect(f.calls).toEqual([]);
    expect(await session.dispatch({ ...command(f.binding, "capture"), events: "SYNTHETIC_PRIVATE_ROWS" })).toBeNull();
    expect(session.hostTerminal().cause).toBe("PROTOCOL_REFUSED");
    const thrown = fixture();
    thrown.browser.action = async () => {
      throw new Error("SYNTHETIC_PRIVATE_ROWS");
    };
    const other = control.attachSelectorSession({ binding: thrown.binding, browser: thrown.browser });
    await other.dispatch(command(thrown.binding, "attach"));
    await other.dispatch(command(thrown.binding, "resume"));
    expect(await other.dispatch(command(thrown.binding, "navigate-orders"))).toBeNull();
    expect(other.hostTerminal().cause).toBe("ADAPTER_FAILURE");
    expect(JSON.stringify(other.hostTerminal())).not.toContain("PRIVATE");
  });
  it("hostile adapter payload and an in-flight refusal never emit, even after an awaited operation", async () => {
    const f = fixture();
    f.browser.inspect = async () => ({
      ...control.inspectOrders(f.document(), "LastTwoYears"),
      payload: { rows: "SYNTHETIC_PRIVATE_ROWS" },
    });
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    await session.dispatch(command(f.binding, "attach"));
    await session.dispatch(command(f.binding, "resume"));
    await session.dispatch(command(f.binding, "navigate-orders"));
    expect(await session.dispatch(command(f.binding, "initial-range"))).toBeNull();
    expect(session.hostTerminal().cause).toBe("DISCLOSURE_GUARD");
    const racing = fixture("C");
    let release: () => void = () => {};
    racing.browser.action = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    };
    const concurrent = control.attachSelectorSession({ binding: racing.binding, browser: racing.browser });
    await concurrent.dispatch(command(racing.binding, "attach"));
    const pending = concurrent.dispatch(command(racing.binding, "install"));
    expect(await concurrent.dispatch(command(racing.binding, "evaluate"))).toBeNull();
    release();
    expect(await pending).toBeNull();
  });
});

describe("selector-agent-profile-cleanup", () => {
  it("refuses root, parent, another profile, every linked ancestor and a raced target", () => {
    const f = fixture();
    expect(control.validateCleanupTarget(f.binding)).toBeDefined();
    for (const profile of [f.root, path.dirname(f.root), path.join(f.root, "other")]) {
      expect(() => control.validateCleanupTarget({ ...f.binding, profile })).toThrow();
    }
    const link = path.join(f.root, "linked");
    symlinkSync(f.profile, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => control.validateCleanupTarget({ ...f.binding, profile: link })).toThrow();
    const admitted = control.validateCleanupTarget(f.binding);
    renameSync(f.profile, path.join(f.root, "replaced"));
    mkdirSync(f.profile);
    expect(() => control.validateCleanupTarget(f.binding, admitted)).toThrow();
    expect(existsSync(f.profile)).toBe(true);
  });
  it("independent complete zero-match AND zero-unknown census is required four times, never inferred from UI", () => {
    const f = fixture();
    const at = new Date().toISOString();
    const value = {
      format: "selector-profile-cleanup-result/v1",
      runId: f.binding.runId,
      policyIdentity: control.POLICY.identity,
      policyHash: control.POLICY.hash,
      cleanup: "TIMELY_VERIFIED",
      code: "CLEANUP_OBSERVED",
      at,
      observations: Array.from({ length: 4 }, () => ({ complete: true, matches: 0, unknown: 0, at })),
    };
    expect(control.validateCleanupEvidence(f.binding, value)).toBe(value);
    for (const observations of [
      [],
      value.observations.slice(1),
      [{ ...value.observations[0], unknown: 1 }, ...value.observations.slice(1)],
      [{ ...value.observations[0], matches: 1 }, ...value.observations.slice(1)],
      [{ ...value.observations[0], complete: false }, ...value.observations.slice(1)],
    ]) {
      expect(control.validateCleanupEvidence(f.binding, { ...value, observations })).toBeNull();
    }
    expect(
      control.validateCleanupEvidence(f.binding, {
        ...value,
        at: new Date(Date.parse(f.binding.startedAt) + 900001).toISOString(),
      }),
    ).toBeNull();
  });
  it("PowerShell rejects linked ancestors, unsafe targets, live and incomplete census fixtures without deletion", () => {
    const f = fixture();
    const script = fileURLToPath(new URL("./selector-profile-cleanup.ps1", import.meta.url));
    const test = path.join(f.root, "cleanup-fixtures.ps1");
    const admission = path.join(f.root, "native-identity.json");
    writeFileSync(admission, JSON.stringify(f.binding));
    writeFileSync(
      test,
      `. '${script.replaceAll("'", "''")}'
      $a=@{root='${f.root.replaceAll("'", "''")}';profile='${f.profile.replaceAll("'", "''")}';policyIdentity='${control.POLICY.identity}';policyHash='${control.POLICY.hash}';mode='S';scope='capability'}
      Assert-SelectorCleanupTarget $a | Out-Null
      foreach($c in @(@{complete=$false;matches=0;unknown=0},@{complete=$true;matches=1;unknown=0},@{complete=$true;matches=0;unknown=1})) {
        $refused=$false;try{Assert-SelectorCensus $c}catch{$refused=$true};if(-not $refused){throw 'census_bypass'}
      }
      $a.profile=$a.root;$refused=$false;try{Assert-SelectorCleanupTarget $a}catch{$refused=$true};if(-not $refused){throw 'root_bypass'}
      if($IsWindows) {
        Initialize-SelectorCleanupNative
        $binding=Get-Content -LiteralPath '${admission.replaceAll("'", "''")}' -TotalCount 100 | ConvertFrom-Json
        $native=[SelectorCleanupNative]::new($binding.profile,$true)
        try {
          Assert-SelectorNativeIdentity $binding $binding.profile $native
          $refused=$false;try{[IO.Directory]::Move($binding.profile,$binding.profile+'-raced')}catch{$refused=$true}
          if(-not $refused){throw 'native_race_bypass'}
        } finally {$native.Dispose()}
      }
      Write-Output 'synthetic cleanup fixtures passed'
    `,
    );
    expect(execFileSync("pwsh", ["-NoProfile", "-File", test], { encoding: "utf8" }).trim()).toBe(
      "synthetic cleanup fixtures passed",
    );
    expect(existsSync(f.profile)).toBe(true);
  });
});

describe("selector-agent-package-parity", () => {
  it("withdraws human launch authority without changing the v4 worker or permissions", () => {
    const core = path.join(
      repo,
      "bounded-contexts/channels/features/connector-client/integrations/order-authority-probe",
    );
    expect(readFileSync(path.join(core, "helper.js"), "utf8")).not.toContain("HUMAN ONLY");
    const packaging = readFileSync(path.join(core, "package.mjs"), "utf8");
    expect(packaging).not.toContain("HUMAN-operated");
    expect(packaging).toContain("operation-capability-policy");
    const cleanup = readFileSync(new URL("./selector-profile-cleanup.ps1", import.meta.url), "utf8");
    expect(cleanup).toContain(`$SelectorOperationCapabilityPolicyHash = '${control.POLICY.hash}'`);
    expect(hash(readFileSync(path.join(core, "worker.js")))).toBe(
      "3530d525a67b8534b7697ceac7d16de547c5203ad2861831f6cee69199905856",
    );
    expect(hash(readFileSync(path.join(core, "manifest.json")))).toBe(
      "7e4d6ca9b8e34087eb9d36375d4ed0848bc806a8531748a831ab9d92888050b4",
    );
  });
});

describe("selector-agent-orders-anchor-contract", () => {
  it("the code-owned Orders predicate serializes into a browser realm without Node closures", () => {
    const context = createContext({ document: documentFor() });
    const result = new Script(`(${control.inspectOrders.toString()})(document, "LastTwoYears")`).runInContext(context);
    expect(result.payload.currentEpochComplete).toBe(true);
  });
  it("returns only the nine structural predicates and discriminates missing, duplicate, unrelated and stale completion", () => {
    const result = control.inspectOrders(documentFor(), "LastTwoYears");
    expect(result.payload).toEqual({
      rangeSemanticsValid: true,
      selectedRangeValid: true,
      quickFilterRelationshipValid: true,
      currentEpochComplete: true,
      oldCompletionInvalidated: false,
      rangeControlMatches: 1,
      quickFilterLabelMatches: 1,
      adjacentCountMatches: 1,
      completionSignalMatches: 1,
    });
    expect(JSON.stringify(result.payload)).not.toMatch(/8675309|999999|PRIVATE/);
    for (const [markup, cause] of [
      [html.replace('name="dateRange"', 'name="wrong"'), "ANCHOR_ABSENT"],
      [html.replace("data-selector-orders", "data-unrelated-shell"), "ORDERS_UI_UNREACHABLE"],
      [html.replace("Ready   to Ship", "Other status"), "STATE_CONTRADICTORY"],
      [html.replace("data-filter-count", "data-unrelated-count"), "ANCHOR_ABSENT"],
      [html.replace("data-orders-completion", "data-ready-state"), "SETTLE_UNOBSERVABLE"],
      [html.replace('data-range="LastTwoYears"', 'data-range="LastThreeMonths"'), "STATE_CONTRADICTORY"],
      [html.replace("</main>", '<select name="dateRange"></select></main>'), "ANCHOR_AMBIGUOUS"],
    ])
      expect(control.inspectOrders(documentFor(markup), "LastTwoYears").cause).toBe(cause);
  });
  it("requires fixed distinct terminal causes and keeps failed cleanup separate", () => {
    const terminal = { phase: "post-reload", cause: "DEADLINE", cleanup: "FAILED", at: new Date().toISOString() };
    expect(control.validateTerminal(terminal)).toEqual(terminal);
    for (const cause of [
      undefined,
      "unknown",
      "NETWORK_TIMEOUT",
      "DEADLINE provider.example",
      "ADAPTER_FAILURE collapse",
    ]) {
      expect(control.validateTerminal({ ...terminal, cause })).toBeNull();
    }
    for (const cleanup of ["PENDING", "REFUSED", "FAILED", "LATE"]) {
      expect(control.validateTerminal({ ...terminal, cleanup }, true)).toBeNull();
    }
    for (const cause of control.POLICY.causes)
      expect(control.validateTerminal({ ...terminal, cause })?.cause).toBe(cause);
    expect(
      control.validateTerminal({ phase: "disposal", cause: null, cleanup: "TIMELY_VERIFIED", at: terminal.at }, true),
    ).not.toBeNull();
  });
  it("simultaneous protocol/cleanup failure preserves cause and phase; later cleanup cannot restore acceptance", async () => {
    const f = fixture();
    f.browser.action = async () => {
      throw new Error("SYNTHETIC_PRIVATE_ROWS");
    };
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    await session.dispatch(command(f.binding, "attach"));
    await session.dispatch(command(f.binding, "resume"));
    await session.dispatch(command(f.binding, "navigate-orders"));
    await session.dispatch(command(f.binding, "close"));
    const at = new Date().toISOString();
    const failed = {
      format: "selector-profile-cleanup-result/v1",
      runId: f.binding.runId,
      policyIdentity: control.POLICY.identity,
      policyHash: control.POLICY.hash,
      cleanup: "FAILED",
      code: "CLEANUP_REFUSED",
      at,
      observations: [],
    };
    expect(session.hostTerminal(failed)).toMatchObject({
      phase: "Orders-navigation",
      cause: "ADAPTER_FAILURE",
      cleanup: "FAILED",
    });
    const later = {
      ...failed,
      cleanup: "TIMELY_VERIFIED",
      code: "CLEANUP_OBSERVED",
      observations: Array.from({ length: 4 }, () => ({ complete: true, matches: 0, unknown: 0, at })),
    };
    expect(session.hostTerminal(later).cleanup).toBe("FAILED");
    expect(control.validateTerminal(session.hostTerminal(), true)).toBeNull();
  });
  it("the structure-evidence CLI refuses extra/private/missing/drifted fields and accepts only the frozen chronology schema", () => {
    const f = fixture();
    const at = new Date().toISOString();
    const payload = control.inspectOrders(f.document(), "LastTwoYears").payload;
    const cleanup = {
      format: "selector-profile-cleanup-result/v1",
      runId: f.binding.runId,
      policyIdentity: control.POLICY.identity,
      policyHash: control.POLICY.hash,
      cleanup: "TIMELY_VERIFIED",
      code: "CLEANUP_OBSERVED",
      at,
      observations: Array.from({ length: 4 }, () => ({ complete: true, matches: 0, unknown: 0, at })),
    };
    const value = {
      format: "selector-agent-structure-evidence/v1",
      binding: f.binding,
      observations: ["initial-range", "post-reload", "fallback-check"].map((phase, i) => ({
        phase,
        at,
        payload: { ...payload, oldCompletionInvalidated: i > 0 },
      })),
      terminal: { phase: "disposal", cause: null, cleanup: "TIMELY_VERIFIED", at },
      cleanup,
    };
    expect(control.verifyStructureEvidence(value)).toBe(true);
    for (const mutant of [
      { ...value, private: "SYNTHETIC_PRIVATE_ROWS" },
      { ...value, terminal: { ...value.terminal, cause: "unknown" } },
      { ...value, binding: { ...value.binding, policyHash: "0".repeat(64) } },
      { ...value, observations: value.observations.slice(1) },
      { ...value, cleanup: { ...cleanup, observations: [] } },
    ])
      expect(control.verifyStructureEvidence(mutant)).toBe(false);
    const file = path.join(f.root, "synthetic-structure.json");
    writeFileSync(file, JSON.stringify(value));
    const cli = fileURLToPath(new URL("./selector-agent-control.mjs", import.meta.url));
    expect(
      execFileSync(process.execPath, [cli, "--verify-structure-evidence", "--evidence", file], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toContain("independent host acceptance remains pending");
    writeFileSync(file, JSON.stringify({ ...value, private: "SYNTHETIC_PRIVATE_ROWS" }));
    expect(() =>
      execFileSync(process.execPath, [cli, "--verify-structure-evidence", "--evidence", file], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow();
  });
  it("range and reload invalidate old completion; readyState, sleeps, static shell and self-flags are not settle", () => {
    const doc = documentFor();
    const initial = control.inspectOrders(doc, "LastTwoYears");
    expect(control.inspectOrders(doc, "LastTwoYears", { token: initial.token }).cause).toBe("SETTLE_UNOBSERVABLE");
    expect(
      control.inspectOrders(doc, "LastTwoYears", { token: initial.token, documentChanged: true }).payload
        .currentEpochComplete,
    ).toBe(false);
    doc.querySelector("main")!.setAttribute("aria-busy", "true");
    const pending = control.inspectOrders(doc, "LastTwoYears", { token: initial.token });
    expect(pending.payload.oldCompletionInvalidated).toBe(true);
    expect(pending.payload.currentEpochComplete).toBe(false);
    expect(pending.cause).toBeNull();
    doc.querySelector("main")!.setAttribute("aria-busy", "false");
    doc.querySelector("[data-orders-completion]")!.setAttribute("data-load", "load-2");
    expect(control.inspectOrders(doc, "LastTwoYears", { token: initial.token }).payload.currentEpochComplete).toBe(
      true,
    );
    for (const flag of [
      "data-ready-state",
      "data-network-idle",
      "data-sleep",
      "data-click-success",
      "data-adapter-settled",
    ]) {
      const mutant = documentFor(html.replace("data-orders-completion", flag));
      expect(control.inspectOrders(mutant, "LastTwoYears").cause).toBe("SETTLE_UNOBSERVABLE");
    }
  });
  it("S refuses every C crossover, stale binding and repeated protocol action; a known loading expiry is DEADLINE", async () => {
    for (const operation of ["install", "capture", "cancel-before-begin", "remove", "read-count", "export", "begin"]) {
      const f = fixture();
      const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
      expect(await session.dispatch(command(f.binding, operation))).toBeNull();
      expect(f.calls).toEqual([]);
    }
    const f = fixture();
    let now = Date.parse(f.binding.startedAt);
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser, now: () => now });
    await session.dispatch(command(f.binding, "attach"));
    now += 900001;
    expect(await session.dispatch(command(f.binding, "resume"))).toBeNull();
    expect(session.hostTerminal().cause).toBe("DEADLINE");
    const g = fixture();
    const other = control.attachSelectorSession({ binding: g.binding, browser: g.browser });
    await other.dispatch(command(g.binding, "attach"));
    g.browser.identity = { ...g.binding, session: "drift" };
    expect(await other.dispatch(command(g.binding, "resume"))).toBeNull();
    expect(other.hostTerminal().cause).toBe("CONTROL_BOUNDARY_LOST");
  });
});

async function mutant(from: string, to: string) {
  const source = fileURLToPath(new URL("./selector-agent-control.mjs", import.meta.url));
  const original = readFileSync(source, "utf8");
  expect(original.split(from)).toHaveLength(2);
  const changed = original
    .replace(from, to)
    .replace("const source = fileURLToPath(import.meta.url);", `const source = ${JSON.stringify(source)};`);
  return import(`data:text/javascript;base64,${Buffer.from(changed).toString("base64")}`);
}
describe("named bypass mutants", () => {
  it("after-output and pause-events mutants are killed by pre-output custody assertions", async () => {
    const bypass = await mutant("return terminal || paused ? null : result;", "return result;");
    const f = fixture("C");
    let release: () => void = () => {};
    f.browser.action = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    };
    const session = bypass.attachSelectorSession({ binding: f.binding, browser: f.browser });
    await session.dispatch(command(f.binding, "attach"));
    const pending = session.dispatch(command(f.binding, "install"));
    await session.dispatch(command(f.binding, "evaluate"));
    release();
    expect(await pending).not.toBeNull(); // The discriminating invariant would FAIL.
    const pause = await mutant('if (paused && op !== "resume" && op !== "close") return null;', "");
    const g = fixture("C");
    g.browser.action = async () => ({ ok: true });
    const paused = pause.attachSelectorSession({ binding: g.binding, browser: g.browser });
    await paused.dispatch(command(g.binding, "attach"));
    await paused.dispatch(command(g.binding, "pause"));
    await paused.dispatch(command(g.binding, "capture"));
    expect(paused.hostTerminal().cause).toBeNull();
    // Even though final output gating survives, the forbidden action ran.
    expect(await paused.dispatch(command(g.binding, "capture"))).toBeNull();
    expect(paused.hostTerminal().cause).toBe("PROTOCOL_REFUSED");
  });
  it("C-mode model-exposed raw browser and S-to-C crossover mutants fail the closed capability contract", async () => {
    const raw = await mutant(
      "return Object.freeze({ dispatch, hostTerminal });",
      "return Object.freeze({ dispatch, hostTerminal, browser });",
    );
    const f = fixture("C");
    expect(Object.keys(raw.attachSelectorSession({ binding: f.binding, browser: f.browser }))).toContain("browser");
    const crossover = await mutant(
      "!POLICY.operations[admitted.mode].includes(message.operation)",
      "!POLICY.operations.C.includes(message.operation)",
    );
    const g = fixture();
    g.browser.action = async () => ({ ok: true });
    const session = crossover.attachSelectorSession({ binding: g.binding, browser: g.browser });
    await session.dispatch(command(g.binding, "attach"));
    expect(await session.dispatch(command(g.binding, "capture"))).toEqual({ ok: true });
  });
  it("skip-census, reparse and race mutants FAIL the cleanup discriminators", async () => {
    const skip = await mutant('if (value.cleanup === "TIMELY_VERIFIED") {', "if (false) {");
    const f = fixture();
    const at = new Date().toISOString();
    expect(
      skip.validateCleanupEvidence(f.binding, {
        format: "selector-profile-cleanup-result/v1",
        runId: f.binding.runId,
        policyIdentity: control.POLICY.identity,
        policyHash: control.POLICY.hash,
        cleanup: "TIMELY_VERIFIED",
        code: "CLEANUP_OBSERVED",
        at,
        observations: [],
      }),
    ).not.toBeNull();
    const race = await mutant('check(!expected || same(identities, expected), "cleanup_race_refused");', "");
    const admitted = race.validateCleanupTarget(f.binding);
    renameSync(f.profile, path.join(f.root, "old-profile"));
    mkdirSync(f.profile);
    expect(() => race.validateCleanupTarget(f.binding, admitted)).not.toThrow();
    const reparse = await mutant(
      "stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(current) === current",
      "true",
    );
    const linked = fixture();
    const target = path.join(linked.root, "target");
    mkdirSync(target);
    renameSync(linked.profile, path.join(linked.root, "old-profile"));
    symlinkSync(target, linked.profile, process.platform === "win32" ? "junction" : "dir");
    expect(() => reparse.validateCleanupTarget({ ...linked.binding, profileIdentity: undefined })).not.toThrow();
  });
});
