"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type Toast = { id: number; text: string; tone: "ok" | "error" };
const Ctx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});

/** Bottom-right toasts: 4 s for success, errors stay until closed. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, tone }]);
    if (tone === "ok") setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cn("card flex items-start gap-3 px-4 py-3 text-sm", t.tone === "error" && "border-negative/40")}>
            <span className={cn("mt-1 size-2 shrink-0 rounded-full", t.tone === "error" ? "bg-negative" : "bg-positive")} />
            <span className="flex-1">{t.text}</span>
            <button className="text-muted hover:text-text" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} aria-label="Закрыть">×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
export const useToast = () => useContext(Ctx);
