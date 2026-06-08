import type { InputHTMLAttributes } from "react";

export interface HiddenInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "children" | "className" | "style" | "type"
> {
  type?: "hidden";
}

export function HiddenInput({ type = "hidden", readOnly = true, ...rest }: HiddenInputProps) {
  return <input {...rest} type={type} readOnly={readOnly} />;
}

export interface HoneypotInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "children" | "className" | "style" | "type"
> {
  name: string;
}

export function HoneypotInput({ name, tabIndex = -1, autoComplete = "off", ...rest }: HoneypotInputProps) {
  return <input {...rest} type="text" name={name} tabIndex={tabIndex} autoComplete={autoComplete} aria-hidden hidden />;
}
