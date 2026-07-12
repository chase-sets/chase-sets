export type Account = Readonly<{
  account_id: string;
  name: string;
  display_name: string;
  account_type: string;
  status: string;
  badges: readonly string[];
  founder_number?: number | null;
  founders_window_started_at?: string | null;
  founders_window_ends_at?: string | null;
  updated_at: string;
}>;
