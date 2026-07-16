import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { Container } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  InvitationAcceptancePage,
  type InvitationAcceptancePresentation,
} from "../../features/invitation-acceptance/ui/invitation-acceptance-page";
import type { InteractiveAuthResult } from "../../support/runtime-support/services";
import { createAuthRequestApiClient } from "../../support/request-support/api-client";
import { marketplaceAuthHost } from "../../support/route-support/auth-host.server";

export const meta: MetaFunction = () => buildOpenGraphMeta({ title: t("auth.routes.marketplace.invite.meta.title") });

export async function loader({ request, params }: LoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const invitationId = params.invitationId ?? "";
  const invitation = await createAuthRequestApiClient(request).inspectInvitation<InvitationAcceptancePresentation>({
    invitationId,
    token,
  });
  return { invitation, token };
}

export async function action({ request, params }: ActionFunctionArgs) {
  try {
    const formData = await request.formData();
    const result = await createAuthRequestApiClient(request).acceptInvitation<InteractiveAuthResult>({
      invitationId: params.invitationId ?? formData.get("invitationId"),
      token: formData.get("token"),
      password: formData.get("password"),
      challengeId: formData.get("challengeId"),
      challenge: formData.get("challenge"),
      externalCredentialId: formData.get("externalCredentialId"),
      label: formData.get("label"),
      webauthnResponse: formData.get("webauthnResponse"),
    });
    return marketplaceAuthHost.completeAuthentication(request, result, {
      defaultSuccessPath: "/account",
      freshWriteSource: result,
    });
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.acceptance.failed.fallback"),
    };
  }
}

export default function MarketplaceInviteRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <Container width="narrow" paddingX={0}>
      <InvitationAcceptancePage
        invitation={data.invitation}
        token={data.token}
        errorMessage={actionData && "error" in actionData ? actionData.error : null}
      />
    </Container>
  );
}
