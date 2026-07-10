#!/usr/bin/env node
// Support-safe cutover evidence capture for the App Platform -> DOKS staging
// cutover.
//
// For each staging host it records three facts the operator signs off in the
// issue: which platform served the check (resolved address vs the DOKS ingress
// load balancer target), the served TLS certificate chain (issuer/subject/
// validity, not the private material), and — when a load balancer id and a DO
// token are available — the load balancer health. The output is a redacted JSON
// artifact: no tokens, no kubeconfig, no certificate private keys, no cookies.
//
// The host set follows the environment-dns model: shadow hosts
// (doks.<zone>, www.doks.<zone>, marketplace.doks.<zone>, admin.doks.<zone>)
// prove DOKS while App Platform still serves the live hosts during rehearse;
// live hosts (<zone>, www.<zone>, marketplace.<zone>, admin.<zone>) prove the
// flip once serving is DOKS.
import process from "node:process";

const defaultReadinessPath = "/health/ready";
const schemaVersion = "staging-doks-cutover-evidence/v1";

const liveHostLeaves = { apex: "", www: "www", marketplace: "marketplace", admin: "admin" };
const shadowHostLeaves = {
  apex: "doks",
  www: "www.doks",
  marketplace: "marketplace.doks",
  admin: "admin.doks",
};

export function deriveHosts({ serving, zone }) {
  const trimmedZone = String(zone ?? "").trim();
  if (!trimmedZone) {
    throw new Error("--zone is required to derive hosts from --serving.");
  }
  const leaves = serving === "doks" ? liveHostLeaves : shadowHostLeaves;
  return Object.values(leaves).map((leaf) => (leaf === "" ? trimmedZone : `${leaf}.${trimmedZone}`));
}

// A cutover check is only trustworthy when it is served by the platform the
// operator expects for this phase. During rehearse the shadow hosts must
// resolve to the DOKS ingress load balancer; after the flip the live hosts must
// too. Matching the resolved A records against the expected target is the
// authoritative "which platform served this" signal — the HTTP Server header is
// recorded as corroboration only.
export function classifyServingPlatform({ resolvedAddresses, cnameTarget, expectedTarget }) {
  const target = String(expectedTarget ?? "").trim();
  const addresses = resolvedAddresses ?? [];
  if (!target) {
    return { servingPlatform: "unknown", matchesExpectedTarget: null };
  }
  if (addresses.length === 0) {
    return {
      servingPlatform: cnameTarget ? "app-platform-or-other" : "unknown",
      matchesExpectedTarget: false,
    };
  }
  const matchesExpectedTarget = addresses.every((address) => address === target);
  return {
    servingPlatform: matchesExpectedTarget ? "doks" : "app-platform-or-other",
    matchesExpectedTarget,
  };
}

export function summarizeCertificate(certificate, now) {
  if (!certificate || Object.keys(certificate).length === 0) {
    return { present: false, valid: false };
  }
  const validFrom = certificate.valid_from ? new Date(certificate.valid_from) : null;
  const validTo = certificate.valid_to ? new Date(certificate.valid_to) : null;
  const reference = now ?? new Date();
  const daysUntilExpiry =
    validTo && !Number.isNaN(validTo.getTime())
      ? Math.floor((validTo.getTime() - reference.getTime()) / 86_400_000)
      : null;
  const notYetValid = Boolean(
    validFrom && !Number.isNaN(validFrom.getTime()) && validFrom.getTime() > reference.getTime(),
  );
  const expired = Boolean(validTo && !Number.isNaN(validTo.getTime()) && validTo.getTime() <= reference.getTime());
  const issuer = certificate.issuer ?? {};
  const subject = certificate.subject ?? {};
  return {
    present: true,
    valid: !notYetValid && !expired,
    notYetValid,
    expired,
    issuerCommonName: issuer.CN ?? null,
    issuerOrganization: issuer.O ?? null,
    subjectCommonName: subject.CN ?? null,
    subjectAltNames: certificate.subjectaltname ?? null,
    validFrom: certificate.valid_from ?? null,
    validTo: certificate.valid_to ?? null,
    daysUntilExpiry,
    fingerprint256: certificate.fingerprint256 ?? null,
    serialNumber: certificate.serialNumber ?? null,
  };
}

export async function captureHostEvidence(host, options = {}) {
  const path = options.path ?? defaultReadinessPath;
  const now = options.now ?? new Date();
  const url = `https://${host}${path}`;

  const [served, tls, dns] = await Promise.all([
    probeServed(url, options),
    probeCertificate(host, options, now),
    resolveDns(host, options),
  ]);

  const { servingPlatform, matchesExpectedTarget } = classifyServingPlatform({
    resolvedAddresses: dns.resolvedAddresses,
    cnameTarget: dns.cnameTarget,
    expectedTarget: options.expectedTarget,
  });

  return {
    host,
    url,
    servedBy: served,
    dns: { ...dns, matchesExpectedTarget },
    tls,
    servingPlatform,
    ok: served.ok && tls.valid && (matchesExpectedTarget === null || matchesExpectedTarget === true),
  };
}

async function probeServed(url, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const startedAt = options.clock ? options.clock() : Date.now();
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "manual" });
    const completedAt = options.clock ? options.clock() : Date.now();
    return {
      ok: response.status >= 200 && response.status < 400,
      httpStatus: response.status,
      serverHeader: readHeader(response, "server"),
      latencyMs: completedAt - startedAt,
    };
  } catch (error) {
    const completedAt = options.clock ? options.clock() : Date.now();
    return {
      ok: false,
      httpStatus: null,
      serverHeader: null,
      latencyMs: completedAt - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readHeader(response, name) {
  const headers = response.headers;
  if (!headers) {
    return null;
  }
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  return headers[name] ?? null;
}

async function probeCertificate(host, options, now) {
  const tlsCertImpl = options.tlsCertImpl;
  if (typeof tlsCertImpl !== "function") {
    return { present: false, valid: false, error: "tls-cert-probe-unavailable" };
  }
  try {
    const certificate = await tlsCertImpl(host);
    return summarizeCertificate(certificate, now);
  } catch (error) {
    return { present: false, valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveDns(host, options) {
  const dnsResolveImpl = options.dnsResolveImpl;
  if (typeof dnsResolveImpl !== "function") {
    return { resolvedAddresses: [], cnameTarget: null, error: "dns-resolve-unavailable" };
  }
  try {
    const resolution = await dnsResolveImpl(host);
    return {
      resolvedAddresses: [...(resolution.addresses ?? [])].sort(),
      cnameTarget: resolution.cnameTarget ?? null,
    };
  } catch (error) {
    return { resolvedAddresses: [], cnameTarget: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function summarizeCutoverEvidence(hosts) {
  const servedOkCount = hosts.filter((entry) => entry.servedBy.ok).length;
  const tlsValidCount = hosts.filter((entry) => entry.tls.valid).length;
  const servedByExpectedTargetCount = hosts.filter((entry) => entry.dns.matchesExpectedTarget === true).length;
  const anyTargetKnown = hosts.some((entry) => entry.dns.matchesExpectedTarget !== null);
  const allServedByExpectedTarget = anyTargetKnown && hosts.every((entry) => entry.dns.matchesExpectedTarget === true);
  const verdict = hosts.length > 0 && hosts.every((entry) => entry.ok) ? "pass" : "fail";
  return {
    hostCount: hosts.length,
    servedOkCount,
    tlsValidCount,
    servedByExpectedTargetCount,
    allServedByExpectedTarget,
    verdict,
  };
}

export async function captureCutoverEvidence(options) {
  const hosts = options.hosts ?? deriveHosts({ serving: options.serving, zone: options.zone });
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error("At least one host is required (pass --host or --serving with --zone).");
  }
  const now = options.now ?? new Date();
  const hostEvidence = await Promise.all(
    hosts.map((host) =>
      captureHostEvidence(host, {
        path: options.path,
        expectedTarget: options.expectedTarget,
        fetchImpl: options.fetchImpl,
        tlsCertImpl: options.tlsCertImpl,
        dnsResolveImpl: options.dnsResolveImpl,
        clock: options.clock,
        now,
      }),
    ),
  );
  const loadBalancer = await captureLoadBalancerHealth(options);

  return {
    schemaVersion,
    environment: options.environment ?? "staging",
    phase: options.phase ?? "rehearse",
    servingFlag: options.serving ?? null,
    expectedIngressTarget: options.expectedTarget ?? null,
    capturedAt: now.toISOString(),
    loadBalancer,
    hosts: hostEvidence,
    summary: summarizeCutoverEvidence(hostEvidence),
    supportSafe: true,
    redaction: {
      secrets: "not-written",
      certificatePrivateMaterial: "not-written",
      kubeconfig: "not-written",
    },
  };
}

async function captureLoadBalancerHealth(options) {
  if (!options.loadBalancerId) {
    return { checked: false, reason: "load-balancer-id-not-provided" };
  }
  const impl = options.loadBalancerHealthImpl;
  if (typeof impl !== "function") {
    return { checked: false, reason: "load-balancer-health-probe-unavailable", id: options.loadBalancerId };
  }
  try {
    const health = await impl(options.loadBalancerId);
    return {
      checked: true,
      id: options.loadBalancerId,
      status: health.status ?? "unknown",
      ip: health.ip ?? null,
      forwardingRuleCount: Array.isArray(health.forwardingRules) ? health.forwardingRules.length : null,
    };
  } catch (error) {
    return {
      checked: false,
      id: options.loadBalancerId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// --- CLI wiring (real network implementations) -----------------------------

function realTlsCertImpl(timeoutMs) {
  return (host) =>
    new Promise((resolve, reject) => {
      import("node:tls").then((tls) => {
        const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true }, () => {
          const certificate = socket.getPeerCertificate(false);
          socket.end();
          resolve(certificate);
        });
        socket.setTimeout(timeoutMs, () => {
          socket.destroy(new Error(`TLS handshake timed out after ${timeoutMs}ms.`));
        });
        socket.on("error", (error) => reject(error));
      }, reject);
    });
}

function realDnsResolveImpl() {
  return async (host) => {
    const dns = await import("node:dns/promises");
    let addresses = [];
    let cnameTarget = null;
    try {
      addresses = await dns.resolve4(host);
    } catch {
      try {
        const cnames = await dns.resolveCname(host);
        cnameTarget = cnames[0] ?? null;
      } catch {
        cnameTarget = null;
      }
    }
    return { addresses, cnameTarget };
  };
}

function realLoadBalancerHealthImpl(token) {
  return async (id) => {
    const response = await globalThis.fetch(`https://api.digitalocean.com/v2/load_balancers/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`DigitalOcean load balancer API returned HTTP ${response.status}.`);
    }
    const body = await response.json();
    const balancer = body.load_balancer ?? {};
    return { status: balancer.status, ip: balancer.ip, forwardingRules: balancer.forwarding_rules ?? [] };
  };
}

function parseArgs(argv) {
  const options = { hosts: [], path: defaultReadinessPath, phase: "rehearse", environment: "staging" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") {
      options.hosts.push(readNext(argv, ++index, arg));
    } else if (arg === "--serving") {
      options.serving = readNext(argv, ++index, arg);
    } else if (arg === "--zone") {
      options.zone = readNext(argv, ++index, arg);
    } else if (arg === "--expected-target") {
      options.expectedTarget = readNext(argv, ++index, arg);
    } else if (arg === "--path") {
      options.path = readNext(argv, ++index, arg);
    } else if (arg === "--phase") {
      options.phase = readNext(argv, ++index, arg);
    } else if (arg === "--environment") {
      options.environment = readNext(argv, ++index, arg);
    } else if (arg === "--load-balancer-id") {
      options.loadBalancerId = readNext(argv, ++index, arg);
    } else if (arg === "--out") {
      options.out = readNext(argv, ++index, arg);
    } else {
      throw new Error(
        "Usage: node ./scripts/staging-doks-cutover-evidence.mjs (--host <fqdn> ... | --serving <app-platform|doks> --zone <zone>) [--expected-target <ip>] [--path <path>] [--phase <phase>] [--load-balancer-id <id>] [--out <file>]",
      );
    }
  }
  if (options.serving && !["app-platform", "doks"].includes(options.serving)) {
    throw new Error('--serving must be "app-platform" or "doks".');
  }
  if (options.hosts.length === 0 && !options.serving) {
    throw new Error("Provide at least one --host, or --serving with --zone.");
  }
  return options;
}

function readNext(argv, index, name) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function main(argv) {
  const options = parseArgs(argv);
  const timeoutMs = Number(process.env.CUTOVER_EVIDENCE_TLS_TIMEOUT_MS ?? "15000");
  const token = process.env.DIGITALOCEAN_ACCESS_TOKEN ?? "";
  const report = await captureCutoverEvidence({
    hosts: options.hosts.length > 0 ? options.hosts : undefined,
    serving: options.serving,
    zone: options.zone,
    path: options.path,
    phase: options.phase,
    environment: options.environment,
    expectedTarget: options.expectedTarget,
    loadBalancerId: options.loadBalancerId,
    fetchImpl: globalThis.fetch,
    tlsCertImpl: realTlsCertImpl(timeoutMs),
    dnsResolveImpl: realDnsResolveImpl(),
    loadBalancerHealthImpl: options.loadBalancerId && token ? realLoadBalancerHealthImpl(token) : undefined,
  });

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    const fs = await import("node:fs/promises");
    const pathModule = await import("node:path");
    await fs.mkdir(pathModule.dirname(options.out), { recursive: true });
    await fs.writeFile(options.out, serialized);
  }
  console.log(serialized);
  return report.summary.verdict === "pass" ? 0 : 1;
}

if (process.argv[1]?.endsWith("staging-doks-cutover-evidence.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
