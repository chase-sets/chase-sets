import { Checkbox, HiddenInput, LinkText, Stack, Text } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import {
  serializeRegistrationConsentResolution,
  type RegistrationConsentResolution,
} from "../../../support/request-support/registration-consent";

const policyLabelKeys: Readonly<Record<string, string>> = {
  "terms-of-service": "auth.features.registration.ui.registerPage.consent.terms.of.service",
  "privacy-policy": "auth.features.registration.ui.registerPage.consent.privacy.policy",
};

export function RegistrationConsentResolutionInput({
  resolution,
}: Readonly<{ resolution: RegistrationConsentResolution }>) {
  return (
    <HiddenInput
      type="hidden"
      name="registrationConsent"
      value={serializeRegistrationConsentResolution(resolution)}
      readOnly
    />
  );
}

export function RegistrationConsentAffirmation({
  resolution,
  affirmed,
  onAffirmedChange,
}: Readonly<{
  resolution: RegistrationConsentResolution;
  affirmed: boolean;
  onAffirmedChange: (affirmed: boolean) => void;
}>) {
  if (resolution.snapshot.requirements.length === 0) {
    return null;
  }

  return (
    <Checkbox
      name="registrationConsentAffirmation"
      value="affirmed"
      checked={affirmed}
      onCheckedChange={(checked) => onAffirmedChange(checked === true)}
      label={
        <Stack gap={1}>
          <Text as="span" size="sm" weight="medium">
            {t("auth.features.registration.ui.registerPage.consent.affirmation.prefix")}
          </Text>
          {resolution.snapshot.requirements.map((requirement) => (
            <Text as="span" size="sm" key={`${requirement.policyKey}:${requirement.version}`}>
              <LinkText
                href={requirement.href}
                target="_blank"
                rel="noreferrer"
                data-policy-key={requirement.policyKey}
              >
                {t(policyLabelKeys[requirement.policyKey] ?? requirement.policyKey)}
              </LinkText>{" "}
              <Text as="span" size="xs" tone="secondary">
                {requirement.policyKey} · {requirement.version}
              </Text>
            </Text>
          ))}
        </Stack>
      }
    />
  );
}
