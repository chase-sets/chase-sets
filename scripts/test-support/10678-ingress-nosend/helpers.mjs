import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const invariant = (condition, code) => {
  if (!condition) throw new Error(code);
};
export const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isRef = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export const isImage = (value) => typeof value === "string" && /^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(value);

export function parseProtocol(text) {
  const p = JSON.parse(text);
  invariant(
    p.schema === 1 &&
      p.round === "10678-one-logical-round" &&
      p.host === "admin.staging.chasesets.com" &&
      p.path === "/api/catalog/source-observations/merge-candidates/generate" &&
      p.backendPort === 8080 &&
      p.branch === "host/10678-ingress-nosend-diagnostic" &&
      p.job === "ingress-nosend-diagnostic" &&
      p.durationMs === 12005 &&
      p.toleranceMs === 25 &&
      p.jobCeilingMinutes === 30 &&
      p.protocolCeilingMinutes === 10 &&
      JSON.stringify(p.rungs) === "[1,100,302,1000]" &&
      p.control.candidates === 302 &&
      p.control.durationMs === 100 &&
      p.chart.name === "ingress-nginx" &&
      p.chart.version === "4.11.3" &&
      p.retainedConfigMapSha256 === "a9c196c3ed04ff4e2612052597296d9b898bddbdae1649eaedc047591b8bec52" &&
      p.briefSha256 === "492610de9d989a24627efcacd2ca5043f85f08cdd3858b38c345f7e5811a6a94" &&
      p.methodSha256 === "15a2c4d7678982530a9098f2f9337d0e695e93cb0f746efd4f927b8e80d1d65b" &&
      p.stacks.length === 2 &&
      p.stacks[0].id === "historical" &&
      p.stacks[0].ref === "edddac45d0885dbb32432486f48e23968402a50c" &&
      p.stacks[0].adapter === "1.19.17" &&
      p.stacks[0].historicalNodePatch === "UNKNOWN" &&
      p.stacks[1].id === "current" &&
      p.stacks[1].ref === "b3df7dfba984aee859c064cc00211ed83e41bee5" &&
      p.stacks[1].adapter === "2.1.6" &&
      p.stacks[1].candidateCommit === "76cf718a845269f521678527bcba37f04d3935ce",
    "PROTOCOL_CHANGED",
  );
  return p;
}

export function matrix(p) {
  return p.stacks.flatMap((stack) =>
    [...p.rungs.map((candidates) => ({ candidates, durationMs: p.durationMs })), p.control].map((rung, i) => ({
      id: `${stack.id}-${i + 1}`,
      stack: stack.id,
      ref: stack.ref,
      ...rung,
      control: i === 4,
    })),
  );
}

export function parseAccess(line) {
  // This is the repository's unchanged query-free log-format-upstream, not a new nginx log format.
  const match = line.match(
    /^(\S+) - (\S+) \[([^\]]+)\] "(\S+) (\S+) (\S+)" (\d+) (\d+) "([^"]*)" (\d+) ([\d.]+) \[([^\]]*)\] \[([^\]]*)\] (.*?) ([\d-]+(?:(?:, | : )[\d-]+)*) ([\d.-]+(?:(?:, | : )[\d.-]+)*) ([\d-]+(?:(?:, | : )[\d-]+)*) (\S+)$/,
  );
  if (!match) return null;
  const parts = (s) => s.split(/[, :]\s*/).filter(Boolean);
  return {
    line,
    method: match[4],
    path: match[5],
    status: Number(match[7]),
    bytes: Number(match[8]),
    userAgent: match[9],
    seconds: Number(match[11]),
    upstream: match[12],
    alternative: match[13],
    endpoint: match[14],
    lengths: parts(match[15]),
    durations: parts(match[16]),
    statuses: parts(match[17]),
    nginxId: match[18],
  };
}

export function classifyRow(row, p) {
  const { app, client, access, socket } = row;
  if (!app || !client || !access || !socket || row.captureComplete !== true) return "UNKNOWN";
  if (
    app.status !== 202 ||
    Math.abs(app.durationMs - row.durationMs) > p.toleranceMs ||
    !app.appTrace ||
    !access.nginxId ||
    !access.endpoint ||
    !client.complete
  )
    return "UNKNOWN";
  const zero502 = access.statuses.some((status, i) => status === "502" && access.lengths[i] === "0");
  if (zero502) return "REPRODUCED_SIGNATURE";
  if (
    client.status === 202 &&
    client.contentType?.startsWith("application/json") &&
    client.bytes === socket.bodyBytes &&
    client.bodySha256 === socket.bodySha256 &&
    socket.finished === true &&
    access.status === 202 &&
    access.statuses.length === 1 &&
    access.statuses[0] === "202"
  )
    return "APPLICATION_202_DELIVERED";
  return "OTHER_FAILURE";
}

export function assembleReceipt(p, rows, phases) {
  const expected = matrix(p);
  invariant(new Set(rows.map((r) => r.id)).size === rows.length, "DUPLICATE_ROW");
  invariant(
    rows.every((r, i) => r.id === expected[i]?.id),
    "ROW_ORDER_CHANGED",
  );
  invariant(
    rows.every((r, i) =>
      ["stack", "ref", "candidates", "durationMs", "control"].every((key) => r[key] === expected[i][key]),
    ),
    "ROW_PROTOCOL_CHANGED",
  );
  const full = rows.length === expected.length && phases.protocolComplete === true;
  const classified = rows.map((r) => ({ ...r, classification: classifyRow(r, p) }));
  const complete = full && classified.every((r) => r.classification !== "UNKNOWN");
  let disposition = rows.length ? "PARTIAL_UNKNOWN_HOST_DISPOSITION" : "NOT_EXECUTED";
  if (complete) {
    const old = classified.some((r) => r.stack === "historical" && r.classification === "REPRODUCED_SIGNATURE");
    const current = classified.some((r) => r.stack === "current" && r.classification === "REPRODUCED_SIGNATURE");
    if (current) disposition = "CURRENT_STACK_REPRODUCES_EVIDENCE_SELECTED_REPAIR_REQUIRED";
    else if (old) {
      disposition = classified
        .filter((r) => r.stack === "current")
        .every((r) => r.classification === "APPLICATION_202_DELIVERED")
        ? "OLD_ONLY_ADAPTER_CANDIDATE_HOST_SERVING_GATE_REQUIRED"
        : "OLD_ONLY_CANDIDATE_NOT_PROVEN_STOP_TO_HOST";
    } else disposition = "NEITHER_STACK_REPRODUCES_STOP_TO_HOST_NO_RETRY";
  }
  return {
    schema: 1,
    synthetic: true,
    round: p.round,
    complete,
    disposition,
    rows: expected.map(
      (r) => classified.find((actual) => actual.id === r.id) ?? { ...r, classification: "NOT_EXECUTED" },
    ),
    phases,
    liveAC3: "NOT_EXECUTED_NOT_AUTHORIZED",
    exposureInvestigationEX1: "SEPARATE_NONBLOCKING_NOT_PERFORMED",
    artifactAuthority: "PENDING_HOST_POST_UPLOAD_CUSTODY",
    mechanism: "SIGNATURE_IS_NOT_MECHANISM_REVIEW_RAW_TIMEOUT_RETRY_CLOSE_WRITE_EVIDENCE",
  };
}

export function validateBundle(meta) {
  const imports = Object.values(meta.outputs).flatMap((o) => o.imports);
  invariant(
    imports.every((i) => !i.external || isBuiltin(i.path)),
    "NON_BUILTIN_EXTERNAL_IMPORT",
  );
  invariant(Object.keys(meta.inputs).length > 3, "INCOMPLETE_BUNDLE_CLOSURE");
}

export function scanExposure(files, depth = 0) {
  const hits = [];
  for (const { file, text } of files) {
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      const encoded = [...line.matchAll(/"bodyBase64"\s*:\s*"([A-Za-z0-9+/=]+)"/g)];
      const decoded = encoded.map((m) => Buffer.from(m[1], "base64").toString("utf8"));
      if (
        depth > 8 ||
        line.includes("\ufffd") ||
        /(?:Bearer\s+[A-Za-z0-9._~-]{8,}|\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16}|sk_(?:live|test)_[A-Za-z0-9]+)|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i.test(
          line,
        ) ||
        /\b(?:authorization|set-cookie|cookie|token|secret|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|code|query)["'\s]*[:=]["'\s]*[^\s,"'}]{4,}/i.test(
          line,
        ) ||
        /"(?:authorization|set-cookie|cookie)"\s*,\s*"[^"\r\n]+"/i.test(line) ||
        /(?:https?:\/\/[^\s"<>]+|\/(?:api|ucp|mcp|channel-connector)[^\s"<>]*)\?[^\s"<>]+/i.test(line) ||
        /[?&](?:token|code|state|query|q|key|secret)=/i.test(line) ||
        decoded.some((value) => scanExposure([{ file, text: value }], depth + 1).length > 0)
      )
        hits.push({ file, line: i + 1 });
    }
  }
  return hits;
}

export const exposureRuleIds = Object.freeze([
  "DEPTH",
  "REPLACEMENT_CHAR",
  "TOKEN_OR_PRIVATE_KEY",
  "LABELED_FIELD",
  "COOKIE_ARRAY",
  "URL_QUERY",
  "QUERY_PARAMETER",
  "ENCODED_BODY",
]);

// Compile only this module's fixed scanner source, not capture text. Keep the scanner
// byte-identical while evaluating every original OR term instead of short-circuiting.
const classifiedScanner = (() => {
  const source = scanExposure.toString().replaceAll("\r\n", "\n");
  const start = source.indexOf("      if (\n");
  const end = source.indexOf("        hits.push({ file, line: i + 1 });", start);
  const predicates = source.slice(start + "      if (\n".length, end).trim().slice(0, -1).trim().split(" ||\n");
  invariant(predicates.length === exposureRuleIds.length, "EXPOSURE_CLASSIFIER_SOURCE_MISMATCH");
  const classified = `${source.slice(0, start)}
      const rules = [${predicates.map((predicate, i) => `((${predicate}) ? ${JSON.stringify(exposureRuleIds[i])} : null)`).join(",")}].filter(Boolean);
      if (rules.length) hits.push({ file, line: i + 1, rules });${source.slice(end + "        hits.push({ file, line: i + 1 });".length)}`;
  return new Function("scanExposure", `return (${classified});`)(scanExposure);
})();

export function classifyExposure(files, depth = 0) {
  return classifiedScanner(files, depth);
}
