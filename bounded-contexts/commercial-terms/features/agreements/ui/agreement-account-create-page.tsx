import { t } from "@chase-sets/localization";
import { Banner, Card, Form, LinkButton, Page, PageHeader, PageSection, Stack, Text } from "@chase-sets/design-system";
import { AgreementCreateFields } from "./agreement-create-fields";

export function AgreementAccountCreatePage({
  accountId,
  errorMessage,
}: {
  accountId: string;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("commercialTerms.features.agreements.ui.agreementAccountCreatePage.admin")}
        title={t("commercialTerms.features.agreements.ui.agreementAccountCreatePage.create.account.agreement")}
        description={t(
          "commercialTerms.features.agreements.ui.agreementAccountCreatePage.create.account.agreement.description",
        )}
        actions={
          <LinkButton href="/commerce/terms/agreements" tone="secondary">
            {t("commercialTerms.features.agreements.ui.agreementAccountCreatePage.back.to.agreements")}
          </LinkButton>
        }
      />

      <Banner
        tone="warning"
        title={t("commercialTerms.features.agreements.ui.agreementListPage.fee.lock.permanence")}
        description={t("commercialTerms.features.agreements.ui.agreementListPage.fee.lock.permanence.description")}
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("commercialTerms.features.agreements.ui.agreementAccountCreatePage.create.agreement")}>
        <Card>
          <Form spacing="none" method="post">
            <Stack gap={3}>
              <Text>
                {t("commercialTerms.features.agreements.ui.agreementAccountCreatePage.account")}
                {accountId}
              </Text>
              <AgreementCreateFields accountId={accountId} />
            </Stack>
          </Form>
        </Card>
      </PageSection>
    </Page>
  );
}
