import { AuthFormPage } from "../shell-support/ui/customer-pages";

export function RegisterPage() {
  return (
    <AuthFormPage
      title="Create Account"
      description="Create your personal identity and owner account to start buying and selling."
      fields={[
        { key: "displayName", label: "Display Name" },
        { key: "email", label: "Email", type: "email" },
        { key: "password", label: "Password", type: "password" },
      ]}
      ctaLabel="Create Account"
    />
  );
}
