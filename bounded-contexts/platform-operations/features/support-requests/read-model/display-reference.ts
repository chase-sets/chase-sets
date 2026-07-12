import {
  DISPLAY_REFERENCE_SUFFIX_LENGTHS,
  deriveDisplayReferenceOrRaw,
} from "@chase-sets/primitives/display-reference";
import type { SupportRequestId } from "@chase-sets/primitives/typed-ids";

/** Unique index name backing `support_request_pages.display_reference`. */
export const SUPPORT_REQUEST_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT = "support_request_pages_display_reference_key";

/** Resolves the stable support-case reference with the shared 8 -> 10 -> 12 collision posture. */
export async function withSupportRequestDisplayReference<T>(
  supportRequestId: SupportRequestId,
  insert: (displayReference: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (const suffixLength of DISPLAY_REFERENCE_SUFFIX_LENGTHS) {
    const displayReference = deriveDisplayReferenceOrRaw(supportRequestId, { suffixLength });
    try {
      return await insert(displayReference);
    } catch (error) {
      if (!isSupportRequestDisplayReferenceUniqueViolation(error)) {
        throw error;
      }
      lastError = error;
      if (displayReference === supportRequestId) {
        break;
      }
    }
  }

  throw lastError;
}

function isSupportRequestDisplayReferenceUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Readonly<{ code?: unknown; constraint?: unknown }>;
  return candidate.code === "23505" && candidate.constraint === SUPPORT_REQUEST_DISPLAY_REFERENCE_UNIQUE_CONSTRAINT;
}
