import { createContext, useContext, type ComponentProps, type ComponentType } from "react";
import { Form as CanonicalForm } from "@chase-sets/design-system";

type MutationFormProps = ComponentProps<typeof CanonicalForm> & {
  family: "listing-stock-ensure";
  targetId: string;
  enabled?: boolean;
  mutationIntents?: readonly string[];
};
const Forms = createContext<ComponentType<MutationFormProps>>(
  ({ family: _family, targetId: _target, enabled: _enabled, mutationIntents: _intents, ...props }) => (
    <CanonicalForm {...props} />
  ),
);
export const MutationFormProvider = Forms.Provider;
export function Form(props: MutationFormProps) {
  const Component = useContext(Forms);
  return <Component {...props} />;
}
