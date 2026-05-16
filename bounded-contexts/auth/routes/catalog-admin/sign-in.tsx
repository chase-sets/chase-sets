import type { MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { catalogAdminAuthHostConfig } from "../../support/route-support/host-config";
import { catalogAdminAuthHost } from "../../support/route-support/auth-host.server";
import { SignInPage } from "../../features/sign-in/ui/sign-in-page";

export const meta: MetaFunction = () => [
  { title: catalogAdminAuthHostConfig.titles.signIn },
];

export const action = catalogAdminAuthHost.createSignInAction();

export default function CatalogAdminSignInRoute() {
  const actionData = useActionData<typeof action>();
  return (
    <SignInPage
      errorMessage={actionData && "error" in actionData ? actionData.error : null}
      notice={actionData && "status" in actionData ? actionData : null}
      signInMethods={catalogAdminAuthHostConfig.signInMethods}
      allowManualMagicLinkTokenEntry={
        catalogAdminAuthHostConfig.allowManualMagicLinkTokenEntry
      }
    />
  );
}
