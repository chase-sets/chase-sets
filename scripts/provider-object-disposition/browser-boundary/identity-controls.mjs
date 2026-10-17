import assert from "node:assert/strict";

// All recorded L/I1/browser identities must survive. Extra Chromium helpers are
// free to start or exit; a replacement can never satisfy a recorded identity.
export function assertIdentitySurvival(before, after) {
  assert.deepEqual(after, before);
}
