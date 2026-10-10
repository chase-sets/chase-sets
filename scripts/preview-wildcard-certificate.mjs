#!/usr/bin/env node
// Keeps the staging cluster's shared preview wildcard certificate
// (cert-manager/preview-wildcard, *.preview.chasesets.com) renewable and
// guards its validity. Every PR preview copies its secret, so an
// expired certificate fails every preview's TLS handshake.
//
//   converge  re-applies the staging DNS-01 token Secret from
//             DIGITALOCEAN_ACCESS_TOKEN (stdin only, via
//             applyDoksDnsTokenSecret) and, only when the certificate is
//             unhealthy, nudges a fresh issuance: stale non-Ready
//             CertificateRequests are deleted (cascading their Order and
//             Challenges, which can never complete once the ACME order has
//             expired) and the Issuing condition is set exactly as
//             `cmctl renew` does. It never waits.
//   check     read-only guard: fails closed when the certificate is not Ready
//             or expires within --min-remaining-days, optionally polling up to
//             --wait-seconds for an in-flight renewal to finish first.
import { spawn } from "node:child_process";
import process from "node:process";
import { applyDoksDnsTokenSecret } from "./doks-cluster-addons.mjs";

export const previewWildcardCertificateName = "preview-wildcard";
export const previewWildcardCertificateNamespace = "cert-manager";
export const previewWildcardRestoreWorkflow = ".github/workflows/platform-preview-wildcard-tls.yml";
// A request younger than this may be the one a previous converge just
// created; deleting it would only restart a healthy ACME order and spend
// Let's Encrypt validation quota.
export const staleCertificateRequestMinutes = 15;
const dayMs = 24 * 60 * 60 * 1000;

function condition(resource, type) {
  return resource?.status?.conditions?.find((entry) => entry.type === type);
}

// Pure assessment of a cert-manager Certificate object.
export function assessCertificate(certificate, options = {}) {
  const now = options.now ?? new Date();
  const minRemainingDays = options.minRemainingDays ?? 14;
  const ready = condition(certificate, "Ready");
  const notAfterMs = Date.parse(certificate?.status?.notAfter ?? "");
  const remainingDays = Number.isFinite(notAfterMs) ? (notAfterMs - now.getTime()) / dayMs : undefined;
  const problems = [];

  if (ready?.status !== "True") {
    problems.push(
      `Ready=${ready?.status ?? "Unknown"} (${ready?.reason ?? "no reason"}: ${ready?.message ?? "no message"})`,
    );
  }
  if (remainingDays === undefined) {
    problems.push("status.notAfter is missing");
  } else if (remainingDays < minRemainingDays) {
    problems.push(
      `notAfter ${certificate.status.notAfter} is ${remainingDays.toFixed(1)} day(s) away, below the ${minRemainingDays}-day floor`,
    );
  }

  return {
    healthy: problems.length === 0,
    notAfter: certificate?.status?.notAfter,
    remainingDays,
    issuing: condition(certificate, "Issuing")?.status === "True",
    problems,
  };
}

// Pure selection of the CertificateRequests a nudge should delete: ones that
// belong to this Certificate, are not Ready=True (successful requests are
// history), and are older than the stale floor.
export function staleCertificateRequestNames(requests, options = {}) {
  const now = options.now ?? new Date();
  const certificateName = options.certificateName ?? previewWildcardCertificateName;
  const staleMs = (options.staleMinutes ?? staleCertificateRequestMinutes) * 60 * 1000;

  return (requests ?? [])
    .filter((request) => request?.metadata?.annotations?.["cert-manager.io/certificate-name"] === certificateName)
    .filter((request) => condition(request, "Ready")?.status !== "True")
    .filter((request) => now.getTime() - Date.parse(request.metadata.creationTimestamp ?? "") >= staleMs)
    .map((request) => request.metadata.name)
    .sort();
}

// Pure `cmctl renew` equivalent: cmctl sets Issuing=True with reason
// ManuallyTriggered on the Certificate status. Returns undefined when
// issuance is already in progress, so the caller never resets an Issuing
// transition time cert-manager is tracking.
export function buildManualRenewStatusPatch(certificate, options = {}) {
  if (condition(certificate, "Issuing")?.status === "True") {
    return undefined;
  }

  const now = options.now ?? new Date();
  const conditions = (certificate?.status?.conditions ?? []).filter((entry) => entry.type !== "Issuing");
  conditions.push({
    type: "Issuing",
    status: "True",
    reason: "ManuallyTriggered",
    message: "Certificate re-issuance manually triggered by the preview wildcard converge",
    lastTransitionTime: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    observedGeneration: certificate?.metadata?.generation,
  });

  return { status: { conditions } };
}

export function formatCertificateGuardError(assessment) {
  return (
    `Preview wildcard certificate ${previewWildcardCertificateNamespace}/${previewWildcardCertificateName} is unhealthy: ` +
    `${assessment.problems.join("; ")}. Every PR preview copies its secret, so preview TLS fails until it renews. ` +
    `Restore it by re-applying the staging DNS-01 token and nudging renewal: ` +
    `gh workflow run ${previewWildcardRestoreWorkflow.split("/").pop()} --ref main -f confirm="restore preview wildcard tls" ` +
    `(see docs/runbooks/doks-platform-operations.md).`
  );
}

function defaultRunKubectl(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.kubectlPath ?? "kubectl", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }
      reject(new Error(`kubectl ${args.join(" ")} exited with code ${code ?? "unknown"}: ${stderr.trim()}`));
    });
  });
}

const namespaceArgs = ["--namespace", previewWildcardCertificateNamespace];

async function readCertificate(runKubectl) {
  const { stdout } = await runKubectl([
    "get",
    `certificate.cert-manager.io/${previewWildcardCertificateName}`,
    ...namespaceArgs,
    "--output",
    "json",
  ]);
  return JSON.parse(stdout);
}

export async function convergePreviewWildcardCertificate(options = {}) {
  const runKubectl = options.runKubectl ?? defaultRunKubectl;
  const applyTokenSecret = options.applyTokenSecret ?? applyDoksDnsTokenSecret;
  const log = options.log ?? console.log;
  const now = options.now ?? new Date();

  // The token is piped over kubectl stdin by applyDoksDnsTokenSecret; it is
  // never an argument here and never logged.
  const applied = await applyTokenSecret({ token: options.token, environment: "staging" });
  log(`Applied staging DNS-01 token secret ${applied.namespace}/${applied.name}.`);

  const certificate = await readCertificate(runKubectl);
  const assessment = assessCertificate(certificate, { now, minRemainingDays: options.minRemainingDays });
  if (assessment.healthy) {
    log(`Preview wildcard certificate is Ready until ${assessment.notAfter}; no renewal nudge needed.`);
    return { assessment, deletedRequests: [], triggered: false };
  }

  log(`Preview wildcard certificate is unhealthy (${assessment.problems.join("; ")}); nudging a fresh issuance.`);
  const { stdout } = await runKubectl([
    "get",
    "certificaterequests.cert-manager.io",
    ...namespaceArgs,
    "--output",
    "json",
  ]);
  const deletedRequests = staleCertificateRequestNames(JSON.parse(stdout).items, { now });
  for (const name of deletedRequests) {
    // Deleting the request cascades to its Order and Challenges through
    // owner references; cert-manager then creates a fresh request while
    // Issuing=True.
    await runKubectl(["delete", `certificaterequest.cert-manager.io/${name}`, ...namespaceArgs, "--wait=false"]);
    log(`Deleted stale CertificateRequest ${name}.`);
  }

  const patch = buildManualRenewStatusPatch(certificate, { now });
  if (patch) {
    await runKubectl([
      "patch",
      `certificate.cert-manager.io/${previewWildcardCertificateName}`,
      ...namespaceArgs,
      "--subresource=status",
      "--type=merge",
      "--patch",
      JSON.stringify(patch),
    ]);
    log("Set Issuing=True (ManuallyTriggered), the cmctl renew equivalent.");
  }

  return { assessment, deletedRequests, triggered: Boolean(patch) };
}

export async function checkPreviewWildcardCertificate(options = {}) {
  const runKubectl = options.runKubectl ?? defaultRunKubectl;
  const log = options.log ?? console.log;
  const warn = options.warn ?? ((message) => console.log(`::warning::${message}`));
  const clock = options.clock ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const waitSeconds = options.waitSeconds ?? 0;
  const pollSeconds = options.pollSeconds ?? 15;
  const deadline = clock().getTime() + waitSeconds * 1000;

  for (;;) {
    const certificate = await readCertificate(runKubectl);
    const assessment = assessCertificate(certificate, { now: clock(), minRemainingDays: options.minRemainingDays });
    if (assessment.healthy) {
      log(
        `Preview wildcard certificate is Ready until ${assessment.notAfter} (${assessment.remainingDays.toFixed(1)} day(s) left).`,
      );
      if (options.warnRemainingDays !== undefined && assessment.remainingDays < options.warnRemainingDays) {
        warn(
          `Preview wildcard certificate expires in ${assessment.remainingDays.toFixed(1)} day(s), below the ${options.warnRemainingDays}-day renewal floor; staging deploys will fail closed until it renews.`,
        );
      }
      return assessment;
    }
    if (clock().getTime() + pollSeconds * 1000 > deadline) {
      throw new Error(formatCertificateGuardError(assessment));
    }
    log(`Waiting for preview wildcard certificate: ${assessment.problems.join("; ")}.`);
    await sleep(pollSeconds * 1000);
  }
}

function nonNegativeNumber(value, flag) {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative number.`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const usage =
    "Usage: node ./scripts/preview-wildcard-certificate.mjs converge|check [--min-remaining-days <days>] [--warn-remaining-days <days>] [--wait-seconds <seconds>]";
  const [command, ...rest] = argv;
  if (command !== "converge" && command !== "check") {
    throw new Error(usage);
  }

  const options = { command, minRemainingDays: 14 };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--min-remaining-days") {
      options.minRemainingDays = nonNegativeNumber(rest[++index], arg);
    } else if (arg === "--warn-remaining-days" && command === "check") {
      options.warnRemainingDays = nonNegativeNumber(rest[++index], arg);
    } else if (arg === "--wait-seconds" && command === "check") {
      options.waitSeconds = nonNegativeNumber(rest[++index], arg);
    } else {
      throw new Error(usage);
    }
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.command === "converge") {
    await convergePreviewWildcardCertificate({
      token: process.env.DIGITALOCEAN_ACCESS_TOKEN,
      minRemainingDays: options.minRemainingDays,
    });
  } else {
    await checkPreviewWildcardCertificate(options);
  }
  return 0;
}

if (process.argv[1]?.endsWith("preview-wildcard-certificate.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
