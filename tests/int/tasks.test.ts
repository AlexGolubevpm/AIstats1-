import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork } from "@tests/factories/network";
import { RuleError } from "@/server/domain/errors";
import { getTasks } from "@/server/mcp/tools";
import { taskBoard, taskOptions, tasksInWork, tasksOfHypothesis } from "@/server/queries/tasks";
import { createTask, deleteTask, moveTask, removeMember, renameMember, taskFromHypothesis, updateTask } from "@/server/services/tasks";
import { resetDb, testDb } from "./helpers";

const db = testDb();
beforeEach(async () => { await resetDb(); await buildNetwork(db); });

describe("tasks (ADR 0021)", () => {
  it("create, edit every field with an audit line each, a new name joins the team, an advertiser is created by name", async () => {
    const id = await createTask(db, { title: "Поднять флор баннеров" });
    await expect(createTask(db, { title: " " })).rejects.toMatchObject({ field: "title" });
    await expect(createTask(db, { title: "x", startDate: "2026-11-10", dueDate: "2026-11-01" })).rejects.toMatchObject({ field: "dueDate" });
    await updateTask(db, id, { title: "Поднять флор баннеров", assignee: " Даниил ", impact: "REVENUE", impactMonth: "250", siteId: "s1", format: "BANNER", advertiser: "Acme Ads", dueDate: "2026-11-20", priority: "HIGH" });
    const t = await db.task.findUniqueOrThrow({ where: { id }, include: { advertiser: true } });
    expect(t).toMatchObject({ assignee: "Даниил", impact: "REVENUE", siteId: "s1", format: "BANNER", priority: "HIGH", status: "BACKLOG" });
    expect(Number(t.impactMonth)).toBe(250); expect(t.advertiser?.name).toBe("Acme Ads");
    expect((await taskOptions()).team.map((m) => m.name)).toEqual(["Даниил"]);
    const fields = (await db.auditLog.findMany({ where: { entity: "Task", entityId: id } })).map((a) => a.field).sort();
    expect(fields).toEqual(["advertiserId", "assignee", "created", "dueDate", "format", "impact", "impactMonth", "priority", "siteId"]);
    expect(await updateTask(db, id, { title: "Поднять флор баннеров", assignee: "Даниил", impact: "REVENUE", impactMonth: "250.00", siteId: "s1", format: "BANNER", advertiser: "Acme Ads", dueDate: "2026-11-20", priority: "HIGH" })).toBe(0);
  });

  it("drag and drop: between two cards, to the top, to another column; «Готово» stamps doneAt and leaving clears it", async () => {
    const a = await createTask(db, { title: "A" }), b = await createTask(db, { title: "B" }), c = await createTask(db, { title: "C" });
    let board = await taskBoard({});
    expect(board.BACKLOG.map((t) => t.title)).toEqual(["A", "B", "C"]);
    await moveTask(db, c, "BACKLOG", a, b);
    expect((await taskBoard({})).BACKLOG.map((t) => t.title)).toEqual(["A", "C", "B"]);
    await moveTask(db, b, "BACKLOG", null, a);
    expect((await taskBoard({})).BACKLOG.map((t) => t.title)).toEqual(["B", "A", "C"]);
    await moveTask(db, a, "IN_PROGRESS");
    expect(await tasksInWork()).toBe(1);
    await moveTask(db, a, "DONE");
    expect((await db.task.findUniqueOrThrow({ where: { id: a } })).doneAt).not.toBeNull();
    await moveTask(db, a, "TESTING");
    expect((await db.task.findUniqueOrThrow({ where: { id: a } })).doneAt).toBeNull();
    expect((await db.auditLog.findMany({ where: { entityId: a, field: "status" }, orderBy: { at: "asc" } })).map((x) => x.after)).toEqual(["IN_PROGRESS", "DONE", "TESTING"]);
    await expect(moveTask(db, a, "NOPE" as never)).rejects.toBeInstanceOf(RuleError);
    board = await taskBoard({});
    expect(board.TESTING.map((t) => t.id)).toEqual([a]);
  });

  it("filters and periods narrow the board; MCP reads the same", async () => {
    await createTask(db, { title: "Nov", assignee: "Даниил", siteId: "s1", impact: "COST", dueDate: "2026-11-15" });
    await createTask(db, { title: "Dec", assignee: "Алексей", siteId: "s2", startDate: "2026-12-01", dueDate: "2026-12-10" });
    await createTask(db, { title: "Undated" });
    const titles = async (f: Parameters<typeof taskBoard>[0]) => Object.values(await taskBoard(f, "2026-11-05")).flat().map((t) => t.title).sort();
    expect(await titles({ assignee: "Даниил" })).toEqual(["Nov"]);
    expect(await titles({ assignee: "-" })).toEqual(["Undated"]);
    expect(await titles({ siteId: "s2" })).toEqual(["Dec"]);
    expect(await titles({ impact: "COST" })).toEqual(["Nov"]);
    expect(await titles({ period: "month" })).toEqual(["Nov"]);
    expect(await titles({ period: "next_month" })).toEqual(["Dec"]);
    expect(await titles({ period: "week" })).toEqual([]);
    expect(await titles({})).toEqual(["Dec", "Nov", "Undated"]);
    expect((await getTasks({ site: "one.test" })).map((t) => [t.title, t.site, t.assignee])).toEqual([["Nov", "one.test", "Даниил"]]);
  });

  it("a task from a hypothesis carries its site, format, effect and what it moves; the team can be renamed and emptied", async () => {
    const h = await db.hypothesis.create({ data: { source: "AUTO", status: "PROPOSED", scope: "format", siteId: "s1", format: "BANNER", title: "Срезать расход", hypothesis: "если так, то этак", metric: "cost_share", impactMonth: "300" } });
    const id = await taskFromHypothesis(db, h.id);
    expect(await db.task.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: "Срезать расход", siteId: "s1", format: "BANNER", impact: "COST", hypothesisId: h.id, status: "BACKLOG" });
    expect((await tasksOfHypothesis(h.id)).map((t) => t.id)).toEqual([id]);
    await updateTask(db, id, { title: "Срезать расход", assignee: "Даня", hypothesisId: h.id, siteId: "s1", format: "BANNER", impact: "COST", impactMonth: "300" });
    const m = (await taskOptions()).team[0];
    await renameMember(db, m.id, "Даниил");
    expect((await db.task.findUniqueOrThrow({ where: { id } })).assignee).toBe("Даниил");
    await removeMember(db, m.id);
    expect((await db.task.findUniqueOrThrow({ where: { id } })).assignee).toBeNull();
    await deleteTask(db, id);
    expect(await db.auditLog.findFirst({ where: { entityId: id, field: "deleted" } })).not.toBeNull();
  });
});
