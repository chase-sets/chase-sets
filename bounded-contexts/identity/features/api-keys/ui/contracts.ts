export type ApiKey = Readonly<{
  api_key_id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  status: string;
  last_used_at: string | null;
  updated_at: string;
}>;
