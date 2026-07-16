import {
  Badge,
  DataTable,
  EmptyState,
  Grid,
  Inline,
  LinkButton,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { centsToMoneyAmount, tryMoneyToCents } from "@chase-sets/primitives/money";
import type { SupportEvidence, SupportRequesterRole } from "../domain/common";
import type { SupportRequestDetail } from "./contracts";
import { formatSupportDateTime } from "./support-request-presentation";

type AffectedLine = Readonly<{ amount: string; currencyCode: string }>;

function affectedLines(request: SupportRequestDetail): readonly AffectedLine[] {
  const raw = request.affected_line_items;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((line) => (line && typeof line === "object" ? (line as Record<string, unknown>) : null))
    .filter((line): line is Record<string, unknown> => Boolean(line))
    .filter((line) => typeof line.amount === "string" && typeof line.currencyCode === "string")
    .map((line) => ({ amount: String(line.amount), currencyCode: String(line.currencyCode) }));
}

/**
 * The domain caps an adjudicated refund at the sum of the affected order
 * lines. Surfacing that same ceiling in the workbench lets the operator issue a
 * decision without hunting for the number or risking a rejection at the domain
 * boundary. Returns `null` when no affected-line snapshot is available.
 */
export function adjudicationRefundCap(request: SupportRequestDetail): string | null {
  const lines = affectedLines(request);
  if (lines.length === 0) {
    return null;
  }
  let totalCents = 0n;
  for (const line of lines) {
    const cents = tryMoneyToCents(line.amount);
    if (cents === null) {
      return null;
    }
    totalCents += cents;
  }
  return centsToMoneyAmount(totalCents);
}

/**
 * Prefill for the decision panel's refund field: the most recent offer's
 * refund amount when it exists and stays within the cap, otherwise the cap
 * itself. Keeps the operator on the offer history's number when the parties
 * were already close, without ever exceeding the domain ceiling.
 */
export function adjudicationRefundPrefill(request: SupportRequestDetail): string | null {
  const cap = adjudicationRefundCap(request);
  const capCents = cap === null ? null : tryMoneyToCents(cap);

  const offersByRecency = [...request.offers].sort((left, right) => right.offeredAt.localeCompare(left.offeredAt));
  const latestOfferWithRefund =
    request.pending_offer?.refundAmount != null
      ? request.pending_offer.refundAmount
      : (offersByRecency.find((offer) => offer.refundAmount != null)?.refundAmount ?? null);

  if (latestOfferWithRefund != null) {
    const offerCents = tryMoneyToCents(latestOfferWithRefund);
    if (offerCents !== null && (capCents === null || offerCents <= capCents)) {
      return centsToMoneyAmount(offerCents);
    }
  }
  return cap;
}

function EvidenceAttachments({ attachments }: Readonly<{ attachments: readonly string[] }>) {
  if (attachments.length === 0) {
    return (
      <Text element="span" size="xs" tone="secondary">
        {t("support.features.supportRequests.ui.supportOperationsPage.adjudication.evidence.noAttachments")}
      </Text>
    );
  }
  return (
    <Inline gap={1}>
      {attachments.map((attachment, index) => (
        <LinkButton
          key={attachment}
          href={attachment}
          size="sm"
          tone="secondary"
          target="_blank"
          rel="noreferrer"
          trailingIcon="externalLink"
        >
          {t("support.features.supportRequests.ui.supportOperationsPage.adjudication.evidence.attachment", {
            index: index + 1,
          })}
        </LinkButton>
      ))}
    </Inline>
  );
}

function PartyPosition({
  request,
  role,
  heading,
  emptyLabel,
}: Readonly<{
  request: SupportRequestDetail;
  role: SupportRequesterRole;
  heading: string;
  emptyLabel: string;
}>) {
  const responses = request.responses.filter((response) => response.submittedByRole === role);
  const evidence: readonly SupportEvidence[] = request.evidence.filter(
    (item) => item.submittedByRole === role && item.evidenceType !== "support-note",
  );

  return (
    <Surface tone="muted">
      <Stack gap={3}>
        <Text weight="semibold">{heading}</Text>
        {responses.length === 0 && evidence.length === 0 ? (
          <Text size="sm" tone="secondary">
            {emptyLabel}
          </Text>
        ) : (
          <Stack gap={3}>
            {responses.map((response) => (
              <Stack key={response.responseId} gap={1}>
                <Inline gap={2}>
                  <Badge tone={response.responseType === "challenge-with-evidence" ? "warning" : "neutral"}>
                    {response.responseType}
                  </Badge>
                  <Text element="span" size="xs" tone="secondary">
                    {formatSupportDateTime(response.submittedAt)}
                  </Text>
                </Inline>
                <Text size="sm" wrap="anywhere">
                  {response.summary}
                </Text>
              </Stack>
            ))}
            {evidence.map((item) => (
              <Stack key={item.evidenceId} gap={1}>
                <Inline gap={2}>
                  <Badge tone="neutral">{item.evidenceType}</Badge>
                  <Text element="span" size="xs" tone="secondary">
                    {formatSupportDateTime(item.submittedAt)}
                  </Text>
                </Inline>
                <Text size="sm" wrap="anywhere">
                  {item.summary}
                </Text>
                <EvidenceAttachments attachments={item.attachments} />
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Surface>
  );
}

function EscalationOrigin({ request }: Readonly<{ request: SupportRequestDetail }>) {
  return (
    <Stack gap={2}>
      <Text weight="semibold">
        {t("support.features.supportRequests.ui.supportOperationsPage.adjudication.escalation.title")}
      </Text>
      {request.escalated_at ? (
        <Surface tone="muted">
          <Stack gap={1}>
            <Inline gap={2}>
              <Badge tone="warning">
                {t("support.features.supportRequests.ui.supportOperationsPage.adjudication.escalation.origin", {
                  role: request.escalated_by_role ?? "support",
                })}
              </Badge>
              <Text element="span" size="xs" tone="secondary">
                {formatSupportDateTime(request.escalated_at)}
              </Text>
            </Inline>
            {request.escalation_reason ? (
              <Text size="sm" wrap="anywhere">
                {request.escalation_reason}
              </Text>
            ) : null}
          </Stack>
        </Surface>
      ) : (
        <Text size="sm" tone="secondary">
          {t("support.features.supportRequests.ui.supportOperationsPage.adjudication.escalation.none")}
        </Text>
      )}
    </Stack>
  );
}

function OfferHistory({ request }: Readonly<{ request: SupportRequestDetail }>) {
  return (
    <Stack gap={2}>
      <Text weight="semibold">
        {t("support.features.supportRequests.ui.supportOperationsPage.adjudication.offers.title")}
      </Text>
      <DataTable
        density="compact"
        rows={[...request.offers]}
        getRowId={(offer) => offer.offerId}
        emptyTitle={t("support.features.supportRequests.ui.supportOperationsPage.adjudication.offers.none")}
        emptyDescription={t("support.features.supportRequests.ui.supportOperationsPage.adjudication.offers.none")}
        columns={[
          {
            key: "offer",
            header: t("support.features.supportRequests.ui.supportOperationsPage.offer"),
            cell: (offer) => (
              <Stack gap={1}>
                <Text weight="semibold">{offer.resolutionType}</Text>
                <Text size="xs" tone="secondary">
                  {t("support.features.supportRequests.ui.supportOperationsPage.adjudication.offers.offeredBy", {
                    role: offer.offeredByRole,
                  })}
                </Text>
                <Text size="xs" tone="secondary" wrap="anywhere">
                  {offer.summary}
                </Text>
              </Stack>
            ),
          },
          {
            key: "amount",
            header: t("support.features.supportRequests.ui.supportOperationsPage.resolve.refundAmount"),
            cell: (offer) =>
              offer.refundAmount ?? t("support.features.supportRequests.ui.supportOperationsPage.not.applicable"),
          },
          {
            key: "status",
            header: t("support.features.supportRequests.ui.supportOperationsPage.status"),
            cell: (offer) => (
              <Stack gap={1}>
                <Badge
                  tone={offer.status === "declined" ? "danger" : offer.status === "pending" ? "warning" : "success"}
                >
                  {offer.status}
                </Badge>
                {offer.status === "declined" ? (
                  <Text size="xs" tone="secondary">
                    {t("support.features.supportRequests.ui.supportOperationsPage.adjudication.offers.declinedBy", {
                      role: offer.decidedByRole ?? "support",
                    })}
                  </Text>
                ) : null}
              </Stack>
            ),
          },
        ]}
      />
    </Stack>
  );
}

/**
 * Read-only adjudication comparison: both parties' positions side by side, the
 * escalation origin, and the offer history including declines. The binding
 * decision itself is issued through the drawer's decision panel, which draws
 * its prefilled, capped refund from {@link adjudicationRefundPrefill}.
 */
export function CaseAdjudicationPanel({ request }: Readonly<{ request: SupportRequestDetail }>) {
  const hasAnyActivity =
    request.responses.length > 0 || request.evidence.length > 0 || request.offers.length > 0 || request.escalated_at;

  return (
    <Stack gap={4} data-support-adjudication-panel="true">
      <Stack gap={1}>
        <Text weight="semibold">
          {t("support.features.supportRequests.ui.supportOperationsPage.adjudication.title")}
        </Text>
        <Text size="sm" tone="secondary">
          {t("support.features.supportRequests.ui.supportOperationsPage.adjudication.description")}
        </Text>
      </Stack>
      {hasAnyActivity ? (
        <>
          <Grid columns={{ base: 1, md: 2 }} gap={3}>
            <PartyPosition
              request={request}
              role="buyer"
              heading={t("support.features.supportRequests.ui.supportOperationsPage.adjudication.buyerPosition")}
              emptyLabel={t("support.features.supportRequests.ui.supportOperationsPage.adjudication.noBuyerPosition")}
            />
            <PartyPosition
              request={request}
              role="seller"
              heading={t("support.features.supportRequests.ui.supportOperationsPage.adjudication.sellerPosition")}
              emptyLabel={t("support.features.supportRequests.ui.supportOperationsPage.adjudication.noSellerPosition")}
            />
          </Grid>
          <EscalationOrigin request={request} />
          <OfferHistory request={request} />
        </>
      ) : (
        <EmptyState
          title={t("support.features.supportRequests.ui.supportOperationsPage.adjudication.noBuyerPosition")}
          description={t("support.features.supportRequests.ui.supportOperationsPage.adjudication.description")}
        />
      )}
    </Stack>
  );
}
