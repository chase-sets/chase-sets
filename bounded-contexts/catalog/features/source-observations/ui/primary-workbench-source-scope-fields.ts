import type {
  CatalogPrimaryWorkbenchSourceOptionPageState,
  CatalogPrimaryWorkbenchSourceOptionsStatus,
} from "../api/primary-workbench-admin-contracts";

export type CatalogPrimaryWorkbenchSourceOptionTone = "success" | "warning" | "danger" | "info" | "neutral";

export function sourceOptionsStatusTone(
  status: CatalogPrimaryWorkbenchSourceOptionsStatus,
): CatalogPrimaryWorkbenchSourceOptionTone {
  switch (status) {
    case "ready":
      return "success";
    case "degraded":
      return "warning";
    case "blocked":
      return "danger";
    case "unavailable":
      return "neutral";
  }
}

export function sourceOptionPageStateTone(
  state: CatalogPrimaryWorkbenchSourceOptionPageState,
): CatalogPrimaryWorkbenchSourceOptionTone {
  switch (state) {
    case "live":
      return "success";
    case "cached":
      return "info";
    case "stale":
      return "warning";
    case "unavailable":
    case "rollout-blocked":
      return "danger";
    case "not-requested":
      return "neutral";
  }
}
