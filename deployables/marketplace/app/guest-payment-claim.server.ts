import { createGuestPaymentClaimRoute } from "@chase-sets/auth/server";
import { readGuestPaymentClaimability } from "@chase-sets/payments/server";

const route = createGuestPaymentClaimRoute(readGuestPaymentClaimability);
export const loader = route.loader;
export const action = route.action;
