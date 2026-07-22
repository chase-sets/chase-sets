import {
  sellerAgreementMeta,
  SellerAgreementRouteAdapter,
} from "../../features/policies/ui/policy-artifact-route-adapter";

export const meta = sellerAgreementMeta;

export default function SellerAgreementRoute() {
  return <SellerAgreementRouteAdapter />;
}
