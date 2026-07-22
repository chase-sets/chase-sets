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
import type { PublicPolicyArtifact } from "../domain/policy-artifact";
import { PublicPresencePageShell } from "../../waitlist/ui/public-pages";

export type PolicyArtifactPageCopy = Readonly<{
  eyebrow: string;
  printLabel: string;
  counselPendingTitle: string;
  counselPendingDescription: string;
  metadataLabel: string;
  metadataTitle: string;
  versionText: string;
  effectiveText: string;
  localeText: string;
  tocLabel: string;
  tocTitle: string;
  counselRequiredBadge: string;
}>;

/**
 * Shared page for every Public Policy Artifact route. A section renders its
 * operative `draftText` once drafted; until then it renders the review
 * manifest's scope note as the explicit counsel-pending placeholder. The
 * remaining review-manifest fields (decision refs, product truth refs, open
 * questions, assumptions) are counsel-packet data and are never rendered.
 */
export function PolicyArtifactPage({
  artifact,
  copy,
}: {
  artifact: PublicPolicyArtifact;
  copy: PolicyArtifactPageCopy;
}) {
  const { metadata } = artifact;

  return (
    <PublicPresencePageShell>
      <Page
        width="wide"
        data-policy-key={metadata.policyKey}
        data-policy-version={metadata.version}
        data-policy-publication-status={metadata.publicationStatus}
        data-policy-effective-at={metadata.effectiveAt ?? ""}
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

        {metadata.publicationStatus !== "published" ? (
          <Banner tone="warning" title={copy.counselPendingTitle} description={copy.counselPendingDescription} />
        ) : null}

        <Surface element="section" tone="subtle" aria-label={copy.metadataLabel}>
          <Stack gap={2}>
            <Heading level={2} visualSize={4}>
              {copy.metadataTitle}
            </Heading>
            <Text>{copy.versionText}</Text>
            <Text>{copy.effectiveText}</Text>
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
                {section.draftText.length > 0 ? (
                  <Text>{section.draftText}</Text>
                ) : (
                  <Text tone="secondary">{section.reviewManifest.scopeNote}</Text>
                )}
              </Stack>
            </Surface>
          ))}
        </Stack>
      </Page>
    </PublicPresencePageShell>
  );
}
