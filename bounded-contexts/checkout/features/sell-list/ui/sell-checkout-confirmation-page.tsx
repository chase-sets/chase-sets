import {
  CheckoutConfirmationPanel,
  CheckoutSummaryPanel,
  LinkButton,
  Page,
  PageHeader,
  Stack,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CheckoutSellListConfirmationRow } from "../read-model/queries";
import { sellListConfirmationSupportReference } from "../read-model/support-reference";

export type SellCheckoutConfirmationPageProps = Readonly<{
  confirmation: CheckoutSellListConfirmationRow;
  sellerActivityPath?: string;
  committedSalesPath?: string;
}>;

function lineOutcomeLabel(
  outcome: NonNullable<CheckoutSellListConfirmationRow["handoff_summary"]["lineOutcomes"]>[number],
) {
  switch (outcome.action) {
    case "accepted-offer":
      return t("checkout.features.sellList.ui.sellListPage.latest.confirmation.status.accepted.offer");
    case "accepted-smart-match":
      return t("checkout.features.sellList.ui.sellListPage.latest.confirmation.status.accepted.smart.match");
    case "published-listing":
      return t("checkout.features.sellList.ui.sellListPage.latest.confirmation.status.published.listing");
    case "mixed":
      return t("checkout.features.sellList.ui.sellListPage.latest.confirmation.status.mixed");
    case "kept-in-sell-list":
      return t("checkout.features.sellList.ui.sellListPage.latest.confirmation.status.kept.in.sell.list");
  }
}

function lineStatusLabel(status: "completed" | "partial" | "skipped") {
  switch (status) {
    case "completed":
      return t("checkout.features.sellList.ui.sellListPage.latest.confirmation.status.completed");
    case "partial":
      return t("checkout.features.sellList.ui.sellListPage.latest.confirmation.status.partial");
    case "skipped":
      return t("checkout.features.sellList.ui.sellListPage.latest.confirmation.status.skipped");
  }
}

export function SellCheckoutConfirmationPage({
  confirmation,
  sellerActivityPath = "/account/sell-list",
  committedSalesPath = "/account/sales",
}: SellCheckoutConfirmationPageProps) {
  const summary = confirmation.handoff_summary;
  const lineOutcomes = summary.lineOutcomes ?? [];
  const acceptedOfferCount = summary.acceptedOfferCount ?? 0;
  const publishedListingCount = summary.publishedListingCount ?? 0;
  const skippedLineCount = summary.skippedLineCount ?? 0;
  const recordedActionCount = acceptedOfferCount + publishedListingCount;
  const supportReference = sellListConfirmationSupportReference(confirmation.confirmation_id);

  return (
    <Page>
      <Stack gap={5}>
        <PageHeader
          eyebrow={t("checkout.features.sellList.ui.signedInSellCheckoutPage.eyebrow")}
          title={t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.title")}
          description={t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.description")}
          actions={
            <LinkButton href={sellerActivityPath} tone="secondary">
              {t("checkout.features.sellList.ui.signedInSellCheckoutPage.view.seller.activity")}
            </LinkButton>
          }
        />

        <CheckoutConfirmationPanel
          title={t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.title")}
          description={t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.description")}
          referenceLabel={t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.reference")}
          referenceValue={supportReference}
          supportReferenceLabel={t(
            "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.support.reference",
          )}
          supportReferenceValue={supportReference}
          totalLabel={t("checkout.features.sellList.ui.sellListPage.latest.confirmation.action")}
          total={recordedActionCount}
          nextSteps={[
            {
              title: t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.sale.title"),
              description: t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.sale.description"),
              icon: "check",
            },
            {
              title: t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.label.title"),
              description: t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.label.description"),
              icon: "truck",
            },
            {
              title: t("checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.side.effects.title"),
              description: t(
                "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.side.effects.description",
              ),
              icon: "shield",
            },
          ]}
          actions={
            <Stack gap={2} direction={{ base: "column", sm: "row" }}>
              <LinkButton href={sellerActivityPath}>
                {t("checkout.features.sellList.ui.signedInSellCheckoutPage.view.seller.activity")}
              </LinkButton>
              <LinkButton href={committedSalesPath} tone="secondary">
                {t("checkout.features.sellList.ui.signedInSellCheckoutPage.view.committed.sales")}
              </LinkButton>
            </Stack>
          }
        />

        <CheckoutSummaryPanel
          title={t("checkout.features.sellList.ui.sellListPage.latest.confirmation.line.outcomes")}
          subtitle={t("checkout.features.sellList.ui.sellListPage.latest.confirmation.recorded")}
          status={t("checkout.features.sellList.ui.sellListPage.latest.confirmation.status.handoff.recorded")}
          statusTone="success"
          items={lineOutcomes.map((outcome) => ({
            id: outcome.lineId,
            title: outcome.itemTitle,
            subtitle: outcome.detail,
            quantity: outcome.quantity,
            facts: [
              lineOutcomeLabel(outcome),
              lineStatusLabel(outcome.status),
              ...(outcome.remainingQuantity > 0
                ? [t("checkout.features.sellList.ui.sellListPage.latest.confirmation.remaining")]
                : []),
            ],
          }))}
          totals={[
            {
              label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.accepted.offers"),
              value: acceptedOfferCount,
            },
            {
              label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.listings.published"),
              value: publishedListingCount,
            },
            {
              label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.status.skipped"),
              value: skippedLineCount,
            },
          ]}
          totalLabel={t("checkout.features.sellList.ui.sellListPage.latest.confirmation.support.references")}
          total={supportReference}
          reassurance={t(
            "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.side.effects.description",
          )}
        />
      </Stack>
    </Page>
  );
}
