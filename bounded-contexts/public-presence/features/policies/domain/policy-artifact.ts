import {
  publicPolicyHrefsByKey,
  publicPolicyKeys,
  publicPolicyPublicationStatuses,
  type PublicPolicyKey,
  type PublicPolicyPublicationStatus,
  type PublicPolicyVersion,
} from "@chase-sets/public-docs/policy-corpus";
import { canonicalClaimIds, type CanonicalClaimId } from "./canonical-claims";

export { publicPolicyHrefsByKey, publicPolicyKeys, publicPolicyPublicationStatuses };
export type { PublicPolicyKey, PublicPolicyPublicationStatus, PublicPolicyVersion };

export const publicPolicySectionReviewStatuses = ["counsel-required", "counsel-approved"] as const;
export type PublicPolicySectionReviewStatus = (typeof publicPolicySectionReviewStatuses)[number];

/** One assumption the draft rests on, tied to the code or test that proves it. */
export type PublicPolicyReviewAssumption = Readonly<{
  assertion: string;
  evidenceRef: string;
}>;

/**
 * A reference from a section to a shared canonical claim. Presence
 * here declares "this section touches this shared claim"; the claim's
 * settled/unresolved status itself lives only in canonical-claims.ts, so no
 * section can locally override it.
 */
export type PublicPolicyCanonicalClaimRef = Readonly<{
  claimId: CanonicalClaimId;
  /** 'path:line' or 'path:start-end' references; required only when the
   *  claim's canonical status is settled. */
  productTruthRefs: readonly string[];
}>;

/**
 * Per-section counsel review manifest. This is checked-in drafting metadata
 * for the counsel review packet only. None of these fields render on the
 * public page; only `draftText` is operative public prose.
 */
export type PublicPolicySectionReviewManifest = Readonly<{
  scopeNote: string;
  decisionRefs: readonly number[];
  productTruthRefs: readonly string[];
  openQuestions: readonly string[];
  assumptions: readonly PublicPolicyReviewAssumption[];
  canonicalClaims?: readonly PublicPolicyCanonicalClaimRef[];
}>;

export type PublicPolicySection<SubjectId extends string = string> = Readonly<{
  id: SubjectId;
  title: string;
  /** Operative public prose. Empty until the owning document slice drafts it. */
  draftText: string;
  reviewStatus: PublicPolicySectionReviewStatus;
  reviewManifest: PublicPolicySectionReviewManifest;
}>;

export type PublicPolicyPublicationMetadata<Key extends PublicPolicyKey = PublicPolicyKey> = Key extends PublicPolicyKey
  ? Readonly<{
      policyKey: Key;
      version: PublicPolicyVersion;
      locale: string;
      href: (typeof publicPolicyHrefsByKey)[Key];
      publicationStatus: PublicPolicyPublicationStatus;
      effectiveAt: string | null;
      counselApprovalReference: string | null;
      rolloutJurisdictionsOrProductLimits: readonly string[];
      launchRequired: boolean;
    }>
  : never;

export type PublicPolicyArtifact<
  Key extends PublicPolicyKey = PublicPolicyKey,
  SubjectId extends string = string,
> = Readonly<{
  metadata: PublicPolicyPublicationMetadata<Key>;
  title: string;
  description: string;
  sections: readonly PublicPolicySection<SubjectId>[];
}>;

export const publicPolicyDisplayNames = {
  "terms-of-service": "Terms of Service",
  "privacy-policy": "Privacy Policy",
  "seller-agreement": "Seller Agreement",
  "payments-terms": "Payments Terms",
  "agent-connector-terms": "Agent Connector Terms",
  "authenticity-service-terms": "Authenticity Service Terms",
  "founders-offer-terms": "Founders Offer Terms",
} as const satisfies Record<PublicPolicyKey, string>;

export type PublicPolicyPublicationReadiness = Readonly<{
  ready: boolean;
  errors: readonly string[];
}>;

const artifactFields = ["metadata", "title", "description", "sections"] as const;
const metadataFields = [
  "policyKey",
  "version",
  "locale",
  "href",
  "publicationStatus",
  "effectiveAt",
  "counselApprovalReference",
  "rolloutJurisdictionsOrProductLimits",
  "launchRequired",
] as const;
const sectionFields = ["id", "title", "draftText", "reviewStatus", "reviewManifest"] as const;
const manifestFields = [
  "scopeNote",
  "decisionRefs",
  "productTruthRefs",
  "openQuestions",
  "assumptions",
  "canonicalClaims",
] as const;
const assumptionFields = ["assertion", "evidenceRef"] as const;
const canonicalClaimFields = ["claimId", "productTruthRefs"] as const;

const policyVersionPattern = /^v[1-9][0-9]*$/;
const canonicalClaimEvidenceRefPattern = /^[\w./-]+:\d+(-\d+)?$/;

/**
 * Closed-schema structural validation for one Public Policy Artifact. Every
 * object level — artifact, metadata, section, review manifest, assumption —
 * rejects unknown fields, and every value is shape-checked, so a typo'd or
 * smuggled field fails the compile and readiness gates instead of silently
 * riding into the generated contract or the counsel packet.
 */
export function validatePublicPolicyArtifactStructure(artifact: PublicPolicyArtifact): readonly string[] {
  const errors: string[] = [];
  if (!isPlainObject(artifact)) {
    return ["Public policy artifact must be an object."];
  }

  const raw = artifact as Record<string, unknown>;
  const metadata = isPlainObject(raw.metadata) ? (raw.metadata as Record<string, unknown>) : undefined;
  const policyKey = metadata?.policyKey;
  const label =
    typeof policyKey === "string" && isPublicPolicyKey(policyKey)
      ? publicPolicyDisplayNames[policyKey]
      : "Public policy";

  pushUnknownFieldErrors(errors, label, raw, artifactFields, "");
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
    errors.push(`${label} artifact requires a non-empty title.`);
  }
  if (typeof raw.description !== "string" || raw.description.trim().length === 0) {
    errors.push(`${label} artifact requires a non-empty description.`);
  }

  if (metadata === undefined) {
    errors.push(`${label} artifact metadata must be an object.`);
  } else {
    pushUnknownFieldErrors(errors, label, metadata, metadataFields, "metadata.");
    if (typeof policyKey !== "string" || !isPublicPolicyKey(policyKey)) {
      errors.push(`${label} artifact policy key must be one of the registered public policy keys.`);
    } else if (metadata.href !== publicPolicyHrefsByKey[policyKey]) {
      errors.push(`${label} artifact href must be the canonical '${publicPolicyHrefsByKey[policyKey]}' route.`);
    }
    if (typeof metadata.version !== "string" || !policyVersionPattern.test(metadata.version)) {
      errors.push(`${label} artifact version must match ${policyVersionPattern}.`);
    }
    if (typeof metadata.locale !== "string" || metadata.locale.trim().length === 0) {
      errors.push(`${label} artifact requires a non-empty locale.`);
    }
    if (
      typeof metadata.publicationStatus !== "string" ||
      !(publicPolicyPublicationStatuses as readonly string[]).includes(metadata.publicationStatus)
    ) {
      errors.push(`${label} artifact publication status must be one of ${publicPolicyPublicationStatuses.join(", ")}.`);
    }
    if (metadata.effectiveAt !== null && !isPublicPolicyEffectiveAt(metadata.effectiveAt)) {
      errors.push(`${label} artifact effectiveAt must be null or an ISO timestamp.`);
    }
    if (metadata.counselApprovalReference !== null && typeof metadata.counselApprovalReference !== "string") {
      errors.push(`${label} artifact counsel approval reference must be null or a string.`);
    }
    if (!isStringArray(metadata.rolloutJurisdictionsOrProductLimits)) {
      errors.push(`${label} artifact rollout jurisdictions or product limits must be an array of non-empty strings.`);
    }
    if (typeof metadata.launchRequired !== "boolean") {
      errors.push(`${label} artifact launchRequired must be a boolean.`);
    }
  }

  if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
    errors.push(`${label} artifact requires at least one section.`);
  } else {
    const seenIds = new Set<string>();
    for (const section of raw.sections as readonly unknown[]) {
      validateSection(errors, label, section, seenIds);
    }
  }

  return errors;
}

function validateSection(errors: string[], label: string, section: unknown, seenIds: Set<string>) {
  if (!isPlainObject(section)) {
    errors.push(`${label} artifact sections must be objects.`);
    return;
  }
  const raw = section as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : undefined;
  const sectionLabel = `${label} section '${id ?? "?"}'`;

  pushUnknownFieldErrors(errors, label, raw, sectionFields, `sections['${id ?? "?"}'].`);
  if (id === undefined) {
    errors.push(`${label} artifact sections require a non-empty string id.`);
  } else if (seenIds.has(id)) {
    errors.push(`${label} artifact section id '${id}' is duplicated.`);
  } else {
    seenIds.add(id);
  }
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
    errors.push(`${sectionLabel} requires a non-empty title.`);
  }
  if (typeof raw.draftText !== "string") {
    errors.push(`${sectionLabel} draft text must be a string.`);
  }
  if (
    typeof raw.reviewStatus !== "string" ||
    !(publicPolicySectionReviewStatuses as readonly string[]).includes(raw.reviewStatus)
  ) {
    errors.push(`${sectionLabel} review status must be one of ${publicPolicySectionReviewStatuses.join(", ")}.`);
  }

  const manifest = raw.reviewManifest;
  if (!isPlainObject(manifest)) {
    errors.push(`${sectionLabel} review manifest must be an object.`);
    return;
  }
  const manifestRaw = manifest as Record<string, unknown>;
  pushUnknownFieldErrors(errors, label, manifestRaw, manifestFields, `sections['${id ?? "?"}'].reviewManifest.`);
  if (typeof manifestRaw.scopeNote !== "string" || manifestRaw.scopeNote.trim().length === 0) {
    errors.push(`${sectionLabel} review manifest requires a non-empty scope note.`);
  }
  if (
    !Array.isArray(manifestRaw.decisionRefs) ||
    !manifestRaw.decisionRefs.every((ref) => Number.isInteger(ref) && (ref as number) > 0)
  ) {
    errors.push(`${sectionLabel} review manifest decision refs must be positive issue numbers.`);
  }
  if (!isStringArray(manifestRaw.productTruthRefs)) {
    errors.push(`${sectionLabel} review manifest product truth refs must be an array of non-empty strings.`);
  }
  if (!isStringArray(manifestRaw.openQuestions)) {
    errors.push(`${sectionLabel} review manifest open questions must be an array of non-empty strings.`);
  }
  if (!Array.isArray(manifestRaw.assumptions)) {
    errors.push(`${sectionLabel} review manifest assumptions must be an array.`);
  } else {
    for (const assumption of manifestRaw.assumptions as readonly unknown[]) {
      if (!isPlainObject(assumption)) {
        errors.push(`${sectionLabel} review manifest assumptions must be objects.`);
        continue;
      }
      const assumptionRaw = assumption as Record<string, unknown>;
      pushUnknownFieldErrors(
        errors,
        label,
        assumptionRaw,
        assumptionFields,
        `sections['${id ?? "?"}'].reviewManifest.assumptions[].`,
      );
      if (typeof assumptionRaw.assertion !== "string" || assumptionRaw.assertion.trim().length === 0) {
        errors.push(`${sectionLabel} review manifest assumptions require a non-empty assertion.`);
      }
      if (typeof assumptionRaw.evidenceRef !== "string" || assumptionRaw.evidenceRef.trim().length === 0) {
        errors.push(`${sectionLabel} review manifest assumptions require a non-empty code or test evidence ref.`);
      }
    }
  }

  if (manifestRaw.canonicalClaims !== undefined) {
    if (!Array.isArray(manifestRaw.canonicalClaims)) {
      errors.push(`${sectionLabel} review manifest canonical claims must be an array.`);
    } else {
      for (const claimRef of manifestRaw.canonicalClaims as readonly unknown[]) {
        if (!isPlainObject(claimRef)) {
          errors.push(`${sectionLabel} review manifest canonical claims must be objects.`);
          continue;
        }
        const claimRaw = claimRef as Record<string, unknown>;
        pushUnknownFieldErrors(
          errors,
          label,
          claimRaw,
          canonicalClaimFields,
          `sections['${id ?? "?"}'].reviewManifest.canonicalClaims[].`,
        );
        if (
          typeof claimRaw.claimId !== "string" ||
          !(canonicalClaimIds as readonly string[]).includes(claimRaw.claimId)
        ) {
          errors.push(
            `${sectionLabel} review manifest canonical claim id must be one of the registered canonical claim ids.`,
          );
        }
        if (
          !Array.isArray(claimRaw.productTruthRefs) ||
          !claimRaw.productTruthRefs.every(
            (ref) => typeof ref === "string" && canonicalClaimEvidenceRefPattern.test(ref),
          )
        ) {
          errors.push(
            `${sectionLabel} review manifest canonical claim product truth refs must be an array of 'path:line' or 'path:start-end' references.`,
          );
        }
      }
    }
  }
}

/**
 * The counsel-gate readiness evaluation shared by every corpus document. The
 * structural closed-schema validation runs first, so a malformed artifact can
 * never read as publication-ready.
 */
export function evaluatePublicPolicyPublicationReadiness(
  artifact: PublicPolicyArtifact,
  requiredSubjectIds: readonly string[],
): PublicPolicyPublicationReadiness {
  const errors: string[] = [...validatePublicPolicyArtifactStructure(artifact)];
  if (errors.length > 0) {
    return { ready: false, errors };
  }

  const { metadata } = artifact;
  const label = publicPolicyDisplayNames[metadata.policyKey];

  if (metadata.publicationStatus !== "published") {
    errors.push(`${label} publication status must be published.`);
  }
  if (!isPublicPolicyEffectiveAt(metadata.effectiveAt)) {
    errors.push(`${label} publication requires an effective ISO timestamp.`);
  }
  if (!isApprovalReference(metadata.counselApprovalReference)) {
    errors.push(`${label} publication requires a non-placeholder counsel approval reference.`);
  }
  if (metadata.rolloutJurisdictionsOrProductLimits.length === 0) {
    errors.push(`${label} publication requires at least one reviewed rollout jurisdiction or product limit.`);
  }

  const requiredSubjectIdSet = new Set(requiredSubjectIds);
  const sectionsById = new Map(artifact.sections.map((section) => [section.id, section]));
  for (const subjectId of requiredSubjectIds) {
    if (!sectionsById.has(subjectId)) {
      errors.push(`${label} publication is missing required subject '${subjectId}'.`);
    }
  }

  // Every rendered section is part of the published artifact. Required
  // subjects must be present, and neither a required subject nor an added
  // informational section may publish placeholder or unreviewed copy.
  for (const section of artifact.sections) {
    const subjectLabel = requiredSubjectIdSet.has(section.id) ? "subject" : "additional subject";
    if (section.reviewStatus !== "counsel-approved") {
      errors.push(`${label} ${subjectLabel} '${section.id}' requires counsel-approved copy.`);
    }
    if (section.draftText.trim().length === 0) {
      errors.push(`${label} ${subjectLabel} '${section.id}' requires non-empty operative copy.`);
    }
  }

  return { ready: errors.length === 0, errors };
}

/**
 * Publication-to-activation invariant: a document may be required by a
 * consent bundle only when it is published and readiness-valid. Compiled into
 * each generated publication record as `consentActivatable`, so Identity
 * consumes the invariant without importing Public Presence behavior, and a
 * placeholder stub can never produce represented acceptance.
 */
export function isConsentActivatable(artifact: PublicPolicyArtifact, requiredSubjectIds: readonly string[]): boolean {
  return (
    artifact.metadata.publicationStatus === "published" &&
    evaluatePublicPolicyPublicationReadiness(artifact, requiredSubjectIds).ready
  );
}

function pushUnknownFieldErrors(
  errors: string[],
  label: string,
  value: Record<string, unknown>,
  knownFields: readonly string[],
  pathPrefix: string,
) {
  for (const field of Object.keys(value)) {
    if (!knownFields.includes(field)) {
      errors.push(`${label} artifact has unexpected field '${pathPrefix}${field}'.`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicPolicyKey(value: string): value is PublicPolicyKey {
  return (publicPolicyKeys as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

/**
 * The canonical Public Policy Artifact instant validator. Consumers use this
 * same predicate for readiness, visible posture, and machine metadata so an
 * invalid timestamp cannot appear published at one seam and pending at
 * another.
 */
export function isPublicPolicyEffectiveAt(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return false;
  }
  const normalized = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return parsed.toISOString() === normalized;
}

function isApprovalReference(value: string | null): value is string {
  return value !== null && value.trim().length >= 12 && !/placeholder|pending|tbd/i.test(value);
}
