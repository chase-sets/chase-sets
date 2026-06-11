export const SELLER_CHECKOUT_REGISTRATION_RETURN_TO = "/account/sell-list?registrationReturn=seller-checkout";

export const SELLER_CHECKOUT_REGISTER_HREF = `/register?returnTo=${encodeURIComponent(
  SELLER_CHECKOUT_REGISTRATION_RETURN_TO,
)}`;

export const SELLER_CHECKOUT_SIGN_IN_HREF = `/sign-in?returnTo=${encodeURIComponent(
  SELLER_CHECKOUT_REGISTRATION_RETURN_TO,
)}`;
