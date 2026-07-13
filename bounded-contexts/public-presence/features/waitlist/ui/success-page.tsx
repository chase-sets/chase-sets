import { useEffect, useRef, useState } from "react";
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
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  TaskProgress,
  Text,
  TextInput,
  ToggleGroup,
} from "@chase-sets/design-system";
import { trackWaitlistEvent } from "./analytics";
import { landingExperimentVariants, type LandingExperimentVariant } from "./landing-experiment";
import { publicPresenceT as t } from "./public-presence-translator";
import { gameItems, inventorySizeItems, PublicPresencePageShell } from "./public-pages";

type ReferralSummary = Readonly<{
  referralCount: number;
  referralGoal: number;
  /** 1-based place in the beta invite line, or null while the read model catches up -- render "pending", never a fake number. */
  queuePosition: number | null;
  totalSignups: number;
  positionsAdvanced: number;
}>;

function useWaitlistReferralSummary(signupId: string) {
  const [summary, setSummary] = useState<ReferralSummary | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/public-presence/waitlist/${encodeURIComponent(signupId)}/referral-summary`, {
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          body: {
            referralCount?: number;
            referralGoal?: number;
            queuePosition?: number | null;
            totalSignups?: number;
            positionsAdvanced?: number;
          } | null,
        ) => {
          if (cancelled || !body) {
            return;
          }

          const queuePosition = Number(body.queuePosition ?? Number.NaN);
          setSummary({
            referralCount: Number(body.referralCount ?? 0),
            referralGoal: Number(body.referralGoal ?? 3),
            queuePosition: Number.isFinite(queuePosition) && queuePosition > 0 ? queuePosition : null,
            totalSignups: Number(body.totalSignups ?? 0),
            positionsAdvanced: Math.max(0, Number(body.positionsAdvanced ?? 0)),
          });
        },
      )
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

const validGameSlugs = new Set(gameItems.map((item) => item.value));

type CohortSaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * The progressive "wave placement" step: collects the cohort-quality fields
 * the minimal hero form deliberately omits. Every field is optional and saved
 * individually the moment it changes -- there is no submit wall, so partial
 * answers still reach the wave-selection store.
 */
function WavePlacementSection({
  signupId,
  initialGames,
  landingExperimentVariant,
}: {
  signupId: string;
  initialGames: readonly string[];
  landingExperimentVariant: LandingExperimentVariant;
}) {
  const [games, setGames] = useState<string[]>([...new Set(initialGames.filter((game) => validGameSlugs.has(game)))]);
  const [inventorySize, setInventorySize] = useState("");
  const [storeUrl, setStoreUrl] = useState("");
  const [status, setStatus] = useState<CohortSaveStatus>("idle");
  const lastSavedStoreUrl = useRef("");

  function saveCohortField(field: string, body: Record<string, unknown>) {
    setStatus("saving");
    fetch(`/api/public-presence/waitlist/${encodeURIComponent(signupId)}/cohort-quality`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Cohort-quality save failed with status ${response.status}.`);
        }
        setStatus("saved");
        trackWaitlistEvent("waitlist_cohort_field_saved", {
          section: "welcome",
          field,
          variant: landingExperimentVariant,
        });
      })
      .catch(() => setStatus("error"));
  }

  function handleGamesChange(nextGames: string[]) {
    setGames(nextGames);
    saveCohortField("games", { games: nextGames });
  }

  function handleInventorySizeChange(nextInventorySize: string) {
    setInventorySize(nextInventorySize);
    saveCohortField("inventorySize", { inventorySize: nextInventorySize || null });
  }

  function handleStoreUrlBlur() {
    const trimmed = storeUrl.trim();
    if (trimmed === lastSavedStoreUrl.current) {
      return;
    }
    lastSavedStoreUrl.current = trimmed;
    saveCohortField("storeUrl", {
      hasStoreLink: trimmed.length > 0,
      storeUrl: trimmed || null,
    });
  }

  return (
    <PageSection
      title={t("publicPresence.welcome.wavePlacement.title")}
      description={t("publicPresence.welcome.wavePlacement.description")}
    >
      <Surface tone="subtle" elevated>
        <Stack gap={4}>
          <Stack gap={2}>
            <Stack gap={1}>
              <Text weight="semibold">{t("publicPresence.waitlist.games.label")}</Text>
              <Text size="sm" tone="secondary">
                {t("publicPresence.waitlist.games.description")}
              </Text>
            </Stack>
            <ToggleGroup
              multiple
              items={gameItems}
              value={games}
              onValueChange={handleGamesChange}
              label={t("publicPresence.waitlist.games.label")}
            />
          </Stack>
          <Grid columns={{ base: 1, md: 2 }} gap={3}>
            <NativeSelect
              label={t("publicPresence.waitlist.inventorySize.label")}
              name="inventorySize"
              placeholder={t("publicPresence.waitlist.inventorySize.placeholder")}
              items={inventorySizeItems}
              value={inventorySize}
              onChange={(event) => handleInventorySizeChange(event.currentTarget.value)}
            />
            <TextInput
              label={t("publicPresence.welcome.wavePlacement.storeLink.label")}
              description={t("publicPresence.welcome.wavePlacement.storeLink.why")}
              name="storeUrl"
              type="url"
              placeholder={t("publicPresence.waitlist.storeUrl.placeholder")}
              value={storeUrl}
              onChange={(event) => setStoreUrl(event.currentTarget.value)}
              onBlur={handleStoreUrlBlur}
            />
          </Grid>
          {status === "saving" ? (
            <Text size="sm" tone="secondary">
              {t("publicPresence.welcome.wavePlacement.saving")}
            </Text>
          ) : null}
          {status === "saved" ? (
            <Text size="sm" tone="secondary">
              {t("publicPresence.welcome.wavePlacement.saved")}
            </Text>
          ) : null}
          {status === "error" ? (
            <Text size="sm" tone="danger">
              {t("publicPresence.welcome.wavePlacement.saveFailed")}
            </Text>
          ) : null}
        </Stack>
      </Surface>
    </PageSection>
  );
}

export function WaitlistSuccessPage({
  signupId,
  publicOrigin,
  discordInviteUrl,
  attributed,
  role = null,
  initialGames = [],
  landingExperimentVariant = landingExperimentVariants.sellerFirstV1,
}: {
  signupId: string;
  publicOrigin: string;
  discordInviteUrl?: string | null;
  attributed?: boolean;
  /**
   * Signup role from the post-signup redirect. Cohort-quality signals are
   * captured only from sell/both-intent signups (see GLOSSARY.md), so the
   * wave-placement step renders only for sell/both; a missing role
   * (bookmarked visit) hides it rather than asking for inventory signals a
   * buy-intent signup never carries.
   */
  role?: "buy" | "sell" | "both" | null;
  /** Games already recorded at signup, prefilled into the wave-placement chips. */
  initialGames?: readonly string[];
  /** The first-party landing assignment carried through the signup redirect. */
  landingExperimentVariant?: LandingExperimentVariant;
}) {
  // The share link carries its own UTM channel so referral traffic shows up
  // as a distinct row in campaign channel attribution (utm_source=referral),
  // alongside the per-signup `?ref=` attribution the queue mechanic uses.
  const referralLink = `${publicOrigin.replace(/\/+$/, "")}/?ref=${encodeURIComponent(signupId)}&utm_source=referral&utm_medium=waitlist_share`;
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
    <PublicPresencePageShell landingExperimentVariant={landingExperimentVariant}>
      <Page>
        <PageHeader
          eyebrow={t("publicPresence.welcome.eyebrow")}
          title={t("publicPresence.waitlist.success.title")}
          description={t("publicPresence.waitlist.success.description")}
        />

        {role === "sell" || role === "both" ? (
          <WavePlacementSection
            signupId={signupId}
            initialGames={initialGames}
            landingExperimentVariant={landingExperimentVariant}
          />
        ) : null}

        <PageSection title={t("publicPresence.welcome.whatNext.title")}>
          <List
            items={[
              t("publicPresence.welcome.whatNext.point.review"),
              t("publicPresence.welcome.whatNext.point.founders"),
              t("publicPresence.welcome.whatNext.point.email"),
              t("publicPresence.welcome.whatNext.point.discord"),
            ]}
          />
          <Inline>
            <LinkButton href="/founders" tone="secondary" size="sm">
              {t("publicPresence.nav.foundersTerms")}
            </LinkButton>
          </Inline>
        </PageSection>

        <PageSection
          title={t("publicPresence.welcome.referral.title")}
          description={t("publicPresence.welcome.referral.description", { goal: referralGoal })}
        >
          <Grid columns={{ base: 1, lg: 2 }} gap={4}>
            <Surface tone="subtle" elevated>
              <Stack gap={3}>
                {summary?.queuePosition != null ? (
                  <Stack gap={1}>
                    <Text size="lg" weight="semibold">
                      {t("publicPresence.welcome.referral.position.value", {
                        position: summary.queuePosition,
                        total: summary.totalSignups,
                      })}
                    </Text>
                    {summary.positionsAdvanced > 0 ? (
                      <Text size="sm" tone="secondary">
                        {t("publicPresence.welcome.referral.position.advanced", {
                          count: summary.positionsAdvanced,
                        })}
                      </Text>
                    ) : null}
                  </Stack>
                ) : (
                  <Text size="sm" tone="secondary">
                    {t("publicPresence.welcome.referral.position.pending")}
                  </Text>
                )}
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
