// SYNTHETIC decoder controls only, plus untouched real non-PASS dispatch shape.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeAuthority, maximumEnvelopeBytes, validateDispatch, validateReviewReport } from "./inventory.mjs";
import { sha256 } from "./helpers.mjs";
import {
  fixtureAuthority,
  fixtureBytes as bytes,
  fixtureEncoded as encoded,
  fixtureHead as head,
  fixtureMeasurementPayload,
} from "./authority-fixtures.mjs";
const protocol = JSON.parse(readFileSync(new URL("./protocol.json", import.meta.url)));
const accept = (e) => decodeAuthority(bytes(e), sha256(bytes(e)), { head, protocol });
const pack = (f) => {
  const r = encoded(f.review);
  Object.assign(f.binding, {
    reviewSha256: r.sha256,
    dispatch: encoded(f.dispatch),
    completion: encoded(f.completion),
  });
  const s = encoded(f.binding);
  return {
    ...f.envelope,
    reviewUtf8Base64: r.utf8Base64,
    reviewSha256: r.sha256,
    subjectBindingUtf8Base64: s.utf8Base64,
    subjectBindingSha256: s.sha256,
  };
};
const originalDispatchRaw = String.raw`{"ts":"2026-11-07T10:38:31.856Z","kind":"dispatch","dispatchRoutingSchema":"watchdog-dispatch-routing/v3","attemptId":"10678-h1-review-r1","label":"10678-h1-review-r1","lane":"20261107-10678-h1-review-r1","laneRole":"review","transcript":"10678-h1-review-r1.jsonl","harness":"codex","model":"gpt-6-astra","effort":"high","row":"11","placement":"provisional","worktree":"D:\\Users\\ToddS\\Source\\Repos\\chase-sets\\20261107-10678-h1-review-r1","branch":"","head":"cbd4068778b1fed220e6d43d2138d41b55839da6","policyGeneration":4,"registryAuthorityDigest":"f2b3d2c923541196","family":"astra","slot":"explicit","usedLastKnownGood":false,"capacityForecastStatus":"in-force","capacityDecisionDigest":"c71e166a3aca1f5d","capacityFlip":null,"capacityShadowFlip":null,"capacityFlipSkip":null,"issue":10678}`;
assert.equal(sha256(originalDispatchRaw), "351b124c4a7c3e7bbf1116363dcb0272ae84becc8b917d53ef1acdd4d094ecb7");
const original = JSON.parse(originalDispatchRaw);
assert.equal(validateDispatch(original, original.head), "10678-h1-review-r1");
assert(!Object.hasOwn(original, "subject"));
assert(
  !Object.values(original).includes(
    `10678:${original.head}:inventory:2c2ce8ca5a5d14d98a709f1eb7ca0a63ac6f3b81aea9b36f3dce86e64064d30d`,
  ),
);
assert.notEqual(original.head, head);
// It is not promoted to PASS, assigned a future head, or paired with invented completion facts.
assert.throws(() => validateDispatch(original, head));

const positive = fixtureAuthority();
accept(positive.envelope);
validateReviewReport(positive.reportBytes, positive.review);
assert(!Object.hasOwn(positive.dispatch, "subject"));
assert.notEqual(positive.dispatch.lane, positive.completion.lane);
assert.equal(positive.completion.lane, positive.dispatch.attemptId);
assert(Object.keys(positive.config.files).length >= 20);
const size = bytes(positive.envelope).length;
assert(size <= maximumEnvelopeBytes);
const padded = Buffer.from(`${JSON.stringify(positive.envelope)}${" ".repeat(maximumEnvelopeBytes - size)}`);
decodeAuthority(padded, sha256(padded), { head, protocol });
const over = Buffer.concat([padded, Buffer.from(" ")]);
assert.throws(() => decodeAuthority(over, sha256(over), { head, protocol }), /ENVELOPE_SIZE/);

const measurement = fixtureAuthority(fixtureMeasurementPayload());
const measuredBytes = bytes(measurement.envelope);
const decodedMeasurement = accept(measurement.envelope);
assert.equal(decodedMeasurement.config.tools.pnpm.closure.fileCount, 448);
assert.equal(decodedMeasurement.config.inventoryAuthority.job, "128523423088");
assert(measuredBytes.length <= maximumEnvelopeBytes);
const fullBoundary = Buffer.concat([measuredBytes, Buffer.alloc(maximumEnvelopeBytes - measuredBytes.length, 32)]);
decodeAuthority(fullBoundary, sha256(fullBoundary), { head, protocol });
const fullOver = Buffer.concat([fullBoundary, Buffer.from(" ")]);
assert.throws(() => decodeAuthority(fullOver, sha256(fullOver), { head, protocol }), /ENVELOPE_SIZE/);
console.log(
  `SYNTHETIC complete prospective measurement E=${measuredBytes.length}; real 448-pair descriptor/sidecar and all D/F-digest/R/C/S/E fields; 48000 accepted, 48001 refused`,
);

let negatives = 0;
const reject = (mutate) => {
  const f = fixtureAuthority();
  mutate(f);
  assert.throws(() => accept(pack(f)));
  negatives++;
};
for (const key of [
  "head",
  "phase",
  "payloadSha256",
  "dispatchRawSha256",
  "reportSha256",
  "issue",
  "verdict",
  "reviewScope",
  "blocking",
  "candidates",
  "nonBlocking",
  "reviewerAttempt",
  "authorAttempt",
])
  reject((f) => {
    f.review[key] = key === "nonBlocking" ? -1 : "SYNTHETIC-wrong";
  });
reject((f) => {
  f.review.authorAttempt = f.review.reviewerAttempt;
});
reject((f) => {
  delete f.review.authorAttempt;
});
for (const key of Object.keys(positive.review))
  reject((f) => {
    delete f.review[key];
  });
reject((f) => {
  f.review.extra = true;
});
for (const key of [
  "kind",
  "issue",
  "laneRole",
  "head",
  "attemptId",
  "label",
  "lane",
  "transcript",
  "harness",
  "model",
  "effort",
  "row",
  "placement",
  "ts",
  "family",
  "slot",
  "capacityForecastStatus",
  "dispatchRoutingSchema",
  "policyGeneration",
  "registryAuthorityDigest",
  "capacityDecisionDigest",
  "usedLastKnownGood",
])
  reject((f) => {
    f.dispatch[key] = "";
  });
for (const key of [
  "kind",
  "issue",
  "outcome",
  "lane",
  "laneRole",
  "harness",
  "model",
  "effort",
  "row",
  "placement",
  "transcript",
  "ts",
])
  reject((f) => {
    f.completion[key] = "SYNTHETIC-wrong";
  });
for (const key of Object.keys(positive.note))
  reject((f) => {
    const note = JSON.parse(f.completion.note);
    delete note[key];
    f.completion.note = JSON.stringify(note);
  });
for (const key of Object.keys(positive.note))
  reject((f) => {
    const note = JSON.parse(f.completion.note);
    note[key] = "SYNTHETIC-wrong";
    f.completion.note = JSON.stringify(note);
  });
reject((f) => {
  f.completion.note = "head-only PASS prose, short digest abc123";
});
reject((f) => {
  f.completion.note = JSON.stringify({ ...f.note, extra: true });
});
reject((f) => {
  f.completion.note = ` ${f.completion.note}`;
});
for (const key of Object.keys(positive.binding)) {
  const f = fixtureAuthority();
  delete f.binding[key];
  const s = encoded(f.binding);
  assert.throws(() =>
    accept({ ...f.envelope, subjectBindingUtf8Base64: s.utf8Base64, subjectBindingSha256: s.sha256 }),
  );
  negatives++;
}
for (const key of ["dispatch", "completion"]) {
  const f = fixtureAuthority();
  f.binding[key].pointers = {};
  const s = encoded(f.binding);
  assert.throws(() =>
    accept({ ...f.envelope, subjectBindingUtf8Base64: s.utf8Base64, subjectBindingSha256: s.sha256 }),
  );
  negatives++;
}
reject((f) => {
  f.binding.schema = "10678-review-subject/v1";
});
reject((f) => {
  f.binding.extra = true;
});

for (const key of ["dispatch", "completion"]) {
  const f = fixtureAuthority();
  f.binding[key].sha256 = "b".repeat(64);
  const s = encoded(f.binding);
  assert.throws(() =>
    accept({ ...f.envelope, subjectBindingUtf8Base64: s.utf8Base64, subjectBindingSha256: s.sha256 }),
  );
  negatives++;
  // Even semantically equivalent reserialization without a new external binding is tampering.
  f.binding[key].utf8Base64 = Buffer.from(
    JSON.stringify(key === "dispatch" ? f.dispatch : f.completion, null, 2),
  ).toString("base64");
  const changed = encoded(f.binding);
  assert.throws(() =>
    accept({ ...f.envelope, subjectBindingUtf8Base64: changed.utf8Base64, subjectBindingSha256: changed.sha256 }),
  );
  negatives++;
}
for (const field of ["payloadUtf8Base64", "reviewUtf8Base64", "subjectBindingUtf8Base64"]) {
  const e = { ...positive.envelope, [field]: `${positive.envelope[field]}\n` };
  assert.throws(() => accept(e));
  negatives++;
}
for (const bad of [Buffer.from([0xff]), Buffer.from("\ufeff{}"), Buffer.from('{"schema":2,"schema":2}')]) {
  assert.throws(() => decodeAuthority(bad, sha256(bad), { head, protocol }));
  negatives++;
}
const duplicate = Buffer.from(JSON.stringify(positive.envelope).replace('"schema":2', '"schema":2,"schema":2'));
assert.throws(() => decodeAuthority(duplicate, sha256(duplicate), { head, protocol }), /DUPLICATE/);
for (const [field, hashField] of [
  ["payloadUtf8Base64", "payloadSha256"],
  ["reviewUtf8Base64", "reviewSha256"],
  ["subjectBindingUtf8Base64", "subjectBindingSha256"],
]) {
  const raw = Buffer.from(
    Buffer.from(positive.envelope[field], "base64").toString().replace(/^{/, '{"DUPLICATE":1,"DUPLICATE":2,'),
  );
  const e = { ...positive.envelope, [field]: raw.toString("base64"), [hashField]: sha256(raw) };
  if (field === "reviewUtf8Base64") {
    const s = encoded({ ...positive.binding, reviewSha256: sha256(raw) });
    e.subjectBindingUtf8Base64 = s.utf8Base64;
    e.subjectBindingSha256 = s.sha256;
  }
  assert.throws(() => accept(e), /DUPLICATE/);
  negatives++;
}
for (const key of ["dispatch", "completion"]) {
  const f = fixtureAuthority();
  const raw = Buffer.from(JSON.stringify(f[key]).replace(/^{/, '{"DUPLICATE":1,"DUPLICATE":2,'));
  f.binding[key] = encoded(raw);
  const s = encoded(f.binding);
  assert.throws(
    () => accept({ ...f.envelope, subjectBindingUtf8Base64: s.utf8Base64, subjectBindingSha256: s.sha256 }),
    /DUPLICATE/,
  );
  negatives++;
}
reject((f) => {
  f.completion.note = f.completion.note.replace(/^{/, '{"DUPLICATE":1,"DUPLICATE":2,');
});
for (const text of [
  "SYNTHETIC report without footer",
  `10678_REVIEW_SUBJECT_V1: {}\n`,
  `${positive.reportBytes}\n${positive.reportBytes}`,
]) {
  const report = Buffer.from(text);
  assert.throws(() => validateReviewReport(report, { ...positive.review, reportSha256: sha256(report) }));
  negatives++;
}
assert.throws(() => validateReviewReport(Buffer.from("tampered"), positive.review));
console.log(
  `PASS D5 original non-PASS dispatch, synthetic full-census inventory E=${size} bytes, exact 48000-byte boundary, ${negatives} independent negative controls; actual F/R/C/E PENDING_HOST_REVIEW`,
);
