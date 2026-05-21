import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { Container } from "@chase-sets/design-system";
import { marketplaceAuthHostConfig } from "../../support/route-support/host-config";
import { marketplaceAuthHost } from "../../support/route-support/auth-host.server";
import { RegisterPage } from "../../features/registration/ui/register-page";

export const meta: MetaFunction = () => buildOpenGraphMeta({ title: marketplaceAuthHostConfig.titles.register! });

export const action = marketplaceAuthHost.createRegisterAction();

export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return {
    returnTo: marketplaceAuthHost.getReturnTo(request),
    socialLoginError: url.searchParams.get("socialLoginError"),
  };
}

export default function MarketplaceRegisterRoute() {
  const actionData = useActionData<typeof action>();
  const data = useLoaderData<typeof loader>();
  return (
    <Container width="narrow" paddingX={0}>
      <RegisterPage
        errorMessage={actionData && "error" in actionData ? actionData.error : data.socialLoginError}
        notice={actionData && "status" in actionData ? actionData : null}
        returnTo={data.returnTo}
      />
    </Container>
  );
}
