import type { HTMLAttributes, ReactNode } from "react";
import { useDensity } from "../../theme/provider";

export interface TableProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  columns: ReactNode[];
  rows: ReactNode[][];
  caption?: ReactNode;
}

export function Table({ columns, rows, caption, ...rest }: TableProps) {
  const density = useDensity();
  const cellPad = density === "compact" ? "px-3 py-2" : "px-4 py-3";

  return (
    <div {...rest} className="modern-surface overflow-x-auto rounded-tokenLg border border-muted shadow-tokenSm">
      <table className="min-w-full border-collapse text-left text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-muted bg-background">
            {columns.map((column, index) => (
              <th key={index} className={`${cellPad} font-semibold text-foreground`}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className="border-b border-muted transition-colors hover:bg-background/60 last:border-b-0"
            >
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className={`${cellPad} text-foreground`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
