"use client";
import { ActionForm } from "@/components/forms/action-form";
import { Input } from "@/components/ui/input";
import { removeMemberAction, renameMemberAction } from "@/server/actions/tasks";

export function TeamRow({ id, name, open }: { id: string; name: string; open: number }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-2">
      <ActionForm action={renameMemberAction} submit="Сохранить" submitSize="sm" submitVariant="secondary" className="flex flex-1 items-center gap-2 [&>div:last-child]:pt-0">
        <input type="hidden" name="id" value={id} />
        <Input name="name" defaultValue={name} className="max-w-64" aria-label="Имя" />
      </ActionForm>
      <span className="text-xs text-muted">открытых задач: {open}</span>
      <ActionForm action={removeMemberAction} submit="Удалить" className="inline" submitVariant="ghost" submitSize="sm">
        <input type="hidden" name="id" value={id} />
      </ActionForm>
    </li>
  );
}
