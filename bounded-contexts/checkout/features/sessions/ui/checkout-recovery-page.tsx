import { t } from "@chase-sets/localization";
import { LinkButton, MarketplaceEmptyState, Page, PageSection } from "@chase-sets/design-system";
import type { CheckoutRecoveryAction, CheckoutRecoveryKind } from "../../../support/request-support/checkout-recovery";
import {
  useCheckoutPreparingRevalidation,
  type CheckoutPreparingRevalidationOptions,
} from "./checkout-recovery-revalidation";

export type CheckoutSessionRecoveryPageProps = Readonly<{
  kind: CheckoutRecoveryKind | null;
  title: string;
  description: string;
  trustCue: string;
  primaryAction: CheckoutRecoveryAction;
  secondaryAction?: CheckoutRecoveryAction | null;
  currentPath: string;
  revalidationOptions?: Pick<CheckoutPreparingRevalidationOptions, "intervalMs" | "maxRevalidations" | "nowMs">;
}>;

export function CheckoutSessionRecoveryPage({
  kind,
  title,
  description,
  trustCue,
  primaryAction,
  secondaryAction,
  currentPath,
  revalidationOptions,
}: CheckoutSessionRecoveryPageProps) {
  const { isAutoRevalidating } = useCheckoutPreparingRevalidation({
    enabled: kind === "checkout-preparing",
    currentPath,
    ...revalidationOptions,
  });

  return (
    <Page>
      <PageSection title={t("checkout.routes.checkoutSession.secure.checkout")}>
        <MarketplaceEmptyState
          title={title}
          description={
            <>
              {/* Persistent live region: text swaps inside it so screen
                  readers announce both the auto-revalidation start and the
                  degradation back to manual recovery. */}
              <span role="status">
                {isAutoRevalidating ? t("checkout.routes.checkoutRecovery.checkout.preparing.auto.description") : ""}
              </span>
              {isAutoRevalidating ? null : description}
            </>
          }
          trustCue={trustCue}
          recoveryActions={
            <>
              <LinkButton href={primaryAction.href} leadingIcon={primaryAction.leadingIcon} tone={primaryAction.tone}>
                {primaryAction.label}
              </LinkButton>
              {secondaryAction ? (
                <LinkButton
                  href={secondaryAction.href}
                  tone={secondaryAction.tone}
                  leadingIcon={secondaryAction.leadingIcon}
                >
                  {secondaryAction.label}
                </LinkButton>
              ) : null}
            </>
          }
        />
      </PageSection>
    </Page>
  );
}
