import type { ReactNode } from "react";
import { SettingsNav } from "./nav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <header><h1 className="text-[24px] leading-8 font-semibold tracking-[-0.01em]">Настройки</h1>
        <p className="mt-0.5 text-sm text-muted">Ничего здесь не удаляет факты: архивирование скрывает, история остаётся</p></header>
      <div className="grid gap-6 md:grid-cols-[180px_1fr]">
        <aside><SettingsNav /></aside>
        <div className="flex min-w-0 flex-col gap-6">{children}</div>
      </div>
    </div>
  );
}
