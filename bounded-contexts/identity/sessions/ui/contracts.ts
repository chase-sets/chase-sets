export type Session = Readonly<{
  session_id: string;
  user_id: string;
  account_id: string;
  available_account_ids: readonly string[];
  authentication_method: string;
  status: string;
  expires_at: string;
  updated_at: string;
}>;
