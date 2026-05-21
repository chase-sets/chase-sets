import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ToastRegion } from "@chase-sets/design-system";

type ToastTone = "success" | "danger" | "warning" | "info" | "accent";

interface ToastEntry {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  open: boolean;
}

interface ToastContextValue {
  addToast: (title: string, tone?: ToastTone, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue>({
  addToast: () => {},
});

export function useToasts() {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const addToast = useCallback((title: string, tone: ToastTone = "success", description?: string) => {
    const id = `toast-${++nextId}`;
    setToasts((prev) => [...prev, { id, title, description, tone, open: true }]);
  }, []);

  const handleOpenChange = useCallback((id: string, open: boolean) => {
    if (!open) {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <ToastRegion
        items={toasts.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          tone: t.tone,
          open: t.open,
          onOpenChange: (open: boolean) => handleOpenChange(t.id, open),
        }))}
      />
    </ToastContext.Provider>
  );
}
