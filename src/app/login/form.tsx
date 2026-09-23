"use client";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { loginAction } from "@/server/actions/auth";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(loginAction, {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Пароль" error={state?.error}>
        <Input type="password" name="password" autoFocus required autoComplete="current-password" />
      </Field>
      <Button variant="primary" disabled={pending}>{pending ? "Входим…" : "Войти"}</Button>
    </form>
  );
}
