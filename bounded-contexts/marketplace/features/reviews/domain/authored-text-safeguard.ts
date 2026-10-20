/**
 * The one Marketplace safeguard for public text an account authors: Review
 * Feedback, Review Response feedback, and Listing Evidence image descriptions.
 * Every check is deterministic and content-neutral -- control characters,
 * text-direction overrides, link schemes other than https, and a repeated link.
 * It never judges meaning; whether text is abusive, deceptive, or otherwise
 * unsafe stays with human moderation through Reports.
 */

export const authoredTextFields = ["review-feedback", "review-response-feedback", "listing-evidence-alt-text"] as const;
export type AuthoredTextField = (typeof authoredTextFields)[number];

/** Closed rejection codes, in the fixed order the checks run. */
export const authoredTextRejectionCodes = [
  "text_control_character",
  "text_direction_override",
  "text_unsafe_link",
  "text_duplicate_link",
] as const;
export type AuthoredTextRejectionCode = (typeof authoredTextRejectionCodes)[number];

export class AuthoredTextRejectedError extends Error {
  public constructor(
    public readonly field: AuthoredTextField,
    public readonly code: AuthoredTextRejectionCode,
  ) {
    // Names only the closed field and code: authored text never reaches an
    // error message, response body, or log line.
    super(`Authored ${field} was rejected with ${code}.`);
    this.name = "AuthoredTextRejectedError";
  }
}

// C0 controls other than tab, line feed, and carriage return; DEL; C1 controls.
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
// Embeddings, overrides, and isolates reorder how text displays. Direction
// marks (LRM, RLM, ALM) do not and stay accepted for right-to-left writing.
const DIRECTION_OVERRIDE = /[\u202A-\u202E\u2066-\u2069]/u;
// Invisible format characters (zero-width joiners, soft hyphens, tags) are
// accepted in text but removed before link inspection so they cannot split a
// scheme name.
const FORMAT_CHARACTER = /\p{Cf}/gu;
// A scheme that does not continue a word, then a colon, then a non-space
// character: prose such as "Note: fast" or "data: delivered" is not a link.
const URI_SCHEME = /(?<![\p{L}\p{N}+.-])([a-z][a-z0-9+.-]*):(?=\S)/giu;
const SCRIPT_OR_DATA_SCHEMES = new Set(["javascript", "vbscript", "data", "file", "blob"]);
const TRAILING_LINK_PUNCTUATION = /[)\]}>.,;:!?'"]+$/u;

/**
 * Returns the first closed rejection code that applies to `text`, or null when
 * the text is accepted. Links are inspected on the NFKC form with format
 * characters removed, so fullwidth or zero-width-split schemes are judged the
 * way a link parser would read them; the stored text itself is never rewritten.
 */
export function findAuthoredTextRejection(text: string): AuthoredTextRejectionCode | null {
  if (CONTROL_CHARACTER.test(text)) return "text_control_character";
  if (DIRECTION_OVERRIDE.test(text)) return "text_direction_override";

  const inspected = text.normalize("NFKC").replace(FORMAT_CHARACTER, "");
  const seenLinks = new Set<string>();
  let duplicateLink = false;
  for (const token of inspected.split(/\s+/u)) {
    const schemes = [...token.matchAll(URI_SCHEME)];
    for (const [index, match] of schemes.entries()) {
      const scheme = match[1]!.toLowerCase();
      const start = match.index!;
      const hierarchical = token.startsWith("//", start + match[0].length);
      if (hierarchical ? scheme !== "https" : SCRIPT_OR_DATA_SCHEMES.has(scheme)) return "text_unsafe_link";
      if (!hierarchical) continue;

      // A link runs to the next scheme in the same token, keeping the scan
      // linear for whitespace-free runs of links.
      const link = linkIdentity(token.slice(start, schemes[index + 1]?.index ?? token.length));
      duplicateLink ||= seenLinks.has(link);
      seenLinks.add(link);
    }
  }

  return duplicateLink ? "text_duplicate_link" : null;
}

/**
 * Throws `AuthoredTextRejectedError` when newly authored `text` fails the
 * safeguard. A value equal to the currently stored `previous` value is carried
 * forward, not newly authored, so legacy content is never re-judged.
 */
export function assertSafeAuthoredText(
  field: AuthoredTextField,
  text: string | null | undefined,
  previous?: string | null,
): void {
  if (!text || text === previous) return;
  const code = findAuthoredTextRejection(text);
  if (code !== null) throw new AuthoredTextRejectedError(field, code);
}

function linkIdentity(candidate: string): string {
  const link = candidate.replace(TRAILING_LINK_PUNCTUATION, "");
  try {
    const url = new URL(link);
    return `${url.host}${url.pathname.replace(/\/+$/u, "")}${url.search}`;
  } catch {
    return link.toLowerCase();
  }
}
