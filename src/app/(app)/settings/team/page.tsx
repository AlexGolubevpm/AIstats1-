import { Section } from "@/components/ui/card";
import { db } from "@/server/db";
import { TeamRow } from "./client";

/** The people tasks are assigned to (ADR 0021): no accounts, only names. A name typed on a task card lands here too. */
export default async function TeamSettings() {
  const [team, counts] = await Promise.all([
    db.teamMember.findMany({ orderBy: { name: "asc" } }),
    db.task.groupBy({ by: ["assignee"], _count: { _all: true }, where: { assignee: { not: null }, status: { not: "DONE" } } }),
  ]);
  const open = new Map(counts.map((c) => [c.assignee, c._count._all]));
  return (
    <Section title="Команда" sub="Исполнители задач на /tasks. Новое имя, вписанное в карточке задачи, появляется здесь само. Переименование меняет его во всех задачах; удаление оставляет задачи без исполнителя">
      {team.length === 0 ? <p className="py-4 text-sm text-muted">Пока никого — впишите исполнителя в карточке задачи</p> : (
        <ul className="-mx-5 divide-y divide-border/60" data-testid="team">
          {team.map((m) => <TeamRow key={m.id} id={m.id} name={m.name} open={open.get(m.name) ?? 0} />)}
        </ul>
      )}
    </Section>
  );
}
