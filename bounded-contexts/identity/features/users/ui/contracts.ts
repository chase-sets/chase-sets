export type User = Readonly<{
  user_id: string;
  display_name: string;
  given_name: string;
  family_name: string;
  primary_email: string;
  status: string;
  auth_methods: readonly string[];
  updated_at: string;
}>;
