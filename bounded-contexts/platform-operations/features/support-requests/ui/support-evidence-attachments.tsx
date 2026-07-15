import { FileDropzone, Grid, LinkText, Stack, Thumbnail } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { useState } from "react";
import {
  SUPPORT_EVIDENCE_ATTACHMENT_CONTENT_TYPES,
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES,
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT,
} from "../domain/attachment-policy";
import { parseSupportEvidenceAttachmentReference } from "../domain/attachment-reference";

export function SupportEvidenceAttachmentInput({
  name = "attachments",
  required = false,
}: Readonly<{ name?: string; required?: boolean }>) {
  const [error, setError] = useState<string | undefined>();
  const [count, setCount] = useState(0);

  function validate(files: FileList | null) {
    const selected = files ? [...files] : [];
    setCount(selected.length);
    if (selected.length > SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT) {
      setError(t("support.features.supportRequests.ui.attachments.tooMany"));
      return;
    }
    if (selected.some((file) => !SUPPORT_EVIDENCE_ATTACHMENT_CONTENT_TYPES.some((type) => type === file.type))) {
      setError(t("support.features.supportRequests.ui.attachments.invalidType"));
      return;
    }
    if (selected.some((file) => file.size > SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES)) {
      setError(t("support.features.supportRequests.ui.attachments.tooLarge"));
      return;
    }
    setError(undefined);
  }

  return (
    <FileDropzone
      name={name}
      label={t("support.features.supportRequests.ui.attachments.add")}
      description={t("support.features.supportRequests.ui.attachments.description")}
      accept={SUPPORT_EVIDENCE_ATTACHMENT_CONTENT_TYPES.join(",")}
      capture="environment"
      multiple
      required={required}
      error={error}
      counter={t("support.features.supportRequests.ui.attachments.count", {
        count,
        maximum: SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT,
      })}
      dropLabel={t("support.features.supportRequests.ui.attachments.drop")}
      browseLabel={t("support.features.supportRequests.ui.attachments.browse")}
      onFilesChange={validate}
    />
  );
}

export function SupportEvidenceAttachmentGallery({
  supportRequestId,
  attachments,
  baseUrl = "/api/marketplace/support-requests",
}: Readonly<{
  supportRequestId: string;
  attachments: readonly string[];
  baseUrl?: string;
}>) {
  const privateAttachments = attachments.flatMap((reference) => {
    const parsed = parseSupportEvidenceAttachmentReference(reference);
    return parsed ? [parsed] : [];
  });
  if (privateAttachments.length === 0) {
    return null;
  }

  return (
    <Grid columns={{ base: 1, sm: 2 }} gap={3}>
      {privateAttachments.map((attachment, index) => {
        const number = index + 1;
        const url = `${baseUrl}/${encodeURIComponent(supportRequestId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`;
        return (
          <Stack key={attachment.attachmentId} gap={2}>
            <Thumbnail
              src={url}
              alt={t("support.features.supportRequests.ui.attachments.photoAlt", { number })}
              ratio={4 / 3}
            />
            <LinkText href={url} target="_blank" rel="noreferrer">
              {t("support.features.supportRequests.ui.attachments.fullSize", { number })}
            </LinkText>
          </Stack>
        );
      })}
    </Grid>
  );
}
