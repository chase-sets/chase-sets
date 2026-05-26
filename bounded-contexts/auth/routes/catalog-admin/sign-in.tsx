import type { MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { Container } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { catalogAdminAuthHostConfig } from "../../support/route-support/host-config";
import { catalogAdminAuthHost } from "../../support/route-support/auth-host.server";
import { SignInPage } from "../../features/sign-in/ui/sign-in-page";

export const meta: MetaFunction = () => [{ title: catalogAdminAuthHostConfig.titles.signIn }];

export const action = catalogAdminAuthHost.createSignInAction();

export default function CatalogAdminSignInRoute() {
  const actionData = useActionData<typeof action>();
  return (
    <Container width="narrow">
      <SignInPage
        errorMessage={actionData && "error" in actionData ? actionData.error : null}
        notice={actionData && "status" in actionData ? actionData : null}
        returnTo={catalogAdminAuthHostConfig.defaultSuccessPath}
        signInMethods={catalogAdminAuthHostConfig.signInMethods}
        allowManualMagicLinkTokenEntry={catalogAdminAuthHostConfig.allowManualMagicLinkTokenEntry}
        socialLoginDescription={t("auth.features.signIn.ui.signInPage.continue.with.workspace.account")}
        socialLoginLinks={[
          {
            href: `/api/auth/social/google/start?journey=catalog-admin&returnTo=${encodeURIComponent(
              catalogAdminAuthHostConfig.defaultSuccessPath,
            )}`,
            label: t("auth.features.signIn.ui.signInPage.continue.with.google.workspace"),
            icon: "badgeCheck",
          },
        ]}
      />
    </Container>
  );
}
