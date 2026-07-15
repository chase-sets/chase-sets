import { t } from "@chase-sets/localization";
import { Card, LinkButton, Page, PageHeader, Stack, Text } from "@chase-sets/design-system";

export function SellerDeskSettingsPage({ permissions }: { permissions: readonly string[] }) {
  const permissionSet = new Set(permissions);
  const canManageInventory = permissionSet.has("inventory.view");
  const canManagePayouts = permissionSet.has("payouts.view");

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.sellerDesk.ui.settings.eyebrow")}
        title={t("marketplace.features.sellerDesk.ui.settings.title")}
        description={t("marketplace.features.sellerDesk.ui.settings.description")}
      />
      <Stack gap={4}>
        {canManageInventory ? (
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">{t("marketplace.features.sellerDesk.ui.settings.inventory.title")}</Text>
              <Text tone="secondary">{t("marketplace.features.sellerDesk.ui.settings.inventory.description")}</Text>
              <LinkButton href="/account/desk/settings/locations" tone="secondary" leadingIcon="package">
                {t("marketplace.features.sellerDesk.ui.settings.inventory.action")}
              </LinkButton>
            </Stack>
          </Card>
        ) : null}
        {canManagePayouts ? (
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">{t("marketplace.features.sellerDesk.ui.settings.payouts.title")}</Text>
              <Text tone="secondary">{t("marketplace.features.sellerDesk.ui.settings.payouts.description")}</Text>
              <LinkButton href="/account/desk/settings/payouts" tone="secondary" leadingIcon="wallet">
                {t("marketplace.features.sellerDesk.ui.settings.payouts.action")}
              </LinkButton>
            </Stack>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
