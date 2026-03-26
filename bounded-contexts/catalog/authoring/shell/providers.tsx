import type { ReactNode } from "react";
import { ToastProvider } from "../support/ui/toasts";

export function CatalogAdminProviders({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

