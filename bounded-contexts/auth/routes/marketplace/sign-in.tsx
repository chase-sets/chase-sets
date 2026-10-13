import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useLocation } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { Container } from "@chase-sets/design-system";
import { marketplaceAuthHostConfig } from "../../support/route-support/host-config";
import { marketplaceAuthHost } from "../../support/route-support/auth-host.server";
import { SignInPage } from "../../features/sign-in/ui/sign-in-page";
import { marketplaceAccountGateContextMessage } from "../../support/route-support/marketplace-account-gate-context";
import { authFormActionFromRequest } from "../../support/route-support/auth-form-action";
import { socialLoginErrorMessage } from "../../support/route-support/social-login-errors";
import { useAuthFormSubmission } from "../../support/ui-support/auth-form-feedback";

export const meta: MetaFunction = () => buildOpenGraphMeta({ title: marketplaceAuthHostConfig.titles.signIn });

export const action = marketplaceAuthHost.createSignInAction();

export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const returnTo = marketplaceAuthHost.getReturnTo(request);
  return {
    returnTo,
    formAction: authFormActionFromRequest(request),
    contextMessage: marketplaceAccountGateContextMessage(returnTo),
    initialIdentifier: url.searchParams.get("signInIdentifier"),
    initialMethod: url.searchParams.get("signInMethod"),
    socialLoginError: socialLoginErrorMessage(url.searchParams.get("socialLoginError")),
  };
}

export default function MarketplaceSignInRoute() {
  const actionData = useActionData<typeof action>();
  const data = useLoaderData<typeof loader>();
  const submission = useAuthFormSubmission();
  const location = useLocation();
  const actionError = actionData && "error" in actionData ? actionData : null;
  return (
    <Container width="narrow" paddingX={0}>
      <SignInPage
        {...submission}
        actionError={actionError}
        socialError={data.socialLoginError}
        socialOccurrence={location.key}
        contextMessage={data.contextMessage}
        notice={actionData && "status" in actionData ? actionData : null}
        action={data.formAction}
        initialIdentifier={data.initialIdentifier}
        initialMethod={actionError?.method ?? data.initialMethod}
        returnTo={data.returnTo}
        signInMethods={marketplaceAuthHostConfig.signInMethods}
        allowManualMagicLinkTokenEntry={marketplaceAuthHostConfig.allowManualMagicLinkTokenEntry}
      />
    </Container>
  );
}
