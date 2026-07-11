import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Cluster,
  CopyButton,
  Grid,
  Heading,
  Inline,
  LinkButton,
  List,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  TaskProgress,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { trackWaitlistEvent } from "./analytics";
import { publicPresenceT as t } from "./public-presence-translator";
import { PublicPresencePageShell } from "./public-pages";

const landingExperimentVariant = "seller_first_v1";

function useWaitlistReferralSummary(signupId: string) {
  const [summary, setSummary] = useState<{ referralCount: number; referralGoal: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/public-presence/waitlist/${encodeURIComponent(signupId)}/referral-summary`, {
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { referralCount?: number; referralGoal?: number } | null) => {
        if (cancelled || !body) {
          return;
        }

        setSummary({
          referralCount: Number(body.referralCount ?? 0),
          referralGoal: Number(body.referralGoal ?? 3),
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [signupId]);

  return summary;
}

function shareText(referralLink: string) {
  return t("publicPresence.welcome.referral.share.message", { link: referralLink });
}

function copyToClipboard(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return;
  }
  navigator.clipboard.writeText(value).catch(() => undefined);
}

export function WaitlistSuccessPage({
  signupId,
  publicOrigin,
  discordInviteUrl,
  attributed,
}: {
  signupId: string;
  publicOrigin: string;
  discordInviteUrl?: string | null;
  attributed?: boolean;
}) {
  const referralLink = `${publicOrigin.replace(/\/+$/, "")}/?ref=${encodeURIComponent(signupId)}`;
  const summary = useWaitlistReferralSummary(signupId);
  const referralGoal = summary?.referralGoal ?? 3;
  const referralCount = summary?.referralCount ?? 0;
  const progressPercent = Math.min(100, (referralCount / referralGoal) * 100);
  const goalReached = referralCount >= referralGoal;

  useEffect(() => {
    trackWaitlistEvent("waitlist_signup_succeeded", {
      section: "welcome",
      variant: landingExperimentVariant,
    });

    if (attributed) {
      trackWaitlistEvent("waitlist_signup_attributed", {
        section: "welcome",
        variant: landingExperimentVariant,
      });
    }
    // Fire once per fresh landing on this page; a bookmarked or repeat visit
    // to the same welcome URL should not re-count as a new signup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function trackShareClick(target: "x" | "discord") {
    trackWaitlistEvent("referral_share_clicked", {
      section: "welcome",
      target,
      variant: landingExperimentVariant,
    });
  }

  function handleDiscordShare() {
    trackShareClick("discord");
    copyToClipboard(shareText(referralLink));
  }

  const twitterIntentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText(referralLink))}`;

  return (
    <PublicPresencePageShell>
      <Page>
        <PageHeader
          eyebrow={t("publicPresence.welcome.eyebrow")}
          title={t("publicPresence.waitlist.success.title")}
          description={t("publicPresence.waitlist.success.description")}
        />

        <PageSection title={t("publicPresence.welcome.whatNext.title")}>
          <List
            items={[
              t("publicPresence.welcome.whatNext.point.review"),
              t("publicPresence.welcome.whatNext.point.email"),
              t("publicPresence.welcome.whatNext.point.discord"),
            ]}
          />
        </PageSection>

        <PageSection
          title={t("publicPresence.welcome.referral.title")}
          description={t("publicPresence.welcome.referral.description", { goal: referralGoal })}
        >
          <Grid columns={{ base: 1, lg: 2 }} gap={4}>
            <Surface tone="subtle" elevated>
              <Stack gap={3}>
                <Text weight="semibold">{t("publicPresence.welcome.referral.linkLabel")}</Text>
                <Cluster gap={2}>
                  <TextInput
                    label={t("publicPresence.welcome.referral.linkLabel")}
                    hideLabel
                    readOnly
                    value={referralLink}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Box onClickCapture={() => trackWaitlistEvent("referral_link_copied", { section: "welcome" })}>
                    <CopyButton
                      value={referralLink}
                      label={t("publicPresence.welcome.referral.copyAction")}
                      copiedLabel={t("publicPresence.welcome.referral.copiedAction")}
                    />
                  </Box>
                </Cluster>
                <TaskProgress
                  label={t("publicPresence.welcome.referral.progress.label")}
                  value={progressPercent}
                  valueLabel={t("publicPresence.welcome.referral.progress.value", {
                    count: referralCount,
                    goal: referralGoal,
                  })}
                  tone={goalReached ? "success" : "accent"}
                  description={
                    goalReached
                      ? t("publicPresence.welcome.referral.progress.complete")
                      : t("publicPresence.welcome.referral.progress.description", { goal: referralGoal })
                  }
                />
                {goalReached ? (
                  <Badge tone="success">{t("publicPresence.welcome.referral.progress.complete")}</Badge>
                ) : null}
              </Stack>
            </Surface>
            <Surface tone="subtle">
              <Stack gap={3}>
                <Heading level={3}>{t("publicPresence.welcome.referral.share.title")}</Heading>
                <Inline gap={2}>
                  <LinkButton
                    href={twitterIntentUrl}
                    tone="secondary"
                    leadingIcon="share"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => trackShareClick("x")}
                  >
                    {t("publicPresence.welcome.referral.share.x")}
                  </LinkButton>
                  {discordInviteUrl ? (
                    <LinkButton
                      href={discordInviteUrl}
                      tone="secondary"
                      leadingIcon="message"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={handleDiscordShare}
                    >
                      {t("publicPresence.welcome.referral.share.discord")}
                    </LinkButton>
                  ) : null}
                </Inline>
              </Stack>
            </Surface>
          </Grid>
        </PageSection>

        <Inline>
          <LinkButton href="/" tone="secondary">
            {t("publicPresence.welcome.backHome")}
          </LinkButton>
        </Inline>
      </Page>
    </PublicPresencePageShell>
  );
}
