// The one offline loader, validator, and identity seam for the Chase Sets
// counsel legal-review corpus.
//
// Two consumers share this module and nothing else: the packet CLI
// (scripts/legal-review-packet.mjs) renders the pre-counsel snapshot from it,
// and the live launch copy audit
// (scripts/marketplace-public-presence-copy-audit.mjs) re-derives the current
// stable corpus identity from it to compare against a retained receipt. There
// is exactly one production membership derivation, one content projection, and
// one digest formula, so a packet and a launch gate can never disagree about
// what "the reviewed corpus" is.
//
// Three separations this module exists to keep:
//
// 1. TWO IDENTITIES, TWO JOBS. `packet.sha256` names the exact immutable
//    pre-counsel Markdown bytes counsel received, INCLUDING the then-current
//    publication metadata and section review statuses. A member's
//    `reviewedContentSha256` instead names the lifecycle-stable reviewed
//    content: it deliberately excludes `publicationStatus`, `effectiveAt`,
//    `counselApprovalReference`, `rolloutJurisdictionsOrProductLimits`, and
//    every section `reviewStatus`. A publication-only transition therefore
//    leaves every reviewed-content and corpus identity fixed while the
//    retained packet bytes still name what counsel actually read.
//
// 2. VALIDATION BEFORE BYTES. Loading returns a result, never a partially
//    rendered packet. Every caller receives either a complete validated corpus
//    or an ordered list of bounded diagnostics naming member keys and paths.
//    Nothing here echoes environment values, credentials, exception bodies, or
//    raw legal payloads into a diagnostic.
//
// 3. NO SECOND SOURCE. Policy membership comes from `publicPolicyRegistry`;
//    compliance membership comes from the source-owned Help manifest; consent
//    surfaces come from Identity's own declarations. This module reads them and
//    re-owns none of them, and it has no runtime exemption, partial-corpus
//    mode, or filename-derived discovery path.
//
// It performs no network call, reads no environment variable, and writes no
// file.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot as defaultRepoRoot } from "./lib/repo.mjs";

export const COUNSEL_REVIEW_PACKET_VERSION = "counsel-review-packet/v1";
export const COUNSEL_REVIEW_PACKET_RECEIPT_VERSION = "counsel-review-packet-receipt/v1";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const POLICY_VERSION_PATTERN = /^v[1-9][0-9]*$/;
const ARTICLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTICLE_REVIEWED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const POLICY_DOMAIN_DIRECTORY = "bounded-contexts/public-presence/features/policies/domain";
const HELP_DOMAIN_DIRECTORY = "bounded-contexts/public-presence/features/help/domain";
const HELP_INTEGRATIONS_DIRECTORY = "bounded-contexts/public-presence/features/help/integrations";
const IDENTITY_CONSENT_DOMAIN_DIRECTORY = "bounded-contexts/identity/features/consents/domain";
const GENERATED_PUBLIC_DOCS_DIRECTORY = "contracts/public-docs/generated";
const HELP_ARTICLES_DIRECTORY = `${HELP_DOMAIN_DIRECTORY}/articles`;
const GENERATED_HELP_ARTICLES_FILE = `${HELP_DOMAIN_DIRECTORY}/generated/articles.ts`;
const GENERATED_HELP_CITATIONS_FILE = `${GENERATED_PUBLIC_DOCS_DIRECTORY}/help-article-policy-citations.ts`;

// The bounded-context domain modules use the repo-standard extensionless
// relative imports, which raw Node type stripping cannot resolve on its own.
// Retrying a failed relative specifier with a `.ts` extension is the same
// narrow seam the public-docs corpus compiler already uses, so this loader
// reads the canonical registry directly instead of keeping a lookalike copy.
let typeStrippingHooksRegistered = false;
function registerExtensionlessTypeScriptResolution() {
  if (typeStrippingHooksRegistered) {
    return;
  }
  typeStrippingHooksRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)) {
          return nextResolve(`${specifier}.ts`, context);
        }
        throw error;
      }
    },
  });
}

// `pathToFileURL`, not string concatenation: a POSIX absolute path already
// starts with a separator, so pasting one after a three-slash file scheme
// produces a four-slash URL with an empty authority on Linux CI while looking
// correct on Windows.
function moduleUrl(repoRootPath, relativePath) {
  return pathToFileURL(path.resolve(repoRootPath, relativePath)).href;
}

export function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * The canonical Markdown normalization for a reviewed source: CRLF and lone CR
 * become LF, and the result ends with exactly one terminal LF. Line-ending
 * churn therefore cannot move a member digest, while any real byte change does.
 */
export function normalizeMarkdownSource(source) {
  return `${source.replace(/\r\n?/g, "\n").replace(/\n+$/, "")}\n`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function describeFailure(error) {
  // Bounded by construction: a caught failure is reported by its error class
  // only, never by its message, so a filesystem path, response body, or legal
  // payload can never reach a diagnostic through an exception.
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

/**
 * Hyphen-normalizes prose so a declared slug can be matched inside operative
 * copy that spells the same identity with spaces. Deliberately narrow: it
 * collapses every run of non-alphanumeric characters to a single hyphen and
 * lowercases, so `condition and photo standards` matches
 * `condition-and-photo-standards` while an unrelated phrase does not.
 */
function hyphenNormalize(value) {
  return `-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-`;
}

function containsSlugIdentity(prose, slug) {
  return hyphenNormalize(prose).includes(`-${slug}-`);
}

// ---------------------------------------------------------------------------
// Authorities
// ---------------------------------------------------------------------------

/**
 * The light authority set: policy registry, source-owned compliance manifest,
 * public policy vocabulary, and the compiled Help Article catalog. Enough to
 * derive membership, and nothing more — the launch gate and the audit's
 * membership pairs must not pay for raw source reads or generated-output
 * freshness comparison.
 */
export async function loadLegalReviewMembershipAuthorities(options = {}) {
  const repoRootPath = options.repoRoot ?? defaultRepoRoot;
  registerExtensionlessTypeScriptResolution();

  const [registryModule, corpusVocabularyModule, complianceManifestModule, articleCatalogModule] = await Promise.all([
    import(moduleUrl(repoRootPath, `${POLICY_DOMAIN_DIRECTORY}/policy-registry.ts`)),
    import(moduleUrl(repoRootPath, "contracts/public-docs/policy-corpus.ts")),
    import(moduleUrl(repoRootPath, `${HELP_DOMAIN_DIRECTORY}/compliance-legal-review-corpus.ts`)),
    import(moduleUrl(repoRootPath, `${HELP_DOMAIN_DIRECTORY}/article-catalog.ts`)),
  ]);

  return {
    repoRoot: repoRootPath,
    policyRegistry: registryModule.publicPolicyRegistry,
    publicPolicyKeys: corpusVocabularyModule.publicPolicyKeys,
    publicPolicyHrefsByKey: corpusVocabularyModule.publicPolicyHrefsByKey,
    complianceArticleSlugs: complianceManifestModule.complianceLegalReviewArticleSlugs,
    incorporatedHelpArticleSlugs: complianceManifestModule.incorporatedHelpArticleSlugs,
    complianceLocale: complianceManifestModule.complianceLegalReviewLocale,
    dmcaComplianceArticleSlug: complianceManifestModule.dmcaComplianceArticleSlug,
    dmcaUnverifiedRegistrationMarker: complianceManifestModule.dmcaUnverifiedRegistrationMarker,
    helpArticles: articleCatalogModule.publicHelpArticles,
  };
}

/**
 * The complete authority set the packet needs: everything membership needs,
 * plus raw Help Article sources, Identity's consent declarations, the shared
 * canonical-claim guard verdict, the disclosure resolver, the artifact
 * validators, and the source-to-derived freshness verdict for both generated
 * output families.
 */
export async function loadLegalReviewAuthorities(options = {}) {
  const membershipAuthorities = await loadLegalReviewMembershipAuthorities(options);
  const repoRootPath = membershipAuthorities.repoRoot;

  const [artifactModule, claimsModule, claimGuardModule, consentModule] = await Promise.all([
    import(moduleUrl(repoRootPath, `${POLICY_DOMAIN_DIRECTORY}/policy-artifact.ts`)),
    import(moduleUrl(repoRootPath, `${POLICY_DOMAIN_DIRECTORY}/canonical-claims.ts`)),
    import(moduleUrl(repoRootPath, `${POLICY_DOMAIN_DIRECTORY}/canonical-claim-guard.ts`)),
    import(moduleUrl(repoRootPath, `${IDENTITY_CONSENT_DOMAIN_DIRECTORY}/consent-bundle.ts`)),
  ]);

  const helpArticleSources = await readHelpArticleSources(repoRootPath);
  const canonicalClaimViolations = claimGuardModule.evaluateCanonicalClaimConsistency(
    membershipAuthorities.policyRegistry,
    repoRootPath,
  );
  const generatedOutputErrors = await evaluateGeneratedOutputFreshness(repoRootPath);

  return {
    ...membershipAuthorities,
    helpArticleSources,
    consentBundleDeclarations: consentModule.consentBundleDeclarations,
    canonicalClaimViolations,
    generatedOutputErrors,
    validateArtifactStructure: artifactModule.validatePublicPolicyArtifactStructure,
    evaluatePublicationReadiness: artifactModule.evaluatePublicPolicyPublicationReadiness,
    resolveDisclosureText: claimsModule.resolveUnresolvedPublicDisclosureText,
  };
}

async function readHelpArticleSources(repoRootPath) {
  const articlesDirectory = path.resolve(repoRootPath, HELP_ARTICLES_DIRECTORY);
  const fileNames = (await readdir(articlesDirectory)).filter((fileName) => fileName.endsWith(".md")).sort();
  return Promise.all(
    fileNames.map(async (fileName) => ({
      fileName,
      source: await readFile(path.join(articlesDirectory, fileName), "utf8"),
    })),
  );
}

/**
 * Source-to-derived freshness. Both generated families are re-rendered from
 * the canonical inputs and compared byte-for-byte against what is checked in,
 * so a packet can never be generated from source whose compiled public
 * records, Help Article catalog, or citation contract have drifted.
 */
export async function evaluateGeneratedOutputFreshness(repoRootPath = defaultRepoRoot) {
  registerExtensionlessTypeScriptResolution();
  const errors = [];

  try {
    const { renderPublicPolicyPublicationContracts } = await import(
      moduleUrl(
        repoRootPath,
        "bounded-contexts/public-presence/features/policies/integrations/compile-policy-publications.mjs",
      )
    );
    const modules = await renderPublicPolicyPublicationContracts();
    for (const module of modules) {
      const target = `${GENERATED_PUBLIC_DOCS_DIRECTORY}/${module.relativePath}`;
      const current = await readFile(path.resolve(repoRootPath, target), "utf8").catch(() => null);
      if (current === null) {
        errors.push(`Generated public policy record '${target}' is missing.`);
      } else if (current !== module.content) {
        errors.push(`Generated public policy record '${target}' is stale for the current policy source.`);
      }
    }
  } catch (error) {
    errors.push(`Generated public policy records could not be re-derived (${describeFailure(error)}).`);
  }

  try {
    const { compileRepositoryCorpus, renderGeneratedManifest, renderCitationContract } = await import(
      moduleUrl(repoRootPath, `${HELP_INTEGRATIONS_DIRECTORY}/compile-help-articles.mjs`)
    );
    const articles = await compileRepositoryCorpus();
    const expected = [
      { target: GENERATED_HELP_ARTICLES_FILE, content: await renderGeneratedManifest(articles) },
      { target: GENERATED_HELP_CITATIONS_FILE, content: await renderCitationContract(articles) },
    ];
    for (const output of expected) {
      const current = await readFile(path.resolve(repoRootPath, output.target), "utf8").catch(() => null);
      if (current === null) {
        errors.push(`Generated Help Article output '${output.target}' is missing.`);
      } else if (current !== output.content) {
        errors.push(`Generated Help Article output '${output.target}' is stale for the current article source.`);
      }
    }
  } catch (error) {
    errors.push(`Generated Help Article output could not be re-derived (${describeFailure(error)}).`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * The two independent membership authorities, each resolved to an atomic
 * pair. A pair is either an exact count and ordered array, or `null/null`; a
 * half-null pair is never produced, and one authority failing never degrades
 * the other.
 */
export function resolveLegalReviewMembership(authorities) {
  return {
    policy: resolvePolicyMembership(authorities),
    compliance: resolveComplianceMembership(authorities),
  };
}

function resolvePolicyMembership(authorities) {
  const errors = [];
  const registry = authorities.policyRegistry;
  const vocabulary = authorities.publicPolicyKeys;
  const hrefsByKey = authorities.publicPolicyHrefsByKey;

  if (!Array.isArray(registry) || registry.length === 0) {
    return invalidMembership(["Public policy registry must be a non-empty array of registry entries."]);
  }
  if (!Array.isArray(vocabulary) || vocabulary.length === 0 || !isPlainObject(hrefsByKey)) {
    return invalidMembership(["Public policy corpus vocabulary is missing its keys or canonical route map."]);
  }

  const keys = [];
  const seen = new Set();
  for (const [index, entry] of registry.entries()) {
    const metadata = isPlainObject(entry) && isPlainObject(entry.artifact) ? entry.artifact.metadata : undefined;
    if (!isPlainObject(metadata)) {
      errors.push(`Public policy registry entry ${index} is missing its artifact metadata.`);
      continue;
    }
    const policyKey = metadata.policyKey;
    if (typeof policyKey !== "string" || !vocabulary.includes(policyKey)) {
      errors.push(`Public policy registry entry ${index} declares an unknown policy key.`);
      continue;
    }
    if (seen.has(policyKey)) {
      errors.push(`Public policy registry registers policy key '${policyKey}' more than once.`);
      continue;
    }
    seen.add(policyKey);
    if (metadata.href !== hrefsByKey[policyKey]) {
      errors.push(`Public policy '${policyKey}' must carry the canonical '${hrefsByKey[policyKey]}' route.`);
    }
    if (typeof metadata.launchRequired !== "boolean") {
      errors.push(`Public policy '${policyKey}' must declare a boolean launchRequired.`);
    }
    keys.push(policyKey);
  }

  for (const policyKey of vocabulary) {
    if (!seen.has(policyKey)) {
      errors.push(`Public policy registry is missing registered policy key '${policyKey}'.`);
    }
  }

  if (errors.length > 0) {
    return invalidMembership(errors);
  }

  const launchRequired = registry.filter((entry) => entry.artifact.metadata.launchRequired === true);
  if (launchRequired.length === 0) {
    return invalidMembership(["Public policy registry declares no launch-required policy member."]);
  }

  return {
    ok: true,
    errors: [],
    policyKeys: keys,
    launchRequiredPolicyKeys: launchRequired.map((entry) => entry.artifact.metadata.policyKey),
    launchRequiredPolicyPaths: launchRequired.map((entry) => entry.artifact.metadata.href),
    launchRequiredPolicyCount: launchRequired.length,
  };
}

function invalidMembership(errors) {
  return {
    ok: false,
    errors,
    policyKeys: null,
    launchRequiredPolicyKeys: null,
    launchRequiredPolicyPaths: null,
    launchRequiredPolicyCount: null,
    complianceArticleSlugs: null,
    complianceArticlePaths: null,
    complianceArticleCount: null,
  };
}

function resolveComplianceMembership(authorities) {
  const errors = [];
  const manifest = authorities.complianceArticleSlugs;
  const locale = authorities.complianceLocale;
  const articles = authorities.helpArticles;

  if (!isStringArray(manifest) || manifest.length === 0) {
    return invalidMembership(["Compliance legal-review manifest must be a non-empty array of article slugs."]);
  }
  if (!isNonEmptyString(locale)) {
    return invalidMembership(["Compliance legal-review manifest must declare a reviewed locale."]);
  }
  if (!Array.isArray(articles)) {
    return invalidMembership(["Compiled Help Article catalog is unavailable."]);
  }

  const seen = new Set();
  const paths = [];
  for (const slug of manifest) {
    if (!ARTICLE_SLUG_PATTERN.test(slug)) {
      errors.push(`Compliance legal-review manifest slug '${slug}' is not a kebab-case article slug.`);
      continue;
    }
    if (seen.has(slug)) {
      errors.push(`Compliance legal-review manifest lists article slug '${slug}' more than once.`);
      continue;
    }
    seen.add(slug);
    const realizations = articles.filter((article) => article.slug === slug && article.locale === locale);
    if (realizations.length !== 1) {
      errors.push(
        `Compliance legal-review member '${slug}' resolves ${realizations.length} times in the compiled Help Article catalog; exactly one is required.`,
      );
      continue;
    }
    paths.push(realizations[0].href);
  }

  if (errors.length > 0) {
    return invalidMembership(errors);
  }

  return {
    ok: true,
    errors: [],
    complianceArticleSlugs: [...manifest],
    complianceArticlePaths: paths,
    complianceArticleCount: manifest.length,
  };
}

/** Production membership entry point: real registry, real manifest, real catalog. */
export async function loadLegalReviewMembership(options = {}) {
  const authorities = await loadLegalReviewMembershipAuthorities(options);
  return resolveLegalReviewMembership(authorities);
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/**
 * Validates the whole in-memory source partition and, only when every member
 * validates, projects the reviewed corpus with its member and aggregate
 * identities. Pure over the supplied authorities, so a one-variable mutant
 * runs through the exact production derivation rather than a lookalike.
 */
export function buildLegalReviewCorpus(authorities) {
  const membership = resolveLegalReviewMembership(authorities);
  const errors = [...membership.policy.errors, ...membership.compliance.errors];

  if (Array.isArray(authorities.generatedOutputErrors)) {
    errors.push(...authorities.generatedOutputErrors);
  }
  for (const violation of authorities.canonicalClaimViolations ?? []) {
    errors.push(
      `Public policy '${violation.policyKey}' section '${violation.sectionId}' canonical claim '${violation.claimId}' ${violation.reason}`,
    );
  }

  if (!membership.policy.ok || !membership.compliance.ok) {
    return { ok: false, errors: dedupe(errors) };
  }

  // Closed-schema structural validation runs to completion before any member
  // is projected. A malformed artifact must read as a bounded diagnostic, not
  // as an exception thrown while a projection walks a field that is not the
  // shape the schema promised.
  for (const entry of authorities.policyRegistry) {
    errors.push(...authorities.validateArtifactStructure(entry.artifact));
  }
  if (errors.length > 0) {
    return { ok: false, errors: dedupe(errors) };
  }

  const policies = buildPolicyMembers(authorities, errors);
  const complianceArticles = buildComplianceMembers(authorities, errors);
  const incorporatedHelpArticles = buildIncorporatedReferences(authorities, errors);
  const consentBundles = buildConsentSurfaces(authorities, membership, errors);
  validateTermsIncorporationCrossReference(authorities, errors);

  if (errors.length > 0) {
    return { ok: false, errors: dedupe(errors) };
  }

  const corpus = {
    policies,
    complianceArticles,
    incorporatedHelpArticles,
    consentBundles,
    launchRequiredPolicyKeys: membership.policy.launchRequiredPolicyKeys,
    complianceArticleSlugs: membership.compliance.complianceArticleSlugs,
    dmcaComplianceArticleSlug: authorities.dmcaComplianceArticleSlug,
    dmcaUnverifiedRegistrationMarker: authorities.dmcaUnverifiedRegistrationMarker,
  };
  const identity = buildLegalReviewCorpusIdentity(corpus);
  return { ok: true, corpus: { ...corpus, identity, sha256: identity.sha256 } };
}

function dedupe(errors) {
  return [...new Set(errors)];
}

/** Projects the policy members. Only ever called on a structurally valid registry. */
function buildPolicyMembers(authorities, errors) {
  const evaluateReadiness = authorities.evaluatePublicationReadiness;
  const resolveDisclosureText = authorities.resolveDisclosureText;
  const members = [];

  for (const entry of authorities.policyRegistry) {
    const { artifact, requiredSubjectIds } = entry;
    const policyKey = artifact.metadata.policyKey;

    const sectionsById = new Map(artifact.sections.map((section) => [section.id, section]));
    for (const subjectId of requiredSubjectIds ?? []) {
      if (!sectionsById.has(subjectId)) {
        errors.push(`Public policy '${policyKey}' is missing required subject '${subjectId}'.`);
      }
    }

    const sections = [];
    for (const section of artifact.sections) {
      if (typeof section.draftText !== "string" || section.draftText.trim().length === 0) {
        errors.push(`Public policy '${policyKey}' subject '${section.id}' has no operative draft text to review.`);
      }
      const disclosures = [];
      for (const disclosure of section.claimDisclosures ?? []) {
        try {
          disclosures.push({ claimId: disclosure.claimId, resolvedText: resolveDisclosureText(disclosure.claimId) });
        } catch (error) {
          errors.push(
            `Public policy '${policyKey}' subject '${section.id}' claim disclosure '${disclosure.claimId}' has no resolvable canonical disclosure text (${describeFailure(error)}).`,
          );
        }
      }
      sections.push({
        id: section.id,
        title: section.title,
        draftText: section.draftText,
        reviewStatus: section.reviewStatus,
        reviewManifest: normalizeReviewManifest(section.reviewManifest),
        claimDisclosures: disclosures,
      });
    }

    members.push({
      policyKey,
      version: artifact.metadata.version,
      locale: artifact.metadata.locale,
      href: artifact.metadata.href,
      launchRequired: artifact.metadata.launchRequired,
      publicationStatus: artifact.metadata.publicationStatus,
      effectiveAt: artifact.metadata.effectiveAt,
      counselApprovalReference: artifact.metadata.counselApprovalReference,
      rolloutJurisdictionsOrProductLimits: [...artifact.metadata.rolloutJurisdictionsOrProductLimits],
      title: artifact.title,
      description: artifact.description,
      sections,
      reviewedContentSha256: computeReviewedPolicyContentDigest({
        metadata: artifact.metadata,
        title: artifact.title,
        description: artifact.description,
        sections,
      }),
      publicationReadinessErrors: [...evaluateReadiness(artifact, requiredSubjectIds ?? []).errors],
    });
  }

  return members;
}

function normalizeReviewManifest(manifest) {
  return {
    scopeNote: manifest.scopeNote,
    decisionRefs: [...manifest.decisionRefs],
    productTruthRefs: [...manifest.productTruthRefs],
    openQuestions: [...manifest.openQuestions],
    assumptions: manifest.assumptions.map((assumption) => ({
      assertion: assumption.assertion,
      evidenceRef: assumption.evidenceRef,
    })),
    canonicalClaims: (manifest.canonicalClaims ?? []).map((claim) => ({
      claimId: claim.claimId,
      productTruthRefs: [...claim.productTruthRefs],
    })),
  };
}

/**
 * The lifecycle-stable reviewed-content projection, hashed as compact UTF-8
 * JSON in exactly this order. `reviewStatus` and the four lifecycle metadata
 * fields are deliberately absent: they are counsel dispositions, validated
 * separately at launch, and a publication-only transition must not read as a
 * new document to review.
 */
export function computeReviewedPolicyContentDigest({ metadata, title, description, sections }) {
  const projection = {
    metadata: {
      policyKey: metadata.policyKey,
      version: metadata.version,
      locale: metadata.locale,
      href: metadata.href,
      launchRequired: metadata.launchRequired,
    },
    title,
    description,
    sections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      draftText: section.draftText,
      reviewManifest: {
        scopeNote: section.reviewManifest.scopeNote,
        decisionRefs: section.reviewManifest.decisionRefs,
        productTruthRefs: section.reviewManifest.productTruthRefs,
        openQuestions: section.reviewManifest.openQuestions,
        assumptions: section.reviewManifest.assumptions.map((assumption) => ({
          assertion: assumption.assertion,
          evidenceRef: assumption.evidenceRef,
        })),
        canonicalClaims: section.reviewManifest.canonicalClaims.map((claim) => ({
          claimId: claim.claimId,
          productTruthRefs: claim.productTruthRefs,
        })),
      },
      claimDisclosures: section.claimDisclosures.map((disclosure) => ({
        claimId: disclosure.claimId,
        resolvedText: disclosure.resolvedText,
      })),
    })),
  };
  return sha256Digest(JSON.stringify(projection));
}

function buildComplianceMembers(authorities, errors) {
  const locale = authorities.complianceLocale;
  const members = [];

  for (const slug of authorities.complianceArticleSlugs) {
    const expectedFileName = `${slug}.${locale}.md`;
    const ownedSources = (authorities.helpArticleSources ?? []).filter((source) =>
      source.fileName.startsWith(`${slug}.`),
    );
    if (ownedSources.length !== 1 || ownedSources[0].fileName !== expectedFileName) {
      errors.push(
        `Compliance legal-review member '${slug}' must own exactly one canonical source named '${expectedFileName}'.`,
      );
      continue;
    }

    const compiled = (authorities.helpArticles ?? []).filter(
      (article) => article.slug === slug && article.locale === locale,
    );
    if (compiled.length !== 1) {
      errors.push(
        `Compliance legal-review member '${slug}' resolves ${compiled.length} times in the compiled Help Article catalog.`,
      );
      continue;
    }
    const article = compiled[0];

    if (article.href !== `/help/${article.category}/${slug}`) {
      errors.push(`Compliance legal-review member '${slug}' does not carry its canonical Help Article route.`);
    }
    if (!ARTICLE_REVIEWED_AT_PATTERN.test(article.reviewedAt ?? "")) {
      errors.push(`Compliance legal-review member '${slug}' is missing a captured YYYY-MM-DD source review date.`);
    }
    if (!Array.isArray(article.promiseTable) || article.promiseTable.length === 0) {
      errors.push(`Compliance legal-review member '${slug}' has no promise/evidence table entries.`);
    } else {
      for (const [index, promise] of article.promiseTable.entries()) {
        if (!isNonEmptyString(promise.claim) || !Array.isArray(promise.tests) || promise.tests.length === 0) {
          errors.push(
            `Compliance legal-review member '${slug}' promise ${index} lacks a claim with executable evidence.`,
          );
        }
      }
    }
    // A compliance member is reviewed as standing legal copy, so it may not
    // interpolate a live policy value or claim a policy citation: both would
    // put content into counsel's hands that the checked-in source does not
    // itself carry.
    if ((article.citedPolicies ?? []).length > 0 || (article.policyValueKeys ?? []).length > 0) {
      errors.push(
        `Compliance legal-review member '${slug}' must not cite a public policy or interpolate a policy value.`,
      );
    }

    const markdown = normalizeMarkdownSource(ownedSources[0].source);
    members.push({
      slug,
      locale,
      href: article.href,
      category: article.category,
      audience: article.audience,
      title: article.title,
      description: article.description,
      reviewedAt: article.reviewedAt,
      fileName: expectedFileName,
      markdown,
      sourceSha256: sha256Digest(markdown),
    });
  }

  return members;
}

function buildIncorporatedReferences(authorities, errors) {
  const locale = authorities.complianceLocale;
  const slugs = authorities.incorporatedHelpArticleSlugs;
  const references = [];

  if (!isStringArray(slugs) || slugs.length === 0) {
    errors.push("Incorporated Help Article manifest must be a non-empty array of article slugs.");
    return references;
  }

  const complianceSlugs = new Set(authorities.complianceArticleSlugs ?? []);
  const seen = new Set();
  for (const slug of slugs) {
    if (seen.has(slug)) {
      errors.push(`Incorporated Help Article manifest lists '${slug}' more than once.`);
      continue;
    }
    seen.add(slug);
    if (complianceSlugs.has(slug)) {
      errors.push(
        `Help Article '${slug}' cannot be both a reproduced compliance member and a summary-only incorporated reference.`,
      );
      continue;
    }
    const compiled = (authorities.helpArticles ?? []).filter(
      (article) => article.slug === slug && article.locale === locale,
    );
    const ownedSources = (authorities.helpArticleSources ?? []).filter(
      (source) => source.fileName === `${slug}.${locale}.md`,
    );
    if (compiled.length !== 1 || ownedSources.length !== 1) {
      errors.push(
        `Incorporated Help Article '${slug}' must resolve exactly once in canonical source and compiled catalog.`,
      );
      continue;
    }
    references.push({ slug, locale, href: compiled[0].href, title: compiled[0].title });
  }

  return references;
}

function buildConsentSurfaces(authorities, membership, errors) {
  const declarations = authorities.consentBundleDeclarations;
  const surfaces = [];

  if (!isPlainObject(declarations) || Object.keys(declarations).length === 0) {
    errors.push("Identity consent bundle declarations are unavailable.");
    return surfaces;
  }

  const policyKeys = new Set(membership.policy.policyKeys ?? []);
  for (const [bundleKey, declaration] of Object.entries(declarations)) {
    if (!isPlainObject(declaration) || declaration.bundleKey !== bundleKey) {
      errors.push(`Consent bundle '${bundleKey}' declaration does not carry its own bundle key.`);
      continue;
    }
    if (!isNonEmptyString(declaration.subjectScope)) {
      errors.push(`Consent bundle '${bundleKey}' declaration is missing its subject scope.`);
      continue;
    }
    if (!isStringArray(declaration.members) || declaration.members.length === 0) {
      errors.push(`Consent bundle '${bundleKey}' declaration must list at least one ordered member.`);
      continue;
    }
    for (const member of declaration.members) {
      if (!policyKeys.has(member)) {
        errors.push(`Consent bundle '${bundleKey}' member '${member}' does not resolve to a registered policy member.`);
      }
    }
    surfaces.push({ bundleKey, subjectScope: declaration.subjectScope, members: [...declaration.members] });
  }

  return surfaces;
}

/**
 * AC6's cross-reference closure: the Terms subject that incorporates sibling
 * policies by reference must actually name every registered sibling route and
 * every declared incorporated Help Article identity, so an added corpus
 * document or a renamed operational standard cannot silently fall out of the
 * incorporating clause.
 */
const TERMS_INCORPORATION_SECTION_ID = "conduct-and-policy-incorporation";

function validateTermsIncorporationCrossReference(authorities, errors) {
  const termsEntry = authorities.policyRegistry.find(
    (entry) => entry.artifact.metadata.policyKey === "terms-of-service",
  );
  if (!termsEntry) {
    errors.push("Public policy registry is missing the Terms of Service member that owns policy incorporation.");
    return;
  }
  const section = termsEntry.artifact.sections.find((candidate) => candidate.id === TERMS_INCORPORATION_SECTION_ID);
  if (!section) {
    errors.push(`Terms of Service is missing the '${TERMS_INCORPORATION_SECTION_ID}' subject.`);
    return;
  }

  const prose = typeof section.draftText === "string" ? section.draftText : "";
  for (const entry of authorities.policyRegistry) {
    const siblingKey = entry.artifact.metadata.policyKey;
    if (siblingKey === "terms-of-service") {
      continue;
    }
    if (!prose.includes(entry.artifact.metadata.href)) {
      errors.push(
        `Terms of Service subject '${TERMS_INCORPORATION_SECTION_ID}' does not incorporate registered policy '${siblingKey}' by its canonical route.`,
      );
    }
  }
  for (const slug of authorities.incorporatedHelpArticleSlugs ?? []) {
    if (!containsSlugIdentity(prose, slug)) {
      errors.push(
        `Terms of Service subject '${TERMS_INCORPORATION_SECTION_ID}' does not name incorporated Help Article '${slug}'.`,
      );
    }
  }
}

/** Production corpus entry point. Never throws for a validation failure. */
export async function loadLegalReviewCorpus(options = {}) {
  let authorities;
  try {
    authorities = await loadLegalReviewAuthorities(options);
  } catch (error) {
    return {
      ok: false,
      errors: [`Legal review corpus source could not be read (${describeFailure(error)}).`],
    };
  }
  try {
    return buildLegalReviewCorpus(authorities);
  } catch (error) {
    return { ok: false, errors: [`Legal review corpus could not be projected (${describeFailure(error)}).`] };
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The lifecycle-stable corpus identity. Exactly these arrays, exactly these
 * field orders, exactly this declared authority order.
 */
export function buildLegalReviewCorpusIdentity(corpus) {
  const policies = corpus.policies.map((policy) => ({
    policyKey: policy.policyKey,
    version: policy.version,
    href: policy.href,
    launchRequired: policy.launchRequired,
    reviewedContentSha256: policy.reviewedContentSha256,
  }));
  const complianceArticles = corpus.complianceArticles.map((article) => ({
    slug: article.slug,
    locale: article.locale,
    href: article.href,
    sourceSha256: article.sourceSha256,
  }));
  const incorporatedHelpArticleSlugs = corpus.incorporatedHelpArticles.map((reference) => reference.slug);
  const consentBundles = corpus.consentBundles.map((bundle) => ({
    bundleKey: bundle.bundleKey,
    subjectScope: bundle.subjectScope,
    members: [...bundle.members],
  }));

  return {
    sha256: sha256Digest(
      JSON.stringify({ policies, complianceArticles, incorporatedHelpArticleSlugs, consentBundles }),
    ),
    policies,
    complianceArticles,
    incorporatedHelpArticleSlugs,
    consentBundles,
  };
}

// ---------------------------------------------------------------------------
// Packet rendering
// ---------------------------------------------------------------------------

const NON_AUTHORITY_HEADER = [
  "> **This packet is drafting input for qualified counsel. It is not legal advice, not a counsel",
  "> approval, not a publication, and not evidence that any document is effective.** Every document",
  "> below is pre-counsel draft copy generated from the checked-in source at one moment. No section",
  "> here may be treated as reviewed, approved, or in force until counsel records a disposition and a",
  "> separate publication change carries it. Unresolved canonical claims are rendered as explicit",
  "> declines, never as settled fact.",
].join("\n");

function renderList(values, renderItem = (value) => `- ${value}`) {
  return values.length === 0 ? "none" : values.map(renderItem).join("\n");
}

function renderBlockQuote(value) {
  return value
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

function fenceFor(content) {
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/**
 * Renders the complete deterministic pre-counsel packet. No wall clock, no
 * environment, no randomness, no filesystem or network access: two runs at the
 * same source produce byte-identical output.
 */
export function renderCounselReviewPacket(corpus) {
  const lines = [];
  const push = (block) => lines.push(block);

  push("# Chase Sets counsel review packet");
  push(NON_AUTHORITY_HEADER);
  push("## Packet identity");
  push(
    [
      `- Packet schema: \`${COUNSEL_REVIEW_PACKET_VERSION}\``,
      `- Reviewed-content corpus digest: \`${corpus.identity.sha256}\``,
      `- Public Policy Artifact members: ${corpus.policies.length}`,
      `- Compliance Help Article members: ${corpus.complianceArticles.length}`,
      `- Incorporated Help Article references: ${corpus.incorporatedHelpArticles.length}`,
      `- Consent surfaces: ${corpus.consentBundles.length}`,
      `- Launch-required policy members: ${corpus.launchRequiredPolicyKeys.length}`,
    ].join("\n"),
  );

  push("## Corpus summary");
  push("### Public Policy Artifacts (registry order)");
  push(
    [
      "| # | Policy key | Version | Route | Launch required | Reviewed-content digest |",
      "| --- | --- | --- | --- | --- | --- |",
      ...corpus.policies.map(
        (policy, index) =>
          `| ${index + 1} | \`${policy.policyKey}\` | ${policy.version} | \`${policy.href}\` | ${policy.launchRequired ? "yes" : "no (packet only)"} | \`${policy.reviewedContentSha256}\` |`,
      ),
    ].join("\n"),
  );
  push("### Compliance Help Articles (manifest order)");
  push(
    [
      "| # | Slug | Locale | Route | Source digest |",
      "| --- | --- | --- | --- | --- |",
      ...corpus.complianceArticles.map(
        (article, index) =>
          `| ${index + 1} | \`${article.slug}\` | ${article.locale} | \`${article.href}\` | \`${article.sourceSha256}\` |`,
      ),
    ].join("\n"),
  );
  push("### Incorporated Help Article references (summary only, not reproduced)");
  push(
    [
      "| # | Slug | Locale | Route |",
      "| --- | --- | --- | --- |",
      ...corpus.incorporatedHelpArticles.map(
        (reference, index) => `| ${index + 1} | \`${reference.slug}\` | ${reference.locale} | \`${reference.href}\` |`,
      ),
    ].join("\n"),
  );
  push("### Consent surfaces (Identity-owned, summary only)");
  push(
    [
      "| # | Bundle | Subject scope | Ordered members |",
      "| --- | --- | --- | --- |",
      ...corpus.consentBundles.map(
        (bundle, index) =>
          `| ${index + 1} | \`${bundle.bundleKey}\` | ${bundle.subjectScope} | ${bundle.members.map((member) => `\`${member}\``).join(", ")} |`,
      ),
    ].join("\n"),
  );

  push("## Public Policy Artifacts");
  for (const [index, policy] of corpus.policies.entries()) {
    push(`### ${index + 1}. ${policy.title}`);
    push(
      [
        `- Policy key: \`${policy.policyKey}\``,
        `- Version: ${policy.version}`,
        `- Locale: ${policy.locale}`,
        `- Route: \`${policy.href}\``,
        `- Launch required: ${policy.launchRequired ? "yes" : "no — packet only"}`,
        `- Publication status: ${policy.publicationStatus}`,
        `- Effective at: ${policy.effectiveAt ?? "none"}`,
        `- Counsel approval reference: ${policy.counselApprovalReference ?? "none"}`,
        `- Rollout jurisdictions or product limits: ${policy.rolloutJurisdictionsOrProductLimits.length === 0 ? "none" : policy.rolloutJurisdictionsOrProductLimits.join("; ")}`,
        `- Reviewed-content digest: \`${policy.reviewedContentSha256}\``,
        `- Subjects: ${policy.sections.length}`,
      ].join("\n"),
    );
    push("**Description**");
    push(renderBlockQuote(policy.description));

    for (const [sectionIndex, section] of policy.sections.entries()) {
      push(`#### ${index + 1}.${sectionIndex + 1} ${section.title} (\`${section.id}\`)`);
      push(`- Review status: ${section.reviewStatus}`);
      push("**Operative draft text**");
      push(renderBlockQuote(section.draftText));
      push("**Rendered claim disclosures**");
      push(
        renderList(section.claimDisclosures, (disclosure) => `- \`${disclosure.claimId}\`: ${disclosure.resolvedText}`),
      );
      push("**Review manifest**");
      push(`- Scope note: ${section.reviewManifest.scopeNote}`);
      push("- Decision refs:");
      push(indent(renderList(section.reviewManifest.decisionRefs, (ref) => `- #${ref}`)));
      push("- Product-truth refs:");
      push(indent(renderList(section.reviewManifest.productTruthRefs, (ref) => `- \`${ref}\``)));
      push("- Open questions:");
      push(indent(renderList(section.reviewManifest.openQuestions)));
      push("- Assumptions:");
      push(
        indent(
          renderList(
            section.reviewManifest.assumptions,
            (assumption) => `- ${assumption.assertion} — evidence: \`${assumption.evidenceRef}\``,
          ),
        ),
      );
      push("- Canonical claims:");
      push(
        indent(
          renderList(
            section.reviewManifest.canonicalClaims,
            (claim) =>
              `- \`${claim.claimId}\` — product-truth refs: ${claim.productTruthRefs.length === 0 ? "none" : claim.productTruthRefs.map((ref) => `\`${ref}\``).join(", ")}`,
          ),
        ),
      );
    }
  }

  push("## Compliance Help Articles");
  for (const [index, article] of corpus.complianceArticles.entries()) {
    push(`### ${index + 1}. ${article.title}`);
    push(
      [
        `- Slug: \`${article.slug}\``,
        `- Locale: ${article.locale}`,
        `- Route: \`${article.href}\``,
        `- Audience: ${article.audience}`,
        `- Category: ${article.category}`,
        `- Source review date: ${article.reviewedAt}`,
        `- Canonical source: \`${HELP_ARTICLES_DIRECTORY}/${article.fileName}\``,
        `- Source digest: \`${article.sourceSha256}\``,
      ].join("\n"),
    );
    push("**Canonical Markdown source (verbatim, LF-normalized)**");
    const fence = fenceFor(article.markdown);
    push(`${fence}markdown\n${article.markdown}${fence}`);
  }

  push("## Incorporated Help Article references");
  push(
    renderList(
      corpus.incorporatedHelpArticles,
      (reference) =>
        `- \`${reference.slug}\` (${reference.locale}) — ${reference.title} at \`${reference.href}\`; incorporated by reference from the Terms of Service and not reproduced in this packet.`,
    ),
  );

  push("## Consent surfaces");
  push(
    renderList(
      corpus.consentBundles,
      (bundle) =>
        `- \`${bundle.bundleKey}\` (${bundle.subjectScope}-scoped) asks, in order: ${bundle.members.map((member) => `\`${member}\``).join(", ")}. Declared membership is not activation; Identity derives every requirement from published metadata and its own activation authority.`,
    ),
  );

  return `${lines.join("\n\n")}\n`;
}

function indent(block) {
  return block
    .split("\n")
    .map((line) => (line.length === 0 ? line : `  ${line}`))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

/**
 * The closed receipt for one exact retained packet byte sequence. Key order is
 * part of the contract; the digest inputs are the identity arrays, so object
 * construction order cannot change what the receipt means.
 */
export function buildCounselReviewPacketReceipt(corpus, packetBytes) {
  const bytes = Buffer.isBuffer(packetBytes) ? packetBytes : Buffer.from(packetBytes, "utf8");
  return {
    schemaVersion: COUNSEL_REVIEW_PACKET_RECEIPT_VERSION,
    packet: {
      schemaVersion: COUNSEL_REVIEW_PACKET_VERSION,
      sha256: sha256Digest(bytes),
      utf8Bytes: bytes.byteLength,
    },
    corpus: {
      sha256: corpus.identity.sha256,
      policies: corpus.identity.policies,
      complianceArticles: corpus.identity.complianceArticles,
      incorporatedHelpArticleSlugs: corpus.identity.incorporatedHelpArticleSlugs,
      consentBundles: corpus.identity.consentBundles,
    },
  };
}

export function renderCounselReviewPacketReceipt(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

const RECEIPT_FIELDS = ["schemaVersion", "packet", "corpus"];
const RECEIPT_PACKET_FIELDS = ["schemaVersion", "sha256", "utf8Bytes"];
const RECEIPT_CORPUS_FIELDS = [
  "sha256",
  "policies",
  "complianceArticles",
  "incorporatedHelpArticleSlugs",
  "consentBundles",
];
const RECEIPT_POLICY_FIELDS = ["policyKey", "version", "href", "launchRequired", "reviewedContentSha256"];
const RECEIPT_ARTICLE_FIELDS = ["slug", "locale", "href", "sourceSha256"];
const RECEIPT_CONSENT_FIELDS = ["bundleKey", "subjectScope", "members"];

function pushUnknownFieldErrors(errors, value, knownFields, pathPrefix) {
  for (const field of Object.keys(value)) {
    if (!knownFields.includes(field)) {
      errors.push(`Counsel review packet receipt has an unexpected field '${pathPrefix}${field}'.`);
    }
  }
  for (const field of knownFields) {
    if (!Object.hasOwn(value, field)) {
      errors.push(`Counsel review packet receipt is missing required field '${pathPrefix}${field}'.`);
    }
  }
}

/**
 * Recursively closed receipt validation. Unknown or missing keys at every
 * level fail, every digest must be a lowercase `sha256:<64 hex>` value, and a
 * predecessor receipt shape can only ever parse as rejected historical input.
 */
export function validateCounselReviewPacketReceipt(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["Counsel review packet receipt must be a JSON object."] };
  }
  pushUnknownFieldErrors(errors, value, RECEIPT_FIELDS, "");
  if (value.schemaVersion !== COUNSEL_REVIEW_PACKET_RECEIPT_VERSION) {
    errors.push(`Counsel review packet receipt schemaVersion must be ${COUNSEL_REVIEW_PACKET_RECEIPT_VERSION}.`);
  }

  if (!isPlainObject(value.packet)) {
    errors.push("Counsel review packet receipt packet must be an object.");
  } else {
    pushUnknownFieldErrors(errors, value.packet, RECEIPT_PACKET_FIELDS, "packet.");
    if (value.packet.schemaVersion !== COUNSEL_REVIEW_PACKET_VERSION) {
      errors.push(`Counsel review packet receipt packet.schemaVersion must be ${COUNSEL_REVIEW_PACKET_VERSION}.`);
    }
    if (typeof value.packet.sha256 !== "string" || !SHA256_PATTERN.test(value.packet.sha256)) {
      errors.push("Counsel review packet receipt packet.sha256 must be a lowercase sha256 digest.");
    }
    if (!Number.isInteger(value.packet.utf8Bytes) || value.packet.utf8Bytes <= 0) {
      errors.push("Counsel review packet receipt packet.utf8Bytes must be a positive integer.");
    }
  }

  if (!isPlainObject(value.corpus)) {
    errors.push("Counsel review packet receipt corpus must be an object.");
    return { ok: false, errors };
  }
  pushUnknownFieldErrors(errors, value.corpus, RECEIPT_CORPUS_FIELDS, "corpus.");
  if (typeof value.corpus.sha256 !== "string" || !SHA256_PATTERN.test(value.corpus.sha256)) {
    errors.push("Counsel review packet receipt corpus.sha256 must be a lowercase sha256 digest.");
  }

  validateReceiptArray(errors, value.corpus.policies, "corpus.policies", (entry, entryPath) => {
    pushUnknownFieldErrors(errors, entry, RECEIPT_POLICY_FIELDS, `${entryPath}.`);
    if (!isNonEmptyString(entry.policyKey)) {
      errors.push(`Counsel review packet receipt ${entryPath}.policyKey must be a non-empty string.`);
    }
    if (typeof entry.version !== "string" || !POLICY_VERSION_PATTERN.test(entry.version)) {
      errors.push(`Counsel review packet receipt ${entryPath}.version must match vN.`);
    }
    if (typeof entry.href !== "string" || !entry.href.startsWith("/")) {
      errors.push(`Counsel review packet receipt ${entryPath}.href must be an absolute route.`);
    }
    if (typeof entry.launchRequired !== "boolean") {
      errors.push(`Counsel review packet receipt ${entryPath}.launchRequired must be a boolean.`);
    }
    if (typeof entry.reviewedContentSha256 !== "string" || !SHA256_PATTERN.test(entry.reviewedContentSha256)) {
      errors.push(
        `Counsel review packet receipt ${entryPath}.reviewedContentSha256 must be a lowercase sha256 digest.`,
      );
    }
  });

  validateReceiptArray(errors, value.corpus.complianceArticles, "corpus.complianceArticles", (entry, entryPath) => {
    pushUnknownFieldErrors(errors, entry, RECEIPT_ARTICLE_FIELDS, `${entryPath}.`);
    if (typeof entry.slug !== "string" || !ARTICLE_SLUG_PATTERN.test(entry.slug)) {
      errors.push(`Counsel review packet receipt ${entryPath}.slug must be a kebab-case article slug.`);
    }
    if (!isNonEmptyString(entry.locale)) {
      errors.push(`Counsel review packet receipt ${entryPath}.locale must be a non-empty string.`);
    }
    if (typeof entry.href !== "string" || !entry.href.startsWith("/")) {
      errors.push(`Counsel review packet receipt ${entryPath}.href must be an absolute route.`);
    }
    if (typeof entry.sourceSha256 !== "string" || !SHA256_PATTERN.test(entry.sourceSha256)) {
      errors.push(`Counsel review packet receipt ${entryPath}.sourceSha256 must be a lowercase sha256 digest.`);
    }
  });

  if (!isStringArray(value.corpus.incorporatedHelpArticleSlugs)) {
    errors.push("Counsel review packet receipt corpus.incorporatedHelpArticleSlugs must be an array of slugs.");
  } else {
    for (const [index, slug] of value.corpus.incorporatedHelpArticleSlugs.entries()) {
      if (!ARTICLE_SLUG_PATTERN.test(slug)) {
        errors.push(
          `Counsel review packet receipt corpus.incorporatedHelpArticleSlugs[${index}] must be a kebab-case article slug.`,
        );
      }
    }
  }

  validateReceiptArray(errors, value.corpus.consentBundles, "corpus.consentBundles", (entry, entryPath) => {
    pushUnknownFieldErrors(errors, entry, RECEIPT_CONSENT_FIELDS, `${entryPath}.`);
    if (!isNonEmptyString(entry.bundleKey)) {
      errors.push(`Counsel review packet receipt ${entryPath}.bundleKey must be a non-empty string.`);
    }
    if (entry.subjectScope !== "user" && entry.subjectScope !== "account") {
      errors.push(`Counsel review packet receipt ${entryPath}.subjectScope must be user or account.`);
    }
    if (!isStringArray(entry.members) || entry.members.length === 0) {
      errors.push(`Counsel review packet receipt ${entryPath}.members must be a non-empty array of policy keys.`);
    }
  });

  return errors.length === 0 ? { ok: true, receipt: value, errors: [] } : { ok: false, errors };
}

function validateReceiptArray(errors, value, arrayPath, validateEntry) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`Counsel review packet receipt ${arrayPath} must be a non-empty array.`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    const entryPath = `${arrayPath}[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`Counsel review packet receipt ${entryPath} must be an object.`);
      continue;
    }
    validateEntry(entry, entryPath);
  }
}

/**
 * The receipt's stable reviewed-content corpus identity compared against the
 * current source's stable projection. Equality of the aggregate digest is
 * necessary but not sufficient — every member row is compared so a diagnostic
 * can name the member that moved.
 */
export function compareRetainedCorpusIdentity(receipt, identity) {
  const errors = [];
  if (receipt.corpus.sha256 !== identity.sha256) {
    errors.push("Retained counsel review receipt corpus digest does not match the current reviewed corpus identity.");
  }
  comparePairs(
    errors,
    receipt.corpus.policies,
    identity.policies,
    "policy member",
    (entry) => entry.policyKey,
    RECEIPT_POLICY_FIELDS,
  );
  comparePairs(
    errors,
    receipt.corpus.complianceArticles,
    identity.complianceArticles,
    "compliance member",
    (entry) => entry.slug,
    RECEIPT_ARTICLE_FIELDS,
  );
  if (
    receipt.corpus.incorporatedHelpArticleSlugs.length !== identity.incorporatedHelpArticleSlugs.length ||
    receipt.corpus.incorporatedHelpArticleSlugs.some(
      (slug, index) => slug !== identity.incorporatedHelpArticleSlugs[index],
    )
  ) {
    errors.push("Retained counsel review receipt incorporated Help Article references do not match current source.");
  }
  comparePairs(
    errors,
    receipt.corpus.consentBundles,
    identity.consentBundles,
    "consent surface",
    (entry) => entry.bundleKey,
    RECEIPT_CONSENT_FIELDS,
  );
  return errors;
}

function comparePairs(errors, retained, current, label, identify, fields) {
  if (retained.length !== current.length) {
    errors.push(
      `Retained counsel review receipt declares ${retained.length} ${label}s; current source has ${current.length}.`,
    );
    return;
  }
  for (const [index, retainedEntry] of retained.entries()) {
    const currentEntry = current[index];
    if (identify(retainedEntry) !== identify(currentEntry)) {
      errors.push(
        `Retained counsel review receipt ${label} ${index + 1} identity or order does not match current source.`,
      );
      continue;
    }
    for (const field of fields) {
      if (JSON.stringify(retainedEntry[field]) !== JSON.stringify(currentEntry[field])) {
        errors.push(
          `Retained counsel review receipt ${label} '${identify(retainedEntry)}' field '${field}' does not match current source.`,
        );
      }
    }
  }
}

/**
 * Launch-only publication readiness over the launch-required members. This is
 * the counsel-disposition half of the contract: it is deliberately not part of
 * corpus validity, because the packet is generated BEFORE counsel and every
 * member is legitimately unpublished at that moment.
 */
export function evaluateLaunchPublicationReadiness(corpus) {
  const errors = [];
  for (const policy of corpus.policies) {
    if (!policy.launchRequired) {
      continue;
    }
    for (const readinessError of policy.publicationReadinessErrors) {
      errors.push(`Public policy source readiness: ${readinessError}`);
    }
  }
  return errors;
}
