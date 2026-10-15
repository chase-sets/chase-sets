import { t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import {
  Banner,
  Button,
  CommerceSheet,
  Inline,
  LinkButton,
  RadioGroup,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { SavedListPickerPreparation, SavedListRouteActionData } from "./contracts";

const NEW_LIST_VALUE = "__new_saved_list__";

export function AddToSavedListControl({
  productKey,
  productLabel,
  prepareFields,
  initialPreparation = null,
  initialError = null,
  tone = "ghost",
  size = "sm",
}: Readonly<{
  productKey: string;
  productLabel: string;
  prepareFields: Readonly<Record<string, string>>;
  initialPreparation?: SavedListPickerPreparation | null;
  initialError?: string | null;
  tone?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
}>) {
  const [open, setOpen] = useState(Boolean(initialPreparation || initialError));
  const [preparation, setPreparation] = useState(initialPreparation);
  const [destinationValue, setDestinationValue] = useState(NEW_LIST_VALUE);
  const [newListTitle, setNewListTitle] = useState("");
  const [trackedQuantity, setTrackedQuantity] = useState(1);
  const fetcher = useFetcher<SavedListRouteActionData | { error?: unknown }>();
  const busy = fetcher.state !== "idle";
  const [error, setError] = useState(initialError);
  const [saved, setSaved] = useState<Extract<SavedListRouteActionData, { status: "saved" }> | null>(null);
  const requestIdRef = useRef(0);
  const pendingRequestRef = useRef<{ id: number; productKey: string } | null>(null);
  const previousProductKeyRef = useRef(productKey);
  const productKeyRef = useRef(productKey);
  productKeyRef.current = productKey;

  useEffect(() => {
    if (previousProductKeyRef.current === productKey) return;
    previousProductKeyRef.current = productKey;
    requestIdRef.current += 1;
    setPreparation(null);
    setSaved(null);
    setError(null);
    setOpen(false);
  }, [productKey]);

  useEffect(() => {
    const request = pendingRequestRef.current;
    if (fetcher.state !== "idle" || !request) return;
    pendingRequestRef.current = null;
    if (request.id !== requestIdRef.current || request.productKey !== productKeyRef.current) return;

    const data = fetcher.data;
    if (typeof data === "object" && data !== null && "status" in data) {
      if (data.status === "registration-required" || data.status === "options-required") {
        window.location.assign(data.href);
        return;
      }
      if (data.status === "ready") {
        setPreparation(data.preparation);
        setSaved(null);
        setOpen(true);
        return;
      }
      if (data.status === "saved") {
        setSaved(data);
        return;
      }
    }
    setError(
      typeof data === "object" &&
        data !== null &&
        "error" in data &&
        typeof data.error === "string" &&
        data.error.trim()
        ? data.error
        : t("collections.features.savedLists.ui.addToList.error.description"),
    );
    setOpen(true);
  }, [fetcher.data, fetcher.state]);

  useEffect(() => {
    if (!preparation) return;
    const resume = preparation.resumeDestination;
    setDestinationValue(
      resume?.kind === "existing"
        ? resume.listId
        : resume?.kind === "new"
          ? NEW_LIST_VALUE
          : (preparation.recentLists[0]?.listId ?? NEW_LIST_VALUE),
    );
    setNewListTitle(resume?.kind === "new" ? resume.title : "");
    setTrackedQuantity(preparation.resumeTrackedQuantity ?? 1);
  }, [preparation]);

  useEffect(() => {
    if ((!initialPreparation && !initialError) || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.has("claimSavedListIntent")) {
      url.searchParams.delete("claimSavedListIntent");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, [initialError, initialPreparation]);

  const prepare = () => {
    pendingRequestRef.current = { id: ++requestIdRef.current, productKey: productKeyRef.current };
    setError(null);
    const formData = new FormData();
    formData.set("intent", "prepare-saved-list");
    for (const [key, value] of Object.entries(prepareFields)) formData.set(key, value);
    void fetcher.submit(formData, { method: "post", defaultShouldRevalidate: false });
  };

  const submit = () => {
    if (!preparation) return;
    pendingRequestRef.current = { id: ++requestIdRef.current, productKey: productKeyRef.current };
    setError(null);
    const formData = new FormData();
    formData.set("intent", "commit-saved-list");
    formData.set("preparation", JSON.stringify(preparation));
    formData.set("trackedQuantity", String(trackedQuantity));
    formData.set("destinationKind", destinationValue === NEW_LIST_VALUE ? "new" : "existing");
    if (destinationValue === NEW_LIST_VALUE) formData.set("newListTitle", newListTitle);
    else formData.set("listId", destinationValue);
    void fetcher.submit(formData, { method: "post", defaultShouldRevalidate: false });
  };

  const listItems: Array<{ value: string; label: string; description: string }> =
    preparation?.recentLists.map((list) => ({
      value: list.listId,
      label: list.title,
      description: t("collections.features.savedLists.ui.addToList.list.summary", {
        lines: list.lineCount,
        quantity: list.trackedUnitCount,
      }),
    })) ?? [];
  listItems.push({
    value: NEW_LIST_VALUE,
    label: t("collections.features.savedLists.ui.addToList.create.new"),
    description: t("collections.features.savedLists.ui.addToList.create.new.description"),
  });
  const canSubmit =
    Boolean(preparation) &&
    Number.isInteger(trackedQuantity) &&
    trackedQuantity > 0 &&
    (destinationValue !== NEW_LIST_VALUE || Boolean(newListTitle.trim()));

  return (
    <>
      <Button
        type="button"
        tone={tone}
        size={size}
        loading={busy && !open}
        aria-label={t("collections.features.savedLists.ui.addToList.accessible", { product: productLabel })}
        onClick={() => void prepare()}
      >
        {t("collections.features.savedLists.ui.addToList.button")}
      </Button>
      <CommerceSheet
        open={open}
        onOpenChange={setOpen}
        title={
          saved
            ? t("collections.features.savedLists.ui.addToList.success.title", { list: saved.result.title })
            : t("collections.features.savedLists.ui.addToList.sheet.title")
        }
        description={saved ? undefined : t("collections.features.savedLists.ui.addToList.sheet.description")}
        footer={
          saved ? (
            <Inline gap={2} align="end">
              <Button type="button" tone="ghost" onClick={() => setOpen(false)}>
                {t("collections.features.savedLists.ui.addToList.cancel")}
              </Button>
              <LinkButton href={`/account/collection?section=lists&list=${encodeURIComponent(saved.result.listId)}`}>
                {t("collections.features.savedLists.ui.addToList.view.collection")}
              </LinkButton>
            </Inline>
          ) : (
            <Inline gap={2} align="end">
              <Button type="button" tone="ghost" onClick={() => setOpen(false)}>
                {t("collections.features.savedLists.ui.addToList.cancel")}
              </Button>
              <Button type="button" loading={busy} disabled={!canSubmit || busy} onClick={() => void submit()}>
                {t("collections.features.savedLists.ui.addToList.submit")}
              </Button>
            </Inline>
          )
        }
      >
        <Stack gap={4}>
          {error ? (
            <Banner
              tone="danger"
              title={
                preparation
                  ? t("collections.features.savedLists.ui.addToList.error.title")
                  : t("collections.features.savedLists.ui.addToList.claim.error.title")
              }
              description={error}
            />
          ) : null}
          {saved ? (
            <Banner
              tone="success"
              title={t("collections.features.savedLists.ui.addToList.success.title", {
                list: saved.result.title,
              })}
              description={t(
                saved.result.lineStatus === "merged"
                  ? "collections.features.savedLists.ui.addToList.success.merged"
                  : "collections.features.savedLists.ui.addToList.success.added",
                { quantity: saved.trackedQuantity },
              )}
            />
          ) : preparation ? (
            <>
              <Text weight="semibold">{preparation.productLabel}</Text>
              {preparation.recentLists.length === 0 ? (
                <Text tone="secondary">{t("collections.features.savedLists.ui.addToList.no.lists")}</Text>
              ) : null}
              <RadioGroup
                label={t("collections.features.savedLists.ui.addToList.destination.label")}
                items={listItems}
                value={destinationValue}
                readOnly={Boolean(preparation.resumeDestination)}
                onValueChange={setDestinationValue}
              />
              {destinationValue === NEW_LIST_VALUE ? (
                <TextInput
                  label={t("collections.features.savedLists.ui.addToList.title.label")}
                  placeholder={t("collections.features.savedLists.ui.addToList.title.placeholder")}
                  value={newListTitle}
                  maxLength={120}
                  readOnly={Boolean(preparation.resumeDestination)}
                  onChange={(event) => setNewListTitle(event.currentTarget.value)}
                />
              ) : null}
              <TextInput
                type="number"
                label={t("collections.features.savedLists.ui.addToList.quantity.label")}
                description={t("collections.features.savedLists.ui.addToList.quantity.description")}
                value={trackedQuantity}
                min={1}
                step={1}
                readOnly={Boolean(preparation.resumeDestination)}
                onChange={(event) => setTrackedQuantity(Number(event.currentTarget.value))}
              />
            </>
          ) : null}
        </Stack>
      </CommerceSheet>
    </>
  );
}
