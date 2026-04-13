import { useState } from "react";
import {
  AlertDialog,
  Button,
  Inline,
  StatusPill,
} from "@chase-sets/design-system";

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
      {transitions.map((t) =>
        t.confirm ? (
          <AlertDialog
            key={t.action}
            open={confirming?.action === t.action}
            onOpenChange={(open) => !open && setConfirming(null)}
            title={t.confirmTitle ?? `${t.label}?`}
            description={t.confirmDescription ?? `Are you sure you want to ${t.label.toLowerCase()} this item?`}
            confirmLabel={t.label}
            cancelLabel="Cancel"
            tone="danger"
            onConfirm={() => handleAction(t.action)}
            trigger={
              <Button
                tone={t.tone ?? "secondary"}
                size="sm"
                disabled={loading || actionLoading}
                onClick={() => setConfirming(t)}
              >
                {t.label}
              </Button>
            }
          />
        ) : (
          <Button
            key={t.action}
            tone={t.tone ?? "secondary"}
            size="sm"
            disabled={loading || actionLoading}
            onClick={() => handleAction(t.action)}
          >
            {t.label}
          </Button>
        ),
      )}
    </Inline>
  );
}

