"use client";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { snoozeAlertAction, unsnoozeAlertAction } from "@/server/actions/alerts";

export function SnoozeButton({ id, snoozed }: { id: string; snoozed: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(() => (snoozed ? unsnoozeAlertAction(id) : snoozeAlertAction(id)))}>
      {snoozed ? "Вернуть" : "Принято к сведению"}
    </Button>
  );
}
