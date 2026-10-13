import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useLocation } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { Container } from "@chase-sets/design-system";
import { marketplaceAuthHostConfig } from "../../support/route-support/host-config";
import { marketplaceAuthHost } from "../../support/route-support/auth-host.server";
import { RegisterPage } from "../../features/registration/ui/register-page";
import { marketplaceAccountGateContextMessage } from "../../support/route-support/marketplace-account-gate-context";
import { authFormActionFromRequest } from "../../support/route-support/auth-form-action";
import { socialLoginErrorMessage } from "../../support/route-support/social-login-errors";
import { useAuthFormActionData, useAuthFormSubmission } from "../../support/ui-support/auth-form-feedback";

export const meta: MetaFunction = () => buildOpenGraphMeta({ title: marketplaceAuthHostConfig.titles.register! });

export const action = marketplaceAuthHost.createRegisterAction();

export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const returnTo = marketplaceAuthHost.getReturnTo(request);
  return {
    returnTo,
    formAction: authFormActionFromRequest(request),
    contextMessage: marketplaceAccountGateContextMessage(returnTo),
    socialLoginError: socialLoginErrorMessage(url.searchParams.get("socialLoginError")),
  };
}

export default function MarketplaceRegisterRoute() {
  const actionData = useAuthFormActionData(useActionData<typeof action>());
  const data = useLoaderData<typeof loader>();
  const submission = useAuthFormSubmission();
  const location = useLocation();
  return (
    <Container width="narrow" paddingX={0}>
      <RegisterPage
        {...submission}
        actionError={actionData && "error" in actionData ? actionData : null}
        socialError={data.socialLoginError}
        socialOccurrence={location.key}
        contextMessage={data.contextMessage}
        notice={actionData && "status" in actionData ? actionData : null}
        action={data.formAction}
        returnTo={data.returnTo}
      />
    </Container>
  );
}
