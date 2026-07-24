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
 * The one canonical-claim cross-artifact consistency check (#6055). The
 * registry in canonical-claims.ts is the sole arbiter of a shared claim's
 * settled/unresolved status, so every section across every artifact that
 * references the same claimId is checked against that single status — no two
 * artifacts can disagree, and a settled claim's cited evidence must actually
 * contain the claim's required keywords at the exact cited lines, so a
 * mis-citation (evidence pointing at unrelated code) fails closed instead of
 * only on human review.
 */
export function evaluateCanonicalClaimConsistency(
  registry: readonly PublicPolicyRegistryEntry[],
  repoRoot: string,
): readonly CanonicalClaimViolation[] {
  const violations: CanonicalClaimViolation[] = [];

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
        }
      }
    }
  }

  return violations;
}
