import { and, asc, desc, eq, gt, like, lt, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

const START_TITLE_SUFFIX = '已开始';
const START_MESSAGE_SUFFIX = '已开始执行';
const RUNNING_TITLE_SUFFIX = '进行中';
const RUNNING_MESSAGE_SUFFIX = '正在执行';
const LEGACY_INTERRUPTED_SUFFIX = '异常中断';
const DEFAULT_GRACE_MS = 2 * 60 * 1000;
const START_SCAN_LIMIT = 1000;
const TERMINAL_MARKERS = [
  '已完成',
  '完成',
  '失败',
  '异常',
  '中断',
  'completed',
  'finished',
  'failed',
  'error',
];
const TERMINAL_TITLE_SPLIT_MARKERS = [
  '已完成',
  '完成',
  '失败',
  '异常中断',
  '异常',
  '中断',
  'completed',
  'finished',
  'failed',
  'error',
];

type EventRow = typeof schema.events.$inferSelect;

function normalizeTaskTitle(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function deriveTaskTitle(row: Pick<EventRow, 'title' | 'message'>): string | null {
  const message = typeof row.message === 'string' ? row.message.trim() : '';
  if (message.endsWith(START_MESSAGE_SUFFIX)) {
    const title = normalizeTaskTitle(message.slice(0, -START_MESSAGE_SUFFIX.length));
    if (title) return title;
  }
  if (message.endsWith(RUNNING_MESSAGE_SUFFIX)) {
    const title = normalizeTaskTitle(message.slice(0, -RUNNING_MESSAGE_SUFFIX.length));
    if (title) return title;
  }

  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (title.endsWith(START_TITLE_SUFFIX)) {
    const taskTitle = normalizeTaskTitle(title.slice(0, -START_TITLE_SUFFIX.length));
    if (taskTitle) return taskTitle;
  }
  if (title.endsWith(RUNNING_TITLE_SUFFIX)) {
    const taskTitle = normalizeTaskTitle(title.slice(0, -RUNNING_TITLE_SUFFIX.length));
    if (taskTitle) return taskTitle;
  }
  if (title.endsWith(LEGACY_INTERRUPTED_SUFFIX)) {
    const taskTitle = normalizeTaskTitle(title.slice(0, -LEGACY_INTERRUPTED_SUFFIX.length));
    if (taskTitle) return taskTitle;
  }

  return null;
}

function containsTaskTitleConditions(taskTitle: string) {
  const pattern = `%${taskTitle}%`;
  return or(
    like(schema.events.title, pattern),
    like(schema.events.message, pattern),
  );
}

function startEventConditions() {
  return or(
    like(schema.events.title, `%${START_TITLE_SUFFIX}`),
    like(schema.events.message, `%${START_MESSAGE_SUFFIX}`),
    like(schema.events.title, `%${RUNNING_TITLE_SUFFIX}`),
    like(schema.events.message, `%${RUNNING_MESSAGE_SUFFIX}`),
  );
}

function foldableTaskStartConditions() {
  return or(
    startEventConditions(),
    like(schema.events.title, `%${LEGACY_INTERRUPTED_SUFFIX}`),
    like(schema.events.message, '%未记录完成或失败结果%'),
  );
}

function isStartEvent(row: Pick<EventRow, 'title' | 'message'>) {
  return deriveTaskTitle(row) !== null;
}

function terminalEventConditions() {
  return or(...TERMINAL_MARKERS.flatMap((marker) => [
    like(schema.events.title, `%${marker}%`),
    like(schema.events.message, `%${marker}%`),
  ]));
}

function deriveTerminalTaskTitle(row: Pick<EventRow, 'title' | 'message'>): string | null {
  const values = [row.title, row.message].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  for (const value of values) {
    const firstLine = value.trim().split('\n')[0] || '';
    for (const marker of TERMINAL_TITLE_SPLIT_MARKERS) {
      const index = firstLine.indexOf(marker);
      if (index > 0) {
        const title = normalizeTaskTitle(firstLine.slice(0, index));
        if (title) return title;
      }
    }
  }
  return null;
}

function titleMatchScore(a: string, b: string) {
  const left = normalizeTaskTitle(a);
  const right = normalizeTaskTitle(b);
  if (!left || !right) return 0;
  if (left === right) return Math.max(left.length, right.length);
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length);

  let index = 0;
  const limit = Math.min(left.length, right.length);
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function buildTerminalMessage(message: string, startAt: string, endAt: string) {
  const lines = message
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('开始时间：') && !line.startsWith('结束时间：'));
  return [
    lines.join('\n') || '任务已结束',
    `开始时间：${startAt}`,
    `结束时间：${endAt}`,
  ].join('\n');
}

async function hasTerminalEventBetween(taskTitle: string, startAt: string, endBefore: string | null) {
  const conditions = [
    eq(schema.events.relatedType, 'task'),
    gt(schema.events.createdAt, startAt),
    terminalEventConditions(),
  ];
  if (endBefore) conditions.push(lt(schema.events.createdAt, endBefore));

  const rows = await db.select()
    .from(schema.events)
    .where(and(...conditions))
    .limit(50)
    .all();
  return rows.some((row) => {
    if (isStartEvent(row)) return false;
    const terminalTitle = deriveTerminalTaskTitle(row);
    return Boolean(terminalTitle && titleMatchScore(taskTitle, terminalTitle) >= 4);
  });
}

async function findNextStartAt(taskTitle: string, startAt: string) {
  const rows = await db.select({ createdAt: schema.events.createdAt })
    .from(schema.events)
    .where(and(
      eq(schema.events.relatedType, 'task'),
      gt(schema.events.createdAt, startAt),
      containsTaskTitleConditions(taskTitle),
      startEventConditions(),
    ))
    .orderBy(asc(schema.events.createdAt))
    .limit(1)
    .all();
  return rows[0]?.createdAt || null;
}

function buildInterruptedMessage(taskTitle: string, startedAt: string, endedAt: string) {
  return [
    `${taskTitle} 未记录完成或失败结果，服务重启后已标记为异常中断`,
    `开始时间：${startedAt}`,
    `结束时间：${endedAt}`,
  ].join('\n');
}

async function foldLegacyInsertedRepairEvents(now: Date) {
  const repairedAt = formatUtcSqlDateTime(now);
  const repairRows = await db.select()
    .from(schema.events)
    .where(and(
      eq(schema.events.relatedType, 'task'),
      like(schema.events.title, `%${LEGACY_INTERRUPTED_SUFFIX}`),
      like(schema.events.message, '%未记录完成或失败结果%'),
    ))
    .orderBy(asc(schema.events.createdAt), asc(schema.events.id))
    .limit(START_SCAN_LIMIT)
    .all();

  let folded = 0;
  for (const repairRow of repairRows) {
    const taskTitle = deriveTaskTitle(repairRow);
    if (!taskTitle) continue;

    const starts = await db.select()
      .from(schema.events)
      .where(and(
        eq(schema.events.relatedType, 'task'),
        lt(schema.events.createdAt, repairRow.createdAt || repairedAt),
        containsTaskTitleConditions(taskTitle),
        startEventConditions(),
      ))
      .orderBy(desc(schema.events.createdAt))
      .limit(1)
      .all();
    const startRow = starts[0];
    if (!startRow?.createdAt) continue;

    await db.update(schema.events)
      .set({
        title: `${taskTitle} 异常中断`,
        message: buildInterruptedMessage(taskTitle, startRow.createdAt, repairRow.createdAt || repairedAt),
        level: 'error',
      })
      .where(eq(schema.events.id, startRow.id))
      .run();
    await db.delete(schema.events).where(eq(schema.events.id, repairRow.id)).run();
    folded += 1;
  }
  return folded;
}

async function foldLegacyTerminalEvents() {
  const terminalRows = await db.select()
    .from(schema.events)
    .where(and(
      eq(schema.events.relatedType, 'task'),
      terminalEventConditions(),
    ))
    .orderBy(asc(schema.events.createdAt), asc(schema.events.id))
    .limit(START_SCAN_LIMIT)
    .all();

  let folded = 0;
  for (const terminalRow of terminalRows) {
    if (isStartEvent(terminalRow)) continue;
    if (typeof terminalRow.message === 'string' && terminalRow.message.includes('未记录完成或失败结果')) continue;

    const terminalTitle = deriveTerminalTaskTitle(terminalRow);
    if (!terminalTitle || !terminalRow.createdAt) continue;

    const startRows = await db.select()
      .from(schema.events)
      .where(and(
        eq(schema.events.relatedType, 'task'),
        lt(schema.events.createdAt, terminalRow.createdAt),
        foldableTaskStartConditions(),
      ))
      .orderBy(desc(schema.events.createdAt), desc(schema.events.id))
      .limit(20)
      .all();

    const matchedStart = startRows
      .map((row) => ({ row, taskTitle: deriveTaskTitle(row) }))
      .filter((item): item is { row: EventRow; taskTitle: string } => Boolean(item.taskTitle))
      .map((item) => ({
        ...item,
        score: titleMatchScore(item.taskTitle, terminalTitle),
      }))
      .filter((item) => item.score >= 4)
      .sort((a, b) => b.score - a.score)[0];

    if (!matchedStart?.row.createdAt) continue;

    await db.update(schema.events)
      .set({
        title: terminalRow.title,
        message: buildTerminalMessage(terminalRow.message || terminalRow.title, matchedStart.row.createdAt, terminalRow.createdAt),
        level: terminalRow.level,
      })
      .where(eq(schema.events.id, matchedStart.row.id))
      .run();
    await db.delete(schema.events).where(eq(schema.events.id, terminalRow.id)).run();
    folded += 1;
  }
  return folded;
}

export async function repairStaleBackgroundTaskEvents(
  now = new Date(),
  graceMs = DEFAULT_GRACE_MS,
): Promise<{ repaired: number }> {
  let repaired = await foldLegacyInsertedRepairEvents(now);
  const cutoff = formatUtcSqlDateTime(new Date(now.getTime() - Math.max(0, graceMs)));
  const startedEvents = await db.select()
    .from(schema.events)
    .where(and(
      eq(schema.events.relatedType, 'task'),
      lt(schema.events.createdAt, cutoff),
      startEventConditions(),
    ))
    .orderBy(desc(schema.events.createdAt))
    .limit(START_SCAN_LIMIT)
    .all();

  for (const event of startedEvents.reverse()) {
    const taskTitle = deriveTaskTitle(event);
    const startAt = event.createdAt || '';
    if (!taskTitle || !startAt) continue;

    const nextStartAt = await findNextStartAt(taskTitle, startAt);
    if (await hasTerminalEventBetween(taskTitle, startAt, nextStartAt)) continue;

    await db.update(schema.events)
      .set({
        title: `${taskTitle} 异常中断`,
        message: buildInterruptedMessage(taskTitle, startAt, formatUtcSqlDateTime(now)),
        level: 'error',
      })
      .where(eq(schema.events.id, event.id))
      .run();
    repaired += 1;
  }
  repaired += await foldLegacyTerminalEvents();

  if (repaired > 0) {
    console.warn(`[background-task] repaired ${repaired} stale task start event(s) without terminal status`);
  }
  return { repaired };
}
