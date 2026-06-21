import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type RepairModule = typeof import('./backgroundTaskEventRepairService.js');

describe('background task event repair service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let repairStaleBackgroundTaskEvents: RepairModule['repairStaleBackgroundTaskEvents'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-background-task-repair-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const repairModule = await import('./backgroundTaskEventRepairService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    repairStaleBackgroundTaskEvents = repairModule.repairStaleBackgroundTaskEvents;
  });

  beforeEach(async () => {
    await db.delete(schema.events).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('marks stale started task events without terminal status as interrupted', async () => {
    await db.insert(schema.events).values({
      type: 'status',
      title: '自动刷新账号令牌模型列表已开始',
      message: '自动刷新账号令牌模型列表 已开始执行',
      level: 'info',
      relatedType: 'task',
      createdAt: '2026-06-20 00:00:00',
    }).run();

    const result = await repairStaleBackgroundTaskEvents(new Date('2026-06-20T00:10:00Z'));

    expect(result).toEqual({ repaired: 1 });
    const rows = await db.select().from(schema.events).orderBy(asc(schema.events.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: '自动刷新账号令牌模型列表 异常中断',
      level: 'error',
      relatedType: 'task',
    });
    expect(rows[0]?.message).toContain('开始时间：2026-06-20 00:00:00');
    expect(rows[0]?.message).toContain('结束时间：2026-06-20 00:10:00');
  });

  it('folds matching terminal status into the original started task event', async () => {
    await db.insert(schema.events).values([
      {
        type: 'status',
        title: '同步全部账号已开始',
        message: '同步全部账号 已开始执行',
        level: 'info',
        relatedType: 'task',
        createdAt: '2026-06-20 00:00:00',
      },
      {
        type: 'status',
        title: '同步全部账号 已完成',
        message: '同步全部账号 已完成',
        level: 'info',
        relatedType: 'task',
        createdAt: '2026-06-20 00:00:30',
      },
    ]).run();

    const result = await repairStaleBackgroundTaskEvents(new Date('2026-06-20T00:10:00Z'));

    expect(result).toEqual({ repaired: 1 });
    const rows = await db.select().from(schema.events).orderBy(asc(schema.events.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: '同步全部账号 已完成',
      message: [
        '同步全部账号 已完成',
        '开始时间：2026-06-20 00:00:00',
        '结束时间：2026-06-20 00:00:30',
      ].join('\n'),
      level: 'info',
    });
  });

  it('leaves recent started task events inside the grace window untouched', async () => {
    await db.insert(schema.events).values({
      type: 'status',
      title: '同步站点令牌已开始',
      message: '同步站点令牌 已开始执行',
      level: 'info',
      relatedType: 'task',
      createdAt: '2026-06-20 00:09:30',
    }).run();

    const result = await repairStaleBackgroundTaskEvents(new Date('2026-06-20T00:10:00Z'), 2 * 60 * 1000);

    expect(result).toEqual({ repaired: 0 });
    expect(await db.select().from(schema.events).all()).toHaveLength(1);
  });

  it('does not use a later run terminal event to complete an earlier stale start', async () => {
    await db.insert(schema.events).values([
      {
        type: 'status',
        title: '自动刷新账号令牌模型列表已开始',
        message: '自动刷新账号令牌模型列表 已开始执行',
        level: 'info',
        relatedType: 'task',
        createdAt: '2026-06-20 00:00:00',
      },
      {
        type: 'status',
        title: '自动刷新账号令牌模型列表已开始',
        message: '自动刷新账号令牌模型列表 已开始执行',
        level: 'info',
        relatedType: 'task',
        createdAt: '2026-06-20 01:00:00',
      },
      {
        type: 'status',
        title: '自动刷新账号令牌模型列表 已完成',
        message: '自动刷新账号令牌模型列表 已完成',
        level: 'info',
        relatedType: 'task',
        createdAt: '2026-06-20 01:01:00',
      },
    ]).run();

    const result = await repairStaleBackgroundTaskEvents(new Date('2026-06-20T02:00:00Z'));

    expect(result).toEqual({ repaired: 2 });
    const rows = await db.select().from(schema.events).orderBy(asc(schema.events.id)).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toBe('自动刷新账号令牌模型列表 异常中断');
    expect(rows[1]?.title).toBe('自动刷新账号令牌模型列表 已完成');
  });
});
