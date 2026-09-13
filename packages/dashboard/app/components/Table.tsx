import type { ReactNode } from "react";
import {
  Table as ShadTable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
export type Column<T> = {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
};

/**
 * Minimal table shared by every page, now on shadcn/ui's Table primitives (which bring
 * their own rounded border, sticky header treatment and mobile scroll container). No
 * client interactivity, so this renders from server components.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  empty?: string;
}) {
  if (rows.length === 0) {
    return <p className="empty">{empty ?? "Nothing to show."}</p>;
  }
  return (
    <ShadTable>
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHead key={col.key}>{col.label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={rowKey(row, i)}>
            {columns.map((col) => (
              <TableCell key={col.key}>
                {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? "")}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </ShadTable>
  );
}
