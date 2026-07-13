import { formatDate, formatMoney, t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  KeyValueList,
  LinkButton,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { SettlementWalletAdjustmentAccountDetail } from "../../../client";
import type { WalletAdjustmentReasonCode } from "../domain/wallet-adjustment";
import { walletAdjustmentCustomerReasonCategoryLabel } from "../integrations/transactional-notifications/wallet-adjustment-notification-intents";
import {
  walletAdjustmentAccountDirectionLabel,
  walletAdjustmentAccountDirectionTone,
  walletAdjustmentAccountStatusLabel,
  walletAdjustmentAccountStatusTone,
} from "./wallet-adjustment-account-copy";

/**
 * The account-facing Wallet Adjustment detail surface (ADR 0020): the
 * account holder's own accessible disclosure of why a Wallet Adjustment
 * happened, its cash-equivalent balance effect, and where to go for support.
 * `adjustment` is already redacted to the account-safe shape at the read-model
 * layer (`getWalletAdjustmentForAccount`) -- this component never receives
 * the raw adjustment id, the operator's free-text explanation, evidence
 * references, or any actor id, so there is nothing internal-only left to
 * accidentally render.
 */
export function SettlementWalletAdjustmentAccountDetailPage({
  adjustment,
}: {
  adjustment: SettlementWalletAdjustmentAccountDetail;
}) {
  const reasonCategory = walletAdjustmentCustomerReasonCategoryLabel(
    adjustment.reason_code as WalletAdjustmentReasonCode,
  );
  const isPosted = adjustment.status === "posted" || adjustment.status === "reversed";

  const items = [
    {
      key: t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.direction"),
      value: (
        <Badge tone={walletAdjustmentAccountDirectionTone(adjustment.direction)}>
          {walletAdjustmentAccountDirectionLabel(adjustment.direction)}
        </Badge>
      ),
    },
    {
      key: t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.amount"),
      value: formatMoney(adjustment.amount, adjustment.currency_code),
    },
    {
      key: t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.reason"),
      value: reasonCategory,
    },
    {
      key: t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.requested"),
      value: formatDate(adjustment.requested_at),
    },
    ...(isPosted && adjustment.posted_at
      ? [
          {
            key: t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.posted"),
            value: formatDate(adjustment.posted_at),
          },
        ]
      : []),
    ...(isPosted && adjustment.available_balance_after !== null
      ? [
          {
            key: t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.resulting.balance"),
            value: formatMoney(adjustment.available_balance_after, adjustment.currency_code),
          },
        ]
      : []),
  ];

  return (
    <Page>
      <PageHeader
        eyebrow={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.wallet")}
        title={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.title", {
          reference: adjustment.display_reference,
        })}
        description={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.description")}
        actions={
          <LinkButton href="/account/settlement" tone="secondary">
            {t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.view.wallet")}
          </LinkButton>
        }
      />

      <PageSection title={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.details")}>
        <Card>
          <Stack gap={3}>
            <Stack direction="row" gap={2} align="center">
              <Badge tone={walletAdjustmentAccountStatusTone(adjustment.status)}>
                {walletAdjustmentAccountStatusLabel(adjustment.status)}
              </Badge>
              <Text weight="semibold">{adjustment.display_reference}</Text>
            </Stack>
            <KeyValueList items={items} />
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.about.this.adjustment")}>
        <MarketplaceNotice
          tone="info"
          title={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.cash.equivalent.title")}
          description={t(
            "settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.cash.equivalent.description",
          )}
        />
      </PageSection>

      {adjustment.reversal_of_display_reference ? (
        <PageSection title={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.reversal.section")}>
          <MarketplaceNotice
            tone="warning"
            title={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.corrects.title")}
            description={
              <>
                {t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.corrects.description", {
                  reference: adjustment.reversal_of_display_reference,
                })}
                <br />
                <LinkButton
                  href={`/account/wallet/adjustments/${adjustment.reversal_of_display_reference}`}
                  tone="secondary"
                  size="sm"
                >
                  {t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.view.original.entry")}
                </LinkButton>
              </>
            }
          />
        </PageSection>
      ) : null}

      {adjustment.reversed_by_display_reference ? (
        <PageSection title={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.reversal.section")}>
          <MarketplaceNotice
            tone="warning"
            title={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.reversed.title")}
            description={
              <>
                {t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.reversed.description", {
                  date: adjustment.reversed_at ? formatDate(adjustment.reversed_at) : "",
                  reference: adjustment.reversed_by_display_reference,
                })}
                <br />
                <LinkButton
                  href={`/account/wallet/adjustments/${adjustment.reversed_by_display_reference}`}
                  tone="secondary"
                  size="sm"
                >
                  {t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.view.correcting.entry")}
                </LinkButton>
              </>
            }
          />
        </PageSection>
      ) : (
        <PageSection title={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.reversal.section")}>
          <Text size="sm" tone="secondary">
            {t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.provisional.note")}
          </Text>
        </PageSection>
      )}

      <PageSection title={t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.support.title")}>
        <Stack gap={2}>
          <Text size="sm" tone="secondary">
            {t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.support.description", {
              reference: adjustment.display_reference,
            })}
          </Text>
          <LinkButton href="/account/support" tone="secondary">
            {t("settlement.features.wallets.ui.walletAdjustmentAccountDetailPage.contact.support")}
          </LinkButton>
        </Stack>
      </PageSection>
    </Page>
  );
}
