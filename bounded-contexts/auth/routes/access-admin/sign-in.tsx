import type { MetaFunction } from "react-router";
import { useActionData, useSearchParams } from "react-router";
import { Container } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { accessAdminAuthHost } from "../../support/route-support/auth-host.server";
import { accessAdminAuthHostConfig } from "../../support/route-support/host-config";
import {
  createAdminGoogleWorkspaceSocialLoginHref,
  getSafeAdminReturnTo,
} from "../../support/route-support/admin-social-login";
import { SignInPage } from "../../features/sign-in/ui/sign-in-page";

export const meta: MetaFunction = () => [{ title: accessAdminAuthHostConfig.titles.signIn }];

export const action = accessAdminAuthHost.createSignInAction();

export default function AccessAdminSignInRoute() {
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const returnTo = getSafeAdminReturnTo(searchParams, accessAdminAuthHostConfig.defaultSuccessPath);
  return (
    <Container width="narrow">
      <SignInPage
        errorMessage={actionData && "error" in actionData ? actionData.error : null}
        notice={actionData && "status" in actionData ? actionData : null}
        returnTo={returnTo}
        signInMethods={accessAdminAuthHostConfig.signInMethods}
        allowManualMagicLinkTokenEntry={accessAdminAuthHostConfig.allowManualMagicLinkTokenEntry}
        socialLoginDescription={t("auth.features.signIn.ui.signInPage.continue.with.workspace.account")}
        socialLoginLinks={[
          {
            href: createAdminGoogleWorkspaceSocialLoginHref("access-admin", returnTo),
            label: t("auth.features.signIn.ui.signInPage.continue.with.google.workspace"),
            icon: "badgeCheck",
          },
        ]}
      />
    </Container>
  );
}
