// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { ToastProvider } from "@/components/ui/toast";

afterEach(cleanup);

function Host({ action }: { action: Parameters<typeof ActionForm>[0]["action"] }) {
  const [shown, setShown] = useState(true);
  return (
    <ToastProvider>
      {shown && (
        <ActionForm action={action} submit="Сохранить" onDone={() => setShown(false)}>
          <FormField name="x" label="X"><input name="x" defaultValue="1" /></FormField>
        </ActionForm>
      )}
    </ToastProvider>
  );
}

describe("ActionForm", () => {
  it("shows the success toast even though the form unmounts right away", async () => {
    render(<Host action={async () => ({ ok: true, message: "Период внесён" })} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); });
    expect(await screen.findByText("Период внесён")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
  });

  it("puts a field error under the field and a general error in a toast", async () => {
    const { unmount } = render(<Host action={async () => ({ error: "Неверно", field: "x" })} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); });
    expect(await screen.findByText("Неверно")).toBeTruthy();
    unmount();
    render(<Host action={async () => ({ error: "Сеть недоступна" })} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); });
    expect(await screen.findByText("Сеть недоступна")).toBeTruthy();
  });
});
