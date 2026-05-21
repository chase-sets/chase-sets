export type Account = Readonly<{
  account_id: string;
  name: string;
  display_name: string;
  account_type: string;
  status: string;
  badges: readonly string[];
  updated_at: string;
}>;
