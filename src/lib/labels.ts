// Display names shared by pages and the Telegram digest (src/lib so server code can use them too).
export const FORMAT_LABEL: Record<string, string> = {
  POPUNDER: "Popunder", BANNER: "Баннер", NATIVE: "Нативка", SLIDER: "Слайдер", OUTSTREAM: "Outstream", INVIDEO: "In-video", INPAGEPUSH: "In-page push", OTHER: "Другое",
};

/** Task board columns and priorities (ADR 0021); src/server/domain/tasks.ts re-exports them for the pages. */
export const TASK_STATUS_LABEL = { BACKLOG: "Бэклог", PLANNED: "Запланировано", IN_PROGRESS: "В работе", TESTING: "Тест", DONE: "Готово" } as const;
export const TASK_PRIORITY_LABEL = { LOW: "Низкий", NORMAL: "Обычный", HIGH: "Высокий" } as const;
