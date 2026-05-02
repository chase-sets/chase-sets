import {
  Banner,
  Button,
  Card,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import type { AuthActionNotice } from "../../../support/route-support/auth-host";
import {
  createPasskeyCredential,
  type PasskeyCredentialPayload,
} from "../../../support/ui-support/passkey-browser";
import {
  HiddenFields,
  PasskeyHiddenFields,
} from "../../../support/ui-support/auth-hidden-fields";

type RegistrationMethod = "password" | "passkey";

export function RegisterPage(props: Readonly<{
  action?: string;
  errorMessage?: string | null;
  hiddenFields?: readonly { name: string; value: string }[];
  notice?: AuthActionNotice | null;
}>) {
  const [method, setMethod] = useState<RegistrationMethod>("password");
  const [passkeyPayload, setPasskeyPayload] =
    useState<PasskeyCredentialPayload | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const passkeyFormRef = useRef<HTMLFormElement | null>(null);

  async function handlePasskeySubmit(event: FormEvent<HTMLFormElement>) {
    if (passkeyPayload) {
      return;
    }

    event.preventDefault();
    setPasskeyError(null);
    setPasskeyLoading(true);

    try {
      const formData = new FormData(event.currentTarget);
      const displayName = String(formData.get("displayName") ?? "");
      const email = String(formData.get("email") ?? "");
      const payload = await createPasskeyCredential({ displayName, email });
      setPasskeyPayload(payload);
      window.setTimeout(() => passkeyFormRef.current?.requestSubmit(), 0);
    } catch (error) {
      setPasskeyError(
        error instanceof Error ? error.message : "Passkey registration failed.",
      );
    } finally {
      setPasskeyLoading(false);
    }
  }

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Text size="lg" weight="semibold">
          Create Account
        </Text>
        <Text tone="secondary">
          Create your personal identity and owner account to start buying and
          selling.
        </Text>
      </Stack>

      {props.errorMessage ? (
        <Banner
          title="Registration failed"
          description={props.errorMessage}
          tone="danger"
          role="alert"
        />
      ) : null}
      {props.notice?.status === "passkey-recovery" ? (
        <Banner title="Passkey added" description={props.notice.message} tone="success" />
      ) : null}

      <SegmentedControl
        fullWidth
        value={method}
        onValueChange={(value) => setMethod(value as RegistrationMethod)}
        items={[
          { value: "password", label: "Password", icon: "lock" },
          { value: "passkey", label: "Passkey", icon: "shield" },
        ]}
      />

      {method === "password" ? (
        <Card>
          <form action={props.action} method="post">
            <Stack gap={3}>
              <HiddenFields fields={props.hiddenFields} />
              <input type="hidden" name="intent" value="password" readOnly />
              <TextInput label="Display Name" name="displayName" required />
              <TextInput label="Email" name="email" type="email" required />
              <PasswordInput label="Password" name="password" required />
              <Button type="submit" leadingIcon="lock">
                Create Account
              </Button>
            </Stack>
          </form>
        </Card>
      ) : null}

      {method === "passkey" ? (
        <Card>
          <form
            ref={passkeyFormRef}
            action={props.action}
            method="post"
            onSubmit={handlePasskeySubmit}
          >
            <Stack gap={3}>
              <HiddenFields fields={props.hiddenFields} />
              <input type="hidden" name="intent" value="passkey-register" readOnly />
              <PasskeyHiddenFields payload={passkeyPayload} />
              <TextInput label="Display Name" name="displayName" required />
              <TextInput label="Email" name="email" type="email" required />
              {passkeyError ? (
                <Banner
                  title="Passkey unavailable"
                  description={passkeyError}
                  tone="warning"
                  role="alert"
                />
              ) : null}
              <Button type="submit" leadingIcon="shield" loading={passkeyLoading}>
                Create With Passkey
              </Button>
            </Stack>
          </form>
        </Card>
      ) : null}
    </Stack>
  );
}
