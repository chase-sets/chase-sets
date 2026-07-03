export type ApiKey = Readonly<{
  api_key_id: string;
  user_id: string;
  user_display_name?: string | null;
  user_primary_email?: string | null;
  name: string;
  key_prefix: string;
  status: string;
  last_used_at: string | null;
  updated_at: string;
}>;

export type { OneTimeApiKeySecret } from "../api/one-time-secret";
