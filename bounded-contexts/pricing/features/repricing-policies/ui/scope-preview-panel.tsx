import { useEffect, useState } from "react";
import { Banner, Button, KeyValueList, Stack, Stat, StatGrid, Text } from "@chase-sets/design-system";
import type { createPricingApiClient } from "../../../support/request-support/api-client";
import type { RepricingScopePreview, RepricingScopePreviewInput } from "../read-model/controls";
import { editorCopy } from "./policy-controls-fields";
import { formatRepricingCount } from "./policy-copy";

export function ScopePreviewPanel({
  api,
  input,
}: {
  api: Pick<ReturnType<typeof createPricingApiClient>, "previewRepricingScope">;
  input: Omit<RepricingScopePreviewInput, "accountId">;
}) {
  const [preview, setPreview] = useState<RepricingScopePreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const encoded = JSON.stringify(input);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setFailed(false);
    const timer = setTimeout(() => {
      void api.previewRepricingScope(JSON.parse(encoded)).then(
        (result) => {
          if (!cancelled) setPreview(result);
        },
        () => {
          if (!cancelled) setFailed(true);
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, encoded, retry]);
  if (failed)
    return (
      <Banner
        tone="danger"
        title={editorCopy("scope.error")}
        actions={<Button onClick={() => setRetry(retry + 1)}>{editorCopy("retry")}</Button>}
      />
    );
  return (
    <Stack gap={3} data-testid="repricing-scope-preview" aria-busy={!preview}>
      <StatGrid>
        <Stat
          label={editorCopy("scope.matching")}
          value={preview ? formatRepricingCount(preview.matching) : editorCopy("loading")}
        />
        <Stat
          label={editorCopy("scope.governed")}
          value={preview ? formatRepricingCount(preview.governed) : editorCopy("loading")}
        />
      </StatGrid>
      {preview ? (
        <>
          <Text>{editorCopy("scope.shadowed")}</Text>
          <KeyValueList
            items={preview.shadowedBy.map((policy) => ({
              key: policy.name,
              value: formatRepricingCount(policy.count),
            }))}
            aria-label={editorCopy("scope.shadowed")}
          />
          <Text>{editorCopy("scope.taken")}</Text>
          <KeyValueList
            items={preview.takenFrom.map((policy) => ({ key: policy.name, value: formatRepricingCount(policy.count) }))}
            aria-label={editorCopy("scope.taken")}
          />
        </>
      ) : null}
    </Stack>
  );
}
