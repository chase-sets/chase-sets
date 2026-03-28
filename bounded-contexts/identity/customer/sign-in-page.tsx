import { AuthFormPage } from "../shell-support/ui/customer-pages";

export function SignInPage() {
  return (
    <AuthFormPage
      title="Sign In"
      description="Use your email and password, a magic link, or a passkey to continue."
      fields={[
        { key: "email", label: "Email", type: "email" },
        { key: "password", label: "Password", type: "password" },
      ]}
      ctaLabel="Sign In"
    />
  );
}
