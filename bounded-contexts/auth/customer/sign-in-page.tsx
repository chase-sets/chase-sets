import { AuthFormPage } from "./ui/auth-form-page";

export function SignInPage(props: Readonly<{
  action?: string;
  errorMessage?: string | null;
  hiddenFields?: readonly { name: string; value: string }[];
}>) {
  return (
    <AuthFormPage
      title="Sign In"
      description="Use your email and password, a magic link, or a passkey to continue."
      fields={[
        { key: "email", label: "Email", type: "email", required: true },
        { key: "password", label: "Password", type: "password", required: true },
      ]}
      ctaLabel="Sign In"
      action={props.action}
      hiddenFields={props.hiddenFields}
      errorMessage={props.errorMessage}
    />
  );
}
