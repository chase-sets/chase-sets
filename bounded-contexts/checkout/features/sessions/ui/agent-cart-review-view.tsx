import { useState, type ReactNode } from "react";
import {
  Banner,
  Box,
  Button,
  ChaseRoot,
  CheckoutStateNotice,
  CheckoutSummaryPanel,
  LiveRegion,
  Skeleton,
  Stack,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import {
  agentCheckoutResult,
  agentCheckoutTotalLabel,
  formatAgentCheckoutAmount,
  isTerminalAgentCheckout,
  type AgentCheckout,
  type AgentCheckoutMessage,
  type AgentCheckoutStatus,
  type AgentCheckoutViewState,
} from "./agent-checkout-result";

const statusBadges: Record<
  AgentCheckoutStatus,
  { label: () => string; tone: "neutral" | "info" | "success" | "warning" }
> = {
  incomplete: { label: () => t("checkout.features.sessions.ui.agentCartReview.status.incomplete"), tone: "warning" },
  requires_escalation: {
    label: () => t("checkout.features.sessions.ui.agentCartReview.status.requiresEscalation"),
    tone: "info",
  },
  ready_for_complete: {
    label: () => t("checkout.features.sessions.ui.agentCartReview.status.readyForComplete"),
    tone: "info",
  },
  complete_in_progress: {
    label: () => t("checkout.features.sessions.ui.agentCartReview.status.completeInProgress"),
    tone: "info",
  },
  completed: { label: () => t("checkout.features.sessions.ui.agentCartReview.status.completed"), tone: "success" },
  canceled: { label: () => t("checkout.features.sessions.ui.agentCartReview.status.canceled"), tone: "neutral" },
};

const messageTones = { error: "danger", warning: "warning", info: "info" } as const;

function AgentCheckoutMessages({ messages }: Readonly<{ messages: readonly AgentCheckoutMessage[] }>) {
  return (
    <>
      {messages.map((message, index) => (
        <CheckoutStateNotice key={index} tone={messageTones[message.type]} title={message.content} />
      ))}
    </>
  );
}

function CheckoutSummary({ checkout, action }: Readonly<{ checkout: AgentCheckout; action?: ReactNode }>) {
  const money = (amount: number) => formatAgentCheckoutAmount(amount, checkout.currency);
  const badge = statusBadges[checkout.status];
  return (
    <CheckoutSummaryPanel
      title={t("checkout.features.sessions.ui.agentCartReview.title")}
      status={badge.label()}
      statusTone={badge.tone}
      items={checkout.lineItems.map((line) => ({
        id: line.id,
        title: line.title,
        quantity: line.quantity,
        price: line.total === undefined ? undefined : money(line.total),
      }))}
      totals={checkout.breakdown.map((entry) => ({
        label: agentCheckoutTotalLabel(entry),
        value: money(entry.amount),
      }))}
      totalLabel={t("checkout.features.sessions.ui.agentCheckout.total.total")}
      total={money(checkout.total)}
      actions={action}
    />
  );
}

/** In-chat review of a UCP checkout. It renders the server's totals as sent and never calls a tool itself. */
export function AgentCartReviewView({
  theme,
  state,
  onContinue,
}: Readonly<{
  theme?: "light" | "dark";
  state: AgentCheckoutViewState;
  onContinue?: () => Promise<void>;
}>) {
  const [continuing, setContinuing] = useState(false);
  const [continueFailed, setContinueFailed] = useState(false);
  const view = state.kind === "loading" ? state : agentCheckoutResult(state.result);
  const proceed = async (run: () => Promise<void>) => {
    setContinueFailed(false);
    setContinuing(true);
    try {
      await run();
    } catch {
      setContinueFailed(true);
    } finally {
      setContinuing(false);
    }
  };

  return (
    <ChaseRoot colorMode={theme ?? "system"}>
      <Box element="main" padding={3}>
        <Stack gap={3}>
          {view.kind === "loading" && (
            <Stack gap={2}>
              <LiveRegion>{t("checkout.features.sessions.ui.agentCartReview.loading")}</LiveRegion>
              <Skeleton height="lg" />
              <Skeleton height="lg" />
            </Stack>
          )}
          {view.kind === "malformed" && (
            <Banner tone="warning" title={t("checkout.features.sessions.ui.agentCartReview.malformed")} />
          )}
          {view.kind === "error" && (
            <Banner
              tone="danger"
              title={t("checkout.features.sessions.ui.agentCartReview.error")}
              description={view.messages.map((message) => message.content).join(" ")}
            />
          )}
          {view.kind === "checkout" && (
            <>
              <AgentCheckoutMessages messages={view.checkout.messages} />
              {view.checkout.lineItems.length === 0 ? (
                <CheckoutStateNotice
                  tone="neutral"
                  title={t("checkout.features.sessions.ui.agentCartReview.empty")}
                  description={t("checkout.features.sessions.ui.agentCartReview.empty.description")}
                />
              ) : (
                <CheckoutSummary
                  checkout={view.checkout}
                  action={
                    onContinue && !isTerminalAgentCheckout(view.checkout.status) ? (
                      <Button type="button" block loading={continuing} onClick={() => void proceed(onContinue)}>
                        {t("checkout.features.sessions.ui.agentCartReview.continue")}
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </>
          )}
          {continueFailed && (
            <Banner tone="danger" title={t("checkout.features.sessions.ui.agentCartReview.continue.error")} />
          )}
        </Stack>
      </Box>
    </ChaseRoot>
  );
}
