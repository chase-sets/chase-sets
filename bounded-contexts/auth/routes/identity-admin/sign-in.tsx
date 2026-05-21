import type { MetaFunction } from "react-router";
import { useActionData } from "react-router";
import { Container } from "@chase-sets/design-system";
import { identityAdminAuthHostConfig } from "../../support/route-support/host-config";
import { identityAdminAuthHost } from "../../support/route-support/auth-host.server";
import { SignInPage } from "../../features/sign-in/ui/sign-in-page";

export const meta: MetaFunction = () => [{ title: identityAdminAuthHostConfig.titles.signIn }];

export const action = identityAdminAuthHost.createSignInAction();

export default function IdentityAdminSignInRoute() {
  const actionData = useActionData<typeof action>();
  return (
    <Container width="narrow">
      <SignInPage
        errorMessage={actionData && "error" in actionData ? actionData.error : null}
        notice={actionData && "status" in actionData ? actionData : null}
        signInMethods={identityAdminAuthHostConfig.signInMethods}
        allowManualMagicLinkTokenEntry={identityAdminAuthHostConfig.allowManualMagicLinkTokenEntry}
      />
    </Container>
  );
}
