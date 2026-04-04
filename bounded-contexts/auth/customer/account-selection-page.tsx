import { Button, Card, Stack, Text } from "@chase-sets/design-system";

export function AccountSelectionPage({
  memberships,
  action,
  errorMessage,
  submitLabel = "Continue",
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
          Choose Account
        </Text>
        <Text tone="secondary">
          This user can act for more than one account.
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
              <input
                type="hidden"
                name="accountId"
                value={membership.accountId}
                readOnly
              />
              <Stack gap={1}>
                <Text weight="semibold">{membership.accountId}</Text>
                <Text tone="secondary">Role: {membership.roleKey}</Text>
              </Stack>
              <Button type="submit">{submitLabel}</Button>
            </Stack>
          </form>
        </Card>
      ))}
    </Stack>
  );
}
