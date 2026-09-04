import type { MetaDescriptor, MetaFunction } from "react-router";
import { agentConnectorTermsPolicyArtifact } from "../domain/agent-connector-terms";
import { authenticityServiceTermsPolicyArtifact } from "../domain/authenticity-service-terms";
import { foundersOfferTermsPolicyArtifact } from "../domain/founders-offer-terms";
import { paymentsTermsPolicyArtifact } from "../domain/payments-terms";
import type { PublicPolicyArtifact } from "../domain/policy-artifact";
import { privacyPolicyArtifact } from "../domain/privacy-policy";
import { sellerAgreementPolicyArtifact } from "../domain/seller-agreement";
import { publicPresenceT as t } from "../../waitlist/ui/public-presence-translator";
import {
  PolicyArtifactPage,
  type PolicyArtifactPageCopyProfile,
  resolvePolicyArtifactPublicationPosture,
} from "./policy-artifact-page";

/**
 * Machine-readable policy metadata for a corpus route, mirroring the /terms
 * meta contract. A counsel-pending artifact additionally stays out of search
 * indexes: these routes are linkable for review but explicitly non-operative
 * until the artifact is published (the corpus launch gate owns the flip).
 */
export function buildPolicyArtifactMeta(
  artifact: PublicPolicyArtifact,
  copy: Readonly<{ title: string; description: string }>,
  options: Readonly<{ noindexWhilePending?: boolean }> = {},
): MetaDescriptor[] {
  const { metadata } = artifact;
  const publicationPosture = resolvePolicyArtifactPublicationPosture(artifact);
  const publicPublicationStatus = publicationPosture.kind === "published" ? "published" : "counsel-review-required";
  return [
    { title: copy.title },
    { name: "description", content: copy.description },
    ...(publicationPosture.kind !== "published" && options.noindexWhilePending !== false
      ? [{ name: "robots", content: "noindex, nofollow" }]
      : []),
    { name: "chase-sets:policy-key", content: metadata.policyKey },
    { name: "chase-sets:policy-version", content: metadata.version },
    { name: "chase-sets:policy-publication-status", content: publicPublicationStatus },
    ...(publicationPosture.kind === "published"
      ? [{ name: "chase-sets:policy-effective-at", content: publicationPosture.effectiveAt }]
      : []),
  ];
}

export function PolicyArtifactRouteAdapter({
  artifact,
  eyebrow,
  copyProfile = "corpus",
}: {
  artifact: PublicPolicyArtifact;
  eyebrow: string;
  copyProfile?: PolicyArtifactPageCopyProfile;
}) {
  return <PolicyArtifactPage artifact={artifact} copyProfile={copyProfile} eyebrow={eyebrow} />;
}

export const sellerAgreementMeta: MetaFunction = () =>
  buildPolicyArtifactMeta(sellerAgreementPolicyArtifact, {
    title: t("publicPresence.routes.sellerAgreement.meta.title"),
    description: t("publicPresence.routes.sellerAgreement.meta.description"),
  });

export function SellerAgreementRouteAdapter({
  artifact = sellerAgreementPolicyArtifact,
}: Readonly<{ artifact?: PublicPolicyArtifact }> = {}) {
  return <PolicyArtifactRouteAdapter artifact={artifact} eyebrow={t("publicPresence.info.sellerAgreement.eyebrow")} />;
}

export const paymentsTermsMeta: MetaFunction = () =>
  buildPolicyArtifactMeta(paymentsTermsPolicyArtifact, {
    title: t("publicPresence.routes.paymentsTerms.meta.title"),
    description: t("publicPresence.routes.paymentsTerms.meta.description"),
  });

export function PaymentsTermsRouteAdapter({
  artifact = paymentsTermsPolicyArtifact,
}: Readonly<{ artifact?: PublicPolicyArtifact }> = {}) {
  return <PolicyArtifactRouteAdapter artifact={artifact} eyebrow={t("publicPresence.info.paymentsTerms.eyebrow")} />;
}

/**
 * /privacy stays indexable while the artifact is counsel-pending: the notice
 * is the canonical public privacy surface a visitor must be able to find, and
 * the page's own posture — banner, metadata, and machine publication status —
 * already says the document is not yet effective. Posture comes from the
 * artifact through the canonical resolver, never from a route-local prop.
 */
export function buildPrivacyPolicyMeta(artifact: PublicPolicyArtifact = privacyPolicyArtifact): MetaDescriptor[] {
  return buildPolicyArtifactMeta(
    artifact,
    {
      title: t("publicPresence.routes.privacy.meta.title"),
      description: t("publicPresence.routes.privacy.meta.description"),
    },
    { noindexWhilePending: false },
  );
}

export const privacyPolicyMeta: MetaFunction = () => buildPrivacyPolicyMeta();

export function PrivacyPolicyRouteAdapter({
  artifact = privacyPolicyArtifact,
}: Readonly<{ artifact?: PublicPolicyArtifact }> = {}) {
  return <PolicyArtifactRouteAdapter artifact={artifact} eyebrow={t("publicPresence.info.privacy.eyebrow")} />;
}

export function buildFoundersOfferTermsMeta(
  artifact: PublicPolicyArtifact = foundersOfferTermsPolicyArtifact,
): MetaDescriptor[] {
  return buildPolicyArtifactMeta(
    artifact,
    {
      title: t("publicPresence.routes.founders.meta.title"),
      description: t("publicPresence.routes.founders.meta.description"),
    },
    { noindexWhilePending: false },
  );
}

export function FoundersOfferTermsRouteAdapter({
  artifact = foundersOfferTermsPolicyArtifact,
}: Readonly<{ artifact?: PublicPolicyArtifact }> = {}) {
  return <PolicyArtifactRouteAdapter artifact={artifact} eyebrow={t("publicPresence.info.founders.eyebrow")} />;
}

export const agentTermsMeta: MetaFunction = () =>
  buildPolicyArtifactMeta(agentConnectorTermsPolicyArtifact, {
    title: t("publicPresence.routes.agentTerms.meta.title"),
    description: t("publicPresence.routes.agentTerms.meta.description"),
  });

export function AgentTermsRouteAdapter({
  artifact = agentConnectorTermsPolicyArtifact,
}: Readonly<{ artifact?: PublicPolicyArtifact }> = {}) {
  return <PolicyArtifactRouteAdapter artifact={artifact} eyebrow={t("publicPresence.info.agentTerms.eyebrow")} />;
}

export const authenticityTermsMeta: MetaFunction = () =>
  buildPolicyArtifactMeta(authenticityServiceTermsPolicyArtifact, {
    title: t("publicPresence.routes.authenticityTerms.meta.title"),
    description: t("publicPresence.routes.authenticityTerms.meta.description"),
  });

export function AuthenticityTermsRouteAdapter({
  artifact = authenticityServiceTermsPolicyArtifact,
}: Readonly<{ artifact?: PublicPolicyArtifact }> = {}) {
  return (
    <PolicyArtifactRouteAdapter artifact={artifact} eyebrow={t("publicPresence.info.authenticityTerms.eyebrow")} />
  );
}
