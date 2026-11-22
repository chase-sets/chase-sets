import type { LoaderFunctionArgs } from "react-router";
import { expect, it } from "vitest";
import { loader as accountAgreementRedirectLoader } from "../../../../routes/admin/account-agreement-new";
import { loader as agreementsRedirectLoader } from "../../../../routes/admin/agreements";
import { loader as agreementRedirectLoader } from "../../../../routes/admin/agreements-detail";

it.each([
  ["/commerce/terms/agreements", agreementsRedirectLoader, {}, "/commerce/terms"],
  [
    "/commerce/terms/agreements/cag_active",
    agreementRedirectLoader,
    { id: "cag_active" },
    "/commerce/terms?agreement=cag_active",
  ],
  [
    "/commerce/terms/accounts/acc_seller/agreements/new",
    accountAgreementRedirectLoader,
    { accountId: "acc_seller" },
    "/commerce/terms?create=agreement&account=acc_seller",
  ],
] satisfies [string, typeof agreementsRedirectLoader, LoaderFunctionArgs["params"], string][])(
  "redirects the retired agreement route %s to the home query-state contract",
  async (path, loader, params, location) => {
    const response = await loader({
      request: new Request(`https://admin.chasesets.com${path}`),
      params,
      context: undefined,
    });
    expect(response.headers.get("Location")).toBe(location);
  },
);
