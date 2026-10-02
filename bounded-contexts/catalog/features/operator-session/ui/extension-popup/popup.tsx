import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@chase-sets/design-system/button";
import { Stack, Inset } from "@chase-sets/design-system/layout";
import { NativeSelect } from "@chase-sets/design-system/select";
import { TextInput } from "@chase-sets/design-system/text-input";
import { Text, Heading } from "@chase-sets/design-system/typography";
import { ChaseRoot } from "@chase-sets/design-system/theme";
import { catalogOperatorExtensionEnglishTranslations as copy } from "@chase-sets/localization/locales/en/catalog/operator-extension";
import { createOperatorPopupClient } from "../../domain/extension/bridge";
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
}: {
  request: (command: OperatorCommand) => Promise<OperatorStatus>;
}) {
  const [environment, setEnvironment] = useState<OperatorEnvironment>("staging");
  const [status, setStatus] = useState<OperatorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [grant, setGrant] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
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
        {status && (
          <Text>
            {t(
              status.cookiePresent
                ? "catalog.operatorExtension.cookiePresent"
                : "catalog.operatorExtension.cookieAbsent",
            )}
          </Text>
        )}
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
      </Stack>
    </Inset>
  );
}

export function renderOperatorExtensionPopup(element: HTMLElement, bridgeOrigin: string) {
  const client = createOperatorPopupClient(window, bridgeOrigin);
  const root = createRoot(element);
  root.render(
    <ChaseRoot>
      <OperatorExtensionPopup request={client.request} />
    </ChaseRoot>,
  );
  return () => {
    client.dispose();
    root.unmount();
  };
}
