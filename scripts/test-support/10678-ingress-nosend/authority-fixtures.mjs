// Pure in-memory SYNTHETIC controls. Never external runtime authority or review admission.
import { readFileSync, readdirSync } from "node:fs";
import { closurePaths, decisionSha256, repairDecisionSha256, retainedPath, supportPath } from "./inventory.mjs";
import { sha256 } from "./helpers.mjs";

export const fixtureHead = "a".repeat(40);
export const fixtureBytes = (v) => Buffer.from(JSON.stringify(v));
export const fixtureEncoded = (v) => {
  const bytes = Buffer.isBuffer(v) ? v : fixtureBytes(v);
  return { utf8Base64: bytes.toString("base64"), sha256: sha256(bytes) };
};
const root = new URL("../../../", import.meta.url);
export function fixturePayload() {
  const protocol = JSON.parse(readFileSync(new URL("./protocol.json", import.meta.url)));
  const files = [
    ...readdirSync(new URL("./", import.meta.url)).map((name) => `${supportPath}/${name}`),
    ...closurePaths,
  ];
  return {
    schema: 2,
    head: fixtureHead,
    phase: "inventory",
    briefSha256: protocol.briefSha256,
    methodSha256: protocol.methodSha256,
    decisionSha256,
    repairDecisionSha256,
    retainedConfigMap: { path: retainedPath },
    sources: protocol.stacks,
    publicInputs: JSON.parse(readFileSync(new URL("./inputs.template.json", import.meta.url))),
    files: Object.fromEntries(files.map((file) => [file, sha256(readFileSync(new URL(file, root)))])),
  };
}

// Same supported generic lane-complete producer fields, not review-complete or a controller receipt.
export function syntheticCompletion(dispatch, note, outcome = "PASS") {
  return {
    ts: "2000-01-01T00:02:00.000Z",
    kind: "lane-complete",
    issue: 10678,
    lane: dispatch.attemptId,
    laneRole: "review",
    harness: dispatch.harness,
    model: dispatch.model,
    effort: dispatch.effort,
    row: dispatch.row,
    placement: dispatch.placement,
    transcript: dispatch.transcript,
    outcome,
    note: JSON.stringify(note),
  };
}

export function fixtureAuthority(config = fixturePayload(), patch = {}) {
  const payload = fixtureEncoded(config);
  const dispatch = {
    ts: "2000-01-01T00:00:00.000Z",
    kind: "dispatch",
    dispatchRoutingSchema: "watchdog-dispatch-routing/v3",
    attemptId: "SYNTHETIC-10678-review",
    label: "SYNTHETIC-10678-review",
    lane: "20000101-SYNTHETIC-10678-review",
    laneRole: "review",
    transcript: "SYNTHETIC-10678-review.jsonl",
    harness: "codex",
    model: "SYNTHETIC-model",
    effort: "high",
    row: "11",
    placement: "provisional",
    worktree: "/SYNTHETIC/review",
    branch: "",
    head: config.head,
    policyGeneration: 4,
    registryAuthorityDigest: "a".repeat(16),
    family: "SYNTHETIC-family",
    slot: "explicit",
    usedLastKnownGood: false,
    capacityForecastStatus: "in-force",
    capacityDecisionDigest: "b".repeat(16),
    capacityFlip: null,
    capacityShadowFlip: null,
    capacityFlipSkip: null,
    issue: 10678,
  };
  const d = fixtureEncoded(dispatch);
  const footer = {
    issue: 10678,
    head: config.head,
    phase: config.phase,
    payloadSha256: payload.sha256,
    dispatchRawSha256: d.sha256,
    reviewerAttempt: dispatch.attemptId,
    authorAttempt: "SYNTHETIC-10678-author",
    verdict: "PASS",
    reviewScope: "COMPLETE",
    blocking: 0,
    candidates: 0,
    nonBlocking: 1,
  };
  const reportBytes = Buffer.from(
    `SYNTHETIC ONLY. No actual review, admission or execution authority.\n10678_REVIEW_SUBJECT_V1: ${JSON.stringify(footer)}\nWHOLE_TASK_RELEASE\n`,
  );
  const review = { schema: "10678-detached-review/v1", ...footer, reportSha256: sha256(reportBytes) };
  const r = fixtureEncoded(review);
  const note = {
    schema: "10678-review-completion/v1",
    dispatchRawSha256: d.sha256,
    head: config.head,
    phase: config.phase,
    payloadSha256: payload.sha256,
    reviewSha256: r.sha256,
    reportSha256: review.reportSha256,
    reviewerAttempt: footer.reviewerAttempt,
    authorAttempt: footer.authorAttempt,
    reviewScope: "COMPLETE",
  };
  const completion = syntheticCompletion(dispatch, note);
  const binding = {
    schema: "10678-review-subject/v2",
    issue: 10678,
    head: config.head,
    phase: config.phase,
    payloadSha256: payload.sha256,
    verdict: "PASS",
    reviewSha256: r.sha256,
    reportSha256: review.reportSha256,
    dispatch: d,
    completion: fixtureEncoded(completion),
  };
  const s = fixtureEncoded(binding);
  const envelope = {
    schema: 2,
    head: config.head,
    phase: config.phase,
    verdict: "PASS",
    payloadUtf8Base64: payload.utf8Base64,
    payloadSha256: payload.sha256,
    reviewUtf8Base64: r.utf8Base64,
    reviewSha256: r.sha256,
    subjectBindingUtf8Base64: s.utf8Base64,
    subjectBindingSha256: s.sha256,
    ...patch,
  };
  return { envelope, config, dispatch, completion, note, review, binding, reportBytes };
}
