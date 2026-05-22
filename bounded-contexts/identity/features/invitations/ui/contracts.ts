export type Invitation = Readonly<{
  invitation_id: string;
  account_id: string;
  account_display_name?: string | null;
  account_name?: string | null;
  email: string;
  role_key: string;
  status: string;
  expires_at: string;
  accepted_by_user_id: string | null;
  accepted_by_user_display_name?: string | null;
  accepted_by_user_primary_email?: string | null;
  updated_at: string;
}>;
