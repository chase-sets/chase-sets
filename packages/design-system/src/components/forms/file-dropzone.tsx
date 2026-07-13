import { forwardRef, useId, useRef, useState } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { FieldChrome, fieldDescribedBy, type BaseInputProps } from "./shared";

export interface FileDropzoneProps extends BaseInputProps {
  id?: string;
  name?: string;
  form?: string;
  accept?: string;
  multiple?: boolean;
  onFilesChange?: (files: FileList | null) => void;
  dropLabel?: string;
  browseLabel?: string;
}

export const FileDropzone = forwardRef<HTMLInputElement, FileDropzoneProps>(function FileDropzone(
  {
    id,
    name,
    label,
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    form,
    accept,
    multiple = false,
    onFilesChange,
    dropLabel = "Drop files here",
    browseLabel = "or choose from your device",
  },
  ref,
) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleDragOver(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(true);
  }

  function handleDragLeave(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    if (inputRef.current) {
      inputRef.current.files = event.dataTransfer.files;
    }
    onFilesChange?.(event.dataTransfer.files);
  }

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      status={status}
      counter={counter}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <label
        htmlFor={inputId}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cx(
          "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-tokenLg border border-dashed bg-background px-4 py-8 text-center transition",
          dragging ? "border-accent bg-elevated" : "border-muted",
        )}
      >
        <Icon name="package" size="lg" tone="accent" />
        <div className="space-y-1">
          <div className="text-sm font-semibold text-foreground">{dropLabel}</div>
          <div className="text-xs text-secondary">{browseLabel}</div>
        </div>
        <input
          ref={(node) => {
            inputRef.current = node;
            if (typeof ref === "function") {
              ref(node);
            } else if (ref) {
              ref.current = node;
            }
          }}
          id={inputId}
          name={name}
          form={form}
          accept={accept}
          multiple={multiple}
          required={required}
          type="file"
          aria-describedby={fieldDescribedBy({ inputId, description, error, status, counter })}
          aria-invalid={!!error || undefined}
          className="sr-only"
          onChange={(event) => onFilesChange?.(event.target.files)}
        />
      </label>
    </FieldChrome>
  );
});
FileDropzone.displayName = "FileDropzone";
