import { Inline, LinkText, Stack, Text } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";

export type CheckoutPolicyLinksProps = Readonly<{
  guestDataDescription?: string | null;
}>;

export function CheckoutPolicyLinks({ guestDataDescription }: CheckoutPolicyLinksProps) {
  return (
    <Stack gap={2} element="section" aria-label={t("checkout.shared.policyLinks.label")}>
      <Inline gap={3}>
        <LinkText href="/terms">{t("checkout.shared.policyLinks.terms")}</LinkText>
        <LinkText href="/privacy">{t("checkout.shared.policyLinks.privacy")}</LinkText>
        <LinkText href="/refunds-and-returns">{t("checkout.shared.policyLinks.refunds")}</LinkText>
      </Inline>
      <Text size="sm" tone="secondary">
        {t("checkout.shared.policyLinks.description")}
      </Text>
      {guestDataDescription ? (
        <Text size="sm" tone="secondary">
          {guestDataDescription}
        </Text>
      ) : null}
    </Stack>
  );
}
