import { useEffect, useRef, type ReactNode, type FormEvent } from "react";
import { Button, Form, HiddenInput, LinkButton, LiveRegion, Stack, Surface, Text } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { useSubmit } from "react-router";
import { mintCheckoutCommandAttemptId } from "../../command-attempts/api/contracts";

export type SellListAttemptState = Readonly<{
  state: "failed-safe" | "ambiguous" | "partial";
  fields: readonly (readonly [string, string])[];
  lines: readonly Readonly<{ id: string; status: string }>[];
}>;

export function SellListAttemptBoundary({
  attempt,
  pending = false,
  retryHref,
  children,
}: {
  attempt?: SellListAttemptState | null;
  pending?: boolean;
  retryHref?: string;
  children: ReactNode;
}) {
  const notice = useRef<HTMLDivElement>(null);
  const submit = useSubmit();
  useEffect(() => {
    if (attempt) notice.current?.focus();
  }, [attempt]);
  const locked = pending || attempt?.state === "ambiguous" || attempt?.state === "partial";
  function prepare(event: FormEvent<HTMLFieldSetElement>) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (locked) {
      event.preventDefault();
      return;
    }
    const field = form.elements.namedItem("attemptId");
    if (field instanceof HTMLInputElement) field.value = mintCheckoutCommandAttemptId();
  }
  return (
    <Stack gap={3}>
      {pending || attempt ? (
        <Stack ref={notice} tabIndex={-1}>
          <LiveRegion>
            {t(
              pending
                ? "checkout.sellList.attempt.confirming"
                : attempt?.state === "ambiguous"
                  ? "checkout.sellList.attempt.ambiguous"
                  : attempt?.state === "partial"
                    ? "checkout.sellList.attempt.partial"
                    : "checkout.sellList.attempt.failedSafe",
            )}
          </LiveRegion>
          {attempt?.lines.map((line) => (
            <Text key={line.id}>
              {line.id}: {line.status}
            </Text>
          ))}
        </Stack>
      ) : null}
      {attempt && !pending && retryHref ? (
        <LinkButton href={retryHref}>{t("checkout.sellList.attempt.retry")}</LinkButton>
      ) : attempt && !pending ? (
        <Form
          method="post"
          spacing="none"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget, { method: "post" });
          }}
        >
          {attempt.fields.map(([name, value], index) => (
            <HiddenInput key={`${name}-${index}`} name={name} value={value} />
          ))}
          <Button type="submit" tone="secondary">
            {t("checkout.sellList.attempt.retry")}
          </Button>
        </Form>
      ) : null}
      <Surface as="fieldset" disabled={Boolean(locked)} onSubmitCapture={prepare} elevation="flush">
        {children}
      </Surface>
    </Stack>
  );
}
