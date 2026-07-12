import { createHash, timingSafeEqual } from "node:crypto";
import { resolvePlatformInternalAuthSecret } from "./http";

// Server-only: node:crypto must never reach a browser bundle. This module is
// deliberately separate from ./http, whose exports are consumed by route
// support code that stays in client module graphs -- a top-level node:crypto
// import there kills client hydration in dev-mode module evaluation.
export function verifyPlatformInternalAuthSecret(
  headerValue: string | null | undefined,
  expectedSecret = resolvePlatformInternalAuthSecret(),
) {
  const expected = hashInternalAuthSecret(expectedSecret);
  const actual = hashInternalAuthSecret(headerValue ?? "");
  return timingSafeEqual(actual, expected);
}

function hashInternalAuthSecret(value: string) {
  return createHash("sha256").update(value).digest();
}
