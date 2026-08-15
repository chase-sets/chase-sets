import { useEffect, useState } from "react";
import { t } from "@chase-sets/localization";
import { subscribeDurableJobStatus } from "@chase-sets/platform-runtime/durable-job-web";
import {
  Button,
  Card,
  Form,
  HiddenInput,
  Inline,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { BulkRepriceJobStatus } from "../api/runtime";

function useBulkRepriceJob(
  jobId?: string | null,
  initialJob?: BulkRepriceJobStatus | null,
): Readonly<{ job: BulkRepriceJobStatus | null; reconnecting: boolean }> {
  const [job, setJob] = useState<BulkRepriceJobStatus | null>(initialJob ?? null);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setReconnecting(false);
      return;
    }

    setJob(initialJob ?? null);
    setReconnecting(false);
    const subscription = subscribeDurableJobStatus<BulkRepriceJobStatus>({
      url: `/api/marketplace/account/bulk-reprice/jobs/${encodeURIComponent(jobId)}/events`,
      onStatus: (nextJob) => {
        setJob(nextJob);
        setReconnecting(false);
      },
      onError: () => {
        setReconnecting(true);
      },
    });
    return () => {
      subscription.close();
    };
  }, [jobId, initialJob]);

  return { job, reconnecting };
}

function jobPhaseTone(job: BulkRepriceJobStatus | null): "success" | "danger" | "info" {
  if (!job) {
    return "info";
  }
  if (job.status === "failed") {
    return "danger";
  }
  if (job.status === "completed") {
    return "success";
  }
  return "info";
}

export function PricingBulkRepricePage({
  activeJobId,
  initialActiveJob,
  message,
  errorMessage,
}: {
  activeJobId?: string | null;
  initialActiveJob?: BulkRepriceJobStatus | null;
  message?: string | null;
  errorMessage?: string | null;
}) {
  const { job: activeJob, reconnecting } = useBulkRepriceJob(activeJobId, initialActiveJob);
  const hasActiveJob = activeJob?.status === "queued" || activeJob?.status === "running";
  const isTerminal = activeJob?.status === "completed" || activeJob?.status === "failed";

  return (
    <Page>
      <PageHeader
        eyebrow={t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.seller")}
        title={t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.bulk.reprice")}
        description={t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.upload.a.csv")}
        actions={
          <Inline>
            <LinkButton href="/api/marketplace/account/bulk-reprice/template.csv" tone="secondary">
              {t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.download.template")}
            </LinkButton>
            <LinkButton href="/account/repricing" tone="ghost">
              {t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.recommendations")}
            </LinkButton>
          </Inline>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.bulk.reprice")}
          description={errorMessage}
        />
      ) : null}

      {message && !activeJobId ? (
        <MarketplaceNotice
          tone="success"
          title={t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.bulk.reprice")}
          description={message}
        />
      ) : null}

      <PageSection title={t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.upload")}>
        <Form spacing="none" method="post" encType="multipart/form-data">
          <Stack data-testid="bulk-reprice-upload-furniture" gap={4}>
            <Text>{t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.upload.description")}</Text>
            <TextInput
              label={t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.csv.file")}
              name="file"
              type="file"
              required
              disabled={hasActiveJob}
            />
            <Inline>
              <Button type="submit" name="intent" value="upload-bulk-reprice" tone="primary" disabled={hasActiveJob}>
                {t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.upload")}
              </Button>
            </Inline>
          </Stack>
        </Form>
      </PageSection>

      {activeJob ? (
        <PageSection title={t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.job.status")}>
          <MarketplaceDashboardPanel
            title={t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.progress")}
            description={
              reconnecting
                ? t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.job.reconnecting")
                : (activeJob.progress.message ?? activeJob.status)
            }
            metrics={[
              {
                label: t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.completed"),
                value: activeJob.progress.completed,
                detail: t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.rows.of.total", {
                  total: activeJob.progress.total,
                }),
              },
              {
                label: t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.applied"),
                value: activeJob.result?.applied ?? 0,
              },
              {
                label: t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.unchanged"),
                value: activeJob.result?.unchanged ?? 0,
              },
              {
                label: t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.failed"),
                value: activeJob.result?.failed ?? 0,
              },
            ]}
          />

          <Card data-testid="bulk-reprice-job-entity" elevation="outlined">
            <Inline align="center">
              <Text tone={jobPhaseTone(activeJob) === "danger" ? "danger" : "primary"}>
                {activeJob.errorMessage ?? activeJob.progress.message}
              </Text>
              <Inline>
                {hasActiveJob ? (
                  <Form spacing="none" method="post">
                    <HiddenInput type="hidden" name="jobId" value={activeJob.jobId} />
                    <Button type="submit" name="intent" value="cancel-bulk-reprice" tone="ghost">
                      {t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.cancel")}
                    </Button>
                  </Form>
                ) : null}
                {isTerminal ? (
                  <LinkButton
                    href={`/api/marketplace/account/bulk-reprice/jobs/${encodeURIComponent(activeJob.jobId)}/results.csv`}
                    tone="secondary"
                  >
                    {t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.download.results")}
                  </LinkButton>
                ) : null}
              </Inline>
            </Inline>
          </Card>
        </PageSection>
      ) : null}
    </Page>
  );
}
