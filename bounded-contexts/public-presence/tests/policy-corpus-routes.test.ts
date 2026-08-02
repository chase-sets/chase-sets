import { describe, expect, it } from "vitest";
import { meta as agentTermsMeta } from "../routes/marketplace/agent-terms";
import { meta as authenticityTermsMeta } from "../routes/marketplace/authenticity-terms";
import { meta as paymentsTermsMeta } from "../routes/marketplace/payments-terms";
import { meta as privacyPolicyMeta } from "../routes/marketplace/privacy";
import { meta as sellerAgreementMeta } from "../routes/marketplace/seller-agreement";
import { meta as termsOfServiceMeta } from "../routes/marketplace/terms";

const corpusRoutes = [
  { routeName: "terms", meta: termsOfServiceMeta, policyKey: "terms-of-service", noindexWhilePending: false },
  {
    routeName: "seller-agreement",
    meta: sellerAgreementMeta,
    policyKey: "seller-agreement",
    noindexWhilePending: true,
  },
  { routeName: "payments-terms", meta: paymentsTermsMeta, policyKey: "payments-terms", noindexWhilePending: true },
  { routeName: "privacy", meta: privacyPolicyMeta, policyKey: "privacy-policy", noindexWhilePending: false },
  { routeName: "agent-terms", meta: agentTermsMeta, policyKey: "agent-connector-terms", noindexWhilePending: true },
  {
    routeName: "authenticity-terms",
    meta: authenticityTermsMeta,
    policyKey: "authenticity-service-terms",
    noindexWhilePending: true,
  },
] as const;

describe("policy corpus route metadata", () => {
  for (const route of corpusRoutes) {
    it(`publishes machine policy metadata and counsel-pending posture for ${route.routeName}`, () => {
      const descriptors = route.meta({} as never);

      expect(descriptors).toEqual(
        expect.arrayContaining([
          { name: "chase-sets:policy-key", content: route.policyKey },
          { name: "chase-sets:policy-version", content: "v1" },
          { name: "chase-sets:policy-publication-status", content: "counsel-review-required" },
        ]),
      );
      if (route.noindexWhilePending) {
        expect(descriptors).toEqual(expect.arrayContaining([{ name: "robots", content: "noindex, nofollow" }]));
      } else {
        expect(descriptors).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "robots" })]));
      }
      expect(descriptors).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "chase-sets:policy-effective-at" })]),
      );
    });
  }
});
