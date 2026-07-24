import type { HTMLAttributes, ReactNode } from "react";
import { TableCell, TableHeadCell, TableRow, TableShell, type TableDensity } from "./table-shell";

export interface TableProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  columns: ReactNode[];
  rows: ReactNode[][];
  caption?: ReactNode;
  /** Override the theme-derived cell density. Defaults to the surrounding `ChaseRoot` density. */
  density?: TableDensity;
}

export function Table({ columns, rows, caption, density, ...rest }: TableProps) {
  return (
    <TableShell {...rest} surface="modern" caption={caption}>
      <thead>
        <TableRow head surface="modern">
          {columns.map((column, index) => (
            <TableHeadCell key={index} density={density}>
              {column}
            </TableHeadCell>
          ))}
        </TableRow>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <TableRow key={rowIndex} surface="modern">
            {row.map((cell, cellIndex) => (
              <TableCell key={cellIndex} density={density}>
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </tbody>
    </TableShell>
  );
}
