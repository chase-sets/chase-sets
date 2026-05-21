import { t } from "@chase-sets/localization";
import { useState } from "react";
import { AlertDialog, Button, Inline, StatusPill } from "@chase-sets/design-system";

export interface Transition {
  label: string;
  action: string;
  tone?: "primary" | "secondary" | "danger";
  confirm?: boolean;
  confirmTitle?: string;
  confirmDescription?: string;
}

interface LifecycleControlsProps {
  status: string;
  transitions: Transition[];
  onAction: (action: string) => Promise<void>;
  loading?: boolean;
}

const statusTone: Record<string, "accent" | "success" | "warning" | "danger" | "neutral"> = {
  draft: "neutral",
  active: "success",
  published: "success",
  deprecated: "warning",
  retired: "warning",
  archived: "danger",
};

export function LifecycleControls({ status, transitions, onAction, loading }: LifecycleControlsProps) {
  const [confirming, setConfirming] = useState<Transition | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  async function handleAction(action: string) {
    setActionLoading(true);
    try {
      await onAction(action);
    } finally {
      setActionLoading(false);
      setConfirming(null);
    }
  }

  return (
    <Inline gap={2}>
      <StatusPill tone={statusTone[status] ?? "neutral"}>{status}</StatusPill>
      {transitions.map((transition) =>
        transition.confirm ? (
          <AlertDialog
            key={transition.action}
            open={confirming?.action === transition.action}
            onOpenChange={(open) => !open && setConfirming(null)}
            title={
              transition.confirmTitle ??
              t("catalog.support.shellSupport.ui.lifecycleControls.confirm.action.title", { action: transition.label })
            }
            description={
              transition.confirmDescription ??
              t("catalog.support.shellSupport.ui.lifecycleControls.confirm.action.description", {
                action: transition.label.toLowerCase(),
              })
            }
            confirmLabel={transition.label}
            cancelLabel={t("catalog.support.shellSupport.ui.lifecycleControls.cancel")}
            tone="danger"
            onConfirm={() => handleAction(transition.action)}
            trigger={
              <Button
                tone={transition.tone ?? "secondary"}
                size="sm"
                disabled={loading || actionLoading}
                onClick={() => setConfirming(transition)}
              >
                {transition.label}
              </Button>
            }
          />
        ) : (
          <Button
            key={transition.action}
            tone={transition.tone ?? "secondary"}
            size="sm"
            disabled={loading || actionLoading}
            onClick={() => handleAction(transition.action)}
          >
            {transition.label}
          </Button>
        ),
      )}
    </Inline>
  );
}
