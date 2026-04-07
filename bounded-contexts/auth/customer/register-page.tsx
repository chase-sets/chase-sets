import { AuthFormPage } from "./ui/auth-form-page";

export function RegisterPage(props: Readonly<{
  action?: string;
  errorMessage?: string | null;
  hiddenFields?: readonly { name: string; value: string }[];
}>) {
  return (
    <AuthFormPage
      title="Create Account"
      description="Create your personal identity and owner account to start buying and selling."
      fields={[
        { key: "displayName", label: "Display Name", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "password", label: "Password", type: "password", required: true },
      ]}
      ctaLabel="Create Account"
      action={props.action}
      hiddenFields={props.hiddenFields}
      errorMessage={props.errorMessage}
    />
  );
}
