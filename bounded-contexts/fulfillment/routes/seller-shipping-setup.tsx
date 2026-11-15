import ShippingSetupRoute, {
  action as shippingSetupAction,
  loader as shippingSetupLoader,
  meta as shippingSetupMeta,
} from "../features/seller-checkout-readiness/ui/shipping-setup-route-adapter";

export const loader = shippingSetupLoader;
export const action = shippingSetupAction;
export const meta = shippingSetupMeta;
export default ShippingSetupRoute;
