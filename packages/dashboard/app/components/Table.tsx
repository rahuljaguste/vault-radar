import type { ReactNode } from "react";

export type Column<T> = {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
};

/**
 * Minimal table shared by every page. No client interactivity, so this can
 * be rendered from server components. Zebra striping and monospace font
 * come from `app/globals.css`.
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
    <table>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key}>{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey(row, i)}>
            {columns.map((col) => (
              <td key={col.key}>{col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? "")}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
