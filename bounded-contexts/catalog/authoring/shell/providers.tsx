import type { ReactNode } from "react";
import { ToastProvider } from "../shell-support/ui/toasts";

export function CatalogAdminProviders({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

