import { t } from "@chase-sets/localization";
import { redirect } from "react-router";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  defineApiErrorAdapter,
  defineFormAction,
  defineResourceRoute,
  type FormActionContext,
} from "@chase-sets/platform-runtime/http";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import { createInternalAuthRequestApiClient } from "../../request-support/api-client";
import { completeBrowserAuthentication } from "../auth-host";
import { clearGuestCheckoutCookie } from "../../auth-support/http";
import type { InteractiveAuthResult } from "../auth-host";
import type {
  BoundGuestClaimContact,
  GuestCheckoutClaimContext,
  GuestClaimActionData,
} from "../../../features/registration/ui/guest-payment-claim-contracts";
import contextManifest from "../../../context.json" with { type: "json" };

export type ReadGuestPaymentClaimability = (
  request: Request,
  paymentId: string,
) => Promise<Readonly<{ claimable: boolean }>>;

type RouteApiError = Error & Readonly<{ status: number; body: unknown }>;
const errorAdapter = defineApiErrorAdapter({
  isError: (error): error is RouteApiError =>
    error instanceof Error && "status" in error && typeof error.status === "number" && "body" in error,
  getStatus: (error) => error.status,
  getBody: (error) => error.body,
});
function hasStatus(error: unknown, status: number) {
  return error instanceof Error && "status" in error && error.status === status;
}
function accessExpired() {
  return new Response("This guest checkout payment link is invalid or expired.", {
    status: 401,
    statusText: "Guest checkout link expired",
  });
}
function localRecoveryEnabled() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.DEPLOYMENT_ENVIRONMENT !== "production" &&
    new Set(["1", "true", "yes", "on"]).has(
      (process.env.GUEST_PAYMENT_CLAIM_LOCAL_RECOVERY_TOKEN_ENABLED ?? "").trim().toLowerCase(),
    )
  );
}

function boundContact(context: GuestCheckoutClaimContext): BoundGuestClaimContact | null {
  const contactEmail = context.contactEmail?.trim();
  const contactName = context.contactName?.trim();
  return contactEmail && contactName ? { contactEmail, contactName } : null;
}

export function createGuestPaymentClaimRoute(readGuestPaymentClaimability: ReadGuestPaymentClaimability) {
  const loader = defineResourceRoute({
    manifest: contextManifest,
    routeId: "guest-payment-claim",
    prepare: async (args) => {
      const request = await resolvePlatformPostWriteRequest(args.request);
      const continuation = new URL(request.url).searchParams.get("claimContinuation")?.trim();
      if (continuation) {
        const result = await createInternalAuthRequestApiClient(
          request,
        ).claimGuestCheckoutWithClaimContinuation<InteractiveAuthResult>({
          continuation,
          paymentId: args.params.paymentId,
        });
        const response = completeBrowserAuthentication(request, result, {
          defaultSuccessPath: `/account/payments/${args.params.paymentId}`,
          accountSelectionPath: "/account/select",
        });
        clearGuestCheckoutCookie(response.headers, request);
        throw response;
      }
      return { ...args, request };
    },
    authorization: async ({ request, params }) => {
      const actor = await resolveActorFromAuthApi({ request });
      if (actor && actor.roleKey !== "guest-buyer") throw redirect(`/account/payments/${params.paymentId}`);
      return actor;
    },
    errorAdapter,
    load: ({ request, params }) => readGuestPaymentClaimability(request, params.paymentId!),
    map: async ({ claimable }, { request, params }) => {
      const paymentId = params.paymentId!;
      if (!claimable) return { paymentId, claimable, guestClaimContact: null };
      try {
        const context = await createInternalAuthRequestApiClient(
          request,
        ).getGuestCheckoutClaimContext<GuestCheckoutClaimContext>({ paymentId });
        return { paymentId, claimable, guestClaimContact: boundContact(context) };
      } catch (error) {
        if (hasStatus(error, 401) || hasStatus(error, 403)) throw accessExpired();
        // Saving the order is optional: a refused or failed read (Auth limits it per guest) leaves it off.
        console.warn(
          `[auth] A paid guest's claim context could not be read; Save this order is left off. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { paymentId, claimable, guestClaimContact: null };
      }
    },
    onPending: () => {
      throw new Response(t("auth.routes.marketplace.guestPaymentClaim.payment.preparing.description"), {
        status: 503,
        statusText: t("auth.routes.marketplace.guestPaymentClaim.payment.preparing"),
      });
    },
    onPermanentFailure: (result) => {
      const error = "error" in result ? result.error : null;
      if (hasStatus(error, 401) || hasStatus(error, 403)) throw accessExpired();
      if (hasStatus(error, 404))
        throw new Response(t("auth.routes.marketplace.guestPaymentClaim.payment.not.found"), { status: 404 });
      if (error) throw error;
      throw new Response("Payment handoff is no longer valid.", { status: 410 });
    },
  });

  async function handleAction(
    intent: string,
    { request, params, formData }: FormActionContext,
  ): Promise<Response | GuestClaimActionData | null> {
    const displayName = String(formData.get("displayName") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    try {
      const { claimable } = await readGuestPaymentClaimability(request, params.paymentId!);
      if (!claimable)
        return {
          scope: "claim",
          error: t("auth.routes.marketplace.guestPaymentClaim.you.can.save.this.order.after.payment"),
        };
      if (intent === "claim-link-request") {
        const result = await createInternalAuthRequestApiClient(request).requestGuestCheckoutClaimLink<{
          token: string;
          expiresAt: string;
        }>({ paymentId: params.paymentId, origin: new URL(request.url).origin });
        return {
          status: "claim-link-sent",
          token: localRecoveryEnabled() ? result.token : null,
          expiresAt: result.expiresAt,
          displayName,
        };
      }
      let result: InteractiveAuthResult;
      if (intent === "claim-link-consume") {
        if (!localRecoveryEnabled())
          return {
            scope: "claim",
            error: t("auth.routes.marketplace.guestPaymentClaim.claim.token.entry.is.not.available"),
          };
        result = await createInternalAuthRequestApiClient(
          request,
        ).claimGuestCheckoutWithMagicLink<InteractiveAuthResult>({
          token: formData.get("token"),
          paymentId: params.paymentId,
          displayName,
        });
      } else if (intent === "claim-passkey") {
        result = await createInternalAuthRequestApiClient(request).claimGuestCheckoutWithPasskey<InteractiveAuthResult>(
          {
            displayName,
            email,
            paymentId: params.paymentId,
            challengeId: formData.get("challengeId"),
            challenge: formData.get("challenge"),
            externalCredentialId: formData.get("externalCredentialId"),
            label: formData.get("label"),
            webauthnResponse: formData.get("webauthnResponse"),
          },
        );
      } else return null;
      const response = completeBrowserAuthentication(request, result, {
        defaultSuccessPath: `/account/payments/${params.paymentId}`,
        accountSelectionPath: "/account/select",
      });
      clearGuestCheckoutCookie(response.headers, request);
      return response;
    } catch (error) {
      return {
        scope: "claim",
        error:
          error instanceof Error
            ? error.message
            : t("auth.routes.marketplace.guestPaymentClaim.could.not.save.this.order"),
      };
    }
  }
  const action = defineFormAction({
    intents: {
      "claim-link-request": (context) => handleAction("claim-link-request", context),
      "claim-link-consume": (context) => handleAction("claim-link-consume", context),
      "claim-passkey": (context) => handleAction("claim-passkey", context),
    },
  });
  return { loader, action };
}
