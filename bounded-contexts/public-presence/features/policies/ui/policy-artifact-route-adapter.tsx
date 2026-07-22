import type { MetaDescriptor, MetaFunction } from "react-router";
import { agentConnectorTermsPolicyArtifact } from "../domain/agent-connector-terms";
import { authenticityServiceTermsPolicyArtifact } from "../domain/authenticity-service-terms";
import { paymentsTermsPolicyArtifact } from "../domain/payments-terms";
import type { PublicPolicyArtifact } from "../domain/policy-artifact";
import { sellerAgreementPolicyArtifact } from "../domain/seller-agreement";
import { publicPresenceT as t } from "../../waitlist/ui/public-presence-translator";
import {
  buildPolicyArtifactPageCopy,
  PolicyArtifactPage,
  type PolicyArtifactPageCopyProfile,
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
): MetaDescriptor[] {
  const { metadata } = artifact;
  return [
    { title: copy.title },
    { name: "description", content: copy.description },
    ...(metadata.publicationStatus !== "published" ? [{ name: "robots", content: "noindex, nofollow" }] : []),
    { name: "chase-sets:policy-key", content: metadata.policyKey },
    { name: "chase-sets:policy-version", content: metadata.version },
    { name: "chase-sets:policy-publication-status", content: metadata.publicationStatus },
    ...(metadata.effectiveAt ? [{ name: "chase-sets:policy-effective-at", content: metadata.effectiveAt }] : []),
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
  return <PolicyArtifactPage artifact={artifact} copy={buildPolicyArtifactPageCopy(artifact, copyProfile, eyebrow)} />;
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
