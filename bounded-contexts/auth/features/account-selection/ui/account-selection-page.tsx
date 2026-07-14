import { t } from "@chase-sets/localization";
import { HiddenInput, Form, Button, Card, LiveRegion, Stack, Text } from "@chase-sets/design-system";

export function AccountSelectionPage({
  memberships,
  action,
  errorMessage,
  submitLabel = t("auth.features.accountSelection.ui.accountSelectionPage.continue"),
}: {
  memberships: readonly { accountId: string; accountName: string; roleLabel: string }[];
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
        <LiveRegion>
          <Text>{errorMessage}</Text>
        </LiveRegion>
      ) : null}
      {memberships.map((membership) => (
        <Card key={membership.accountId}>
          <Form spacing="none" action={action} method="post">
            <Stack gap={3}>
              <HiddenInput type="hidden" name="accountId" value={membership.accountId} readOnly />
              <Stack gap={1}>
                <Text weight="semibold">{membership.accountName}</Text>
                <Text tone="secondary">
                  {t("auth.features.accountSelection.ui.accountSelectionPage.role", {
                    roleLabel: membership.roleLabel,
                  })}
                </Text>
              </Stack>
              <Button type="submit">{submitLabel}</Button>
            </Stack>
          </Form>
        </Card>
      ))}
    </Stack>
  );
}
