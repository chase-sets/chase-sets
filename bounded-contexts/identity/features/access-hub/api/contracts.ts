import type { Account } from "../../accounts/ui/contracts";
import type { ApiKey } from "../../api-keys/ui/contracts";
import type { Invitation } from "../../invitations/ui/contracts";
import type { Membership } from "../../memberships/ui/contracts";
import type { User } from "../../users/ui/contracts";

export type ApiKeyRotationAttention = ApiKey &
  Readonly<{
    account_id: string;
    account_display_name: string;
    last_rotated_at: string;
    rotation_due_at: string;
  }>;

export type AccessAttentionQueue = Readonly<{
  pending_invitations: readonly Invitation[];
  api_keys_needing_rotation: readonly ApiKeyRotationAttention[];
  suspended_accounts: readonly Account[];
  memberships_awaiting_review: readonly Membership[];
}>;

export type AccessHome = Readonly<{
  accounts: readonly Account[];
  account_total: number;
  attention: AccessAttentionQueue;
}>;

export type AccountAuditEvent = Readonly<{
  event_id: string;
  stream_id: string;
  event_type: string;
  performed_by_user_id: string;
  recorded_at: string;
}>;

export type AccountAccessHub = Readonly<{
  account: Account;
  users: readonly User[];
  memberships: readonly Membership[];
  invitations: readonly Invitation[];
  api_keys: readonly ApiKey[];
  audit_events: readonly AccountAuditEvent[];
}>;

export type UserAccountLink = Readonly<{ account_id: string | null }>;
