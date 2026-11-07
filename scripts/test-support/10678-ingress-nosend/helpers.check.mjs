import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assembleReceipt,
  classifyRow,
  classifyExposure,
  exposureRuleIds,
  isImage,
  matrix,
  parseAccess,
  parseProtocol,
  scanExposure,
  sha256,
  validateBundle,
} from "./helpers.mjs";

const protocolText = readFileSync(new URL("./protocol.json", import.meta.url), "utf8");
const p = parseProtocol(protocolText);
let checks = 0;
const check = (name, run) => {
  run();
  checks++;
  console.log(`PASS ${name}`);
};
const accessLine = (tail = "208 12.006 202", id = "nginx-distinct-id") =>
  `172.29.0.4 - - [07/Nov/2026:12:00:00 +0000] "POST ${p.path} HTTP/1.1" 202 208 "ingress-nosend-historical-1" 360 12.009 [diagnostic-api-8080] [] 172.29.0.5:8080 ${tail} ${id}`;
const delivered = (r) => ({
  ...r,
  captureComplete: true,
  app: { status: 202, durationMs: r.durationMs, appTrace: "synthetic-app-trace" },
  client: { status: 202, contentType: "application/json", bytes: 208, bodySha256: "same", complete: true },
  access: parseAccess(accessLine()),
  socket: { bodyBytes: 208, bodySha256: "same", finished: true },
});
check("fixed ten rows, serial order, measured duration and control", () => {
  assert.equal(matrix(p).length, 10);
  assert.deepEqual(
    matrix(p).map((r) => r.candidates),
    [1, 100, 302, 1000, 302, 1, 100, 302, 1000, 302],
  );
  for (const patch of [
    { backendPort: 3000 },
    { durationMs: 12000 },
    { rungs: [1, 302] },
    { stacks: [...p.stacks].reverse() },
    { protocolCeilingMinutes: 11 },
  ])
    assert.throws(() => parseProtocol(JSON.stringify({ ...p, ...patch })), /PROTOCOL_CHANGED/);
});
check("nginx default-backend and retry groups retain zero-byte signature", () => {
  const parsed = parseAccess(accessLine("0 : 548 12.010 : 0.001 502 : 404"));
  assert.deepEqual(parsed.statuses, ["502", "404"]);
  assert.deepEqual(parsed.lengths, ["0", "548"]);
  assert.deepEqual(parseAccess(accessLine("0, 0 : 548 5.000, 7.010 : 0.001 502, 502 : 404")).statuses, [
    "502",
    "502",
    "404",
  ]);
  assert.equal(parseAccess("truncated nginx line"), null);
});
check("completion is not delivery; exact calibration and complete evidence required", () => {
  const r = delivered(matrix(p)[0]);
  assert.equal(classifyRow(r, p), "APPLICATION_202_DELIVERED");
  assert.equal(classifyRow({ ...r, socket: { ...r.socket, finished: false } }, p), "OTHER_FAILURE");
  assert.equal(classifyRow({ ...r, client: { ...r.client, bodySha256: "different" } }, p), "OTHER_FAILURE");
  assert.equal(classifyRow({ ...r, app: { ...r.app, durationMs: 12031 } }, p), "UNKNOWN");
  assert.equal(classifyRow({ ...r, app: { ...r.app, durationMs: 12030 } }, p), "APPLICATION_202_DELIVERED");
  assert.equal(classifyRow({ ...r, captureComplete: false }, p), "UNKNOWN");
  assert.equal(
    classifyRow({ ...r, access: parseAccess(accessLine("0 : 548 12.010 : 0.001 502 : 404")) }, p),
    "REPRODUCED_SIGNATURE",
  );
  assert.equal(classifyRow({ ...r, access: parseAccess(accessLine("548 12.010 502")) }, p), "OTHER_FAILURE");
});
check("total receipt states and old/current/neither selection cannot create live authority", () => {
  const rows = matrix(p).map(delivered);
  assert.equal(assembleReceipt(p, [], {}).disposition, "NOT_EXECUTED");
  assert.match(assembleReceipt(p, rows.slice(0, 4), {}).disposition, /PARTIAL_UNKNOWN/);
  assert.equal(
    assembleReceipt(p, rows, { protocolComplete: true }).disposition,
    "NEITHER_STACK_REPRODUCES_STOP_TO_HOST_NO_RETRY",
  );
  rows[0].access = parseAccess(accessLine("0 : 548 12.010 : 0.001 502 : 404"));
  assert.match(assembleReceipt(p, rows, { protocolComplete: true }).disposition, /^OLD_ONLY_ADAPTER/);
  rows[5].access = rows[0].access;
  const receipt = assembleReceipt(p, rows, { protocolComplete: true });
  assert.match(receipt.disposition, /^CURRENT_STACK_REPRODUCES/);
  assert.equal(receipt.liveAC3, "NOT_EXECUTED_NOT_AUTHORIZED");
  assert.throws(() => assembleReceipt(p, [rows[0], rows[0]], {}), /DUPLICATE_ROW/);
  assert.throws(() => assembleReceipt(p, [rows[1]], {}), /ROW_ORDER_CHANGED/);
  assert.throws(() => assembleReceipt(p, [{ ...rows[0], durationMs: 1 }], {}), /ROW_PROTOCOL_CHANGED/);
});
check("private scan catches token, cookie, code, query and encoded-body leaks without echo", () => {
  assert.deepEqual(
    scanExposure([{ file: "headers.log", text: JSON.stringify({ headers: ["set-cookie", "syntheticCookie"] }) }]),
    [{ file: "headers.log", line: 1 }],
  );
  const leaked = [
    "Bearer syntheticSecret123",
    "cookie: syntheticCookie",
    "code=syntheticCode",
    "https://example.invalid/api/path?q=private",
    "/api/path?query=private",
  ];
  for (const leak of leaked) {
    assert.deepEqual(scanExposure([{ file: "synthetic.log", text: `clean\n${leak}` }]), [
      { file: "synthetic.log", line: 2 },
    ]);
    const bodyBase64 = Buffer.from(leak).toString("base64");
    assert.deepEqual(scanExposure([{ file: "encoded.log", text: JSON.stringify({ bodyBase64 }) }]), [
      { file: "encoded.log", line: 1 },
    ]);
  }
  assert.deepEqual(
    scanExposure([
      { file: "clean.json", text: JSON.stringify({ synthetic: true, appTrace: "synthetic-123", status: 202 }) },
    ]),
    [],
  );
});
check("bundle closure rejects non-builtin externals and image tags without digests", () => {
  const meta = {
    inputs: { a: {}, b: {}, c: {}, d: {} },
    outputs: { bundle: { imports: [{ path: "node:fs", external: true }] } },
  };
  validateBundle(meta);
  assert.throws(
    () => validateBundle({ ...meta, outputs: { bundle: { imports: [{ path: "hono", external: true }] } } }),
    /NON_BUILTIN_EXTERNAL/,
  );
  assert.equal(isImage("node:24-bookworm-slim"), false);
  assert.equal(isImage(`node:24-bookworm-slim@sha256:${"a".repeat(64)}`), true);
  assert.equal(sha256("synthetic").length, 64);
});
check("classifier evaluates the unchanged scanner predicates and every matching rule", () => {
  const corpus = [
    "neutral synthetic text",
    "\ufffd",
    "Bearer syntheticMarker123",
    "token: syntheticMarker123",
    '["cookie", "syntheticMarker123"]',
    "https://example.invalid/path?neutral=value",
    "?state=syntheticMarker123",
    JSON.stringify({ bodyBase64: Buffer.from("token: syntheticMarker123").toString("base64") }),
    "token: https://example.invalid/path?state=syntheticMarker123",
  ].map((text, i) => ({ file: `synthetic-${i}`, text: `neutral\n${text}\nneutral` }));
  const verify = (classify, depth = 0) => {
    const classified = classify(corpus, depth);
    assert.deepEqual(classified.map(({ file, line }) => ({ file, line })), scanExposure(corpus, depth));
    return classified;
  };
  const classified = verify(classifyExposure);
  const deep = verify(classifyExposure, 9);
  assert.deepEqual(new Set([...classified, ...deep].flatMap(({ rules }) => rules)), new Set(exposureRuleIds));
  assert.deepEqual(classified.at(-1).rules, ["LABELED_FIELD", "URL_QUERY", "QUERY_PARAMETER"]);
  for (const rule of exposureRuleIds) {
    const dropping = (files, depth) => classifyExposure(files, depth)
      .map((hit) => ({ ...hit, rules: hit.rules.filter((entry) => entry !== rule) }))
      .filter(({ rules }) => rules.length);
    assert.throws(() => verify(dropping, rule === "DEPTH" ? 9 : 0), undefined, `dropping ${rule} must go red`);
  }
  // The fixed scanner body remains exactly H1'''; the classifier contains no regex literals.
  assert.equal(sha256(scanExposure.toString().replaceAll("\r\n", "\n")), "2c5519d273b0e86622983f767c430ec9427b1b24bcb57ba185ccac77ff55232b");
});
console.log(`PASS ${checks} focused pure-helper groups; no processes, containers, network or harness execution`);
