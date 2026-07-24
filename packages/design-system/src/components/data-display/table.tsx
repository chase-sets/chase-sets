import type { HTMLAttributes, ReactNode } from "react";
import { TableCell, TableHeadCell, TableRow, TableShell, type TableDensity } from "./table-shell";

export interface TableProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  columns: ReactNode[];
  rows: ReactNode[][];
  caption?: ReactNode;
  /** Override the theme-derived cell density. Defaults to the surrounding `ChaseRoot` density. */
  density?: TableDensity;
  /**
   * Wrap the first column's label (including mid-word breaks) instead of
   * letting a long unbreakable word force the table wider than its
   * container. Applies to the header cell and every row's first cell.
   */
  wrapFirstColumn?: boolean;
}

export function Table({ columns, rows, caption, density, wrapFirstColumn = false, ...rest }: TableProps) {
  return (
    <TableShell {...rest} surface="modern" caption={caption}>
      <thead>
        <TableRow head surface="modern">
          {columns.map((column, index) => (
            <TableHeadCell
              key={index}
              density={density}
              wrapLabel={wrapFirstColumn && index === 0}
              lang={wrapFirstColumn && index === 0 ? "en" : undefined}
            >
              {column}
            </TableHeadCell>
          ))}
        </TableRow>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <TableRow key={rowIndex} surface="modern">
            {row.map((cell, cellIndex) => (
              <TableCell
                key={cellIndex}
                density={density}
                wrapLabel={wrapFirstColumn && cellIndex === 0}
                lang={wrapFirstColumn && cellIndex === 0 ? "en" : undefined}
              >
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </tbody>
    </TableShell>
  );
}
