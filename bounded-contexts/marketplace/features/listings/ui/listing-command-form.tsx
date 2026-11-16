import { useRef, useState, type ComponentProps } from "react";
import { Form, HiddenInput } from "@chase-sets/design-system";
import { useListingRecovery } from "./listing-batch-recovery";

/** One mounted form owns its attempt until the seller changes the request. No durable browser storage. */
export function ListingCommandForm({ children, onChange, onSubmit, ...props }: ComponentProps<typeof Form>) {
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const revision = useRef(0);
  const recovery = useListingRecovery();
  const write = props.method?.toLowerCase() === "post";
  const disabled =
    props.disabled ||
    (write &&
      Boolean(
        recovery &&
        (recovery.busy ||
          (recovery.recovery &&
            (recovery.recovery.phase === "ambiguous" ||
              recovery.recovery.items.some((item) => item.outcome !== "unknown")))),
      ));
  return (
    <Form
      {...props}
      disabled={disabled}
      onSubmit={(event) => {
        onSubmit?.(event);
        if (event.defaultPrevented || !write || !recovery) return;
        event.preventDefault();
        if (disabled) return;
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        const form = new FormData(event.currentTarget);
        if (submitter?.name) form.set(submitter.name, submitter.value);
        const version = revision.current;
        void recovery.submit(form, () => revision.current === version);
      }}
      onChange={(event) => {
        revision.current++;
        setIdempotencyKey(crypto.randomUUID());
        onChange?.(event);
      }}
    >
      <HiddenInput name="idempotencyKey" value={idempotencyKey} />
      {children}
    </Form>
  );
}
