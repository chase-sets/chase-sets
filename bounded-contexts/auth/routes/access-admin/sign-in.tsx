import type { MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { Container } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { accessAdminAuthHost } from "../../support/route-support/auth-host.server";
import { accessAdminAuthHostConfig } from "../../support/route-support/host-config";
import { SignInPage } from "../../features/sign-in/ui/sign-in-page";

export const meta: MetaFunction = () => [{ title: accessAdminAuthHostConfig.titles.signIn }];

export const action = accessAdminAuthHost.createSignInAction();

export default function AccessAdminSignInRoute() {
  const actionData = useActionData<typeof action>();
  return (
    <Container width="narrow">
      <SignInPage
        errorMessage={actionData && "error" in actionData ? actionData.error : null}
        notice={actionData && "status" in actionData ? actionData : null}
        returnTo={accessAdminAuthHostConfig.defaultSuccessPath}
        signInMethods={accessAdminAuthHostConfig.signInMethods}
        allowManualMagicLinkTokenEntry={accessAdminAuthHostConfig.allowManualMagicLinkTokenEntry}
        socialLoginDescription={t("auth.features.signIn.ui.signInPage.continue.with.workspace.account")}
        socialLoginLinks={[
          {
            href: `/api/auth/social/google/start?journey=access-admin&returnTo=${encodeURIComponent(
              accessAdminAuthHostConfig.defaultSuccessPath,
            )}`,
            label: t("auth.features.signIn.ui.signInPage.continue.with.google.workspace"),
            icon: "badgeCheck",
          },
        ]}
      />
    </Container>
  );
}
