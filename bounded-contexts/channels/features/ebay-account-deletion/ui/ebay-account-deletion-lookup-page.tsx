import { t } from "@chase-sets/localization";
import {
  Button,
  Cluster,
  EmptyState,
  Form,
  Page,
  PageHeader,
  PageSection,
  Surface,
  Table,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { EbayReceiptMatch, EbaySubjectDataCount } from "../domain/responses";

export function EbayAccountDeletionLookupPage({
  matches,
  counts,
  error,
  pending = false,
}: Readonly<{
  matches: readonly EbayReceiptMatch[] | null;
  counts: EbaySubjectDataCount | null;
  error: boolean;
  pending?: boolean;
}>) {
  return (
    <Page>
      <PageHeader title={t("channels.ebayDeletion.title")} description={t("channels.ebayDeletion.description")} />
      <PageSection title={t("channels.ebayDeletion.lookup")}>
        <Surface elevation="tinted" data-elevation-role="furniture">
          <Form method="post" spacing="md">
            <TextInput
              label={t("channels.ebayDeletion.userId")}
              name="userId"
              required
              autoComplete="off"
              maxLength={1024}
            />
            <Cluster justify="end">
              <Button type="submit" disabled={pending}>
                {t(pending ? "channels.ebayDeletion.loading" : "channels.ebayDeletion.lookup")}
              </Button>
            </Cluster>
          </Form>
        </Surface>
      </PageSection>
      {error ? <Text role="alert">{t("channels.ebayDeletion.error")}</Text> : null}
      {!pending && !error && matches !== null ? (
        <PageSection title={t("channels.ebayDeletion.receipts")}>
          {matches.length === 0 ? (
            <EmptyState title={t("channels.ebayDeletion.empty")} />
          ) : (
            <Table
              columns={[
                t("channels.ebayDeletion.notification"),
                t("channels.ebayDeletion.eventDate"),
                t("channels.ebayDeletion.expiresAt"),
              ]}
              rows={matches.map((row) => [row.notificationId, row.eventDate, row.expiresAt])}
            />
          )}
        </PageSection>
      ) : null}
      {counts ? (
        <PageSection title={t("channels.ebayDeletion.countTitle")}>
          <Text>{t("channels.ebayDeletion.counts", counts)}</Text>
          <Text>{t("channels.ebayDeletion.saveWarning")}</Text>
        </PageSection>
      ) : null}
    </Page>
  );
}
