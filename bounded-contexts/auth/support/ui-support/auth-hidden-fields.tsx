import type { PasskeyCredentialPayload } from "./passkey-browser";

export function HiddenFields({
  fields,
}: Readonly<{
  fields?: readonly { name: string; value: string }[];
}>) {
  return (
    <>
      {fields?.map((field) => (
        <input key={field.name} type="hidden" name={field.name} value={field.value} readOnly />
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
      <input type="hidden" name="challengeId" value={payload.challengeId} readOnly />
      <input type="hidden" name="challenge" value={payload.challenge} readOnly />
      <input type="hidden" name="externalCredentialId" value={payload.externalCredentialId} readOnly />
      <input type="hidden" name="label" value={payload.label} readOnly />
      <input type="hidden" name="publicKey" value={payload.publicKey} readOnly />
    </>
  );
}
