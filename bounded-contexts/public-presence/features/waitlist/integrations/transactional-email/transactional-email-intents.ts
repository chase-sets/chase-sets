import { createTransactionalEmailNotificationMessage, type NotificationMessage } from "@chase-sets/outbound-messaging";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

const PUBLIC_ORIGIN = "https://chasesets.com";
const MARKETPLACE_ORIGIN = "https://marketplace.chasesets.com";

export const WAITLIST_NURTURE_SEQUENCE = [
  { step: "welcome", ageDays: 0 },
  { step: "fee-lock", ageDays: 3 },
  { step: "open-offers", ageDays: 7 },
  { step: "wave-approaching", ageDays: 14 },
] as const;

export type WaitlistNurtureStep = (typeof WAITLIST_NURTURE_SEQUENCE)[number]["step"] | "wave-admitted";

export type WaitlistNurtureEmailIntentInput = Readonly<{
  email: string;
  signupId: string;
  correlationId: string;
}>;

export type WaitlistNurtureSequenceIntentInput = WaitlistNurtureEmailIntentInput &
  Readonly<{
    recordedAt: string;
  }>;

export type WaitlistAdmissionEmailIntentInput = WaitlistNurtureEmailIntentInput &
  Readonly<{
    accountId: AccountId;
    betaAccessStartedAt: string;
    foundersWindowEndsAt: string;
    missingCohortFields: readonly string[];
  }>;

export function waitlistNurtureAvailableAt(recordedAt: string, ageDays: number) {
  const value = new Date(recordedAt);
  value.setUTCDate(value.getUTCDate() + ageDays);
  return value.toISOString();
}

export function mapWaitlistSignupRecordedToNurtureEmails(
  input: WaitlistNurtureSequenceIntentInput,
): readonly Readonly<{ message: NotificationMessage; availableAt: string; step: WaitlistNurtureStep }>[] {
  return WAITLIST_NURTURE_SEQUENCE.map(({ step, ageDays }) => ({
    step,
    availableAt: waitlistNurtureAvailableAt(input.recordedAt, ageDays),
    message: mapWaitlistNurtureEmail(step, input),
  }));
}

export function mapWaitlistNurtureEmail(
  step: Exclude<WaitlistNurtureStep, "wave-admitted">,
  input: WaitlistNurtureEmailIntentInput,
): NotificationMessage {
  const referralLink = trackedReferralLink(input.signupId, step);
  const welcomeLink = trackedPublicUrl(`/welcome?signup=${encodeURIComponent(input.signupId)}`, step, "welcome");
  const common = {
    messageType: `public-presence.waitlist-nurture.${step}` as const,
    criticality: "operational" as const,
    category: "operational" as const,
    to: [{ email: input.email }] as const,
    templateVersion: 1,
    locale: "en",
    idempotencyKey: `public-presence:waitlist-nurture:${input.signupId}:${step}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  };

  if (step === "welcome") {
    return createTransactionalEmailNotificationMessage({
      ...common,
      subject: "Welcome to Chase Sets early access",
      templateId: "waitlist_nurture_welcome",
      templateData: {
        headline: "You are on the early access list.",
        intro:
          "Chase Sets opens to everyone September 1, 2026. Before then, beta access opens in measured invite waves.",
        founders:
          "Beta access starts a 60-day window: listings confirmed during that window lock a 0% marketplace sales fee. Your first listing or offer claims a numbered founder badge while one of 500 remains.",
        foundersTermsLink: trackedPublicUrl("/founders", step, "founders_terms"),
        discordInviteLink: trackedPublicUrl(
          `/welcome?signup=${encodeURIComponent(input.signupId)}`,
          step,
          "discord_invite",
        ),
        referralLink,
      },
    });
  }

  if (step === "fee-lock") {
    return createTransactionalEmailNotificationMessage({
      ...common,
      subject: "How a listing locks its fee terms",
      templateId: "waitlist_nurture_fee_lock",
      templateData: {
        headline: "The fee lock is a listing rule, not a temporary coupon.",
        intro:
          "When you confirm a listing, its units keep the fee terms you reviewed. A later schedule change does not replace those locked terms; newly added units lock the terms in effect when they are added.",
        founders:
          "For an admitted founder, the same rule locks 0% on listings confirmed during the 60-day founders window. Listings confirmed after the window use the standard schedule.",
        detailsLink: trackedPublicUrl("/sales-fees", step, "sales_fees"),
        referralLink,
      },
    });
  }

  if (step === "open-offers") {
    return createTransactionalEmailNotificationMessage({
      ...common,
      subject: "Open offers turn an ISO post into an order",
      templateId: "waitlist_nurture_open_offers",
      templateData: {
        headline: "Post the card and price you want once. Any matching seller can accept.",
        intro:
          "An accepted open offer becomes a marketplace order with checkout fee and shipping shown before payment. The 30-second demo is still in production, so the current preview explains the shipped workflow without pretending the clip is live.",
        detailsLink: trackedPublicUrl("/#open-offers", step, "open_offers_preview"),
        referralLink,
      },
    });
  }

  return createTransactionalEmailNotificationMessage({
    ...common,
    subject: "Get ready for your Chase Sets invite wave",
    templateId: "waitlist_nurture_wave_approaching",
    templateData: {
      headline: "Invite waves are approaching; public launch is September 1, 2026.",
      intro:
        "Market context is part of the product direction, but per-grade price guides are not a shipped promise. For now, prepare the listing facts the marketplace can use on day one.",
      checklist:
        "Choose the games you sell; note a realistic inventory-size range; keep a TCGplayer or eBay store link handy; prepare clear front-and-back photos and grading certification details where applicable.",
      detailsLink: welcomeLink,
      referralLink,
    },
  });
}

export function mapFoundersWindowOpenedToAdmissionEmail(input: WaitlistAdmissionEmailIntentInput): NotificationMessage {
  const step = "wave-admitted" as const;
  const missingAsk =
    input.missingCohortFields.length > 0
      ? `One quick ask before you start: add ${formatNaturalList(input.missingCohortFields)} so we can finish your wave-placement profile.`
      : "Your wave-placement profile is complete. Start with the first-listing walkthrough when you are ready.";

  return createTransactionalEmailNotificationMessage({
    messageType: "public-presence.waitlist-nurture.wave-admitted",
    criticality: "operational",
    category: "operational",
    recipientAccountId: input.accountId,
    to: [{ email: input.email }],
    subject: "Your Chase Sets beta access is open",
    templateId: "waitlist_nurture_wave_admitted",
    templateVersion: 1,
    locale: "en",
    templateData: {
      headline: "You are in. Your 60-day founders window starts now.",
      intro: `Your window starts ${formatDate(input.betaAccessStartedAt)} and ends ${formatDate(input.foundersWindowEndsAt)}. Listings confirmed before it ends lock a 0% marketplace sales fee.`,
      missingAsk,
      detailsLink:
        input.missingCohortFields.length > 0
          ? trackedPublicUrl(`/welcome?signup=${encodeURIComponent(input.signupId)}`, step, "complete_wave_profile")
          : trackedMarketplaceUrl("/account/sell-list", step, "first_listing_walkthrough"),
      preferencesLink: trackedMarketplaceUrl("/?notifications=settings", step, "email_preferences"),
      referralLink: trackedReferralLink(input.signupId, step),
    },
    idempotencyKey: `public-presence:waitlist-nurture:${input.signupId}:${step}:${input.betaAccessStartedAt}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: input.accountId },
  });
}

function trackedReferralLink(signupId: string, step: WaitlistNurtureStep) {
  return `${PUBLIC_ORIGIN}/?ref=${encodeURIComponent(signupId)}&utm_source=referral&utm_medium=waitlist_email&utm_campaign=waitlist_nurture&utm_content=${step}`;
}

function trackedPublicUrl(path: string, step: WaitlistNurtureStep, content: string) {
  return trackedUrl(PUBLIC_ORIGIN, path, step, content);
}

function trackedMarketplaceUrl(path: string, step: WaitlistNurtureStep, content: string) {
  return trackedUrl(MARKETPLACE_ORIGIN, path, step, content);
}

function trackedUrl(origin: string, path: string, step: WaitlistNurtureStep, content: string) {
  const [pathnameAndQuery, hash] = path.split("#", 2);
  const separator = pathnameAndQuery.includes("?") ? "&" : "?";
  return `${origin}${pathnameAndQuery}${separator}utm_source=waitlist_email&utm_medium=email&utm_campaign=waitlist_nurture&utm_content=${content}_${step}${hash ? `#${hash}` : ""}`;
}

function formatNaturalList(values: readonly string[]) {
  if (values.length <= 1) return values[0] ?? "your missing details";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(value),
  );
}

export function mapWaitlistAdmissionToTransactionalEmail(input: {
  email: string;
  signupId: string;
  waveNumber: number;
  correlationId: string;
}): NotificationMessage {
  return createTransactionalEmailNotificationMessage({
    messageType: "public-presence.waitlist-signup.admitted",
    criticality: "operational",
    to: [{ email: input.email }],
    subject: `Your Chase Sets beta wave ${input.waveNumber} invite`,
    templateId: "waitlist_beta_invitation",
    templateVersion: 1,
    locale: "en",
    templateData: {
      headline: `You are invited to beta wave ${input.waveNumber}.`,
      intro: "Create your Chase Sets account with this email to enter the beta.",
      registrationPath: "/register",
    },
    idempotencyKey: `public-presence:beta-invitation:${input.signupId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  });
}
