"use client";
// Sidebar 240px, collapses to 56px (state in localStorage). Freshness indicator at the bottom:
// yellow dot when older than 2 h, red when the last run failed.
import {
  ArrowLeftRight, BarChart3, ChevronDown, ChevronsLeft, ChevronsRight, CircleDollarSign, Globe, LayoutDashboard, Layers, LogOut, Moon, Settings,
  Sun, TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Tip } from "@/components/ui/tooltip";
import { Logo } from "./logo";
import { cn } from "@/lib/cn";
import { fmtAgo } from "@/lib/format";
import { logoutAction } from "@/server/actions/auth";

export interface SidebarProps {
  bundles: { slug: string; title: string; color: string }[];
  counts: { alerts: number; deals: number };
  freshness: { source: string; label: string; lastOk: string | null; failed: boolean }[];
  mcpConnected: boolean;
}

const NAV = [
  { href: "/", label: "Сводка", icon: LayoutDashboard },
  { href: "/finance", label: "Финансы", icon: CircleDollarSign },
  { href: "/bundles", label: "Бандлы", icon: Layers, bundles: true },
  { href: "/sites", label: "Сайты", icon: BarChart3 },
  { href: "/geo", label: "Гео", icon: Globe },
  { href: "/deals", label: "Фикс-дилы", icon: ArrowLeftRight, count: "deals" as const },
  { href: "/alerts", label: "Алерты", icon: TriangleAlert, count: "alerts" as const },
];

export function Sidebar({ bundles, counts, freshness, mcpConnected }: SidebarProps) {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [bundlesOpen, setBundlesOpen] = useState(true);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem("sidebar") === "1"); } catch {}
    setDark(document.documentElement.dataset.theme === "dark");
  }, []);
  const toggle = () => { setCollapsed((c) => { try { localStorage.setItem("sidebar", c ? "0" : "1"); } catch {} return !c; }); };
  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    if (next) document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch {}
  };
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const item = (active: boolean) => cn("flex h-9 items-center gap-3 rounded-lg px-3 text-sm transition-colors",
    active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-hover hover:text-text", collapsed && "justify-center px-0");

  return (
    <aside className={cn("sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-surface transition-[width]", collapsed ? "w-14" : "w-60")}>
      <div className={cn("flex h-16 items-center gap-2 px-5", collapsed && "justify-center px-0")}>
        <Logo />
        {!collapsed && <span className="text-[17px] font-semibold tracking-[-0.01em]">TubeStat</span>}
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2" aria-label="Основная навигация">
        {NAV.map((n) => {
          const Icon = n.icon;
          const count = n.count ? counts[n.count] : 0;
          const link = (
            <Link href={n.href} className={item(isActive(n.href))} aria-current={isActive(n.href) ? "page" : undefined}>
              <Icon className="size-[18px] shrink-0" />
              {!collapsed && <span className="flex-1">{n.label}</span>}
              {!collapsed && count > 0 && <span className="num rounded-full bg-negative-soft px-1.5 text-[11px] font-medium text-negative">{count}</span>}
              {!collapsed && n.bundles && bundles.length > 0 && (
                <button aria-label="Показать бандлы" onClick={(e) => { e.preventDefault(); setBundlesOpen((o) => !o); }} className="rounded p-0.5 hover:bg-surface">
                  <ChevronDown className={cn("size-3.5 transition-transform", !bundlesOpen && "-rotate-90")} />
                </button>
              )}
            </Link>
          );
          return (
            <div key={n.href}>
              {collapsed ? <Tip content={n.label}>{link}</Tip> : link}
              {n.bundles && !collapsed && bundlesOpen && (
                <div className="mt-0.5 mb-1 flex flex-col gap-0.5 pl-9">
                  {bundles.map((b) => (
                    <Link key={b.slug} href={`/bundles/${b.slug}`}
                      className={cn("flex h-7 items-center gap-2 rounded-md px-2 text-[13px]", path === `/bundles/${b.slug}` ? "text-accent" : "text-muted hover:text-text")}>
                      <span className="size-2 rounded-full" style={{ background: b.color }} />{b.title}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="my-2 border-t border-border" />
        <Link href="/settings/sites" className={item(path.startsWith("/settings"))}>
          <Settings className="size-[18px] shrink-0" />{!collapsed && "Настройки"}
        </Link>
      </nav>
      <div className="flex flex-col gap-1 border-t border-border p-2">
        {!collapsed && (
          <Link href="/settings/integrations" className="flex flex-col gap-1 rounded-lg px-3 py-2 text-xs hover:bg-surface-hover">
            {freshness.map((f) => {
              const stale = !f.lastOk || Date.now() - Date.parse(f.lastOk) > 2 * 3_600_000;
              return (
                <span key={f.source} className="flex items-center gap-2 text-muted">
                  <span className={cn("size-2 rounded-full", f.failed ? "bg-negative" : stale ? "bg-warning" : "bg-positive")} />
                  <span className="flex-1">{f.label}</span>
                  <span className="text-faint">{f.lastOk ? fmtAgo(f.lastOk) : "нет данных"}</span>
                </span>
              );
            })}
            <span className="flex items-center gap-2 text-muted">
              <span className={cn("size-2 rounded-full", mcpConnected ? "bg-positive" : "bg-faint")} />
              <span className="flex-1">MCP</span><span className="text-faint">{mcpConnected ? "подключён" : "нет токена"}</span>
            </span>
          </Link>
        )}
        <div className={cn("flex items-center gap-1", collapsed ? "flex-col" : "justify-between px-1")}>
          <button onClick={toggleTheme} className="rounded-md p-2 text-muted hover:bg-surface-hover" aria-label="Сменить тему">{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
          <form action={logoutAction}><button className="rounded-md p-2 text-muted hover:bg-surface-hover" aria-label="Выйти"><LogOut className="size-4" /></button></form>
          <button onClick={toggle} className="rounded-md p-2 text-muted hover:bg-surface-hover" aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}>
            {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          </button>
        </div>
      </div>
    </aside>
  );
}
