"use client";
import * as T from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export function Tip({ content, children }: { content: ReactNode; children: ReactNode }) {
  if (!content) return <>{children}</>;
  return (
    <T.Provider delayDuration={150}>
      <T.Root>
        <T.Trigger asChild><span className="inline-flex">{children}</span></T.Trigger>
        <T.Portal>
          <T.Content sideOffset={6} className="z-50 max-w-xs rounded-md bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-lg">
            {content}
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
