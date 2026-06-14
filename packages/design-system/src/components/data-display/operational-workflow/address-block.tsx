import { type HTMLAttributes, type ReactNode } from "react";
import { Cluster, Surface } from "../../../primitives/layout";
import { Subheading } from "../../../primitives/typography";
import { CopyButton } from "../../actions/copy-button";

export interface AddressBlockProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  lines: readonly ReactNode[];
  copyValue?: string;
  copyLabel?: string;
}

/**
 * Address block: a titled card listing the lines of a postal address with an
 * optional one-tap copy control, used for ship-to and bill-to detail on a
 * fulfillment workstation.
 */
export function AddressBlock({ title, lines, copyValue, copyLabel = "Copy", ...rest }: AddressBlockProps) {
  const visibleLines = lines.filter(Boolean);

  return (
    <Surface {...rest} element="section" tone="subtle" gap={3}>
      <Cluster align="start" justify="between" gap={3}>
        <Subheading level={2}>{title}</Subheading>
        {copyValue ? <CopyButton value={copyValue} label={copyLabel} size="sm" tone="secondary" /> : null}
      </Cluster>
      <address className="not-italic text-sm leading-6 text-foreground">
        {visibleLines.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
      </address>
    </Surface>
  );
}
