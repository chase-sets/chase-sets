import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { defineFormAction, formActionRedirect, readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import type { Account, Invitation } from "../../support/request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { createId } from "@chase-sets/primitives/typed-ids";
import { InvitationListPage } from "../../features/invitations/ui/invitation-list-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";
import {
  IDENTITY_INVITATION_STATUSES,
  identityListQuery,
  readIdentityListFilters,
} from "../../support/route-support/list-filters";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const page = readOffsetPageParams(request);
  const filters = readIdentityListFilters(request, IDENTITY_INVITATION_STATUSES);
  const [data, accounts] = await Promise.all([
    api.listInvitations<ListResponse<Invitation>>(identityListQuery(page.query, filters)),
    api.listAccounts<ListResponse<Account>>("limit=500&offset=0"),
  ]);
  return {
    accounts: accounts.items,
    initialData: { ...data, limit: page.limit, offset: page.offset },
    filters,
  };
}

export const action = defineFormAction({
  intents: {
    create: async ({ request, formData }) => {
      const invitationId = createId("ivt");
      return formActionRedirect(
        await createIdentityRequestApiClient(request).createInvitation({
          invitationId,
          accountId: String(formData.get("accountId") ?? ""),
          email: String(formData.get("email") ?? ""),
          roleKey: String(formData.get("roleKey") ?? "viewer"),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        `/access/invitations/${invitationId}`,
      );
    },
  },
  onUnknownIntent: () => {
    throw new Response("Unsupported invitation action.", { status: 400 });
  },
});

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.invitations.invitations.identity.admin") }];

export default function InvitationsRoute() {
  const data = useLoaderData<typeof loader>();
  return <InvitationListPage accounts={data.accounts} initialData={data.initialData} filters={data.filters} />;
}
