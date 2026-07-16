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
import { PublicPresencePageShell } from "../../waitlist/ui/public-pages";
import { publicPresenceT as t } from "../../waitlist/ui/public-presence-translator";
import { termsOfServicePolicyArtifact } from "../domain/terms-of-service";

export function TermsOfServicePage() {
  const artifact = termsOfServicePolicyArtifact;
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
          eyebrow={t("publicPresence.info.terms.eyebrow")}
          title={artifact.title}
          description={artifact.description}
          actions={
            <Button tone="secondary" onClick={() => globalThis.print()}>
              {t("publicPresence.info.terms.print")}
            </Button>
          }
        />

        <Banner
          tone="warning"
          title={t("publicPresence.info.terms.counselPending.title")}
          description={t("publicPresence.info.terms.counselPending.description")}
        />

        <Surface element="section" tone="subtle" aria-label={t("publicPresence.info.terms.metadata.label")}>
          <Stack gap={2}>
            <Heading level={2} visualSize={4}>
              {t("publicPresence.info.terms.metadata.title")}
            </Heading>
            <Text>{t("publicPresence.info.terms.metadata.version", { version: metadata.version })}</Text>
            <Text>{t("publicPresence.info.terms.metadata.effectivePending")}</Text>
            <Text>{t("publicPresence.info.terms.metadata.locale", { locale: metadata.locale })}</Text>
          </Stack>
        </Surface>

        <Surface element="nav" tone="subtle" aria-label={t("publicPresence.info.terms.toc.label")}>
          <Stack gap={3}>
            <Heading level={2} visualSize={4}>
              {t("publicPresence.info.terms.toc.title")}
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
                <Badge tone="warning">{t("publicPresence.info.terms.section.counselRequired")}</Badge>
                <Text tone="secondary">{section.placeholderScope}</Text>
              </Stack>
            </Surface>
          ))}
        </Stack>
      </Page>
    </PublicPresencePageShell>
  );
}
