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
  getPasskeyCredential,
  type PasskeyCredentialPayload,
} from "../../../support/ui-support/passkey-browser";
import {
  HiddenFields,
  PasskeyHiddenFields,
} from "../../../support/ui-support/auth-hidden-fields";

type SignInMethod = "password" | "magic-link" | "passkey";

export function SignInPage(props: Readonly<{
  action?: string;
  errorMessage?: string | null;
  hiddenFields?: readonly { name: string; value: string }[];
  notice?: AuthActionNotice | null;
}>) {
  const [method, setMethod] = useState<SignInMethod>("password");
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
      const email = String(formData.get("email") ?? "");
      const payload = await getPasskeyCredential(email);
      setPasskeyPayload(payload);
      window.setTimeout(() => passkeyFormRef.current?.requestSubmit(), 0);
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : "Passkey sign-in failed.");
    } finally {
      setPasskeyLoading(false);
    }
  }

  const statusMessage =
    props.notice?.status === "magic-link-sent"
      ? "Magic link ready. Check your email, or continue here in local recovery mode."
      : null;

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Text size="lg" weight="semibold">
          Sign In
        </Text>
        <Text tone="secondary">
          Use a password, magic link, or passkey to continue.
        </Text>
      </Stack>

      {props.errorMessage ? (
        <Banner title="Sign-in failed" description={props.errorMessage} tone="danger" role="alert" />
      ) : null}
      {statusMessage ? (
        <Banner
          title="Magic link sent"
          description={statusMessage}
          tone="success"
          actions={
            props.notice?.status === "magic-link-sent" ? (
              <form action={props.action} method="post">
                <HiddenFields fields={props.hiddenFields} />
                <input type="hidden" name="intent" value="magic-link-consume" readOnly />
                <input type="hidden" name="token" value={props.notice.token} readOnly />
                <Button type="submit" tone="secondary" size="sm">
                  Continue
                </Button>
              </form>
            ) : null
          }
        />
      ) : null}

      <SegmentedControl
        fullWidth
        value={method}
        onValueChange={(value) => setMethod(value as SignInMethod)}
        items={[
          { value: "password", label: "Password", icon: "lock" },
          { value: "magic-link", label: "Magic Link", icon: "message" },
          { value: "passkey", label: "Passkey", icon: "shield" },
        ]}
      />

      {method === "password" ? (
        <Card>
          <form action={props.action} method="post">
            <Stack gap={3}>
              <HiddenFields fields={props.hiddenFields} />
              <input type="hidden" name="intent" value="password" readOnly />
              <TextInput label="Email" name="email" type="email" required />
              <PasswordInput label="Password" name="password" required />
              <Button type="submit" leadingIcon="lock">
                Sign In
              </Button>
            </Stack>
          </form>
        </Card>
      ) : null}

      {method === "magic-link" ? (
        <Card>
          <Stack gap={4}>
            <form action={props.action} method="post">
              <Stack gap={3}>
                <HiddenFields fields={props.hiddenFields} />
                <input type="hidden" name="intent" value="magic-link-request" readOnly />
                <TextInput label="Email" name="email" type="email" required />
                <Button type="submit" leadingIcon="message">
                  Send Magic Link
                </Button>
              </Stack>
            </form>
            <form action={props.action} method="post">
              <Stack gap={3}>
                <HiddenFields fields={props.hiddenFields} />
                <input type="hidden" name="intent" value="magic-link-consume" readOnly />
                <TextInput label="Magic Link Token" name="token" required />
                <Button type="submit" tone="secondary">
                  Continue With Token
                </Button>
              </Stack>
            </form>
          </Stack>
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
              <input type="hidden" name="intent" value="passkey-sign-in" readOnly />
              <PasskeyHiddenFields payload={passkeyPayload} />
              <TextInput label="Email" name="email" type="email" required />
              {passkeyError ? (
                <Banner title="Passkey unavailable" description={passkeyError} tone="warning" role="alert" />
              ) : null}
              <Button type="submit" leadingIcon="shield" loading={passkeyLoading}>
                Use Passkey
              </Button>
            </Stack>
          </form>
        </Card>
      ) : null}
    </Stack>
  );
}
