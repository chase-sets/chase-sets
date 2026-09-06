import type { Translate } from "./index";

const MAX_SAFE_MACHINE_TOKEN_LENGTH = 40;
const SAFE_MACHINE_TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type MachineValueLabelOptions = Readonly<{
  knownValueTranslationKeys: Readonly<Record<string, string>>;
  family: string;
  translate: Translate;
  unrecognizedTranslationKey: string;
  unrecognizedWithValueTranslationKey: string;
}>;

export function safeMachineToken(value: string): string | null {
  return value.length > 0 && value.length <= MAX_SAFE_MACHINE_TOKEN_LENGTH && SAFE_MACHINE_TOKEN.test(value)
    ? value
    : null;
}

export function humanizeMachineToken(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function formatMachineValue(value: string, options: MachineValueLabelOptions): string {
  const knownTranslationKey = Object.prototype.hasOwnProperty.call(options.knownValueTranslationKeys, value)
    ? options.knownValueTranslationKeys[value]
    : undefined;

  if (knownTranslationKey) {
    return options.translate(knownTranslationKey);
  }

  const safeToken = safeMachineToken(value);
  return safeToken
    ? options.translate(options.unrecognizedWithValueTranslationKey, {
        family: options.family,
        value: humanizeMachineToken(safeToken),
      })
    : options.translate(options.unrecognizedTranslationKey, { family: options.family });
}

const authenticationMethodTranslationKeys = {
  password: "identity.values.authenticationMethod.password",
  "magic-link": "identity.values.authenticationMethod.magicLink",
  passkey: "identity.values.authenticationMethod.passkey",
  "sms-code": "identity.values.authenticationMethod.smsCode",
  "social-login": "identity.values.authenticationMethod.socialLogin",
  google: "identity.values.authenticationMethod.google",
  facebook: "identity.values.authenticationMethod.facebook",
} as const;

export const authenticationMethodValues = Object.freeze(Object.keys(authenticationMethodTranslationKeys));

export function authenticationMethodLabel(value: string, translate: Translate): string {
  return formatMachineValue(value, {
    knownValueTranslationKeys: authenticationMethodTranslationKeys,
    family: translate("identity.values.family.authenticationMethod"),
    translate,
    unrecognizedTranslationKey: "identity.values.unrecognized",
    unrecognizedWithValueTranslationKey: "identity.values.unrecognized.withValue",
  });
}
