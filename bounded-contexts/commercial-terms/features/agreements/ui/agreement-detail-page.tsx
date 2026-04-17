import {
  Badge,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { CommercialAgreementViewModel } from "./contracts";

function statusTone(status: string) {
  return status === "active" ? "accent" : "warning";
}

export function AgreementDetailPage({ agreement }: { agreement: CommercialAgreementViewModel }) {
  return (
    <Page>
      <PageHeader
        eyebrow="Admin"
        title={agreement.label}
        description="Inspect the account-specific commercial fee override."
        actions={
          <LinkButton href="/commercial-terms/agreements" tone="secondary">
            Back to agreements
          </LinkButton>
        }
      />
      <PageSection title="Agreement">
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(agreement.status)}>{agreement.status}</Badge>
            <Text>Agreement ID: {agreement.agreement_id}</Text>
            <Text>Account: {agreement.account_display_name ?? agreement.account_id}</Text>
            <Text>Account Type: {agreement.account_type ?? "Unknown"}</Text>
            <Text>
              Marketplace Fee: {agreement.marketplace_fee_percentage_bps} bps + $
              {agreement.marketplace_fee_fixed_amount}
            </Text>
            <Text>
              Payment Fee: {agreement.payment_fee_percentage_bps} bps + $
              {agreement.payment_fee_fixed_amount}
            </Text>
            <Text>Effective From: {agreement.effective_from}</Text>
            <Text>Effective Until: {agreement.effective_until ?? "Open-ended"}</Text>
            <Text>Updated At: {agreement.updated_at}</Text>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
