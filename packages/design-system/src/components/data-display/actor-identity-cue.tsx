import type { ReactNode } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { Badge } from "../feedback";
import { Card } from "./card";
import { Stat, StatGrid } from "./stat";

export type ActorIdentityCueVariant = "shell" | "panel";

export interface ActorIdentityCueProps {
  accountDetail?: ReactNode;
  accountLabel: ReactNode;
  accountName: ReactNode;
  className?: string;
  description?: ReactNode;
  membershipDetail?: ReactNode;
  membershipLabel: ReactNode;
  membershipName: ReactNode;
  title: ReactNode;
  userDetail?: ReactNode;
  userLabel: ReactNode;
  userName: ReactNode;
  variant?: ActorIdentityCueVariant;
}

export function ActorIdentityCue({
  accountDetail,
  accountLabel,
  accountName,
  className,
  description,
  membershipDetail,
  membershipLabel,
  membershipName,
  title,
  userDetail,
  userLabel,
  userName,
  variant = "shell",
}: ActorIdentityCueProps) {
  if (variant === "panel") {
    return (
      <div className={className}>
        <Card>
          <div className="space-y-4">
            <div className="max-w-3xl space-y-1">
              <div className="font-heading text-lg font-semibold text-foreground">{title}</div>
              {description ? <div className="text-sm leading-6 text-secondary">{description}</div> : null}
            </div>
            <StatGrid columns={{ base: 1, md: 3 }}>
              <Stat label={accountLabel} value={accountName} trend={accountDetail} />
              <Stat label={userLabel} value={userName} trend={userDetail} />
              <Stat label={membershipLabel} value={membershipName} trend={membershipDetail} />
            </StatGrid>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div
      className={cx(
        "flex min-w-0 max-w-[18rem] items-center gap-2 rounded-tokenMd border border-muted bg-surface px-3 py-2 shadow-tokenSm",
        className,
      )}
      aria-label={typeof title === "string" ? title : undefined}
    >
      <Icon name="user" size="sm" tone="secondary" />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-xs font-semibold text-foreground">
          {accountLabel} {accountName}
        </div>
        <div className="truncate text-2xs text-secondary">
          {userLabel} {userName}
        </div>
      </div>
      <Badge tone="neutral">{membershipName}</Badge>
    </div>
  );
}
