import { useEffect, useRef, useState } from "react";
import { Button } from "@chase-sets/design-system/button";
import { Stack } from "@chase-sets/design-system/layout";
import { NativeSelect } from "@chase-sets/design-system/select";
import { Textarea } from "@chase-sets/design-system/forms";
import { Text, Heading } from "@chase-sets/design-system/typography";
import { catalogOperatorExtensionEnglishTranslations as copy } from "@chase-sets/localization/locales/en/catalog/operator-extension";
import type { OperatorEnvironment } from "../../domain/extension/protocol";
import { tcgplayerSetNameUnits } from "../../domain/extension/set-names/contract";
import type { SetNamesRequest, SetNamesReceipt } from "../../domain/extension/set-names/probe";
import { runTcgplayerSetNames, type SetNamesRunResult } from "../../domain/extension/set-names/run";
import type { SetNamesPost } from "../../domain/extension/set-names/transport";

const t = (key: keyof typeof copy) => copy[key];

export function SetNamesAction({
  environment,
  paired,
  disabled,
  request,
  post,
  copyReceipt,
  onBusyChange,
  onGrantInvalid,
}: {
  environment: OperatorEnvironment;
  paired: boolean;
  disabled: boolean;
  request?: SetNamesRequest;
  post?: SetNamesPost;
  copyReceipt?: (text: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onGrantInvalid: () => void;
}) {
  const [productLineId, setProductLineId] = useState("");
  const [phase, setPhase] = useState<"fetching" | "posting" | null>(null);
  const [receipt, setReceipt] = useState<SetNamesReceipt | null>(null);
  const [result, setResult] = useState<SetNamesRunResult | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    setReceipt(null);
    setResult(null);
    setCopyFailed(false);
  }, [environment]);
  async function run() {
    if (inFlight.current || disabled || !paired || !productLineId || !request || !post) return;
    inFlight.current = true;
    onBusyChange(true);
    setPhase("fetching");
    setReceipt(null);
    setResult(null);
    setCopyFailed(false);
    try {
      const outcome = await runTcgplayerSetNames({
        environment,
        productLineId: Number(productLineId),
        request,
        post: async (...args) => {
          setPhase("posting");
          return post(...args);
        },
        onReceipt: setReceipt,
      });
      setResult(outcome);
      if (outcome.outcome === "grant-invalid") onGrantInvalid();
    } finally {
      inFlight.current = false;
      setPhase(null);
      onBusyChange(false);
    }
  }
  return (
    <Stack gap={2}>
      <Heading level={2}>{t("catalog.operatorExtension.setNames.title")}</Heading>
      <NativeSelect
        label={t("catalog.operatorExtension.setNames.productLine")}
        value={productLineId}
        disabled={disabled || phase !== null}
        items={[
          { value: "", label: t("catalog.operatorExtension.setNames.empty") },
          ...tcgplayerSetNameUnits.flatMap((unit) =>
            unit.productLineId === null
              ? []
              : [
                  {
                    value: String(unit.productLineId),
                    label: t(`catalog.operatorExtension.probe.unit.${unit.unitKey.split(":")[1]}` as keyof typeof copy),
                  },
                ],
          ),
        ]}
        onChange={(event) => {
          setProductLineId(event.target.value);
          setReceipt(null);
          setResult(null);
          setCopyFailed(false);
        }}
      />
      {!productLineId ? <Text>{t("catalog.operatorExtension.setNames.empty")}</Text> : null}
      <Button
        disabled={disabled || phase !== null || !paired || !productLineId || !request || !post}
        onClick={() => void run()}
      >
        {phase ? t(`catalog.operatorExtension.setNames.${phase}`) : t("catalog.operatorExtension.setNames.run")}
      </Button>
      {phase ? <Text role="status">{t(`catalog.operatorExtension.setNames.${phase}`)}</Text> : null}
      {receipt ? (
        <>
          <Textarea
            label={t("catalog.operatorExtension.setNames.receipt")}
            value={JSON.stringify(receipt, null, 2)}
            readOnly
            rows={6}
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
            {t("catalog.operatorExtension.setNames.copy")}
          </Button>
        </>
      ) : null}
      {copyFailed ? <Text role="alert">{t("catalog.operatorExtension.setNames.copyFailed")}</Text> : null}
      {result?.outcome === "recorded" ? (
        <Stack gap={1}>
          <Text role="status">{t("catalog.operatorExtension.setNames.success")}</Text>
          <Text>
            {t("catalog.operatorExtension.setNames.observations")}: {result.observationCount}
          </Text>
          <Text>
            {t("catalog.operatorExtension.setNames.newObservations")}: {result.newObservationCount}
          </Text>
          <Text>
            {t("catalog.operatorExtension.setNames.mappings")}: {result.mappingsProposed}
          </Text>
        </Stack>
      ) : result ? (
        <Text role="alert">
          {result.outcome === "grant-invalid"
            ? t("catalog.operatorExtension.re-pair-required")
            : `${t("catalog.operatorExtension.setNames.stopped")}: ${result.outcome}${result.outcome === "unqualified" ? ` (${result.code})` : ""}`}
        </Text>
      ) : null}
    </Stack>
  );
}
