import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useNavigation, useRevalidator, useRouteError, useSubmit } from "react-router";
import {
  Button,
  HiddenInput,
  LinkButton,
  MarketplaceNotice,
  Stack,
  Text,
  VisuallyHidden,
} from "@chase-sets/design-system";
import { RouterForm as Form } from "@chase-sets/design-system/react-router";
import { createMarketplaceApiClient } from "../../../client";
import { t } from "@chase-sets/localization";
import {
  LISTING_RECOVERY_PARAM,
  listingRecoveryForForm,
  listingRecoveryFormKey,
  listingRecoveryUrl,
  sameListingRecovery,
  type ListingRecovery,
} from "./listing-batch";

type RecoveryContext = {
  recovery: ListingRecovery | null;
  busy: boolean;
  submit: (form: FormData, unchanged: () => boolean) => Promise<void>;
};
const ListingRecoveryContext = createContext<RecoveryContext | null>(null);
export const useListingRecovery = () => useContext(ListingRecoveryContext);

export function ListingRecoveryScope({
  recovery,
  listingId = null,
  accountId,
  children,
}: {
  recovery: ListingRecovery | null;
  listingId?: string | null;
  accountId: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const submit = useSubmit();
  const location = useLocation();
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const navigation = useNavigation();
  const pending = useRef(false);
  const staged = useRef<{ destination: string; form: FormData; unchanged: () => boolean } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [failure, setFailure] = useState<ListingRecovery | null>(null);
  useEffect(() => {
    generation.current++;
    setFailure(null);
  }, [location.key]);
  useEffect(() => {
    const prepared = staged.current;
    if (!prepared) return;
    staged.current = null;
    if (
      `${location.pathname}${location.search}` !== prepared.destination ||
      !prepared.unchanged() ||
      !recovery?.identity ||
      recovery.phase !== "confirming"
    ) {
      pending.current = false;
      setPreparing(false);
      return;
    }
    void submit(prepared.form, { method: "post", action: prepared.destination })
      .catch(() =>
        setFailure({ identity: recovery?.identity ?? null, items: recovery?.items ?? [], phase: "ambiguous" }),
      )
      .finally(() => {
        pending.current = false;
        setPreparing(false);
      });
  }, [location.key, recovery, submit]);
  const busy = preparing || navigation.state !== "idle";
  const current = failure ?? recovery;
  const visible = busy
    ? {
        identity: current?.identity ?? null,
        items: current?.items ?? [],
        phase: navigation.state === "submitting" ? ("confirming" as const) : ("loading" as const),
      }
    : current;
  return (
    <ListingRecoveryContext.Provider
      value={{
        recovery: visible,
        busy,
        submit: async (form, unchanged) => {
          if (pending.current) return;
          const revision = generation.current;
          pending.current = true;
          setPreparing(true);
          let handedOff = false;
          try {
            if (current?.phase === "ambiguous") return;
            if (current?.identity) {
              if (current.items.some((item) => item.outcome !== "unknown")) return;
              const key = listingRecoveryFormKey(current.identity, String(form.get("intent")));
              if (!key) return;
              form.set("idempotencyKey", key);
            }
            const identity = await listingRecoveryForForm(form, listingId, accountId);
            if (!identity) {
              await submit(form, { method: "post" });
              return;
            }
            if (current?.identity && !sameListingRecovery(current.identity, identity))
              throw new Error("Changed request");
            if (!mounted.current || !unchanged() || revision !== generation.current) return;
            await createMarketplaceApiClient().prepareListingBatch(identity);
            if (!mounted.current || !unchanged() || revision !== generation.current) return;
            const destination = listingRecoveryUrl(`${location.pathname}${location.search}`, identity);
            // Commit the reference before the command can leave the browser. No request bytes enter history state.
            staged.current = { destination, form, unchanged };
            handedOff = true;
            await navigate(destination, { replace: true });
          } catch {
            handedOff = false;
            staged.current = null;
            setFailure({ identity: current?.identity ?? null, items: current?.items ?? [], phase: "failed-safe" });
          } finally {
            if (!handedOff) {
              pending.current = false;
              setPreparing(false);
            }
          }
        },
      }}
    >
      {children}
    </ListingRecoveryContext.Provider>
  );
}

export function ListingRecoveryNotice() {
  const context = useListingRecovery();
  return context ? <ListingRecoveryNoticeContent context={context} /> : null;
}

export function ListingRecoveryErrorBoundary({ fallback }: { fallback?: ReactNode }) {
  const location = useLocation();
  const error = useRouteError();
  if (!new URLSearchParams(location.search).has(LISTING_RECOVERY_PARAM)) {
    if (fallback) return fallback;
    throw error;
  }
  return <InterruptedListingRead />;
}

function InterruptedListingRead() {
  const revalidator = useRevalidator();
  const location = useLocation();
  const attempted = useRef(false);
  const feedback = useRef<HTMLParagraphElement>(null);
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    // A lost route POST is not an API response. Recover via the real loader, never by repeating its action.
    void revalidator.revalidate().finally(() => setWaiting(false));
  }, [revalidator]);
  useEffect(() => {
    if (!waiting) feedback.current?.focus();
  }, [waiting]);
  const title = t(waiting ? "marketplace.listingRecovery.confirming" : "marketplace.listingRecovery.ambiguous");
  return (
    <Stack>
      <Text ref={feedback} tabIndex={-1} role={waiting ? "status" : "alert"}>
        <VisuallyHidden aria-live={waiting ? "polite" : "assertive"}>{title}</VisuallyHidden>
      </Text>
      <MarketplaceNotice
        tone={waiting ? "info" : "warning"}
        title={title}
        action={
          !waiting ? (
            <LinkButton href={`${location.pathname}${location.search}`}>
              {t("marketplace.listingRecovery.checkAgain")}
            </LinkButton>
          ) : undefined
        }
      />
    </Stack>
  );
}

function ListingRecoveryNoticeContent({ context }: { context: RecoveryContext }) {
  const location = useLocation();
  const feedback = useRef<HTMLParagraphElement>(null);
  const recovery = context.recovery;
  const ambiguous = recovery?.phase === "ambiguous";
  useEffect(() => {
    if (ambiguous) feedback.current?.focus();
  }, [ambiguous, recovery]);
  if (!recovery) return null;
  const title = t(`marketplace.listingRecovery.${recovery.phase === "failed-safe" ? "failedSafe" : recovery.phase}`, {
    succeeded: recovery.items.filter((item) => item.outcome === "succeeded").length,
    total: recovery.items.length,
  });
  const clear = new URLSearchParams(location.search);
  clear.delete(LISTING_RECOVERY_PARAM);
  const canRetry =
    !context.busy && !ambiguous && recovery.identity?.bulk && recovery.items.some((item) => item.outcome === "unknown");
  return (
    <Stack gap={2}>
      <Text ref={feedback} tabIndex={-1} role={ambiguous ? "alert" : "status"}>
        <VisuallyHidden aria-live={ambiguous ? "assertive" : "polite"}>{title}</VisuallyHidden>
      </Text>
      <MarketplaceNotice
        tone={
          ambiguous || recovery.phase === "conflict" || recovery.phase === "failed-safe"
            ? "warning"
            : recovery.phase === "succeeded"
              ? "success"
              : "info"
        }
        title={title}
        description={
          <Stack gap={1}>
            {recovery.items.map((item) => (
              <Text key={item.targetId}>
                {t("marketplace.listingRecovery.target", {
                  target: item.targetId,
                  outcome: t(`marketplace.listingRecovery.outcome.${item.outcome}`),
                })}
              </Text>
            ))}
            {recovery.phase === "confirming" && !context.busy && !recovery.identity?.bulk ? (
              <Text>{t("marketplace.listingRecovery.reenter")}</Text>
            ) : null}
          </Stack>
        }
        action={
          <Stack direction="row" gap={2}>
            {canRetry ? (
              <Form method="post">
                <HiddenInput name="intent" value="retry-listing-batch" />
                <Button type="submit">{t("marketplace.listingRecovery.retryUnknown")}</Button>
              </Form>
            ) : null}
            {!ambiguous && !context.busy ? (
              <LinkButton href={`${location.pathname}${clear.size ? `?${clear}` : ""}`} tone="secondary">
                {t("marketplace.listingRecovery.continue")}
              </LinkButton>
            ) : null}
            {ambiguous ? (
              <LinkButton href={`${location.pathname}${location.search}`} tone="secondary">
                {t("marketplace.listingRecovery.checkAgain")}
              </LinkButton>
            ) : null}
          </Stack>
        }
      />
    </Stack>
  );
}
