import { t } from "@chase-sets/localization";
import type { AuthoredTextRejectionCode } from "../domain/authored-text-safeguard";

/** Closed codes an authoring form recovers from by editing or waiting, then resubmitting. */
export type AuthoredTextRecoveryCode = AuthoredTextRejectionCode | "rate_limited";

/** The one copy source for each closed code; every authoring surface renders these keys. */
export const authoredTextRecoveryCopy = {
  text_control_character: "marketplace.features.reviews.ui.authoredTextRecovery.controlCharacter",
  text_direction_override: "marketplace.features.reviews.ui.authoredTextRecovery.directionOverride",
  text_unsafe_link: "marketplace.features.reviews.ui.authoredTextRecovery.unsafeLink",
  text_duplicate_link: "marketplace.features.reviews.ui.authoredTextRecovery.duplicateLink",
  rate_limited: "marketplace.features.reviews.ui.authoredTextRecovery.rateLimited",
} as const satisfies Record<AuthoredTextRecoveryCode, string>;

function isAuthoredTextRecoveryCode(code: unknown): code is AuthoredTextRecoveryCode {
  return typeof code === "string" && Object.hasOwn(authoredTextRecoveryCopy, code);
}

/** Safe corrective text for a closed authoring code; null for every other code. */
export function authoredTextRecoveryMessage(code: string): string | null {
  return isAuthoredTextRecoveryCode(code) ? t(authoredTextRecoveryCopy[code]) : null;
}

/**
 * A closed rejection a form renders as recovery. `fieldLevel` is false for a
 * rate limit: the text itself is fine, so no field is marked invalid.
 */
export type AuthoredTextRecovery = Readonly<{
  code: AuthoredTextRecoveryCode;
  message: string;
  fieldLevel: boolean;
}>;

/** Recovery for the closed authoring code in an API error body (`{ error: { code } }`), or null. */
export function authoredTextRecoveryFromApiError(body: unknown): AuthoredTextRecovery | null {
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
  if (!isAuthoredTextRecoveryCode(code)) return null;
  return { code, message: t(authoredTextRecoveryCopy[code]), fieldLevel: code !== "rate_limited" };
}
