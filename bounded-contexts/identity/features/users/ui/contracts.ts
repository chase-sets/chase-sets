export type User = Readonly<{
  user_id: string;
  display_name: string;
  given_name: string;
  family_name: string;
  primary_email: string | null;
  status: string;
  contact_methods: readonly UserContactMethod[];
  auth_methods: readonly string[];
  updated_at: string;
}>;

export type UserContactMethod = Readonly<{
  contactMethodId: string;
  type: string;
  value: string;
  verifiedAt: string | null;
}>;
