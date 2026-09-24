"use client";
import { useState, useTransition } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { changePasswordAction, issueMcpTokenAction } from "@/server/actions/settings";

export function PasswordForm() {
  const [key, setKey] = useState(0);
  return (
    <ActionForm key={key} action={changePasswordAction} submit="Сменить пароль" onDone={() => setKey(key + 1)} className="flex max-w-sm flex-col gap-4">
      <FormField name="current" label="Текущий пароль"><Input type="password" name="current" required autoComplete="current-password" /></FormField>
      <FormField name="next" label="Новый пароль" hint="Не короче 10 символов"><Input type="password" name="next" required autoComplete="new-password" /></FormField>
      <FormField name="repeat" label="Повторите"><Input type="password" name="repeat" required autoComplete="new-password" /></FormField>
    </ActionForm>
  );
}

export function McpToken({ exists, url }: { exists: boolean; url: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();
  const issue = () => start(async () => { const r = await issueMcpTokenAction(); if (r.error) toast(r.error, "error"); else { setToken(String(r.data?.token)); toast(r.message ?? "Готово"); } });
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div><div className="text-xs text-muted">URL для коннектора Claude</div><code className="font-mono text-xs">{url}</code></div>
      {token && (
        <div className="rounded-lg border border-warning/40 bg-warning-soft p-3">
          <div className="mb-1 text-xs text-warning">Токен показывается один раз — сохраните его сейчас</div>
          <div className="flex items-center gap-2"><code className="flex-1 font-mono text-xs break-all">{token}</code>
            <Button size="sm" onClick={() => { navigator.clipboard?.writeText(token); toast("Скопировано"); }}>Копировать</Button></div>
        </div>
      )}
      <div><Button size="sm" variant={exists ? "secondary" : "primary"} disabled={pending} onClick={() => (exists ? setConfirm(true) : issue())}>{exists ? "Перевыпустить токен" : "Выпустить токен"}</Button></div>
      <Confirm open={confirm} onOpenChange={setConfirm} title="Перевыпустить MCP-токен?" confirmLabel="Перевыпустить" destructive
        body="Старый токен сразу перестанет работать — коннектор в Claude нужно будет обновить." onConfirm={issue} />
    </div>
  );
}
