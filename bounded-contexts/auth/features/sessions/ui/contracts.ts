export type Session = Readonly<{
  session_id: string;
  user_id: string;
  user_display_name?: string | null;
  user_primary_email?: string | null;
  account_id: string;
  account_display_name?: string | null;
  account_name?: string | null;
  available_account_ids: readonly string[];
  authentication_method: string;
  status: string;
  expires_at: string;
  updated_at: string;
}>;
