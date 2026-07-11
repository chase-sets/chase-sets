import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../../utils/cx";
import { Badge } from "../../feedback/badge";
import { OperationalStatusBanner } from "./operational-status-banner";

export type ConnectionLiveStatus = "live" | "connecting" | "stale";

export interface ConnectionStatusIndicatorProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "title"
> {
  status: ConnectionLiveStatus;
  liveLabel: ReactNode;
  connectingLabel?: ReactNode;
  staleLabel?: ReactNode;
  staleDescription?: ReactNode;
  action?: ReactNode;
}

const dotToneClasses: Record<Exclude<ConnectionLiveStatus, "stale">, string> = {
  live: "animate-pulse bg-info",
  connecting: "bg-muted",
};

/**
 * Connection live/stale indicator: a compact "live" badge with a reduced-
 * motion-aware pulse while a realtime stream or poll is actually advancing,
 * escalating to an `OperationalStatusBanner` once the connection has gone
 * quiet past the caller's staleness threshold. Copy comes entirely from props
 * so it stays localization-injectable, and the whole indicator sits in a
 * shared `aria-live="polite"` status region so a live-to-stale flip announces
 * to screen readers without the operator having to keep eyes on the badge.
 */
export function ConnectionStatusIndicator({
  status,
  liveLabel,
  connectingLabel,
  staleLabel,
  staleDescription,
  action,
  ...rest
}: ConnectionStatusIndicatorProps) {
  if (status === "stale") {
    return (
      <div {...rest} role="status" aria-live="polite">
        <OperationalStatusBanner
          tone="warning"
          title={staleLabel ?? liveLabel}
          description={staleDescription}
          action={action}
        />
      </div>
    );
  }

  return (
    <div {...rest} role="status" aria-live="polite">
      <Badge tone={status === "live" ? "info" : "neutral"}>
        <span aria-hidden="true" className={cx("inline-block h-1.5 w-1.5 rounded-tokenFull", dotToneClasses[status])} />
        {status === "live" ? liveLabel : (connectingLabel ?? liveLabel)}
      </Badge>
    </div>
  );
}
