import { t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  RouterForm,
  Button,
  Card,
  Heading,
  LiveRegion,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { ComponentProps, ReactNode } from "react";

function AccountSelectionSubmissionForm({
  router,
  children,
  ...props
}: Omit<ComponentProps<typeof Form>, "method" | "encType" | "action"> & {
  router: boolean;
  children: ReactNode;
  method?: "get" | "post";
  encType?: "application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain";
  action?: string;
}) {
  return router ? (
    <RouterForm {...props} method="post">
      {children}
    </RouterForm>
  ) : (
    <Form {...props} method="post">
      {children}
    </Form>
  );
}

export function AccountSelectionPage({
  memberships,
  action,
  errorMessage,
  submitLabel = t("auth.features.accountSelection.ui.accountSelectionPage.continue"),
  submissionMode = "document",
}: {
  memberships: readonly { accountId: string; accountName: string; roleLabel: string }[];
  action?: string;
  errorMessage?: string | null;
  submitLabel?: string;
  submissionMode?: "document" | "router";
}) {
  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Heading level={1} visualSize={5}>
          {t("auth.features.accountSelection.ui.accountSelectionPage.choose.account")}
        </Heading>
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
        <Card key={membership.accountId} elevation="elevated">
          <AccountSelectionSubmissionForm
            router={submissionMode === "router"}
            spacing="none"
            action={action}
            method="post"
          >
            <Stack gap={3}>
              <HiddenInput type="hidden" name="accountId" value={membership.accountId} readOnly />
              <Stack gap={1}>
                <Heading level={2} visualSize={6}>
                  {membership.accountName}
                </Heading>
                <Text tone="secondary">
                  {t("auth.features.accountSelection.ui.accountSelectionPage.role", {
                    roleLabel: membership.roleLabel,
                  })}
                </Text>
              </Stack>
              <Button type="submit">{submitLabel}</Button>
            </Stack>
          </AccountSelectionSubmissionForm>
        </Card>
      ))}
    </Stack>
  );
}
