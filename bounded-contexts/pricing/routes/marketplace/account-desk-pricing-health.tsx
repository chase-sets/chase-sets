import type { MetaFunction } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { t } from "@chase-sets/localization";

export { default, loader, action } from "../../support/route-support/pricing-health";
export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("pricing.features.pricingHealth.title"),
    description: t("pricing.features.pricingHealth.description"),
  });
