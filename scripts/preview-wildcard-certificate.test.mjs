import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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

function certificate({ ready = "True", reason = "Ready", notAfter = daysFromNow(60), issuing } = {}) {
  const conditions = [{ type: "Ready", status: ready, reason, message: `Certificate ${reason}` }];
  if (issuing) {
    conditions.push({ type: "Issuing", status: issuing, reason: "Renewing", message: "renewing" });
  }
  return {
    metadata: { name: "preview-wildcard", namespace: "cert-manager", generation: 3 },
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
  });

  it("only re-applies the token when the certificate is healthy", async () => {
    const { calls, runKubectl } = fakeKubectl({ "get certificate.cert-manager.io/preview-wildcard": certificate() });
    let applied = 0;

    const result = await convergePreviewWildcardCertificate({
      token: "t",
      now,
      runKubectl,
      applyTokenSecret: async () => {
        applied += 1;
        return { name: "digitalocean-dns-token", namespace: "cert-manager" };
      },
      log: () => {},
    });

    expect(applied).toBe(1);
    expect(result).toMatchObject({ deletedRequests: [], triggered: false });
    expect(calls).toHaveLength(1);
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

  it("points the guard at a restore workflow that exists", () => {
    expect(readFileSync(resolve(previewWildcardRestoreWorkflow), "utf8")).toContain(
      "node ./scripts/preview-wildcard-certificate.mjs converge",
    );
  });
});
