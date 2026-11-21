import { useState } from "react";
import {
  Banner,
  Box,
  Button,
  ChaseRoot,
  CheckoutConfirmationPanel,
  CheckoutReadinessPrompt,
  CheckoutStateNotice,
  LiveRegion,
  Skeleton,
  Stack,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import {
  agentCheckoutLink,
  agentCheckoutResult,
  formatAgentCheckoutAmount,
  type AgentCheckout,
  type AgentCheckoutMessage,
  type AgentCheckoutViewState,
} from "./agent-checkout-result";

type Messages = readonly AgentCheckoutMessage[];

type Handoff =
  | { kind: "loading" }
  | { kind: "malformed" }
  | { kind: "error" | "unavailable" | "ready" | "canceled" | "expired"; messages: Messages }
  | { kind: "escalation"; messages: Messages; url: string }
  | { kind: "processing" }
  | { kind: "incomplete"; notices: readonly { line?: string; message: AgentCheckoutMessage }[] }
  | { kind: "confirmed"; reference: string; total: string; orderUrl?: string };

function lineTitle(checkout: AgentCheckout, path: string | undefined) {
  const index = /^\$\.line_items\[(\d+)\]/.exec(path ?? "")?.[1];
  return index === undefined ? undefined : checkout.lineItems[Number(index)]?.title;
}

function handoff(state: AgentCheckoutViewState): Handoff {
  if (state.kind === "loading") return state;
  const result = agentCheckoutResult(state.result);
  if (result.kind !== "checkout") return result;
  const { checkout } = result;
  const { messages } = checkout;
  // An error message ends the handoff, whatever the status.
  if (messages.some((message) => message.type === "error")) return { kind: "error", messages };
  switch (checkout.status) {
    case "requires_escalation": {
      const url = agentCheckoutLink(checkout.continueUrl);
      return url && messages.length > 0 ? { kind: "escalation", messages, url } : { kind: "unavailable", messages };
    }
    case "complete_in_progress":
      return { kind: "processing" };
    case "incomplete":
      return {
        kind: "incomplete",
        notices: messages.map((message) => ({ line: lineTitle(checkout, message.path), message })),
      };
    case "ready_for_complete":
      return { kind: "ready", messages };
    case "completed":
      return checkout.order
        ? {
            kind: "confirmed",
            reference: checkout.order.label ?? checkout.order.id,
            total: formatAgentCheckoutAmount(checkout.total, checkout.currency),
            orderUrl: agentCheckoutLink(checkout.order.permalinkUrl),
          }
        : { kind: "malformed" };
    case "canceled":
      return {
        kind: messages.some((message) => message.code === "checkout_expired") ? "expired" : "canceled",
        messages,
      };
  }
}

const text = (messages: Messages) => messages.map((message) => message.content).join(" ") || undefined;

function OrderConfirmation({
  reference,
  total,
  orderUrl,
  open,
}: Readonly<{ reference: string; total: string; orderUrl?: string; open: (url: string) => Promise<void> }>) {
  return (
    <CheckoutConfirmationPanel
      title={t("checkout.features.sessions.ui.agentCheckoutHandoff.confirmed")}
      referenceLabel={t("checkout.features.sessions.ui.agentCheckoutHandoff.confirmed.order")}
      referenceValue={reference}
      totalLabel={t("checkout.features.sessions.ui.agentCheckout.total.total")}
      total={total}
      actions={
        orderUrl ? (
          <Button type="button" tone="secondary" onClick={() => void open(orderUrl)}>
            {t("checkout.features.sessions.ui.agentCheckoutHandoff.confirmed.view")}
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * In-chat checkout handoff. The only action opens Chase Sets through the host's `openLink`; terminal states and
 * error messages never offer it, and the view never calls a tool itself.
 */
export function AgentCheckoutHandoffView({
  theme,
  state,
  openLink,
}: Readonly<{
  theme?: "light" | "dark";
  state: AgentCheckoutViewState;
  openLink: (url: string) => Promise<void>;
}>) {
  const [linkFailed, setLinkFailed] = useState(false);
  const view = handoff(state);
  const open = async (url: string) => {
    setLinkFailed(false);
    try {
      await openLink(url);
    } catch {
      setLinkFailed(true);
    }
  };

  return (
    <ChaseRoot colorMode={theme ?? "system"}>
      <Box element="main" padding={3}>
        <Stack gap={3}>
          {view.kind === "loading" && (
            <Stack gap={2}>
              <LiveRegion>{t("checkout.features.sessions.ui.agentCheckoutHandoff.loading")}</LiveRegion>
              <Skeleton height="lg" />
            </Stack>
          )}
          {view.kind === "malformed" && (
            <Banner tone="warning" title={t("checkout.features.sessions.ui.agentCheckoutHandoff.malformed")} />
          )}
          {view.kind === "error" && (
            <Banner
              tone="danger"
              title={t("checkout.features.sessions.ui.agentCheckoutHandoff.error")}
              description={text(view.messages)}
            />
          )}
          {view.kind === "unavailable" && (
            <Banner
              tone="danger"
              title={t("checkout.features.sessions.ui.agentCheckoutHandoff.unavailable")}
              description={text(view.messages)}
            />
          )}
          {view.kind === "escalation" && (
            <CheckoutReadinessPrompt
              tone="warning"
              title={t("checkout.features.sessions.ui.agentCheckoutHandoff.escalation")}
              description={text(view.messages)}
              action={
                <Button type="button" onClick={() => void open(view.url)}>
                  {t("checkout.features.sessions.ui.agentCheckoutHandoff.continue")}
                </Button>
              }
            />
          )}
          {view.kind === "processing" && (
            <CheckoutStateNotice
              tone="info"
              title={t("checkout.features.sessions.ui.agentCheckoutHandoff.processing")}
              description={t("checkout.features.sessions.ui.agentCheckoutHandoff.processing.description")}
            />
          )}
          {view.kind === "incomplete" && (
            <>
              <CheckoutStateNotice
                tone="warning"
                title={t("checkout.features.sessions.ui.agentCheckoutHandoff.incomplete")}
              />
              {view.notices.map(({ line, message }, index) => (
                <CheckoutStateNotice
                  key={index}
                  tone={message.type === "info" ? "info" : "warning"}
                  title={line ?? message.content}
                  description={line ? message.content : undefined}
                />
              ))}
            </>
          )}
          {view.kind === "ready" && (
            <CheckoutStateNotice
              tone="info"
              title={t("checkout.features.sessions.ui.agentCheckoutHandoff.ready")}
              description={text(view.messages)}
            />
          )}
          {view.kind === "confirmed" && (
            <OrderConfirmation reference={view.reference} total={view.total} orderUrl={view.orderUrl} open={open} />
          )}
          {(view.kind === "canceled" || view.kind === "expired") && (
            <CheckoutStateNotice
              tone="neutral"
              title={
                view.kind === "expired"
                  ? t("checkout.features.sessions.ui.agentCheckoutHandoff.expired")
                  : t("checkout.features.sessions.ui.agentCheckoutHandoff.canceled")
              }
              description={text(view.messages)}
            />
          )}
          {linkFailed && (
            <Banner tone="warning" title={t("checkout.features.sessions.ui.agentCheckoutHandoff.continue.error")} />
          )}
        </Stack>
      </Box>
    </ChaseRoot>
  );
}
