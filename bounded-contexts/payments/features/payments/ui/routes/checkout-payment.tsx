export { action, ErrorBoundary, loader, meta } from "./account-payment";

import AccountPaymentRoute from "./account-payment";

export default function CheckoutPaymentRoute() {
  return <AccountPaymentRoute />;
}
