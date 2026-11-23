import { useEffect, useRef, useState } from "react";
import { Button } from "@chase-sets/design-system/button";
import { Stack } from "@chase-sets/design-system/layout";
import { NativeSelect } from "@chase-sets/design-system/select";
import { Textarea } from "@chase-sets/design-system/forms";
import { Text, Heading } from "@chase-sets/design-system/typography";
import { catalogOperatorExtensionEnglishTranslations as copy } from "@chase-sets/localization/locales/en/catalog/operator-extension";
import type { OperatorEnvironment } from "../../domain/extension/protocol";
import type { TcgplayerSetNameEntry } from "../../domain/extension/set-names/contract";
import {
  sealedProductLines,
  type SealedFetch,
  type SealedReceipt,
} from "../../domain/extension/sealed-products/collector";
import { runSealedProducts } from "../../domain/extension/sealed-products/run";
import type { SealedPost } from "../../domain/extension/sealed-products/transport";
const t = (key: keyof typeof copy) => copy[key];
export function SealedProductsAction({
  environment,
  paired,
  disabled,
  setsByLine,
  request,
  post,
  copyReceipt,
  onBusyChange,
  onGrantInvalid,
}: {
  environment: OperatorEnvironment;
  paired: boolean;
  disabled: boolean;
  setsByLine: Record<number, readonly TcgplayerSetNameEntry[]>;
  request?: SealedFetch;
  post?: SealedPost;
  copyReceipt?: (text: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onGrantInvalid: () => void;
}) {
  const [line, setLine] = useState("");
  const [setId, setSetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<SealedReceipt | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const running = useRef(false);
  const sets = setsByLine[Number(line)] ?? [];
  useEffect(() => {
    setLine("");
    setSetId("");
    setReceipt(null);
    setOutcome(null);
    setCopyFailed(false);
  }, [environment]);
  async function run() {
    const set = sets.find((entry) => String(entry.setNameId) === setId);
    if (running.current || disabled || !paired || !request || !post || !set) return;
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    setOutcome(null);
    setReceipt(null);
    setCopyFailed(false);
    try {
      const result = await runSealedProducts({
        selection: { productLineId: Number(line), setId: set.setNameId, setName: set.cleanSetName },
        environment,
        request,
        post,
        onReceipt: setReceipt,
      });
      setOutcome(result.outcome);
      if (result.outcome === "grant-invalid") onGrantInvalid();
    } catch {
      setOutcome("unavailable");
    } finally {
      running.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <Stack gap={2}>
      <Heading level={2}>{t("catalog.operatorExtension.sealed.title")}</Heading>
      <NativeSelect
        label={t("catalog.operatorExtension.sealed.productLine")}
        value={line}
        disabled={disabled || busy}
        items={[
          { value: "", label: t("catalog.operatorExtension.setNames.empty") },
          ...sealedProductLines().map((line) => ({ value: String(line.id), label: line.name })),
        ]}
        onChange={(event) => {
          setLine(event.target.value);
          setSetId("");
          setReceipt(null);
          setOutcome(null);
        }}
      />
      <NativeSelect
        label={t("catalog.operatorExtension.sealed.set")}
        value={setId}
        disabled={disabled || busy || sets.length === 0}
        items={[
          { value: "", label: t("catalog.operatorExtension.sealed.empty") },
          ...sets.map((set) => ({ value: String(set.setNameId), label: set.name })),
        ]}
        onChange={(event) => {
          setSetId(event.target.value);
          setReceipt(null);
          setOutcome(null);
        }}
      />
      {line && sets.length === 0 ? <Text>{t("catalog.operatorExtension.sealed.needsSetNames")}</Text> : null}
      <Button disabled={disabled || busy || !paired || !setId || !request || !post} onClick={() => void run()}>
        {t("catalog.operatorExtension.sealed.run")}
      </Button>
      {busy ? <Text role="status">{t("catalog.operatorExtension.sealed.loading")}</Text> : null}
      {receipt ? (
        <>
          <Textarea
            label={t("catalog.operatorExtension.sealed.receipt")}
            value={JSON.stringify(receipt, null, 2)}
            readOnly
            rows={8}
          />
          <Button
            tone="secondary"
            disabled={!copyReceipt}
            onClick={async () => {
              setCopyFailed(false);
              try {
                await copyReceipt?.(JSON.stringify(receipt, null, 2));
              } catch {
                setCopyFailed(true);
              }
            }}
          >
            {t("catalog.operatorExtension.sealed.copy")}
          </Button>
          <Text>
            {t("catalog.operatorExtension.sealed.counts")
              .replace("{recorded}", String(receipt.catalog.recorded))
              .replace("{changed}", String(receipt.catalog.changed))
              .replace("{unchanged}", String(receipt.catalog.unchanged))
              .replace("{candidates}", String(receipt.catalog.candidateCount))
              .replace("{exclusions}", String(receipt.catalog.exclusions))}
          </Text>
        </>
      ) : null}
      {copyFailed ? <Text role="alert">{t("catalog.operatorExtension.setNames.copyFailed")}</Text> : null}
      {outcome === "recorded" ? (
        <Text role="status">{t("catalog.operatorExtension.sealed.success")}</Text>
      ) : outcome ? (
        <Text role="alert">
          {outcome === "grant-invalid"
            ? t("catalog.operatorExtension.re-pair-required")
            : t("catalog.operatorExtension.sealed.stopped").replace("{outcome}", outcome)}
        </Text>
      ) : null}
    </Stack>
  );
}
