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
import { validateOperatorSessionInstant, validateOperatorSessionRevision } from "../../domain/value";
import {
  awaitOperatorExtensionHandoff,
  handOffToOperatorExtension,
  type OperatorExtensionHandoff,
} from "./operator-extension-handoff";
import type { OperatorSessionGrantMetadata, OperatorSessionMetadata } from "./operator-session-admin-types";

// The panel only renders on the TCGplayer provider page, so re-authentication
// returns to that literal same-origin route, never to a value read from the URL.
export const operatorSessionSignInHref = "/catalog/sign-in?returnTo=%2Fcatalog%2Fproviders%2Ftcgplayer";

type MetadataState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; metadata: OperatorSessionMetadata }>;

type Notice =
  | Readonly<{ kind: "failure"; failure: OperatorSessionFailure }>
  | Readonly<{ kind: "paired" }>
  | Readonly<{ kind: "disconnect-incomplete"; failure: OperatorSessionFailure }>
  | Readonly<{ kind: "disconnected"; outcome: OperatorSessionDisconnectOutcome }>;

type Mutation = "pair" | "disconnect";

type PairResult =
  | Readonly<{ kind: "failed"; failure: OperatorSessionFailure }>
  | Readonly<{ kind: "paired" }>
  | Readonly<{ kind: "not-confirmed"; grant: OperatorSessionMintedGrant }>
  | Readonly<{ kind: "obsolete" }>;

// Operator session status, extension pairing and Disconnect for the TCGplayer
// provider detail page. A minted grant is first handed to the operator
// extension once, held unrendered in the pairing operation. A timely `paired`
// drops it unseen; otherwise it lives only in this component's state as the
// once-shown paste fallback. It is never written to loader data, storage, the
// URL or an error, and it is dropped on dismissal, Disconnect, a newer mutation
// or unmount (the route remounts this panel on navigation or actor change).
export function OperatorSessionPanel({
  extensionHandoff = handOffToOperatorExtension,
}: Readonly<{ extensionHandoff?: OperatorExtensionHandoff }>) {
  const [metadataState, setMetadataState] = useState<MetadataState>({ kind: "loading" });
  const [busy, setBusy] = useState<Mutation | null>(null);
  const [grant, setGrant] = useState<OperatorSessionMintedGrant | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Disconnect is enabled only when validated grant metadata or a successful
  // mint shows an active server grant. Provider credentials are never present.
  const [disconnectable, setDisconnectable] = useState(false);
  const pairButton = useRef<HTMLButtonElement>(null);
  // A completion applies only while the panel is mounted and it is still the
  // latest of its kind. Aborting a request would not roll back the server, so
  // obsolete completions are discarded rather than cancelled.
  const live = useRef({ mounted: false, read: 0, mutation: 0, busy: false });

  const refresh = useCallback(async () => {
    const read = ++live.current.read;
    const result = await readOperatorSessionMetadata();
    if (!live.current.mounted || read !== live.current.read) return;
    if (!result.ok) {
      setMetadataState({ kind: "unavailable" });
      return;
    }
    const metadata = result.value;
    setMetadataState({ kind: "ready", metadata });
    setDisconnectable(metadata.grant !== null);
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

  async function mutate<T>(kind: Mutation, run: (isCurrent: () => boolean) => Promise<T>, settle: (result: T) => void) {
    const current = live.current;
    if (current.busy) return;
    current.busy = true;
    const mutation = ++current.mutation;
    current.read++;
    setBusy(kind);
    setGrant(null);
    setNotice(null);
    const result = await run(() => current.mounted && mutation === current.mutation);
    if (!current.mounted) return;
    current.busy = false;
    setBusy(null);
    if (mutation === current.mutation) settle(result);
    void refresh();
  }

  // One send, only after a successful mint and only while this pairing is
  // still current. A late reply after the bounded wait is discarded: nothing
  // retries or mints again, because an unacknowledged handoff may still have
  // been committed.
  const pair = () =>
    mutate(
      "pair",
      async (isCurrent): Promise<PairResult> => {
        const minted = await mintOperatorSessionGrant();
        if (!minted.ok) return { kind: "failed", failure: minted.failure };
        if (!isCurrent()) return { kind: "obsolete" };
        const handoff = await awaitOperatorExtensionHandoff(extensionHandoff, minted.value.grant);
        return handoff === "paired" ? { kind: "paired" } : { kind: "not-confirmed", grant: minted.value };
      },
      (result) => {
        if (result.kind === "obsolete") return;
        if (result.kind === "failed") {
          setNotice({ kind: "failure", failure: result.failure });
          return;
        }
        setDisconnectable(true);
        if (result.kind === "paired") setNotice({ kind: "paired" });
        else setGrant(result.grant);
      },
    );

  const disconnect = () =>
    mutate("disconnect", disconnectOperatorSession, (result) => {
      if (!result.ok) {
        setNotice({
          kind: refusedBeforeDisconnect(result.failure) ? "failure" : "disconnect-incomplete",
          failure: result.failure,
        });
        return;
      }
      setNotice({ kind: "disconnected", outcome: result.value });
      // A stale revision means a newer grant remains and must stay visible.
      if (result.value.outcome !== "stale-revision") setDisconnectable(false);
    });

  function dismissGrant() {
    live.current.mutation++;
    setGrant(null);
    pairButton.current?.focus();
  }

  const metadata = metadataState.kind === "ready" ? metadataState.metadata : null;

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
            {disconnectable ? (
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
  const { revision, grant } = metadata;
  const facts: KeyValueItem[] = [
    { key: t("catalog.features.operatorSession.ui.adminPanel.facts.revision"), value: String(revision) },
  ];

  return (
    <Stack gap={3}>
      <EmptyState
        title={t("catalog.features.operatorSession.ui.adminPanel.unavailable.title")}
        description={t("catalog.features.operatorSession.ui.adminPanel.unavailable.description")}
      />
      <KeyValueList density="compact" variant="surface" items={facts} />
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
      <Text size="sm">{t("catalog.features.operatorSession.ui.adminPanel.pair.handoff.notConfirmed")}</Text>
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
  if (notice.kind === "paired") {
    return <Text role="status">{t("catalog.features.operatorSession.ui.adminPanel.pair.handoff.paired")}</Text>;
  }

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

// Browser client for the three Admin operator-session routes
// (api/route.ts operatorSessionAdminRoutes). Every response is validated
// against the closed api/grants.ts shapes before the panel sees it; failures
// collapse to a bounded code, so response bodies and thrown errors never reach
// the UI.
const adminPath = "/api/catalog/operator-session";

type OperatorSessionMintedGrant = Readonly<{ grant: string; idleExpiresAt: string }>;

type OperatorSessionDisconnectOutcome = Readonly<{
  outcome: "cleared" | "unchanged" | "stale-revision";
  revision: number;
}>;

type OperatorSessionFailure =
  | "step-up-required"
  | "unauthenticated"
  | "forbidden"
  | "rate-limited"
  | "custody-unavailable"
  | "revision-exhausted"
  | "unknown";

type OperatorSessionResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: OperatorSessionFailure }>;

async function readOperatorSessionMetadata(): Promise<OperatorSessionResult<OperatorSessionMetadata>> {
  const response = await send("GET", adminPath);
  if (response?.status !== 200) return failed(response);
  return validated(parseMetadata(response.body));
}

async function mintOperatorSessionGrant(): Promise<OperatorSessionResult<OperatorSessionMintedGrant>> {
  const response = await send("POST", `${adminPath}/grant`);
  if (response?.status !== 200) return failed(response);
  return validated(parseMintedGrant(response.body));
}

async function disconnectOperatorSession(): Promise<OperatorSessionResult<OperatorSessionDisconnectOutcome>> {
  const response = await send("DELETE", adminPath);
  if (response?.status === 200) return validated(parseDisconnectOutcome(response.body, ["cleared", "unchanged"]));
  if (response?.status === 409) return validated(parseDisconnectOutcome(response.body, ["stale-revision"]));
  return failed(response);
}

type RawResponse = Readonly<{ status: number; body: unknown }>;

async function send(method: "GET" | "POST" | "DELETE", path: string): Promise<RawResponse | null> {
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const body: unknown = await response.json().catch(() => undefined);
    return { status: response.status, body };
  } catch {
    return null;
  }
}

// Step-up is the flat 400 {code:"step_up_required"} the slice middleware
// returns (api/route.ts). The payout-style nested {error:{code}} envelope is a
// different contract and is deliberately not recognised here. Every 403 shape
// (host authorization_forbidden or the slice's flat forbidden) is forbidden.
function failed(response: RawResponse | null): Readonly<{ ok: false; failure: OperatorSessionFailure }> {
  return { ok: false, failure: classifyFailure(response) };
}

function classifyFailure(response: RawResponse | null): OperatorSessionFailure {
  if (!response) return "unknown";
  const code = isRecord(response.body) ? response.body.code : undefined;
  if (response.status === 400 && code === "step_up_required") return "step-up-required";
  if (response.status === 401) return "unauthenticated";
  if (response.status === 403) return "forbidden";
  if (response.status === 429) return "rate-limited";
  if (response.status === 503 && code === "custody-unavailable") return "custody-unavailable";
  if (response.status === 503 && code === "revision-exhausted") return "revision-exhausted";
  return "unknown";
}

function validated<T>(value: T | null): OperatorSessionResult<T> {
  return value === null ? { ok: false, failure: "unknown" } : { ok: true, value };
}

function parseMetadata(body: unknown): OperatorSessionMetadata | null {
  if (!hasExactKeys(body, ["revision", "storedAt", "browserExpiresAt", "custodyAvailable", "grant"])) return null;
  const { revision, storedAt, browserExpiresAt, custodyAvailable, grant } = body;
  if (!isRevision(revision) || typeof custodyAvailable !== "boolean") return null;
  if (!isNullableInstant(storedAt) || !isNullableInstant(browserExpiresAt)) return null;
  const parsedGrant = grant === null ? null : parseGrantMetadata(grant);
  if (grant !== null && parsedGrant === null) return null;
  return { revision, storedAt, browserExpiresAt, custodyAvailable, grant: parsedGrant };
}

function parseGrantMetadata(body: unknown): OperatorSessionGrantMetadata | null {
  if (!hasExactKeys(body, ["active", "createdAt", "idleExpiresAt", "lastUsedAt"])) return null;
  const { active, createdAt, idleExpiresAt, lastUsedAt } = body;
  if (typeof active !== "boolean" || !isInstant(createdAt) || !isInstant(idleExpiresAt) || !isInstant(lastUsedAt))
    return null;
  return { active, createdAt, idleExpiresAt, lastUsedAt };
}

// grants.ts mints randomBytes(32) as base64url: exactly 43 URL-safe characters.
function parseMintedGrant(body: unknown): OperatorSessionMintedGrant | null {
  if (!hasExactKeys(body, ["grant", "idleExpiresAt"])) return null;
  const { grant, idleExpiresAt } = body;
  if (typeof grant !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grant) || !isInstant(idleExpiresAt)) return null;
  return { grant, idleExpiresAt };
}

function parseDisconnectOutcome(
  body: unknown,
  outcomes: readonly OperatorSessionDisconnectOutcome["outcome"][],
): OperatorSessionDisconnectOutcome | null {
  if (!hasExactKeys(body, ["outcome", "revision"])) return null;
  const { outcome, revision } = body;
  if (!outcomes.includes(outcome as OperatorSessionDisconnectOutcome["outcome"]) || !isRevision(revision)) return null;
  return { outcome: outcome as OperatorSessionDisconnectOutcome["outcome"], revision };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && passes(() => validateOperatorSessionRevision(value));
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && passes(() => validateOperatorSessionInstant(value));
}

function isNullableInstant(value: unknown): value is string | null {
  return value === null || isInstant(value);
}

function passes(validate: () => void): boolean {
  try {
    validate();
    return true;
  } catch {
    return false;
  }
}
