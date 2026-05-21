import { useEffect, useState, type ReactNode } from "react";
import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { Icon } from "../../icons";
import { usePortalRoots } from "../../theme/provider";
import { IconButton } from "../actions";
import { type Tone, toneIcon } from "./shared";

export interface ToastItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  tone?: Exclude<Tone, "neutral">;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  dismissLabel?: string;
}

export interface ToastRegionProps {
  items?: ToastItem[];
  timeout?: number;
  limit?: number;
  manager?: ToastManager;
}

export interface ToastData {
  tone: Exclude<Tone, "neutral">;
  dismissLabel: string;
}

export type ToastManager = ReturnType<typeof ToastPrimitive.createToastManager<ToastData>>;

export const defaultToastManager = ToastPrimitive.createToastManager<ToastData>();
export const toastManager = defaultToastManager;

export interface ToastProviderProps {
  children?: ReactNode;
  timeout?: number;
  limit?: number;
  manager?: ToastManager;
}

export interface ShowToastOptions extends Omit<ToastItem, "id" | "open" | "onOpenChange"> {
  id?: string;
  timeout?: number;
  priority?: "low" | "high";
}

export function ToastProvider({
  children,
  timeout = 4000,
  limit = 3,
  manager = defaultToastManager,
}: ToastProviderProps) {
  return (
    <ToastPrimitive.Provider timeout={timeout} limit={limit} toastManager={manager}>
      {children}
    </ToastPrimitive.Provider>
  );
}

export function useToast() {
  return ToastPrimitive.useToastManager<ToastData>();
}

export function showToast({
  id,
  title,
  description,
  tone = "info",
  dismissLabel = "Dismiss notification",
  timeout,
  priority,
}: ShowToastOptions) {
  return defaultToastManager.add({
    id,
    title,
    description,
    type: tone,
    timeout,
    priority,
    data: {
      tone,
      dismissLabel,
    },
  });
}

function ToastRegionItem({
  toast,
  onDismiss,
}: {
  toast: ToastPrimitive.Root.ToastObject<ToastData>;
  onDismiss: () => void;
}) {
  const tone = toast.data?.tone ?? "info";

  return (
    <ToastPrimitive.Root
      toast={toast}
      swipeDirection="right"
      className="modern-surface rounded-tokenLg border border-muted shadow-overlay"
    >
      <ToastPrimitive.Content className="grid grid-cols-[auto_1fr_auto] items-start gap-3 p-4">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-background">
          <Icon name={toneIcon(tone)} size="sm" tone={tone} />
        </div>
        <div className="min-w-0 space-y-1">
          <ToastPrimitive.Title className="text-sm font-semibold text-foreground" />
          <ToastPrimitive.Description className="text-sm text-secondary" />
        </div>
        <div className="self-start">
          <IconButton
            label={toast.data?.dismissLabel ?? "Dismiss notification"}
            icon="close"
            tone="ghost"
            size="sm"
            onClick={onDismiss}
          />
        </div>
      </ToastPrimitive.Content>
    </ToastPrimitive.Root>
  );
}

function ToastRegionContent({ items = [], timeout = 4000 }: Pick<ToastRegionProps, "items" | "timeout">) {
  const { toastNode } = usePortalRoots();
  const toastManager = ToastPrimitive.useToastManager<ToastData>();
  const [openById, setOpenById] = useState<Record<string, boolean>>({});

  useEffect(() => {
    items.forEach((item) => {
      const resolvedOpen = item.open ?? openById[item.id] ?? true;

      if (!resolvedOpen) {
        toastManager.close(item.id);
        return;
      }

      toastManager.add({
        id: item.id,
        title: item.title,
        description: item.description,
        type: item.tone ?? "info",
        timeout,
        data: {
          tone: item.tone ?? "info",
          dismissLabel: item.dismissLabel ?? "Dismiss notification",
        },
        onClose: () => {
          if (item.open === undefined) {
            setOpenById((current) => ({ ...current, [item.id]: false }));
          }
          item.onOpenChange?.(false);
        },
      });
    });
  }, [items, openById, timeout]);

  const { toasts } = toastManager;

  return (
    <ToastPrimitive.Portal container={toastNode ?? undefined}>
      <ToastPrimitive.Viewport className="fixed inset-x-0 bottom-0 z-toast mx-auto flex w-full max-w-md flex-col gap-3 p-4 outline-none">
        {toasts.map((toast) => (
          <ToastRegionItem key={toast.id} toast={toast} onDismiss={() => toastManager.close(toast.id)} />
        ))}
      </ToastPrimitive.Viewport>
    </ToastPrimitive.Portal>
  );
}

export function ToastRegion(props: ToastRegionProps) {
  const { items = [], timeout = 4000, limit = 3, manager = defaultToastManager } = props;

  return (
    <ToastProvider timeout={timeout} limit={limit} manager={manager}>
      <ToastRegionContent items={items} timeout={timeout} />
    </ToastProvider>
  );
}
