export type Membership = Readonly<{
  membership_id: string;
  user_id: string;
  user_display_name?: string | null;
  user_primary_email?: string | null;
  account_id: string;
  account_display_name?: string | null;
  account_name?: string | null;
  role_key: string;
  status: string;
  updated_at: string;
}>;
