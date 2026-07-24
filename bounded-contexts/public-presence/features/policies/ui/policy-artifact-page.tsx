import {
  Badge,
  Banner,
  Button,
  Heading,
  LinkText,
  List,
  Page,
  PageHeader,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import { resolveUnresolvedPublicDisclosureText } from "../domain/canonical-claims";
import {
  evaluatePublicPolicyPublicationReadiness,
  isPublicPolicyEffectiveAt,
  type PublicPolicyArtifact,
} from "../domain/policy-artifact";
import { getPublicPolicyRegistryEntry } from "../domain/policy-registry";
import { PublicPresencePageShell } from "../../waitlist/ui/public-pages";
import { publicPresenceT as t } from "../../waitlist/ui/public-presence-translator";

export type PolicyArtifactPageCopyProfile = "corpus" | "terms-of-service";

type PolicyArtifactPageCopy = Readonly<{
  eyebrow: string;
  printLabel: string;
  counselPendingTitle: string;
  counselPendingDescription: string;
  metadataLabel: string;
  metadataTitle: string;
  versionText: string;
  effectivePendingText: string;
  formatEffectiveText: (effectiveAt: string) => string;
  localeText: string;
  tocLabel: string;
  tocTitle: string;
  counselRequiredBadge: string;
}>;

type PolicyArtifactPublicationPosture =
  | Readonly<{ kind: "counsel-pending" }>
  | Readonly<{ kind: "published"; effectiveAt: string }>;

/**
 * The sole visible publication-posture mapper. Published artifacts must carry
 * the effective timestamp that the page promises to show; an internally
 * contradictory published artifact fails closed instead of rendering stale or
 * empty effective-date copy.
 */
export function resolvePolicyArtifactPublicationPosture(
  artifact: PublicPolicyArtifact,
): PolicyArtifactPublicationPosture {
  const registryEntry = getPublicPolicyRegistryEntry(artifact.metadata.policyKey);
  const readiness = evaluatePublicPolicyPublicationReadiness(artifact, registryEntry.requiredSubjectIds);
  const { effectiveAt } = artifact.metadata;
  if (!readiness.ready || !isPublicPolicyEffectiveAt(effectiveAt)) {
    return { kind: "counsel-pending" };
  }
  return { kind: "published", effectiveAt };
}

/**
 * Canonical localized copy builder for every artifact-backed policy route.
 * Pending posture keys live here so route adapters cannot pin a page to the
 * pre-publication state independently of the artifact.
 */
function buildPolicyArtifactPageCopy(
  artifact: PublicPolicyArtifact,
  profile: PolicyArtifactPageCopyProfile,
  eyebrow: string,
): PolicyArtifactPageCopy {
  const { metadata } = artifact;
  const effectiveCopy = {
    effectivePendingText:
      profile === "terms-of-service"
        ? t("publicPresence.info.terms.metadata.effectivePending")
        : t("publicPresence.info.policies.metadata.effectivePending"),
    formatEffectiveText: (effectiveAt: string) => t("publicPresence.info.policies.metadata.effective", { effectiveAt }),
  };

  if (profile === "terms-of-service") {
    return {
      eyebrow,
      printLabel: t("publicPresence.info.terms.print"),
      counselPendingTitle: t("publicPresence.info.terms.counselPending.title"),
      counselPendingDescription: t("publicPresence.info.terms.counselPending.description"),
      metadataLabel: t("publicPresence.info.terms.metadata.label"),
      metadataTitle: t("publicPresence.info.terms.metadata.title"),
      versionText: t("publicPresence.info.terms.metadata.version", { version: metadata.version }),
      ...effectiveCopy,
      localeText: t("publicPresence.info.terms.metadata.locale", { locale: metadata.locale }),
      tocLabel: t("publicPresence.info.terms.toc.label"),
      tocTitle: t("publicPresence.info.terms.toc.title"),
      counselRequiredBadge: t("publicPresence.info.terms.section.counselRequired"),
    };
  }

  return {
    eyebrow,
    printLabel: t("publicPresence.info.policies.print"),
    counselPendingTitle: t("publicPresence.info.policies.counselPending.title"),
    counselPendingDescription: t("publicPresence.info.policies.counselPending.description"),
    metadataLabel: t("publicPresence.info.policies.metadata.label"),
    metadataTitle: t("publicPresence.info.policies.metadata.title"),
    versionText: t("publicPresence.info.policies.metadata.version", { version: metadata.version }),
    ...effectiveCopy,
    localeText: t("publicPresence.info.policies.metadata.locale", { locale: metadata.locale }),
    tocLabel: t("publicPresence.info.policies.toc.label"),
    tocTitle: t("publicPresence.info.policies.toc.title"),
    counselRequiredBadge: t("publicPresence.info.policies.section.counselRequired"),
  };
}

/**
 * Shared page for every Public Policy Artifact route. Only operative
 * `draftText` and structural `claimDisclosures` render. The complete review
 * manifest remains packet-only.
 */
export function PolicyArtifactPage({
  artifact,
  copyProfile,
  eyebrow,
}: {
  artifact: PublicPolicyArtifact;
  copyProfile: PolicyArtifactPageCopyProfile;
  eyebrow: string;
}) {
  const { metadata } = artifact;
  const publicationPosture = resolvePolicyArtifactPublicationPosture(artifact);
  const copy = buildPolicyArtifactPageCopy(artifact, copyProfile, eyebrow);
  const publicPublicationStatus = publicationPosture.kind === "published" ? "published" : "counsel-review-required";

  return (
    <PublicPresencePageShell>
      <Page
        width="wide"
        data-policy-key={metadata.policyKey}
        data-policy-version={metadata.version}
        data-policy-publication-status={publicPublicationStatus}
        data-policy-effective-at={publicationPosture.kind === "published" ? publicationPosture.effectiveAt : ""}
      >
        <PageHeader
          eyebrow={copy.eyebrow}
          title={artifact.title}
          description={artifact.description}
          actions={
            <Button tone="secondary" onClick={() => globalThis.print()}>
              {copy.printLabel}
            </Button>
          }
        />

        {publicationPosture.kind === "counsel-pending" ? (
          <Banner tone="warning" title={copy.counselPendingTitle} description={copy.counselPendingDescription} />
        ) : null}

        <Surface element="section" tone="subtle" aria-label={copy.metadataLabel}>
          <Stack gap={2}>
            <Heading level={2} visualSize={4}>
              {copy.metadataTitle}
            </Heading>
            <Text>{copy.versionText}</Text>
            <Text>
              {publicationPosture.kind === "published"
                ? copy.formatEffectiveText(publicationPosture.effectiveAt)
                : copy.effectivePendingText}
            </Text>
            <Text>{copy.localeText}</Text>
          </Stack>
        </Surface>

        <Surface element="nav" tone="subtle" aria-label={copy.tocLabel}>
          <Stack gap={3}>
            <Heading level={2} visualSize={4}>
              {copy.tocTitle}
            </Heading>
            <List
              items={artifact.sections.map((section) => (
                <LinkText key={section.id} href={`#${section.id}`} tone="neutral">
                  {section.title}
                </LinkText>
              ))}
            />
          </Stack>
        </Surface>

        <Stack element="article" gap={5}>
          {artifact.sections.map((section) => (
            <Surface key={section.id} element="section" elevated aria-labelledby={section.id}>
              <Stack gap={3}>
                <Heading id={section.id} level={2}>
                  {section.title}
                </Heading>
                {section.reviewStatus === "counsel-required" ? (
                  <Badge tone="warning">{copy.counselRequiredBadge}</Badge>
                ) : null}
                {section.draftText.trim().length > 0 ? <Text>{section.draftText}</Text> : null}
                {(section.claimDisclosures ?? []).map((disclosure) => (
                  <Text key={disclosure.claimId}>{resolveUnresolvedPublicDisclosureText(disclosure.claimId)}</Text>
                ))}
              </Stack>
            </Surface>
          ))}
        </Stack>
      </Page>
    </PublicPresencePageShell>
  );
}
