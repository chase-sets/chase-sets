import type { PasskeyCredentialPayload } from "./passkey-browser";
import { HiddenInput } from "@chase-sets/design-system";

export function HiddenFields({
  fields,
}: Readonly<{
  fields?: readonly { name: string; value: string }[];
}>) {
  return (
    <>
      {fields?.map((field) => (
        <HiddenInput key={field.name} type="hidden" name={field.name} value={field.value} readOnly />
      ))}
    </>
  );
}

export function PasskeyHiddenFields({
  payload,
}: Readonly<{
  payload: PasskeyCredentialPayload | null;
}>) {
  if (!payload) {
    return null;
  }

  return (
    <>
      <HiddenInput type="hidden" name="challengeId" value={payload.challengeId} readOnly />
      <HiddenInput type="hidden" name="challenge" value={payload.challenge} readOnly />
      <HiddenInput type="hidden" name="externalCredentialId" value={payload.externalCredentialId} readOnly />
      <HiddenInput type="hidden" name="label" value={payload.label} readOnly />
      <HiddenInput type="hidden" name="publicKey" value={payload.publicKey} readOnly />
    </>
  );
}
