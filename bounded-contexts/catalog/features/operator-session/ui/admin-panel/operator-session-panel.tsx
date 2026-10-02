import {
  AlertDialog,
  Badge,
  Button,
  CopyButton,
  EmptyState,
  Inline,
  KeyValueList,
  LinkButton,
  Stack,
  Subheading,
  Text,
  WorkflowModule,
  type KeyValueItem,
} from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  disconnectOperatorSession,
  mintOperatorSessionGrant,
  readOperatorSessionMetadata,
  type OperatorSessionDisconnectOutcome,
  type OperatorSessionFailure,
  type OperatorSessionMetadata,
  type OperatorSessionMintedGrant,
} from "./operator-session-http";

// The panel only renders on the TCGplayer provider page, so re-authentication
// returns to that literal same-origin route, never to a value read from the URL.
export const operatorSessionSignInHref = "/catalog/sign-in?returnTo=%2Fcatalog%2Fproviders%2Ftcgplayer";

type MetadataState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; metadata: OperatorSessionMetadata }>;

type Notice =
  | Readonly<{ kind: "failure"; failure: OperatorSessionFailure }>
  | Readonly<{ kind: "disconnect-incomplete"; failure: OperatorSessionFailure }>
  | Readonly<{ kind: "disconnected"; outcome: OperatorSessionDisconnectOutcome }>;

type Mutation = "pair" | "disconnect";

// Operator session status, extension pairing and Disconnect for the TCGplayer
// provider detail page. The minted grant lives only in this component's state:
// it is never written to loader data, storage, the URL or an error, and it is
// dropped on dismissal, Disconnect, a newer mutation or unmount (the route
// remounts this panel on navigation or actor change).
export function OperatorSessionPanel() {
  const [metadataState, setMetadataState] = useState<MetadataState>({ kind: "loading" });
  const [busy, setBusy] = useState<Mutation | null>(null);
  const [grant, setGrant] = useState<OperatorSessionMintedGrant | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const pairButton = useRef<HTMLButtonElement>(null);
  // A completion applies only while the panel is mounted and it is still the
  // latest of its kind. Aborting a request would not roll back the server, so
  // obsolete completions are discarded rather than cancelled.
  const live = useRef({ mounted: false, read: 0, mutation: 0, busy: false });

  const refresh = useCallback(async () => {
    const read = ++live.current.read;
    const result = await readOperatorSessionMetadata();
    if (!live.current.mounted || read !== live.current.read) return;
    setMetadataState(result.ok ? { kind: "ready", metadata: result.value } : { kind: "unavailable" });
  }, []);

  useEffect(() => {
    const current = live.current;
    current.mounted = true;
    void refresh();
    return () => {
      current.mounted = false;
      current.read++;
      current.mutation++;
    };
  }, [refresh]);

  async function mutate<T>(kind: Mutation, run: () => Promise<T>, settle: (result: T) => void) {
    const current = live.current;
    if (current.busy) return;
    current.busy = true;
    const mutation = ++current.mutation;
    current.read++;
    setBusy(kind);
    setGrant(null);
    setNotice(null);
    const result = await run();
    if (!current.mounted) return;
    current.busy = false;
    setBusy(null);
    if (mutation === current.mutation) settle(result);
    void refresh();
  }

  const pair = () =>
    mutate("pair", mintOperatorSessionGrant, (result) => {
      if (result.ok) setGrant(result.value);
      else setNotice({ kind: "failure", failure: result.failure });
    });

  const disconnect = () =>
    mutate("disconnect", disconnectOperatorSession, (result) =>
      setNotice(
        result.ok
          ? { kind: "disconnected", outcome: result.value }
          : {
              kind: refusedBeforeDisconnect(result.failure) ? "failure" : "disconnect-incomplete",
              failure: result.failure,
            },
      ),
    );

  function dismissGrant() {
    live.current.mutation++;
    setGrant(null);
    pairButton.current?.focus();
  }

  const metadata = metadataState.kind === "ready" ? metadataState.metadata : null;
  // Break-glass: Disconnect stays available whenever custody or a grant remains,
  // even when the current key cannot read the stored session.
  const canDisconnect = metadata !== null && (metadata.storedAt !== null || metadata.grant !== null);

  return (
    <WorkflowModule
      title={t("catalog.features.operatorSession.ui.adminPanel.title")}
      description={t("catalog.features.operatorSession.ui.adminPanel.description")}
      density="compact"
      data-catalog-operator-session-panel="true"
    >
      {metadataState.kind === "loading" ? (
        <Text role="status">{t("catalog.features.operatorSession.ui.adminPanel.loading")}</Text>
      ) : null}
      {metadataState.kind === "unavailable" ? (
        <EmptyState
          title={t("catalog.features.operatorSession.ui.adminPanel.unavailable.title")}
          description={t("catalog.features.operatorSession.ui.adminPanel.unavailable.description")}
        />
      ) : null}
      {metadata ? <OperatorSessionStatus metadata={metadata} /> : null}
      {metadataState.kind === "loading" ? null : (
        <Stack gap={2}>
          <Text size="sm" tone="secondary">
            {t("catalog.features.operatorSession.ui.adminPanel.pair.description")}
          </Text>
          <Inline gap={2}>
            <Button
              ref={pairButton}
              loading={busy === "pair"}
              disabled={busy !== null}
              aria-label={
                busy === "pair"
                  ? t("catalog.features.operatorSession.ui.adminPanel.pair.submitting.accessible")
                  : undefined
              }
              onClick={() => void pair()}
            >
              {t("catalog.features.operatorSession.ui.adminPanel.pair.submit")}
            </Button>
            {canDisconnect ? (
              <AlertDialog
                title={t("catalog.features.operatorSession.ui.adminPanel.disconnect.dialog.title")}
                description={t("catalog.features.operatorSession.ui.adminPanel.disconnect.dialog.description")}
                confirmLabel={t("catalog.features.operatorSession.ui.adminPanel.disconnect.dialog.confirm")}
                tone="danger"
                onConfirm={() => void disconnect()}
                trigger={
                  <Button
                    tone="danger"
                    loading={busy === "disconnect"}
                    disabled={busy !== null}
                    aria-label={
                      busy === "disconnect"
                        ? t("catalog.features.operatorSession.ui.adminPanel.disconnect.submitting.accessible")
                        : undefined
                    }
                  >
                    {t("catalog.features.operatorSession.ui.adminPanel.disconnect.submit")}
                  </Button>
                }
              />
            ) : null}
          </Inline>
        </Stack>
      )}
      <Text role="status" size="sm" tone="secondary">
        {liveAnnouncement(busy, grant !== null)}
      </Text>
      {grant ? <MintedGrant grant={grant} onDismiss={dismissGrant} /> : null}
      {notice ? <OperatorSessionNotice notice={notice} /> : null}
    </WorkflowModule>
  );
}

// Step-up, sign-in, permission and rate-limit refusals happen before the
// Disconnect handler runs. Any other failure may follow a committed grant
// revocation, so it never claims completion or fallback.
function refusedBeforeDisconnect(failure: OperatorSessionFailure): boolean {
  return (
    failure === "step-up-required" ||
    failure === "unauthenticated" ||
    failure === "forbidden" ||
    failure === "rate-limited"
  );
}

function liveAnnouncement(busy: Mutation | null, grantShown: boolean): string | null {
  if (busy === "pair") return t("catalog.features.operatorSession.ui.adminPanel.pair.submitting");
  if (busy === "disconnect") return t("catalog.features.operatorSession.ui.adminPanel.disconnect.submitting");
  if (grantShown) return t("catalog.features.operatorSession.ui.adminPanel.pair.grant.announcement");
  return null;
}

function OperatorSessionStatus({ metadata }: Readonly<{ metadata: OperatorSessionMetadata }>) {
  const { revision, storedAt, browserExpiresAt, custodyAvailable, grant } = metadata;
  const facts: KeyValueItem[] = [
    { key: t("catalog.features.operatorSession.ui.adminPanel.facts.revision"), value: String(revision) },
  ];
  if (storedAt !== null) {
    facts.push(
      { key: t("catalog.features.operatorSession.ui.adminPanel.facts.storedAt"), value: formatDateTime(storedAt) },
      {
        key: t("catalog.features.operatorSession.ui.adminPanel.facts.browserExpiresAt"),
        value:
          browserExpiresAt === null
            ? t("catalog.features.operatorSession.ui.adminPanel.facts.browserExpiresAt.none")
            : formatDateTime(browserExpiresAt),
      },
    );
  }
  facts.push({
    key: t("catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable"),
    value: custodyAvailable
      ? t("catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.yes")
      : t("catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.no"),
  });

  return (
    <Stack gap={3}>
      {storedAt === null && revision === 0 ? (
        <EmptyState
          title={t("catalog.features.operatorSession.ui.adminPanel.absent.title")}
          description={t("catalog.features.operatorSession.ui.adminPanel.absent.description")}
        />
      ) : null}
      {storedAt === null && revision > 0 ? (
        <EmptyState
          title={t("catalog.features.operatorSession.ui.adminPanel.cleared.title")}
          description={t("catalog.features.operatorSession.ui.adminPanel.cleared.description", { revision })}
        />
      ) : null}
      <KeyValueList density="compact" variant="surface" items={facts} />
      <Text size="sm" tone="secondary">
        {t("catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.hint")}
      </Text>
      {storedAt !== null && !custodyAvailable ? (
        <Text size="sm" tone="danger">
          {t("catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.unreadable")}
        </Text>
      ) : null}
      <GrantFacts grant={grant} />
    </Stack>
  );
}

function GrantFacts({ grant }: Readonly<{ grant: OperatorSessionMetadata["grant"] }>) {
  const state = grant === null ? "none" : grant.active ? "active" : "inactive";
  const items: KeyValueItem[] = [
    {
      key: t("catalog.features.operatorSession.ui.adminPanel.grant.heading"),
      value: (
        <Badge tone={state === "active" ? "success" : state === "inactive" ? "warning" : "neutral"}>
          {state === "active"
            ? t("catalog.features.operatorSession.ui.adminPanel.grant.state.active")
            : state === "inactive"
              ? t("catalog.features.operatorSession.ui.adminPanel.grant.state.inactive")
              : t("catalog.features.operatorSession.ui.adminPanel.grant.state.none")}
        </Badge>
      ),
    },
  ];
  if (grant) {
    items.push(
      {
        key: t("catalog.features.operatorSession.ui.adminPanel.grant.createdAt"),
        value: formatDateTime(grant.createdAt),
      },
      {
        key: t("catalog.features.operatorSession.ui.adminPanel.grant.lastUsedAt"),
        value: formatDateTime(grant.lastUsedAt),
      },
      {
        key: t("catalog.features.operatorSession.ui.adminPanel.grant.idleExpiresAt"),
        value: formatDateTime(grant.idleExpiresAt),
      },
    );
  }

  return (
    <Stack gap={2}>
      <KeyValueList density="compact" variant="surface" items={items} />
      {state === "inactive" ? (
        <Text size="sm" tone="secondary">
          {t("catalog.features.operatorSession.ui.adminPanel.grant.state.inactive.hint")}
        </Text>
      ) : null}
    </Stack>
  );
}

function MintedGrant({ grant, onDismiss }: Readonly<{ grant: OperatorSessionMintedGrant; onDismiss: () => void }>) {
  return (
    <Stack gap={2} data-operator-session-grant="true">
      <Subheading level={4}>{t("catalog.features.operatorSession.ui.adminPanel.pair.grant.heading")}</Subheading>
      <Text size="sm">{t("catalog.features.operatorSession.ui.adminPanel.pair.grant.once")}</Text>
      <Text size="sm">{t("catalog.features.operatorSession.ui.adminPanel.pair.grant.paste")}</Text>
      <Text weight="semibold" wrap="anywhere">
        {grant.grant}
      </Text>
      <Text size="sm" tone="secondary">
        {t("catalog.features.operatorSession.ui.adminPanel.pair.grant.idleExpiresAt", {
          instant: formatDateTime(grant.idleExpiresAt),
        })}
      </Text>
      <Inline gap={2}>
        <CopyButton value={grant.grant} />
        <Button tone="secondary" onClick={onDismiss}>
          {t("catalog.features.operatorSession.ui.adminPanel.pair.grant.dismiss")}
        </Button>
      </Inline>
    </Stack>
  );
}

function OperatorSessionNotice({ notice }: Readonly<{ notice: Notice }>) {
  if (notice.kind === "disconnected") {
    const { outcome, revision } = notice.outcome;
    if (outcome === "stale-revision") {
      return (
        <Text role="alert" tone="danger">
          {t("catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.conflict", { revision })}
        </Text>
      );
    }
    return (
      <Text role="status">
        {outcome === "cleared"
          ? t("catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.cleared", { revision })
          : t("catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.unchanged", { revision })}
      </Text>
    );
  }

  if (notice.kind === "disconnect-incomplete") {
    return (
      <Stack gap={2}>
        <Text role="alert" tone="danger">
          {t("catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.partialFailure")}
        </Text>
        {notice.failure === "revision-exhausted" ? (
          <Text tone="danger">{t("catalog.features.operatorSession.ui.adminPanel.error.revisionExhausted")}</Text>
        ) : null}
      </Stack>
    );
  }

  const failure = notice.failure;
  const signIn = failure === "step-up-required" || failure === "unauthenticated";
  return (
    <Stack gap={2}>
      <Text role="alert" tone="danger">
        {failureMessage(failure)}
      </Text>
      {signIn ? (
        <Inline gap={2}>
          <LinkButton href={operatorSessionSignInHref}>
            {t("catalog.features.operatorSession.ui.adminPanel.stepUp.signIn")}
          </LinkButton>
        </Inline>
      ) : null}
    </Stack>
  );
}

function failureMessage(failure: OperatorSessionFailure): string {
  switch (failure) {
    case "step-up-required":
      return t("catalog.features.operatorSession.ui.adminPanel.stepUp.message");
    case "unauthenticated":
      return t("catalog.features.operatorSession.ui.adminPanel.error.unauthenticated");
    case "forbidden":
      return t("catalog.features.operatorSession.ui.adminPanel.error.forbidden");
    case "rate-limited":
      return t("catalog.features.operatorSession.ui.adminPanel.error.rateLimited");
    case "custody-unavailable":
      return t("catalog.features.operatorSession.ui.adminPanel.error.custodyUnavailable");
    case "revision-exhausted":
      return t("catalog.features.operatorSession.ui.adminPanel.error.revisionExhausted");
    case "unknown":
      return t("catalog.features.operatorSession.ui.adminPanel.error.unknown");
  }
}
