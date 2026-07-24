import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { Container } from "@chase-sets/design-system";
import { marketplaceAuthHostConfig } from "../../support/route-support/host-config";
import { marketplaceAuthHost } from "../../support/route-support/auth-host.server";
import { RegisterPage } from "../../features/registration/ui/register-page";
import { marketplaceAccountGateContextMessage } from "../../support/route-support/marketplace-account-gate-context";
import { authFormActionFromRequest } from "../../support/route-support/auth-form-action";
import { resolveRegistrationConsentForRequest } from "../../support/request-support/registration-consent";

export const meta: MetaFunction = () => buildOpenGraphMeta({ title: marketplaceAuthHostConfig.titles.register! });

export const action = marketplaceAuthHost.createRegisterAction();

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const returnTo = marketplaceAuthHost.getReturnTo(request);
  return {
    returnTo,
    formAction: authFormActionFromRequest(request),
    contextMessage: marketplaceAccountGateContextMessage(returnTo),
    socialLoginError: url.searchParams.get("socialLoginError"),
    registrationConsent: await resolveRegistrationConsentForRequest(request),
  };
}

export default function MarketplaceRegisterRoute() {
  const actionData = useActionData<typeof action>();
  const data = useLoaderData<typeof loader>();
  return (
    <Container width="narrow" paddingX={0}>
      <RegisterPage
        errorMessage={actionData && "error" in actionData ? actionData.error : data.socialLoginError}
        contextMessage={data.contextMessage}
        notice={actionData && "status" in actionData ? actionData : null}
        action={data.formAction}
        returnTo={data.returnTo}
        registrationConsent={data.registrationConsent}
      />
    </Container>
  );
}
