import { describe, expect, it } from "vitest";
import {
  captureCutoverEvidence,
  captureHostEvidence,
  classifyServingPlatform,
  deriveHosts,
  summarizeCertificate,
  summarizeCutoverEvidence,
} from "./staging-doks-cutover-evidence.mjs";

const futureCert = {
  issuer: { CN: "R11", O: "Let's Encrypt" },
  subject: { CN: "marketplace.doks.staging.chasesets.com" },
  subjectaltname: "DNS:marketplace.doks.staging.chasesets.com",
  valid_from: "Jul  1 00:00:00 2026 GMT",
  valid_to: "Oct  1 00:00:00 2026 GMT",
  fingerprint256: "AA:BB",
  serialNumber: "01",
};

const now = new Date("2026-07-08T00:00:00Z");

describe("deriveHosts", () => {
  it("derives DOKS shadow hosts while App Platform still serves live", () => {
    expect(deriveHosts({ serving: "app-platform", zone: "staging.chasesets.com" })).toEqual([
      "doks.staging.chasesets.com",
      "www.doks.staging.chasesets.com",
      "marketplace.doks.staging.chasesets.com",
      "admin.doks.staging.chasesets.com",
    ]);
  });

  it("derives live hosts once serving is flipped to DOKS", () => {
    expect(deriveHosts({ serving: "doks", zone: "staging.chasesets.com" })).toEqual([
      "staging.chasesets.com",
      "www.staging.chasesets.com",
      "marketplace.staging.chasesets.com",
      "admin.staging.chasesets.com",
    ]);
  });

  it("requires a zone", () => {
    expect(() => deriveHosts({ serving: "doks", zone: "" })).toThrow("--zone");
  });
});

describe("classifyServingPlatform", () => {
  it("classifies DOKS when every A record matches the ingress load balancer", () => {
    expect(classifyServingPlatform({ resolvedAddresses: ["203.0.113.10"], expectedTarget: "203.0.113.10" })).toEqual({
      servingPlatform: "doks",
      matchesExpectedTarget: true,
    });
  });

  it("classifies non-DOKS when a CNAME still points at App Platform", () => {
    expect(
      classifyServingPlatform({
        resolvedAddresses: [],
        cnameTarget: "chase-sets-staging.ondigitalocean.app",
        expectedTarget: "203.0.113.10",
      }),
    ).toEqual({ servingPlatform: "app-platform-or-other", matchesExpectedTarget: false });
  });

  it("is unknown when no expected target is supplied", () => {
    expect(classifyServingPlatform({ resolvedAddresses: ["203.0.113.10"] })).toEqual({
      servingPlatform: "unknown",
      matchesExpectedTarget: null,
    });
  });
});

describe("summarizeCertificate", () => {
  it("reports a valid cert-manager certificate chain without private material", () => {
    const summary = summarizeCertificate(futureCert, now);
    expect(summary).toMatchObject({
      present: true,
      valid: true,
      issuerCommonName: "R11",
      issuerOrganization: "Let's Encrypt",
      subjectCommonName: "marketplace.doks.staging.chasesets.com",
      daysUntilExpiry: 85,
    });
    expect(JSON.stringify(summary)).not.toContain("PRIVATE KEY");
  });

  it("flags an expired certificate", () => {
    const summary = summarizeCertificate({ ...futureCert, valid_to: "Jul  1 00:00:00 2026 GMT" }, now);
    expect(summary.valid).toBe(false);
    expect(summary.expired).toBe(true);
  });

  it("reports absent certificates", () => {
    expect(summarizeCertificate(null, now)).toEqual({ present: false, valid: false });
  });
});

describe("captureHostEvidence", () => {
  const deps = {
    expectedTarget: "203.0.113.10",
    now,
    clock: (() => {
      let value = 0;
      return () => (value += 100);
    })(),
    fetchImpl: async () => ({ status: 200, headers: new Map([["server", "nginx"]]) }),
    tlsCertImpl: async () => futureCert,
    dnsResolveImpl: async () => ({ addresses: ["203.0.113.10"] }),
  };

  it("captures served platform, cert chain, and DNS match as ok", async () => {
    const evidence = await captureHostEvidence("marketplace.doks.staging.chasesets.com", deps);
    expect(evidence.ok).toBe(true);
    expect(evidence.servingPlatform).toBe("doks");
    expect(evidence.servedBy).toMatchObject({ ok: true, httpStatus: 200, serverHeader: "nginx" });
    expect(evidence.tls.valid).toBe(true);
    expect(evidence.dns.matchesExpectedTarget).toBe(true);
  });

  it("marks a host not-ok when it still resolves off the DOKS load balancer", async () => {
    const evidence = await captureHostEvidence("marketplace.doks.staging.chasesets.com", {
      ...deps,
      dnsResolveImpl: async () => ({ addresses: ["198.51.100.5"] }),
    });
    expect(evidence.ok).toBe(false);
    expect(evidence.servingPlatform).toBe("app-platform-or-other");
  });

  it("marks a host not-ok when TLS validation fails", async () => {
    const evidence = await captureHostEvidence("marketplace.doks.staging.chasesets.com", {
      ...deps,
      tlsCertImpl: async () => {
        throw new Error("unable to verify the first certificate");
      },
    });
    expect(evidence.ok).toBe(false);
    expect(evidence.tls.valid).toBe(false);
  });
});

describe("captureCutoverEvidence", () => {
  it("produces a support-safe report with a pass verdict when every host checks out", async () => {
    const report = await captureCutoverEvidence({
      serving: "app-platform",
      zone: "staging.chasesets.com",
      phase: "rehearse",
      expectedTarget: "203.0.113.10",
      now,
      fetchImpl: async () => ({ status: 200, headers: new Map([["server", "nginx"]]) }),
      tlsCertImpl: async () => futureCert,
      dnsResolveImpl: async () => ({ addresses: ["203.0.113.10"] }),
    });

    expect(report.schemaVersion).toBe("staging-doks-cutover-evidence/v1");
    expect(report.supportSafe).toBe(true);
    expect(report.hosts).toHaveLength(4);
    expect(report.summary.verdict).toBe("pass");
    expect(report.summary.allServedByExpectedTarget).toBe(true);
    expect(report.loadBalancer).toEqual({ checked: false, reason: "load-balancer-id-not-provided" });
  });

  it("records load balancer health when an id and probe are supplied", async () => {
    const report = await captureCutoverEvidence({
      hosts: ["doks.staging.chasesets.com"],
      expectedTarget: "203.0.113.10",
      loadBalancerId: "lb-123",
      now,
      fetchImpl: async () => ({ status: 200, headers: new Map() }),
      tlsCertImpl: async () => futureCert,
      dnsResolveImpl: async () => ({ addresses: ["203.0.113.10"] }),
      loadBalancerHealthImpl: async (id) => ({ status: "active", ip: "203.0.113.10", forwardingRules: [{}, {}] }),
    });
    expect(report.loadBalancer).toEqual({
      checked: true,
      id: "lb-123",
      status: "active",
      ip: "203.0.113.10",
      forwardingRuleCount: 2,
    });
  });

  it("fails the verdict when a host is served by the wrong platform", async () => {
    const report = await captureCutoverEvidence({
      hosts: ["marketplace.staging.chasesets.com"],
      expectedTarget: "203.0.113.10",
      now,
      fetchImpl: async () => ({ status: 200, headers: new Map() }),
      tlsCertImpl: async () => futureCert,
      dnsResolveImpl: async () => ({ addresses: ["198.51.100.5"] }),
    });
    expect(report.summary.verdict).toBe("fail");
    expect(report.summary.allServedByExpectedTarget).toBe(false);
  });
});

describe("summarizeCutoverEvidence", () => {
  it("counts served, TLS-valid, and expected-target hosts", () => {
    const summary = summarizeCutoverEvidence([
      { ok: true, servedBy: { ok: true }, tls: { valid: true }, dns: { matchesExpectedTarget: true } },
      { ok: false, servedBy: { ok: true }, tls: { valid: false }, dns: { matchesExpectedTarget: true } },
    ]);
    expect(summary).toEqual({
      hostCount: 2,
      servedOkCount: 2,
      tlsValidCount: 1,
      servedByExpectedTargetCount: 2,
      allServedByExpectedTarget: true,
      verdict: "fail",
    });
  });
});
