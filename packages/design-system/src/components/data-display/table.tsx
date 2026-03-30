import type { HTMLAttributes, ReactNode } from "react";

export interface TableProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  columns: ReactNode[];
  rows: ReactNode[][];
  caption?: ReactNode;
}

export function Table({
  columns,
  rows,
  caption,
  ...rest
}: TableProps) {
  return (
    <div
      {...rest}
      className="modern-surface overflow-x-auto rounded-tokenLg border border-muted shadow-tokenSm"
    >
      <table className="min-w-full border-collapse text-left text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-muted bg-background">
            {columns.map((column, index) => (
              <th key={index} className="px-4 py-3 font-semibold text-foreground">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-muted last:border-b-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-4 py-3 text-secondary">
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
