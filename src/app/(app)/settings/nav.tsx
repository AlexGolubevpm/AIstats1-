"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const ITEMS = [["sites", "Сайты"], ["bundles", "Бандлы"], ["costs", "Закупка"], ["networks", "Сетки"], ["integrations", "Интеграции"], ["access", "Доступ"]];

export function SettingsNav() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Настройки">
      {ITEMS.map(([id, label]) => {
        const href = `/settings/${id}`, on = path.startsWith(href);
        return <Link key={id} href={href} aria-current={on ? "page" : undefined}
          className={cn("rounded-lg px-3 py-2 text-sm whitespace-nowrap", on ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-hover hover:text-text")}>{label}</Link>;
      })}
    </nav>
  );
}
