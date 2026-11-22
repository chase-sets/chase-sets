import { IdentityDomainError } from "../../../support/runtime-support/common";

export const displayNameRejectionCodes = [
  "text_control_character",
  "text_direction_override",
  "text_unsafe_link",
  "text_duplicate_link",
] as const;
export type DisplayNameRejectionCode = (typeof displayNameRejectionCodes)[number];

export function isDisplayNameRejectionCode(value: unknown): value is DisplayNameRejectionCode {
  return (displayNameRejectionCodes as readonly unknown[]).includes(value);
}

export class DisplayNameRejectedError extends IdentityDomainError {
  constructor(readonly code: DisplayNameRejectionCode) {
    super(code);
    this.name = "DisplayNameRejectedError";
  }
}

export function assertSafeDisplayName(displayName: string, previous?: string): void {
  if (displayName === previous) return;
  const code = findDisplayNameRejection(displayName);
  if (code !== null) throw new DisplayNameRejectedError(code);
}

// Mirrors the Marketplace authored-text safeguard; the authoring policy stays context-owned.
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
export function findDisplayNameRejection(text: string): DisplayNameRejectionCode | null {
  if (CONTROL_CHARACTER.test(text)) return "text_control_character";
  if (DIRECTION_OVERRIDE.test(text)) return "text_direction_override";

  const inspected = text.normalize("NFKC").replace(FORMAT_CHARACTER, "");
  const seenLinks = new Set<string>();
  let duplicateLink = false;
  for (const token of inspected.split(/\s+/u)) {
    const schemes = [...token.matchAll(URI_SCHEME)];
    const linkStarts = schemes
      .filter((match) => token.startsWith("//", match.index! + match[0].length))
      .map((match) => match.index!);
    let inLink = false;
    let next = 0;
    for (const match of schemes) {
      const scheme = match[1]!.toLowerCase();
      const start = match.index!;
      const hierarchical = token.startsWith("//", start + match[0].length);
      if (!hierarchical) {
        // A scheme-like segment directly following URL syntax belongs to the
        // running hierarchical link rather than starting a new scheme.
        const before = token[start - 1];
        if (inLink && before !== undefined && "/?=&#:@".includes(before)) continue;
        if (SCRIPT_OR_DATA_SCHEMES.has(scheme)) return "text_unsafe_link";
        continue;
      }
      if (scheme !== "https") return "text_unsafe_link";
      inLink = true;
      next++;

      // A link runs to the next hierarchical scheme in the same token,
      // keeping the scan linear for whitespace-free runs of links.
      const link = linkIdentity(token.slice(start, linkStarts[next] ?? token.length));
      duplicateLink ||= seenLinks.has(link);
      seenLinks.add(link);
    }
  }

  return duplicateLink ? "text_duplicate_link" : null;
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
