import type { HTMLAttributes, ReactNode } from "react";
import { TableCell, TableHeadCell, TableRow, TableShell } from "./table-shell";

export interface TableProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  columns: ReactNode[];
  rows: ReactNode[][];
  caption?: ReactNode;
}

export function Table({ columns, rows, caption, ...rest }: TableProps) {
  return (
    <TableShell {...rest} surface="modern" caption={caption}>
      <thead>
        <TableRow head surface="modern">
          {columns.map((column, index) => (
            <TableHeadCell key={index}>{column}</TableHeadCell>
          ))}
        </TableRow>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <TableRow key={rowIndex} surface="modern">
            {row.map((cell, cellIndex) => (
              <TableCell key={cellIndex}>{cell}</TableCell>
            ))}
          </TableRow>
        ))}
      </tbody>
    </TableShell>
  );
}
