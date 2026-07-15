import { LinkButton } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { WalletAdjustmentFlowErrorKind } from "../../../support/request-support/wallet-adjustment-flow-error";

export function walletAdjustmentReauthenticationHref(returnTo: string): string {
  return `/access/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
}

export function WalletAdjustmentReauthenticationLink({
  errorKind,
  returnTo,
}: {
  errorKind: WalletAdjustmentFlowErrorKind | null;
  returnTo: string;
}) {
  if (errorKind !== "step-up-required" && errorKind !== "authentication-required") {
    return null;
  }

  return (
    <LinkButton
      href={walletAdjustmentReauthenticationHref(returnTo)}
      target="_blank"
      rel="noreferrer"
      tone="secondary"
      size="sm"
    >
      {t("settlement.features.wallets.ui.walletAdjustmentReauthenticationLink.sign.in.again.in.new.tab")}
    </LinkButton>
  );
}
