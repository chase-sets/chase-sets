import type { PublicPolicyRegistryEntry } from "./policy-registry";

export const FOUNDER_LOCALE_NAMESPACE_PREFIXES = [
  "publicPresence.home.foundersOffer.",
  "publicPresence.info.founders.",
  "publicPresence.info.sellerFees.founders.",
] as const;

export const FORBIDDEN_FOUNDER_BADGE_PERMANENCE_TERMS = [
  { term: "permanent", pattern: /\bpermanent\b/i },
  { term: "permanently", pattern: /\bpermanently\b/i },
  { term: "never expire", pattern: /\bnever expire\b/i },
  { term: "never expires", pattern: /\bnever expires\b/i },
  { term: "forever", pattern: /\bforever\b/i },
  { term: "cannot be revoked", pattern: /\bcannot be revoked\b/i },
  { term: "cannot be changed", pattern: /\bcannot be changed\b/i },
] as const;

export type FounderClaimTextSource = Readonly<{
  id: string;
  text: string;
  founderScoped: boolean;
}>;

export type FounderHelpArticleSource = Readonly<{
  fileName: string;
  source: string;
}>;

export type FounderClaimViolation = Readonly<{
  sourceId: string;
  term: (typeof FORBIDDEN_FOUNDER_BADGE_PERMANENCE_TERMS)[number]["term"];
  sentence: string;
}>;

export type FounderClaimCorpus = Readonly<{
  localeEntries: readonly FounderClaimTextSource[];
  helpArticles: readonly FounderClaimTextSource[];
  registeredArtifacts: readonly PublicPolicyRegistryEntry[];
  policyDrafts: readonly FounderClaimTextSource[];
}>;

const founderContextPattern = /\bfounders?(?:[-\s](?:account|badge|number|offer|window))?\b/i;
const badgeOrDisplaySubjectPattern =
  /\bbadges?\b|\bpublic(?:ly)?\s+display(?:ed|s|ing)?\b|\bdisplay(?:ed|s|ing)?\s+publicly\b|\bpublic\s+display\b/i;
const anaphoricReferencePattern = /\b(?:it|its|they|their|this|that|the badge|the display)\b/i;

export function founderLocaleClaimSources(
  translations: Readonly<Record<string, string>>,
): readonly FounderClaimTextSource[] {
  return Object.entries(translations)
    .filter(([key]) => FOUNDER_LOCALE_NAMESPACE_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .map(([id, text]) => ({ id, text, founderScoped: true }));
}

export function founderHelpArticleClaimSources(
  articles: readonly FounderHelpArticleSource[],
): readonly FounderClaimTextSource[] {
  return articles.map(({ fileName, source }) => ({
    id: `help:${fileName}`,
    text: source,
    founderScoped: false,
  }));
}

export function founderPolicyClaimSources(
  registry: readonly PublicPolicyRegistryEntry[],
): readonly FounderClaimTextSource[] {
  return registry.flatMap(({ artifact }) =>
    artifact.sections.map((section) => ({
      id: `policy:${artifact.metadata.policyKey}:${section.id}`,
      text: section.draftText,
      founderScoped: artifact.metadata.policyKey === "founders-offer-terms",
    })),
  );
}

export function collectFounderClaimCorpus(
  translations: Readonly<Record<string, string>>,
  articles: readonly FounderHelpArticleSource[],
  registry: readonly PublicPolicyRegistryEntry[],
): FounderClaimCorpus {
  return {
    localeEntries: founderLocaleClaimSources(translations),
    helpArticles: founderHelpArticleClaimSources(articles),
    registeredArtifacts: registry,
    policyDrafts: founderPolicyClaimSources(registry),
  };
}

export function findFounderClaimViolations(
  sources: readonly FounderClaimTextSource[],
): readonly FounderClaimViolation[] {
  const violations: FounderClaimViolation[] = [];

  for (const source of sources) {
    const sentences = splitSentences(source.text);
    for (const [index, sentence] of sentences.entries()) {
      const previousSentence = index > 0 ? sentences[index - 1] : undefined;
      if (!permanenceBindsToFounderBadge(source, sentence, previousSentence)) {
        continue;
      }
      for (const forbidden of FORBIDDEN_FOUNDER_BADGE_PERMANENCE_TERMS) {
        if (forbidden.pattern.test(sentence)) {
          violations.push({ sourceId: source.id, term: forbidden.term, sentence });
        }
      }
    }
  }

  return violations;
}

export function evaluateFounderClaimCorpus(corpus: FounderClaimCorpus): readonly FounderClaimViolation[] {
  return findFounderClaimViolations([...corpus.localeEntries, ...corpus.helpArticles, ...corpus.policyDrafts]);
}

function permanenceBindsToFounderBadge(
  source: FounderClaimTextSource,
  sentence: string,
  previousSentence: string | undefined,
): boolean {
  const hasPermanenceTerm = FORBIDDEN_FOUNDER_BADGE_PERMANENCE_TERMS.some(({ pattern }) => pattern.test(sentence));
  if (!hasPermanenceTerm) {
    return false;
  }

  const founderContext =
    source.founderScoped ||
    founderContextPattern.test(sentence) ||
    (previousSentence !== undefined && founderContextPattern.test(previousSentence));
  if (!founderContext) {
    return false;
  }

  const sameClauseBinding = splitClauses(sentence).some(
    (clause) =>
      badgeOrDisplaySubjectPattern.test(clause) &&
      FORBIDDEN_FOUNDER_BADGE_PERMANENCE_TERMS.some(({ pattern }) => pattern.test(clause)),
  );
  if (sameClauseBinding) {
    return true;
  }

  return (
    previousSentence !== undefined &&
    badgeOrDisplaySubjectPattern.test(previousSentence) &&
    anaphoricReferencePattern.test(sentence)
  );
}

function splitClauses(sentence: string): readonly string[] {
  return sentence
    .split(/;|,\s+(?=(?:and|but|while|whereas)\b)/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function splitSentences(text: string): readonly string[] {
  return (text.replace(/\r\n?/g, "\n").match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}
