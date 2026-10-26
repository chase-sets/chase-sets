import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@chase-sets/design-system/button";
import { Stack, Inset } from "@chase-sets/design-system/layout";
import { NativeSelect } from "@chase-sets/design-system/select";
import { TextInput } from "@chase-sets/design-system/text-input";
import { Textarea } from "@chase-sets/design-system/forms";
import { Text, Heading } from "@chase-sets/design-system/typography";
import { ChaseRoot } from "@chase-sets/design-system/theme";
import { catalogOperatorExtensionEnglishTranslations as copy } from "@chase-sets/localization/locales/en/catalog/operator-extension";
import { createOperatorPopupClient } from "../../domain/extension/bridge";
import {
  probeTcgplayerSetNames,
  serializeSetNamesProbeReport,
  sha256SetNamesProbeReport,
  setNamesProbeUnitConstraints,
  type SetNamesRequest,
} from "../../domain/extension/set-names/probe";
import {
  isEnvironment,
  isGrant,
  type OperatorCommand,
  type OperatorEnvironment,
  type OperatorStatus,
} from "../../domain/extension/protocol";

const t = (key: keyof typeof copy) => copy[key];
export function OperatorExtensionPopup({
  request,
  setNameRequest,
  copyProbeReport,
  extensionVersion = "0.1.0",
  buildCommit = "unknown",
  browserMajor = "unknown",
}: {
  request: (command: OperatorCommand) => Promise<OperatorStatus>;
  setNameRequest?: SetNamesRequest;
  copyProbeReport?: (text: string) => Promise<void>;
  extensionVersion?: string;
  buildCommit?: string;
  browserMajor?: string;
}) {
  const [environment, setEnvironment] = useState<OperatorEnvironment>("staging");
  const [status, setStatus] = useState<OperatorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [grant, setGrant] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [productLineIds, setProductLineIds] = useState<Record<string, string>>(() =>
    Object.fromEntries(setNamesProbeUnitConstraints.map((unit) => [unit.unitKey, unit.productLineId])),
  );
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeReport, setProbeReport] = useState<string | null>(null);
  const [probeSha, setProbeSha] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeCopyError, setProbeCopyError] = useState(false);
  async function run(command: OperatorCommand) {
    const current = ++generation.current;
    setBusy(true);
    setFailed(false);
    try {
      const result = await request(command);
      if (current === generation.current) setStatus(result);
    } catch {
      if (current === generation.current) setFailed(true);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  function clear() {
    setGrant("");
    if (input.current) input.current.value = "";
  }
  useEffect(() => {
    clear();
    setStatus(null);
    void run({ action: "status", environment });
    return () => {
      generation.current++;
    };
  }, [environment]);
  useEffect(() => {
    const dismiss = () => clear();
    window.addEventListener("pagehide", dismiss);
    return () => window.removeEventListener("pagehide", dismiss);
  }, []);
  const locked = busy || status?.state === "upgrade-required";
  async function runProbe() {
    if (!setNameRequest) return;
    setProbeBusy(true);
    setProbeError(null);
    setProbeReport(null);
    setProbeSha(null);
    setProbeCopyError(false);
    try {
      const report = await probeTcgplayerSetNames({
        request: setNameRequest,
        extensionVersion,
        buildCommit,
        browserMajor,
        productLineInputs: setNamesProbeUnitConstraints
          .map((unit) => ({ unitKey: unit.unitKey, productLineId: productLineIds[unit.unitKey]?.trim() ?? "" }))
          .filter((target) => /^\d+$/.test(target.productLineId)),
      });
      const serialized = serializeSetNamesProbeReport(report);
      setProbeReport(serialized);
      setProbeSha(await sha256SetNamesProbeReport(report));
      const reasons = [...new Set(report.rows.flatMap((row) => row.qualification.reasons))];
      if (reasons.length > 0) setProbeError(reasons.join(", "));
    } catch {
      setProbeError(t("catalog.operatorExtension.probe.error"));
    } finally {
      setProbeBusy(false);
    }
  }
  return (
    <Inset padding={4}>
      <Stack gap={3}>
        <Heading level={1}>{t("catalog.operatorExtension.title")}</Heading>
        <NativeSelect
          label={t("catalog.operatorExtension.environment")}
          value={environment}
          disabled={busy}
          items={[
            { value: "staging", label: t("catalog.operatorExtension.staging") },
            { value: "production", label: t("catalog.operatorExtension.production") },
          ]}
          onChange={(event) => {
            if (isEnvironment(event.target.value)) setEnvironment(event.target.value);
          }}
        />
        <Text role="status" aria-live="polite">
          {busy
            ? t("catalog.operatorExtension.loading")
            : failed
              ? t("catalog.operatorExtension.unavailable")
              : status
                ? t(`catalog.operatorExtension.${status.state}`)
                : t("catalog.operatorExtension.loading")}
        </Text>
        <TextInput
          ref={input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          label={t("catalog.operatorExtension.grant")}
          value={grant}
          disabled={locked}
          onChange={(event) => setGrant(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") clear();
          }}
        />
        <Button
          disabled={locked || !isGrant(grant)}
          onClick={() => {
            const value = grant;
            clear();
            void run({ action: "pair", environment, grant: value });
          }}
        >
          {t("catalog.operatorExtension.pair")}
        </Button>
        <Button
          tone="secondary"
          disabled={!grant}
          onClick={() => {
            clear();
            input.current?.focus();
          }}
        >
          {t("catalog.operatorExtension.cancel")}
        </Button>
        <Button
          tone="secondary"
          disabled={locked || !status?.paired}
          onClick={() => {
            clear();
            void run({ action: "unpair", environment });
          }}
        >
          {t("catalog.operatorExtension.unpair")}
        </Button>
        <Button tone="secondary" disabled={busy} onClick={() => void run({ action: "status", environment })}>
          {t("catalog.operatorExtension.refresh")}
        </Button>
        <Button
          tone="secondary"
          disabled={locked || !status?.paired}
          onClick={() => void run({ action: "recover", environment })}
        >
          {t("catalog.operatorExtension.recover")}
        </Button>
        <Text size="sm">{t("catalog.operatorExtension.offboarding")}</Text>
        <Heading level={2}>{t("catalog.operatorExtension.probe.title")}</Heading>
        <Stack gap={2}>
          {setNamesProbeUnitConstraints.map((unit) => (
            <TextInput
              key={unit.unitKey}
              label={t(
                `catalog.operatorExtension.probe.unit.${unit.unitKey.split(":")[1] ?? "unknown"}` as keyof typeof copy,
              )}
              inputMode="numeric"
              value={productLineIds[unit.unitKey] ?? ""}
              disabled={probeBusy}
              onChange={(event) => setProductLineIds((current) => ({ ...current, [unit.unitKey]: event.target.value }))}
            />
          ))}
        </Stack>
        <Button
          disabled={probeBusy || !Object.values(productLineIds).some((value) => /^\d+$/.test(value.trim()))}
          onClick={() => void runProbe()}
        >
          {probeBusy ? t("catalog.operatorExtension.probe.running") : t("catalog.operatorExtension.probe.run")}
        </Button>
        {probeError ? <Text role="alert">{probeError}</Text> : null}
        {!probeBusy &&
        !probeError &&
        !probeReport &&
        !Object.values(productLineIds).some((value) => /^\d+$/.test(value.trim())) ? (
          <Text>{t("catalog.operatorExtension.probe.empty")}</Text>
        ) : null}
        {probeReport ? (
          <Stack gap={2}>
            <Text role="status">{t("catalog.operatorExtension.probe.success")}</Text>
            <Textarea label={t("catalog.operatorExtension.probe.report")} value={probeReport} readOnly rows={8} />
            <Text size="sm">
              {t("catalog.operatorExtension.probe.sha256")}: {probeSha}
            </Text>
            <Button
              tone="secondary"
              onClick={async () => {
                setProbeCopyError(false);
                try {
                  if (!copyProbeReport) throw new Error("unavailable");
                  await copyProbeReport(probeReport);
                } catch {
                  setProbeCopyError(true);
                }
              }}
            >
              {t("catalog.operatorExtension.probe.copy")}
            </Button>
            {probeCopyError ? <Text role="alert">{t("catalog.operatorExtension.probe.copyFailed")}</Text> : null}
          </Stack>
        ) : null}
      </Stack>
    </Inset>
  );
}

export function renderOperatorExtensionPopup(
  element: HTMLElement,
  bridgeOrigin: string,
  options: Readonly<{
    setNameRequest?: SetNamesRequest;
    copyProbeReport?: (text: string) => Promise<void>;
    extensionVersion?: string;
    buildCommit?: string;
    browserMajor?: string;
  }> = {},
) {
  const client = createOperatorPopupClient(window, bridgeOrigin);
  const root = createRoot(element);
  root.render(
    <ChaseRoot>
      <OperatorExtensionPopup
        {...options}
        request={client.request}
        setNameRequest={options.setNameRequest ?? client.requestSetNames}
        copyProbeReport={options.copyProbeReport ?? client.copyProbeReport}
      />
    </ChaseRoot>,
  );
  return () => {
    client.dispose();
    root.unmount();
  };
}
