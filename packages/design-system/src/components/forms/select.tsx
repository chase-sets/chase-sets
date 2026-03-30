import { useId } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Icon } from "../../icons";
import { usePortalRoots } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { FieldChrome, controlClass, type BaseInputProps } from "./shared";

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps extends BaseInputProps {
  id?: string;
  items: SelectItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function Select({
  label,
  description,
  error,
  required,
  hideLabel,
  items,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Choose an option",
  disabled = false
}: SelectProps) {
  const fallbackId = useId();
  const { overlayNode } = usePortalRoots();

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={fallbackId}
    >
      <SelectPrimitive.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          id={fallbackId}
          className={cx(
            controlClass,
            "inline-flex items-center justify-between gap-2 text-left"
          )}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon>
            <Icon name="chevronDown" size="sm" tone="secondary" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal container={overlayNode ?? undefined}>
          <SelectPrimitive.Content
            position="popper"
            className="modern-surface z-popover min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-tokenLg border border-muted shadow-overlay"
          >
            <SelectPrimitive.Viewport className="p-2">
              {items.map((item) => (
                <SelectPrimitive.Item
                  key={item.value}
                  value={item.value}
                  disabled={item.disabled}
                  className="focus-ring relative flex cursor-pointer select-none items-center rounded-tokenMd px-3 py-2 text-sm text-foreground outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-background"
                >
                  <SelectPrimitive.ItemText>
                    <div className="space-y-0.5">
                      <div>{item.label}</div>
                      {item.description ? (
                        <div className="text-xs text-secondary">
                          {item.description}
                        </div>
                      ) : null}
                    </div>
                  </SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </FieldChrome>
  );
}
