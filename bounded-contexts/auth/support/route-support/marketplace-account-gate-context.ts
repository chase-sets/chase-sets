import { EMAIL_VERIFICATION_RETURN_PARAMETER, type EmailVerificationPurpose } from "@chase-sets/auth-context";
import { t } from "@chase-sets/localization";

export type MarketplaceAccountGateContextMessage = Readonly<{
  title: string;
  description: string;
}>;

const MARKETPLACE_RETURN_ORIGIN = "https://marketplace.chasesets.local";
const PURCHASE_DETAIL_PATH = /^\/account\/purchases\/[^/]+$/;

export function marketplaceAccountGateContextMessage(returnTo: string): MarketplaceAccountGateContextMessage | null {
  let url: URL;
  try {
    url = new URL(returnTo, MARKETPLACE_RETURN_ORIGIN);
  } catch {
    return null;
  }

  if (url.origin !== MARKETPLACE_RETURN_ORIGIN) {
    return null;
  }

  if (url.pathname === "/account/sell-list" && url.searchParams.get("registrationReturn") === "seller-checkout") {
    return {
      title: t("auth.routes.marketplace.accountGate.seller.checkout.title"),
      description: t("auth.routes.marketplace.accountGate.seller.checkout.description"),
    };
  }

  if (url.pathname === "/account/listings/new" && url.searchParams.has("claimListingIntent")) {
    return {
      title: t("auth.routes.marketplace.accountGate.listing.draft.title"),
      description: t("auth.routes.marketplace.accountGate.listing.draft.description"),
    };
  }

  if (
    PURCHASE_DETAIL_PATH.test(url.pathname) &&
    url.searchParams.get(EMAIL_VERIFICATION_RETURN_PARAMETER) === ("cancel-purchase" satisfies EmailVerificationPurpose)
  ) {
    return {
      title: t("auth.routes.marketplace.accountGate.purchase.cancel.verify.title"),
      description: t("auth.routes.marketplace.accountGate.purchase.cancel.verify.description"),
    };
  }

  return null;
}
