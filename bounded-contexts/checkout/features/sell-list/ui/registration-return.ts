export const SELLER_CHECKOUT_REGISTRATION_RETURN_TO = "/account/sell-list?registrationReturn=seller-checkout";

export function sellerCheckoutRegisterHref(returnTo = SELLER_CHECKOUT_REGISTRATION_RETURN_TO) {
  return `/register?returnTo=${encodeURIComponent(returnTo)}`;
}

export function sellerCheckoutSignInHref(returnTo = SELLER_CHECKOUT_REGISTRATION_RETURN_TO) {
  return `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
}

export const SELLER_CHECKOUT_REGISTER_HREF = sellerCheckoutRegisterHref();

export const SELLER_CHECKOUT_SIGN_IN_HREF = sellerCheckoutSignInHref();
