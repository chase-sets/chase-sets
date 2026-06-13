import { useId } from "react";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "../../lib/utils";

export interface RadioItem {
  value: string;
  label: string;
  description?: string;
}

export function RadioGroup({
  label,
  items,
  value,
  defaultValue,
  onValueChange,
}: {
  label: string;
  items: RadioItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}) {
  const groupLabelId = useId();

  return (
    <div className="grid gap-2">
      <div id={groupLabelId} className="text-sm font-medium">
        {label}
      </div>
      <RadioGroupPrimitive
        aria-labelledby={groupLabelId}
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        className="grid gap-2"
      >
        {items.map((item) => {
          const itemLabelId = `${groupLabelId}-${item.value}-label`;
          const itemDescriptionId = item.description ? `${groupLabelId}-${item.value}-description` : undefined;

          return (
            <Radio.Root
              key={item.value}
              value={item.value}
              nativeButton
              aria-labelledby={itemLabelId}
              aria-describedby={itemDescriptionId}
              className={(state) =>
                cn(
                  "ds-panel flex w-full cursor-pointer items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--muted)] p-3 text-left transition-colors",
                  state.checked && "border-[var(--primary)] bg-[var(--secondary)]",
                )
              }
              render={<button type="button" />}
            >
              <span className="ds-focus mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-tokenFull border border-[var(--border)] bg-[var(--card)]">
                <Radio.Indicator className="h-2.5 w-2.5 rounded-tokenFull bg-[var(--primary)]" />
              </span>
              <span className="grid gap-1">
                <span id={itemLabelId} className="text-sm font-medium">
                  {item.label}
                </span>
                {item.description ? (
                  <span id={itemDescriptionId} className="text-xs text-[var(--muted-foreground)]">
                    {item.description}
                  </span>
                ) : null}
              </span>
            </Radio.Root>
          );
        })}
      </RadioGroupPrimitive>
    </div>
  );
}
