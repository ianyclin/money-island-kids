"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type StatusToastTone = "success" | "waiting" | "error";

type StatusToastValue = {
  id: number;
  message: string;
  tone: StatusToastTone;
};

const toneStyles: Record<StatusToastTone, React.CSSProperties> = {
  success: { background: "#174f49", color: "#fffdf7" },
  waiting: { background: "#fff0ba", color: "#59430b", border: "1px solid #e8cb6f" },
  error: { background: "#8f3650", color: "#fffafc" },
};

const toneIcons: Record<StatusToastTone, string> = {
  success: "✓",
  waiting: "⌛",
  error: "!",
};

export function useStatusToast() {
  const serial = useRef(0);
  const [toast, setToast] = useState<StatusToastValue | null>(null);
  const showStatus = useCallback((message: string, tone: StatusToastTone = "success") => {
    const cleanMessage = message.trim();
    if (!cleanMessage) return;
    serial.current += 1;
    setToast({ id: serial.current, message: cleanMessage, tone });
  }, []);
  const dismissStatus = useCallback(() => setToast(null), []);
  return { toast, showStatus, dismissStatus };
}

export function StatusToast({
  toast,
  onDismiss,
}: {
  toast: StatusToastValue | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(onDismiss, toast.tone === "error" ? 7000 : 4500);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast]);

  if (!toast) return null;
  return (
    <div
      key={toast.id}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      style={{
        ...toneStyles[toast.tone],
        alignItems: "center",
        borderRadius: 18,
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 20px)",
        boxShadow: "0 14px 38px rgba(19, 64, 59, .22)",
        display: "flex",
        gap: 12,
        left: "50%",
        maxWidth: "calc(100vw - 32px)",
        minHeight: 56,
        padding: "10px 10px 10px 16px",
        position: "fixed",
        transform: "translateX(-50%)",
        width: 520,
        zIndex: 10000,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          alignItems: "center",
          background: "rgba(255,255,255,.2)",
          borderRadius: 999,
          display: "inline-flex",
          flex: "0 0 32px",
          fontSize: 18,
          fontWeight: 800,
          height: 32,
          justifyContent: "center",
        }}
      >
        {toneIcons[toast.tone]}
      </span>
      <strong style={{ flex: 1, fontSize: 15, lineHeight: 1.45 }}>{toast.message}</strong>
      <button
        type="button"
        aria-label="關閉提示"
        onClick={onDismiss}
        style={{
          alignItems: "center",
          background: "transparent",
          border: 0,
          borderRadius: 999,
          color: "inherit",
          cursor: "pointer",
          display: "inline-flex",
          flex: "0 0 44px",
          fontSize: 24,
          height: 44,
          justifyContent: "center",
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
