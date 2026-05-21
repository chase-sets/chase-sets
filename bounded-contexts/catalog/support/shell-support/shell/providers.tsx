import type { ReactNode } from "react";
import { ToastProvider } from "../ui/toasts";

export function CatalogAdminProviders({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
