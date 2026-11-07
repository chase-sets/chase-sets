// Pure event adapter controls; no collector, runner, subprocess or network execution.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inventoryRefusal, normalizePushEvent, validateExecutionHead } from "./inventory.mjs";
const protocol = JSON.parse(readFileSync(new URL("./protocol.json", import.meta.url)));
const head = "a".repeat(40);
const event = {
  repository: { full_name: "chase-sets/chase-sets" },
  ref: `refs/heads/${protocol.branch}`,
  before: "b".repeat(40),
  after: head,
  deleted: false,
};
const identity = { eventName: "push", ref: event.ref, sha: head };
const normalized = normalizePushEvent(event, identity, protocol);
assert.deepEqual(normalized, {
  eventName: "push",
  ref: event.ref,
  before: event.before,
  after: head,
  head,
  base: null,
  merge: null,
});
validateExecutionHead(normalized, head, head);
assert.throws(() => validateExecutionHead(normalized, "c".repeat(40), head));
assert.throws(() => validateExecutionHead(normalized, head, "c".repeat(40)));
for (const patch of [
  { repository: { full_name: "SYNTHETIC-fork/repo" } },
  { repository: {} },
  { ref: "refs/heads/main" },
  { ref: "refs/heads/other" },
  { ref: "refs/tags/host/10678-ingress-nosend-diagnostic" },
  { ref: undefined },
  { deleted: true },
  { deleted: undefined },
  { after: "0".repeat(40) },
  { after: "c".repeat(40) },
  { after: "bad" },
  { after: undefined },
  { before: undefined },
  { pull_request: { head: { sha: head } } },
])
  assert.throws(() => normalizePushEvent({ ...event, ...patch }, identity, protocol), /EVENT_NOT_ADMITTED/);
for (const patch of [
  { eventName: "pull_request" },
  { eventName: undefined },
  { ref: "refs/heads/main" },
  { ref: undefined },
  { sha: "c".repeat(40) },
  { sha: undefined },
])
  assert.throws(() => normalizePushEvent(event, { ...identity, ...patch }, protocol), /EVENT_NOT_ADMITTED/);
assert.equal(normalizePushEvent({ ...event, before: "0".repeat(40) }, identity, protocol).before, "0".repeat(40));
assert.equal(
  inventoryRefusal(new Error("EVENT_NOT_ADMITTED")),
  "INVENTORY_REFUSED_MEASUREMENT_NOT_EXECUTED category=EVENT_NOT_ADMITTED",
);
const secret = "SYNTHETIC_PRIVATE_cookie_token_value";
assert.equal(inventoryRefusal(new Error(secret)), "INVENTORY_REFUSED_MEASUREMENT_NOT_EXECUTED category=OTHER");
assert(!inventoryRefusal(new Error(secret)).includes(secret));
console.log("PASS pure push event matrix, checkout/disk/P identity and secret-safe N1 refusal controls");
