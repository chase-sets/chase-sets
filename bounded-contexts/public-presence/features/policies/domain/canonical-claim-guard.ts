import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalClaimRegistry } from "./canonical-claims";
import type { PublicPolicyRegistryEntry } from "./policy-registry";

export type CanonicalClaimViolation = Readonly<{
  policyKey: string;
  sectionId: string;
  claimId: string;
  reason: string;
}>;

const evidenceRefPattern = /^([\w./-]+):(\d+)(?:-(\d+))?$/;

function resolveEvidenceRef(ref: string): Readonly<{ path: string; start: number; end: number }> | null {
  const match = evidenceRefPattern.exec(ref.trim());
  if (!match) {
    return null;
  }
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  if (end < start) {
    return null;
  }
  return { path: match[1], start, end };
}

function readCitedText(repoRoot: string, path: string, start: number, end: number): string | null {
  let content: string;
  try {
    content = readFileSync(resolve(repoRoot, path), "utf8");
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);
  if (start < 1 || end > lines.length) {
    return null;
  }
  return lines.slice(start - 1, end).join("\n");
}

/**
 * The one canonical-claim cross-artifact consistency check. The
 * registry in canonical-claims.ts is the sole arbiter of a shared claim's
 * settled/unresolved status, so every section across every artifact that
 * references the same claimId is checked against that single status — no two
 * artifacts can disagree, and a settled claim's cited evidence must actually
 * contain the claim's required keywords at the exact cited lines, so a
 * mis-citation (evidence pointing at unrelated code) fails closed instead of
 * only on human review.
 *
 * Beyond that manifest bookkeeping, this also evaluates the PUBLIC/rendered
 * source — `draftText` and the structural `claimDisclosures` segments — not
 * just the packet-only review manifest: a section that registers a claim as
 * unresolved must carry a structural claim-disclosure segment for it (the
 * claim-aware boundary, not free-form prose), and no section's rendered
 * draft text corpus-wide may contain a claim's narrow, per-claim forbidden
 * settled-style phrasing while that claim remains unresolved (defense in
 * depth, independent of section/file naming).
 */
export function evaluateCanonicalClaimConsistency(
  registry: readonly PublicPolicyRegistryEntry[],
  repoRoot: string,
): readonly CanonicalClaimViolation[] {
  const violations: CanonicalClaimViolation[] = [];

  for (const entry of registry) {
    const policyKey = entry.artifact.metadata.policyKey;
    for (const section of entry.artifact.sections) {
      const lowered = section.draftText.toLowerCase();
      for (const [claimId, definition] of Object.entries(canonicalClaimRegistry)) {
        if (definition.status !== "unresolved") {
          continue;
        }
        for (const phrase of definition.forbiddenAssertionPhrases ?? []) {
          if (lowered.includes(phrase.toLowerCase())) {
            violations.push({
              policyKey,
              sectionId: section.id,
              claimId,
              reason:
                `renders a forbidden settled-style assertion ('${phrase}') in its public draft text for the ` +
                `unresolved canonical claim '${claimId}' — this applies regardless of whether the section ` +
                "declares that claim in its own canonicalClaims manifest.",
            });
          }
        }
      }
    }
  }

  for (const entry of registry) {
    const policyKey = entry.artifact.metadata.policyKey;
    for (const section of entry.artifact.sections) {
      const claimRefs = section.reviewManifest.canonicalClaims ?? [];
      for (const claimRef of claimRefs) {
        const definition = (
          canonicalClaimRegistry as Record<string, (typeof canonicalClaimRegistry)[keyof typeof canonicalClaimRegistry]>
        )[claimRef.claimId];
        if (!definition) {
          violations.push({
            policyKey,
            sectionId: section.id,
            claimId: claimRef.claimId,
            reason: "references a canonical claim id that is not registered in canonical-claims.ts.",
          });
          continue;
        }

        if (definition.status === "settled") {
          if (
            claimRef.productTruthRefs.length !== definition.productTruthRefs.length ||
            claimRef.productTruthRefs.some((ref, index) => ref !== definition.productTruthRefs[index])
          ) {
            violations.push({
              policyKey,
              sectionId: section.id,
              claimId: claimRef.claimId,
              reason:
                "does not use the canonical claim's exact product-truth provenance identity " +
                `(${definition.productTruthRefs.join("; ")}).`,
            });
          }
          if (claimRef.productTruthRefs.length === 0) {
            violations.push({
              policyKey,
              sectionId: section.id,
              claimId: claimRef.claimId,
              reason: "is registered settled but this section cites no product-truth evidence for it.",
            });
          }
          for (const ref of claimRef.productTruthRefs) {
            const parsed = resolveEvidenceRef(ref);
            if (!parsed) {
              violations.push({
                policyKey,
                sectionId: section.id,
                claimId: claimRef.claimId,
                reason: `evidence citation '${ref}' is not a resolvable 'path:line-range' reference.`,
              });
              continue;
            }
            const cited = readCitedText(repoRoot, parsed.path, parsed.start, parsed.end);
            if (cited === null) {
              violations.push({
                policyKey,
                sectionId: section.id,
                claimId: claimRef.claimId,
                reason: `evidence citation '${ref}' does not resolve to real source lines.`,
              });
              continue;
            }
            const lowered = cited.toLowerCase();
            const matched = definition.requiredEvidenceKeywords.some((keyword) =>
              lowered.includes(keyword.toLowerCase()),
            );
            if (!matched) {
              violations.push({
                policyKey,
                sectionId: section.id,
                claimId: claimRef.claimId,
                reason: `evidence citation '${ref}' does not contain any of this claim's required keywords (${definition.requiredEvidenceKeywords.join(", ")}) — the cited text does not support the claim.`,
              });
            }
          }
        } else {
          if (claimRef.productTruthRefs.length > 0) {
            violations.push({
              policyKey,
              sectionId: section.id,
              claimId: claimRef.claimId,
              reason: "is registered unresolved but this section cites settled-style product-truth evidence for it.",
            });
          }
          if (section.reviewManifest.openQuestions.length === 0) {
            violations.push({
              policyKey,
              sectionId: section.id,
              claimId: claimRef.claimId,
              reason: "is registered unresolved but this section carries no open question reflecting that.",
            });
          }
          const hasDisclosure = (section.claimDisclosures ?? []).some(
            (disclosure) => disclosure.claimId === claimRef.claimId,
          );
          if (!hasDisclosure) {
            violations.push({
              policyKey,
              sectionId: section.id,
              claimId: claimRef.claimId,
              reason:
                "is registered unresolved but this section has no structural claimDisclosures segment for it; an " +
                "unresolved claim's public disclosure must come from an explicit claim-aware structure, not " +
                "unconstrained free-form draftText.",
            });
          }
        }
      }

      for (const disclosure of section.claimDisclosures ?? []) {
        const definition = (
          canonicalClaimRegistry as Record<string, (typeof canonicalClaimRegistry)[keyof typeof canonicalClaimRegistry]>
        )[disclosure.claimId];
        if (!definition) {
          violations.push({
            policyKey,
            sectionId: section.id,
            claimId: disclosure.claimId,
            reason:
              "renders a claimDisclosures segment for a canonical claim id that is not registered in canonical-claims.ts.",
          });
          continue;
        }
        if (definition.status !== "unresolved") {
          violations.push({
            policyKey,
            sectionId: section.id,
            claimId: disclosure.claimId,
            reason:
              "renders a claimDisclosures segment for a claim the canonical registry marks settled; use ordinary draftText prose instead.",
          });
        } else if (!definition.unresolvedPublicDisclosure) {
          violations.push({
            policyKey,
            sectionId: section.id,
            claimId: disclosure.claimId,
            reason:
              "renders a claimDisclosures segment for an unresolved claim that has no unresolvedPublicDisclosure text configured.",
          });
        }
        const trackedInManifest = claimRefs.some((claimRef) => claimRef.claimId === disclosure.claimId);
        if (!trackedInManifest) {
          violations.push({
            policyKey,
            sectionId: section.id,
            claimId: disclosure.claimId,
            reason:
              "renders a claimDisclosures segment that is not tracked in this section's reviewManifest.canonicalClaims.",
          });
        }
      }
    }
  }

  return violations;
}
