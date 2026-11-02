import { t } from "@chase-sets/localization";
import { Inline, LinkText, Stack, Text, ValidationSummary } from "@chase-sets/design-system";
import type { AuthoredTextRecovery } from "./authored-text-recovery";

// Public Presence owns both pages; Marketplace links them and never copies
// their policy prose into a form.
const communityGuidelinesHref = "/help/buying/community-guidelines-and-enforcement";
const contactSupportHref = "/contact";

/** Rendered inside each form that publishes account-authored text, before its submit control. */
export function AuthoredTextGuidance() {
  return (
    <Stack gap={1}>
      <Text size="sm" tone="secondary">
        {t("marketplace.features.reviews.ui.authoredTextGuidance.description")}
      </Text>
      <Inline gap={3}>
        <LinkText href={communityGuidelinesHref}>
          {t("marketplace.features.reviews.ui.authoredTextGuidance.communityGuidelines")}
        </LinkText>
        <LinkText href={contactSupportHref}>
          {t("marketplace.features.reviews.ui.authoredTextGuidance.contactSupport")}
        </LinkText>
      </Inline>
    </Stack>
  );
}

/**
 * Announces a closed rejection, says the draft was kept, and links the field to
 * edit. A rate limit names no field because the text itself was not judged.
 */
export function AuthoredTextRecoverySummary({
  recovery,
  fieldId,
  fieldName,
}: {
  recovery: AuthoredTextRecovery;
  fieldId: string;
  fieldName: string;
}) {
  return (
    <ValidationSummary
      title={t("marketplace.features.reviews.ui.authoredTextRecovery.title")}
      description={t("marketplace.features.reviews.ui.authoredTextRecovery.draftKept")}
      errors={[recovery.fieldLevel ? { fieldId, fieldName, message: recovery.message } : { message: recovery.message }]}
    />
  );
}
