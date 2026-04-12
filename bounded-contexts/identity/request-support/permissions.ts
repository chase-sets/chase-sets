import {
  hasPermission as hasActorPermission,
  type ResolvedActor,
} from "@chase-sets/platform-runtime/auth";
import type { PermissionKey } from "../common";

export function hasPermission(
  actor: ResolvedActor | null | undefined,
  permission: PermissionKey,
) {
  return hasActorPermission(actor, permission);
}
