import type { ReactNode } from "react";

export function InfoTip({ children, label = "查看說明", align = "left" }: { children: ReactNode; label?: string; align?: "left" | "right" }) {
  return (
    <details className={`info-tip info-tip-${align}`}>
      <summary aria-label={label} title={label}>❔</summary>
      <div className="info-tip-popover" role="note">{children}</div>
    </details>
  );
}
