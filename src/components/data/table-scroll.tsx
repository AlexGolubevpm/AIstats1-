import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Horizontal scroll container for a hand-written table inside a card: the table keeps its natural
 * width (numbers on one line, `.tbl`) and scrolls under the card's edges instead of squeezing the
 * page — on a phone an over-wide block makes the browser zoom the whole layout out.
 */
export function TableScroll({ children, className, flush }: { children: ReactNode; className?: string; flush?: boolean }) {
  return <div className={cn("ts-scroll overflow-x-auto", flush ? "" : "-mx-5 px-5", className)}>{children}</div>;
}
