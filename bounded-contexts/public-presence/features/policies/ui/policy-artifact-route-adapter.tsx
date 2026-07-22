import type { MetaDescriptor, MetaFunction } from "react-router";
import { agentConnectorTermsPolicyArtifact } from "../domain/agent-connector-terms";
import { authenticityServiceTermsPolicyArtifact } from "../domain/authenticity-service-terms";
import { paymentsTermsPolicyArtifact } from "../domain/payments-terms";
import type { PublicPolicyArtifact } from "../domain/policy-artifact";
import { sellerAgreementPolicyArtifact } from "../domain/seller-agreement";
import { publicPresenceT as t } from "../../waitlist/ui/public-presence-translator";
import { PolicyArtifactPage, type PolicyArtifactPageCopy } from "./policy-artifact-page";

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

/** Shared page chrome for the corpus routes added by the registry slice. */
export function buildPolicyCorpusPageCopy(
  artifact: PublicPolicyArtifact,
  docCopy: Readonly<{ eyebrow: string }>,
): PolicyArtifactPageCopy {
  const { metadata } = artifact;
  return {
    eyebrow: docCopy.eyebrow,
    printLabel: t("publicPresence.info.policies.print"),
    counselPendingTitle: t("publicPresence.info.policies.counselPending.title"),
    counselPendingDescription: t("publicPresence.info.policies.counselPending.description"),
    metadataLabel: t("publicPresence.info.policies.metadata.label"),
    metadataTitle: t("publicPresence.info.policies.metadata.title"),
    versionText: t("publicPresence.info.policies.metadata.version", { version: metadata.version }),
    effectiveText:
      metadata.publicationStatus === "published"
        ? t("publicPresence.info.policies.metadata.effective", { effectiveAt: metadata.effectiveAt ?? "" })
        : t("publicPresence.info.policies.metadata.effectivePending"),
    localeText: t("publicPresence.info.policies.metadata.locale", { locale: metadata.locale }),
    tocLabel: t("publicPresence.info.policies.toc.label"),
    tocTitle: t("publicPresence.info.policies.toc.title"),
    counselRequiredBadge: t("publicPresence.info.policies.section.counselRequired"),
  };
}

export function PolicyArtifactRouteAdapter({ artifact, eyebrow }: { artifact: PublicPolicyArtifact; eyebrow: string }) {
  return <PolicyArtifactPage artifact={artifact} copy={buildPolicyCorpusPageCopy(artifact, { eyebrow })} />;
}

export const sellerAgreementMeta: MetaFunction = () =>
  buildPolicyArtifactMeta(sellerAgreementPolicyArtifact, {
    title: t("publicPresence.routes.sellerAgreement.meta.title"),
    description: t("publicPresence.routes.sellerAgreement.meta.description"),
  });

export function SellerAgreementRouteAdapter() {
  return (
    <PolicyArtifactRouteAdapter
      artifact={sellerAgreementPolicyArtifact}
      eyebrow={t("publicPresence.info.sellerAgreement.eyebrow")}
    />
  );
}

export const paymentsTermsMeta: MetaFunction = () =>
  buildPolicyArtifactMeta(paymentsTermsPolicyArtifact, {
    title: t("publicPresence.routes.paymentsTerms.meta.title"),
    description: t("publicPresence.routes.paymentsTerms.meta.description"),
  });

export function PaymentsTermsRouteAdapter() {
  return (
    <PolicyArtifactRouteAdapter
      artifact={paymentsTermsPolicyArtifact}
      eyebrow={t("publicPresence.info.paymentsTerms.eyebrow")}
    />
  );
}

export const agentTermsMeta: MetaFunction = () =>
  buildPolicyArtifactMeta(agentConnectorTermsPolicyArtifact, {
    title: t("publicPresence.routes.agentTerms.meta.title"),
    description: t("publicPresence.routes.agentTerms.meta.description"),
  });

export function AgentTermsRouteAdapter() {
  return (
    <PolicyArtifactRouteAdapter
      artifact={agentConnectorTermsPolicyArtifact}
      eyebrow={t("publicPresence.info.agentTerms.eyebrow")}
    />
  );
}

export const authenticityTermsMeta: MetaFunction = () =>
  buildPolicyArtifactMeta(authenticityServiceTermsPolicyArtifact, {
    title: t("publicPresence.routes.authenticityTerms.meta.title"),
    description: t("publicPresence.routes.authenticityTerms.meta.description"),
  });

export function AuthenticityTermsRouteAdapter() {
  return (
    <PolicyArtifactRouteAdapter
      artifact={authenticityServiceTermsPolicyArtifact}
      eyebrow={t("publicPresence.info.authenticityTerms.eyebrow")}
    />
  );
}
