import { t } from "@chase-sets/localization";
import { Banner, CopyButton, EvidenceCodeBlock, Stack } from "@chase-sets/design-system";
import type { OneTimeApiKeySecret } from "./contracts";

export function ApiKeySecretReveal({ secret }: { secret: OneTimeApiKeySecret | null | undefined }) {
  if (!secret) {
    return null;
  }

  const title =
    secret.action === "created"
      ? t("identity.features.apiKeys.ui.apiKeySecretReveal.created.title")
      : t("identity.features.apiKeys.ui.apiKeySecretReveal.rotated.title");

  return (
    <Stack gap={3}>
      <Banner
        tone="warning"
        title={title}
        description={t("identity.features.apiKeys.ui.apiKeySecretReveal.warning")}
        actions={
          <CopyButton
            value={secret.secret}
            label={t("identity.features.apiKeys.ui.apiKeySecretReveal.copy")}
            copiedLabel={t("identity.features.apiKeys.ui.apiKeySecretReveal.copied")}
          />
        }
      />
      <EvidenceCodeBlock label={t("identity.features.apiKeys.ui.apiKeySecretReveal.full.secret")}>
        {secret.secret}
      </EvidenceCodeBlock>
    </Stack>
  );
}
