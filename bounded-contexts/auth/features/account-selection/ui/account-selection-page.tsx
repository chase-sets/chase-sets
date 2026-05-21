import { t } from "@chase-sets/localization";
import { Button, Card, Stack, Text } from "@chase-sets/design-system";

export function AccountSelectionPage({
  memberships,
  action,
  errorMessage,
  submitLabel = t("auth.features.accountSelection.ui.accountSelectionPage.continue"),
}: {
  memberships: readonly { accountId: string; roleKey: string }[];
  action?: string;
  errorMessage?: string | null;
  submitLabel?: string;
}) {
  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Text size="lg" weight="semibold">
          {t("auth.features.accountSelection.ui.accountSelectionPage.choose.account")}
        </Text>
        <Text tone="secondary">
          {t("auth.features.accountSelection.ui.accountSelectionPage.this.user.can.act.for.more")}
        </Text>
      </Stack>
      {errorMessage ? (
        <div role="alert">
          <Text>{errorMessage}</Text>
        </div>
      ) : null}
      {memberships.map((membership) => (
        <Card key={membership.accountId}>
          <form action={action} method="post">
            <Stack gap={3}>
              <input type="hidden" name="accountId" value={membership.accountId} readOnly />
              <Stack gap={1}>
                <Text weight="semibold">{membership.accountId}</Text>
                <Text tone="secondary">
                  {t("auth.features.accountSelection.ui.accountSelectionPage.role")}
                  {membership.roleKey}
                </Text>
              </Stack>
              <Button type="submit">{submitLabel}</Button>
            </Stack>
          </form>
        </Card>
      ))}
    </Stack>
  );
}
