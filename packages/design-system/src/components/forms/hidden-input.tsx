import { forwardRef, type InputHTMLAttributes } from "react";

export interface HiddenInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "children" | "className" | "style" | "type"
> {
  type?: "hidden";
}

export const HiddenInput = forwardRef<HTMLInputElement, HiddenInputProps>(function HiddenInput(
  { type = "hidden", readOnly = true, ...rest },
  ref,
) {
  return <input {...rest} ref={ref} type={type} readOnly={readOnly} />;
});
HiddenInput.displayName = "HiddenInput";

export interface HoneypotInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "children" | "className" | "style" | "type"
> {
  name: string;
}

export const HoneypotInput = forwardRef<HTMLInputElement, HoneypotInputProps>(function HoneypotInput(
  { name, tabIndex = -1, autoComplete = "off", ...rest },
  ref,
) {
  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      name={name}
      tabIndex={tabIndex}
      autoComplete={autoComplete}
      aria-hidden
      hidden
    />
  );
});
HoneypotInput.displayName = "HoneypotInput";
