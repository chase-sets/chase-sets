import { useState, type ComponentProps } from "react";
import { Form, HiddenInput } from "@chase-sets/design-system";

/** One mounted form owns its attempt until the seller changes the request. No durable browser storage. */
export function ListingCommandForm({ children, onChange, ...props }: ComponentProps<typeof Form>) {
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  return (
    <Form
      {...props}
      onChange={(event) => {
        setIdempotencyKey(crypto.randomUUID());
        onChange?.(event);
      }}
    >
      <HiddenInput name="idempotencyKey" value={idempotencyKey} />
      {children}
    </Form>
  );
}
