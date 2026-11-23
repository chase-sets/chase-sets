import { sellerAgreementMeta, SellerAgreementRouteAdapter } from "../policy-artifact-route-adapter";

export const meta = sellerAgreementMeta;

export default function SellerAgreementRoute() {
  return <SellerAgreementRouteAdapter />;
}
