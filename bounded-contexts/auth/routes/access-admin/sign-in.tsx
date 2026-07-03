import type { MetaFunction } from "react-router";
import { useActionData, useLocation, useSearchParams } from "react-router";
import { Container } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { adminAuthHost } from "../../support/route-support/auth-host.server";
import { adminAuthHostConfig } from "../../support/route-support/host-config";
import {
  createAdminGoogleWorkspaceSocialLoginHref,
  getSafeAdminReturnTo,
} from "../../support/route-support/admin-social-login";
import { authFormActionFromLocation } from "../../support/route-support/auth-form-action";
import { SignInPage } from "../../features/sign-in/ui/sign-in-page";

export const meta: MetaFunction = () => [{ title: adminAuthHostConfig.titles.signIn }];

export const action = adminAuthHost.createSignInAction();

export default function AccessAdminSignInRoute() {
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const returnTo = getSafeAdminReturnTo(searchParams, adminAuthHostConfig.defaultSuccessPath);
  return (
    <Container width="narrow">
      <SignInPage
        errorMessage={actionData && "error" in actionData ? actionData.error : null}
        notice={actionData && "status" in actionData ? actionData : null}
        action={authFormActionFromLocation(location)}
        initialIdentifier={searchParams.get("signInIdentifier")}
        initialMethod={searchParams.get("signInMethod")}
        returnTo={returnTo}
        signInMethods={adminAuthHostConfig.signInMethods}
        allowManualMagicLinkTokenEntry={adminAuthHostConfig.allowManualMagicLinkTokenEntry}
        socialLoginDescription={t("auth.features.signIn.ui.signInPage.continue.with.workspace.account")}
        socialLoginLinks={[
          {
            href: createAdminGoogleWorkspaceSocialLoginHref(returnTo),
            label: t("auth.features.signIn.ui.signInPage.continue.with.google.workspace"),
            icon: "badgeCheck",
          },
        ]}
      />
    </Container>
  );
}
