import { t } from "@chase-sets/localization";
import { Badge, Inline, VisuallyHidden } from "@chase-sets/design-system";

export const accountBadgeKeys = ["founding-account", "manual-payout-review", "trusted-seller"] as const;
export type AccountBadgeKey = (typeof accountBadgeKeys)[number];

export const accountBadgeLabels: Record<AccountBadgeKey, string> = {
  "founding-account": t("identity.features.accounts.ui.accountBadges.founding.account"),
  "manual-payout-review": t("identity.features.accounts.ui.accountBadges.manual.payout.review"),
  "trusted-seller": t("identity.features.accounts.ui.accountBadges.trusted.seller"),
};

export function isAccountBadgeKey(value: string): value is AccountBadgeKey {
  return accountBadgeKeys.includes(value as AccountBadgeKey);
}

export function accountBadgeLabel(badgeKey: string) {
  return isAccountBadgeKey(badgeKey) ? accountBadgeLabels[badgeKey] : badgeKey;
}

export function AccountBadgeIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      height={16}
      viewBox="0 0 96 96"
      width={16}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path fill="var(--accent)" d="M48 6 80 18v26c0 21.5-12.6 36.6-32 46C28.6 80.6 16 65.5 16 44V18L48 6Z" />
      <path
        d="M48 12 74 22v22c0 17.2-9.6 29.8-26 38-16.4-8.2-26-20.8-26-38V22l26-10Z"
        fill="none"
        stroke="var(--surface)"
        strokeOpacity="0.88"
        strokeWidth="4"
      />
      <path
        fill="var(--surface)"
        d="m48 24 5.6 11.4 12.6 1.8-9.1 8.9 2.2 12.5L48 52.7 36.7 58.6l2.2-12.5-9.1-8.9 12.6-1.8L48 24Z"
      />
      <path fill="var(--foreground)" fillOpacity="0.18" d="M34 63h28a4 4 0 0 1 4 4v2H30v-2a4 4 0 0 1 4-4Z" />
      <path fill="var(--surface)" fillOpacity="0.92" d="M33 60h30a3 3 0 0 1 3 3v3H30v-3a3 3 0 0 1 3-3Z" />
      <path fill="var(--accent)" d="M37 58h22v4H37z" />
    </svg>
  );
}

export function AccountBadgeList({
  badges,
  compact = false,
  founderNumber,
}: {
  badges: readonly string[];
  compact?: boolean;
  founderNumber?: number | null;
}) {
  const accountBadges = badges.filter(isAccountBadgeKey);
  if (accountBadges.length === 0) {
    return null;
  }

  return (
    <Inline gap={1}>
      {accountBadges.map((badgeKey) => {
        const label =
          badgeKey === "founding-account" && founderNumber
            ? `${accountBadgeLabels[badgeKey]} #${String(founderNumber).padStart(3, "0")}`
            : accountBadgeLabels[badgeKey];
        return (
          <Badge key={badgeKey} tone="accent" title={label}>
            <AccountBadgeIcon />
            {compact ? <VisuallyHidden>{label}</VisuallyHidden> : label}
          </Badge>
        );
      })}
    </Inline>
  );
}
