import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { applyDoksDnsTokenSecret } from "./doks-cluster-addons.mjs";
import {
  assessCertificate,
  buildManualRenewStatusPatch,
  checkPreviewWildcardCertificate,
  convergePreviewWildcardCertificate,
  parseArgs,
  previewWildcardRestoreWorkflow,
  staleCertificateRequestNames,
} from "./preview-wildcard-certificate.mjs";

const now = new Date("2026-10-10T12:00:00Z");
const daysFromNow = (days) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60 * 1000).toISOString();

function certificate({
  ready = "True",
  reason = "Ready",
  notAfter = daysFromNow(60),
  issuing,
  resourceVersion = "rv-1",
} = {}) {
  const conditions = [{ type: "Ready", status: ready, reason, message: `Certificate ${reason}` }];
  if (issuing) {
    conditions.push({ type: "Issuing", status: issuing, reason: "Renewing", message: "renewing" });
  }
  return {
    metadata: { name: "preview-wildcard", namespace: "cert-manager", generation: 3, resourceVersion },
    status: { conditions, notAfter },
  };
}

// The real incident: expired since 2026-10-09, renewal stuck on a 30-day-old
// request whose DNS-01 challenge 401s on the revoked token.
const expiredStuck = certificate({
  ready: "False",
  reason: "Expired",
  notAfter: "2026-10-09T16:56:21Z",
  issuing: "True",
});

function request(
  name,
  { ready = "False", reason = "Pending", createdMinutesAgo = 60 * 24 * 30, owner = "preview-wildcard" } = {},
) {
  return {
    metadata: {
      name,
      creationTimestamp: minutesAgo(createdMinutesAgo),
      annotations: { "cert-manager.io/certificate-name": owner },
    },
    status: { conditions: [{ type: "Ready", status: ready, reason }] },
  };
}

function fakeKubectl(responses) {
  const calls = [];
  const runKubectl = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const response = responses[key];
    if (typeof response === "function") {
      return { stdout: JSON.stringify(response()) };
    }
    return { stdout: response === undefined ? "" : JSON.stringify(response) };
  };
  return { calls, runKubectl };
}

// A minimal API server for the Certificate: status merge patches replace the
// conditions array and honour metadata.resourceVersion as a precondition the
// way kube-apiserver does. `onCall` lets a test advance cert-manager's state
// between converge's kubectl calls.
function fakeCertificateApi(initial, { requests = [], onCall = () => {} } = {}) {
  const state = { live: structuredClone(initial), version: 1, patches: [], calls: [] };
  const runKubectl = async (args) => {
    state.calls.push(args);
    onCall(args, state);
    if (args[0] === "get" && args[1].startsWith("certificate.")) {
      return { stdout: JSON.stringify(state.live) };
    }
    if (args[0] === "get") {
      return { stdout: JSON.stringify({ items: requests }) };
    }
    if (args[0] === "patch") {
      const patch = JSON.parse(args.at(-1));
      state.patches.push(patch);
      const expected = patch.metadata?.resourceVersion;
      if (expected !== undefined && expected !== state.live.metadata.resourceVersion) {
        throw new Error(
          `kubectl ${args.slice(0, 2).join(" ")} exited with code 1: Error from server (Conflict): Operation cannot be fulfilled on certificates.cert-manager.io "preview-wildcard": the object has been modified; please apply your changes to the latest version and try again`,
        );
      }
      state.live.status.conditions = patch.status.conditions;
      state.version += 1;
      state.live.metadata.resourceVersion = `rv-${state.version}`;
    }
    return { stdout: "" };
  };
  // cert-manager starting an issuance: Issuing=True and a new resourceVersion.
  const startIssuance = () => {
    state.live.status.conditions = [
      ...state.live.status.conditions.filter((entry) => entry.type !== "Issuing"),
      { type: "Issuing", status: "True", reason: "Renewing", lastTransitionTime: "2026-10-10T11:59:59Z" },
    ];
    state.version += 1;
    state.live.metadata.resourceVersion = `rv-${state.version}`;
  };
  return { state, runKubectl, startIssuance };
}

const appliedSecret = async () => ({ name: "digitalocean-dns-token", namespace: "cert-manager" });

describe("preview wildcard certificate assessment", () => {
  it("is healthy when Ready and outside the 14-day floor", () => {
    const assessment = assessCertificate(certificate(), { now });
    expect(assessment.healthy).toBe(true);
    expect(assessment.remainingDays).toBeCloseTo(60);
  });

  it("is unhealthy when the certificate expired (the #9268 incident state)", () => {
    const assessment = assessCertificate(expiredStuck, { now });
    expect(assessment.healthy).toBe(false);
    expect(assessment.problems.join(" ")).toContain("Ready=False (Expired");
    expect(assessment.problems.join(" ")).toContain("below the 14-day floor");
  });

  it("is unhealthy when Ready but expiring within 14 days", () => {
    const assessment = assessCertificate(certificate({ notAfter: daysFromNow(13) }), { now });
    expect(assessment.healthy).toBe(false);
    expect(assessment.problems).toHaveLength(1);
    expect(assessment.problems[0]).toContain("below the 14-day floor");
  });

  it("fails closed when Ready or notAfter is missing", () => {
    const assessment = assessCertificate({ status: {} }, { now });
    expect(assessment.healthy).toBe(false);
    expect(assessment.problems).toEqual(["Ready=Unknown (no reason: no message)", "status.notAfter is missing"]);
  });

  it("honours a custom floor", () => {
    expect(assessCertificate(certificate({ notAfter: daysFromNow(5) }), { now, minRemainingDays: 0 }).healthy).toBe(
      true,
    );
  });
});

describe("stale certificate request selection", () => {
  it("selects only this certificate's non-Ready requests older than the stale floor", () => {
    const names = staleCertificateRequestNames(
      [
        request("preview-wildcard-2"),
        request("preview-wildcard-1", { ready: "True", reason: "Issued" }),
        request("preview-wildcard-3", { createdMinutesAgo: 5 }),
        request("preview-wildcard-0", { reason: "Failed", createdMinutesAgo: 120 }),
        request("other-cert-1", { owner: "chase-sets-platform-doks" }),
      ],
      { now },
    );
    expect(names).toEqual(["preview-wildcard-0", "preview-wildcard-2"]);
  });
});

describe("manual renew status patch (cmctl renew equivalent)", () => {
  it("sets Issuing=True ManuallyTriggered while preserving other conditions", () => {
    const patch = buildManualRenewStatusPatch(certificate({ ready: "False", reason: "Expired", issuing: "False" }), {
      now,
    });
    expect(patch.metadata).toEqual({ resourceVersion: "rv-1" });
    expect(patch.status.conditions).toEqual([
      { type: "Ready", status: "False", reason: "Expired", message: "Certificate Expired" },
      expect.objectContaining({
        type: "Issuing",
        status: "True",
        reason: "ManuallyTriggered",
        lastTransitionTime: "2026-10-10T12:00:00Z",
        observedGeneration: 3,
      }),
    ]);
  });

  it("leaves an in-progress issuance alone", () => {
    expect(buildManualRenewStatusPatch(expiredStuck, { now })).toBeUndefined();
  });
});

describe("convergePreviewWildcardCertificate", () => {
  it("re-applies the staging token over stdin and nudges the stuck renewal (#9268)", async () => {
    const spawnCalls = [];
    const spawn = (command, args) => {
      const child = new EventEmitter();
      child.stdin = { end: (input) => spawnCalls.push({ command, args, input }) };
      queueMicrotask(() => child.emit("close", 0));
      return child;
    };
    const { calls, runKubectl } = fakeKubectl({
      "get certificate.cert-manager.io/preview-wildcard": expiredStuck,
      "get certificaterequests.cert-manager.io": { items: [request("preview-wildcard-2")] },
    });

    const result = await convergePreviewWildcardCertificate({
      token: "do_fake_token_value",
      now,
      runKubectl,
      applyTokenSecret: (options) => applyDoksDnsTokenSecret({ ...options, spawn }),
      log: () => {},
    });

    // Reuses applyDoksDnsTokenSecret: the token only ever travels on stdin.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toEqual(["apply", "-f", "-"]);
    const secret = JSON.parse(spawnCalls[0].input);
    expect(secret.metadata).toMatchObject({ name: "digitalocean-dns-token", namespace: "cert-manager" });
    expect(secret.metadata.labels["app.kubernetes.io/component"]).toBe("staging-dns01");
    expect(secret.data["access-token"]).toBe(Buffer.from("do_fake_token_value", "utf8").toString("base64"));
    for (const args of [...spawnCalls.map((call) => call.args), ...calls]) {
      expect(args.join(" ")).not.toContain("do_fake_token_value");
    }

    expect(result).toMatchObject({ deletedRequests: ["preview-wildcard-2"], triggered: false });
    expect(calls).toContainEqual([
      "delete",
      "certificaterequest.cert-manager.io/preview-wildcard-2",
      "--namespace",
      "cert-manager",
      "--wait=false",
    ]);
    expect(calls.some((args) => args[0] === "patch")).toBe(false);
  });

  it("sets Issuing=True through the status subresource when no issuance is in progress", async () => {
    const { calls, runKubectl } = fakeKubectl({
      "get certificate.cert-manager.io/preview-wildcard": certificate({ notAfter: daysFromNow(10), issuing: "False" }),
      "get certificaterequests.cert-manager.io": { items: [] },
    });

    const result = await convergePreviewWildcardCertificate({
      token: "t",
      now,
      runKubectl,
      applyTokenSecret: async () => ({ name: "digitalocean-dns-token", namespace: "cert-manager" }),
      log: () => {},
    });

    expect(result.triggered).toBe(true);
    const patch = calls.find((args) => args[0] === "patch");
    expect(patch.slice(0, 6)).toEqual([
      "patch",
      "certificate.cert-manager.io/preview-wildcard",
      "--namespace",
      "cert-manager",
      "--subresource=status",
      "--type=merge",
    ]);
    expect(JSON.parse(patch.at(-1)).status.conditions.at(-1)).toMatchObject({ type: "Issuing", status: "True" });
    // The decision and the write both come from the read taken after request
    // handling, and the write is bound to that read's resourceVersion.
    expect(calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "get certificate.cert-manager.io/preview-wildcard",
      "get certificaterequests.cert-manager.io",
      "get certificate.cert-manager.io/preview-wildcard",
      "patch certificate.cert-manager.io/preview-wildcard",
    ]);
    expect(JSON.parse(patch.at(-1)).metadata).toEqual({ resourceVersion: "rv-1" });
  });

  it("does not patch when cert-manager starts an issuance while stale requests are handled", async () => {
    const api = fakeCertificateApi(certificate({ ready: "False", reason: "Expired", issuing: "False" }), {
      requests: [request("preview-wildcard-2")],
      onCall: (args) => {
        if (args[0] === "delete") api.startIssuance();
      },
    });

    const result = await convergePreviewWildcardCertificate({
      token: "t",
      now,
      runKubectl: api.runKubectl,
      applyTokenSecret: appliedSecret,
      log: () => {},
    });

    expect(result).toMatchObject({ deletedRequests: ["preview-wildcard-2"], triggered: false });
    expect(api.state.patches).toEqual([]);
    expect(api.state.live.status.conditions.find((entry) => entry.type === "Issuing")).toMatchObject({
      reason: "Renewing",
      lastTransitionTime: "2026-10-10T11:59:59Z",
    });
  });

  it("fails closed on a resourceVersion conflict when issuance starts after the final read", async () => {
    let certificateReads = 0;
    const api = fakeCertificateApi(certificate({ ready: "False", reason: "Expired", issuing: "False" }), {
      onCall: (args) => {
        if (args[0] === "get" && args[1].startsWith("certificate.")) certificateReads += 1;
        if (args[0] === "patch") api.startIssuance();
      },
    });

    await expect(
      convergePreviewWildcardCertificate({
        token: "t",
        now,
        runKubectl: api.runKubectl,
        applyTokenSecret: appliedSecret,
        log: () => {},
      }),
    ).rejects.toThrow(/changed while nudging renewal \(resourceVersion rv-1 conflict\).*\(Conflict\)/);

    expect(certificateReads).toBe(2);
    // One attempt, no retry, and cert-manager's conditions survive intact.
    expect(api.state.patches).toHaveLength(1);
    expect(api.state.live.status.conditions).toEqual([
      { type: "Ready", status: "False", reason: "Expired", message: "Certificate Expired" },
      { type: "Issuing", status: "True", reason: "Renewing", lastTransitionTime: "2026-10-10T11:59:59Z" },
    ]);
  });

  it("does not patch when the certificate became healthy while stale requests were handled", async () => {
    const api = fakeCertificateApi(certificate({ ready: "False", reason: "Expired", issuing: "False" }), {
      requests: [request("preview-wildcard-2")],
      onCall: (args, state) => {
        if (args[0] === "delete") {
          state.live = certificate({ notAfter: "2027-01-08T12:00:00Z", issuing: "False", resourceVersion: "rv-9" });
        }
      },
    });

    const result = await convergePreviewWildcardCertificate({
      token: "t",
      now,
      runKubectl: api.runKubectl,
      applyTokenSecret: appliedSecret,
      log: () => {},
    });

    expect(result.triggered).toBe(false);
    expect(api.state.patches).toEqual([]);
  });

  it("propagates non-conflict patch failures unchanged", async () => {
    const api = fakeCertificateApi(certificate({ ready: "False", reason: "Expired", issuing: "False" }), {
      onCall: (args) => {
        if (args[0] === "patch") throw new Error("kubectl patch exited with code 1: Error from server (Forbidden)");
      },
    });

    await expect(
      convergePreviewWildcardCertificate({
        token: "t",
        now,
        runKubectl: api.runKubectl,
        applyTokenSecret: appliedSecret,
        log: () => {},
      }),
    ).rejects.toThrow(/^kubectl patch exited with code 1: Error from server \(Forbidden\)$/);
  });

  it("logs only the unhealthy diagnostic, never the successful apply, delete or patch", async () => {
    const api = fakeCertificateApi(certificate({ ready: "False", reason: "Expired", issuing: "False" }), {
      requests: [request("preview-wildcard-2")],
    });
    const logs = [];

    const result = await convergePreviewWildcardCertificate({
      token: "t",
      now,
      runKubectl: api.runKubectl,
      applyTokenSecret: appliedSecret,
      log: (message) => logs.push(message),
    });

    expect(result).toMatchObject({ deletedRequests: ["preview-wildcard-2"], triggered: true });
    expect(logs).toEqual([expect.stringMatching(/^Preview wildcard certificate is unhealthy \(Ready=False \(Expired/)]);
  });

  it("only re-applies the token, silently, when the certificate is healthy", async () => {
    const { calls, runKubectl } = fakeKubectl({ "get certificate.cert-manager.io/preview-wildcard": certificate() });
    let applied = 0;
    const logs = [];

    const result = await convergePreviewWildcardCertificate({
      token: "t",
      now,
      runKubectl,
      applyTokenSecret: async () => {
        applied += 1;
        return { name: "digitalocean-dns-token", namespace: "cert-manager" };
      },
      log: (message) => logs.push(message),
    });

    expect(applied).toBe(1);
    expect(result).toMatchObject({ deletedRequests: [], triggered: false });
    expect(calls).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it("refuses to run without a token instead of applying an empty credential", async () => {
    const { calls, runKubectl } = fakeKubectl({});
    await expect(convergePreviewWildcardCertificate({ token: "", runKubectl, log: () => {} })).rejects.toThrow(
      "DIGITALOCEAN_ACCESS_TOKEN is required",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("checkPreviewWildcardCertificate", () => {
  function clockFrom(start) {
    let current = start.getTime();
    return {
      clock: () => new Date(current),
      sleep: async (ms) => {
        current += ms;
      },
    };
  }

  it("passes silently when the certificate is healthy", async () => {
    const { runKubectl } = fakeKubectl({ "get certificate.cert-manager.io/preview-wildcard": certificate() });
    const logs = [];
    const warnings = [];

    const assessment = await checkPreviewWildcardCertificate({
      runKubectl,
      clock: () => now,
      warnRemainingDays: 14,
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    });

    expect(assessment.healthy).toBe(true);
    expect(logs).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("fails closed with the restore command when the certificate stays unhealthy", async () => {
    const { runKubectl } = fakeKubectl({ "get certificate.cert-manager.io/preview-wildcard": expiredStuck });
    const { clock, sleep } = clockFrom(now);

    await expect(
      checkPreviewWildcardCertificate({ runKubectl, clock, sleep, waitSeconds: 60, pollSeconds: 15, log: () => {} }),
    ).rejects.toThrow(/preview-wildcard is unhealthy: Ready=False \(Expired.*platform-preview-wildcard-tls\.yml/);
  });

  it("waits a bounded window for an in-flight renewal to become Ready", async () => {
    let reads = 0;
    const { runKubectl } = fakeKubectl({
      "get certificate.cert-manager.io/preview-wildcard": () => {
        reads += 1;
        return reads < 3 ? expiredStuck : certificate({ notAfter: "2027-01-08T12:00:00Z" });
      },
    });
    const { clock, sleep } = clockFrom(now);

    const assessment = await checkPreviewWildcardCertificate({
      runKubectl,
      clock,
      sleep,
      waitSeconds: 600,
      log: () => {},
    });

    expect(assessment.healthy).toBe(true);
    expect(reads).toBe(3);
  });

  it("does not poll when no wait is requested", async () => {
    let reads = 0;
    const { runKubectl } = fakeKubectl({
      "get certificate.cert-manager.io/preview-wildcard": () => {
        reads += 1;
        return expiredStuck;
      },
    });
    await expect(checkPreviewWildcardCertificate({ runKubectl, minRemainingDays: 0, log: () => {} })).rejects.toThrow(
      "Ready=False",
    );
    expect(reads).toBe(1);
  });

  it("warns, without failing, inside the warn window when the fail floor is lower", async () => {
    const { runKubectl } = fakeKubectl({
      "get certificate.cert-manager.io/preview-wildcard": certificate({ notAfter: daysFromNow(10) }),
    });
    const warnings = [];
    const { clock } = clockFrom(now);

    const assessment = await checkPreviewWildcardCertificate({
      runKubectl,
      clock,
      minRemainingDays: 0,
      warnRemainingDays: 14,
      log: () => {},
      warn: (message) => warnings.push(message),
    });

    expect(assessment.healthy).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("below the 14-day renewal floor");
  });
});

describe("preview wildcard certificate CLI", () => {
  it("parses converge and check options and rejects unknown flags", () => {
    expect(parseArgs(["converge"])).toEqual({ command: "converge", minRemainingDays: 14 });
    expect(
      parseArgs(["check", "--min-remaining-days", "0", "--warn-remaining-days", "14", "--wait-seconds", "600"]),
    ).toEqual({
      command: "check",
      minRemainingDays: 0,
      warnRemainingDays: 14,
      waitSeconds: 600,
    });
    expect(() => parseArgs(["converge", "--wait-seconds", "60"])).toThrow("Usage:");
    expect(() => parseArgs(["check", "--wait-seconds", "-1"])).toThrow("non-negative");
    expect(() => parseArgs([])).toThrow("Usage:");
  });

  it("restore workflow installs doctl without auth and keeps the token in step env only", () => {
    const workflow = parse(readFileSync(resolve(previewWildcardRestoreWorkflow), "utf8"));
    const steps = workflow.jobs["restore-preview-wildcard-tls"].steps;
    const doctlAction = steps.filter((step) => step.uses?.startsWith("digitalocean/action-doctl@"));

    // The pinned action's auth path runs `doctl auth init -t <token>`, which
    // puts the token on a process command line; it must only install.
    expect(doctlAction).toHaveLength(1);
    expect(doctlAction[0].with).toEqual({ no_auth: "true" });
    for (const step of steps) {
      expect(JSON.stringify(step.with ?? {})).not.toContain("secrets.");
      expect(step.run ?? "").not.toContain("secrets.");
      expect(step.run ?? "").not.toMatch(/doctl\s+auth\b|--access-token|\s-t\s/);
    }
    // Every later doctl use authenticates from DIGITALOCEAN_ACCESS_TOKEN env.
    const doctlRuns = steps.filter((step) => /\bdoctl\s/.test(step.run ?? ""));
    expect(doctlRuns.map((step) => step.name)).toEqual(["Configure staging Kubernetes context"]);
    for (const step of doctlRuns) {
      expect(step.env.DIGITALOCEAN_ACCESS_TOKEN).toBe("${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
    }
  });

  it("points the guard at a restore workflow that exists", () => {
    expect(readFileSync(resolve(previewWildcardRestoreWorkflow), "utf8")).toContain(
      "node ./scripts/preview-wildcard-certificate.mjs converge",
    );
  });
});
