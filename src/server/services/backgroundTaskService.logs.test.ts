import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type BackgroundTaskModule = typeof import('./backgroundTaskService.js');

describe('background task log streaming', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let __resetBackgroundTasksForTests: BackgroundTaskModule['__resetBackgroundTasksForTests'];
  let appendBackgroundTaskLog: BackgroundTaskModule['appendBackgroundTaskLog'];
  let getBackgroundTask: BackgroundTaskModule['getBackgroundTask'];
  let startBackgroundTask: BackgroundTaskModule['startBackgroundTask'];
  let subscribeToBackgroundTaskLogs: BackgroundTaskModule['subscribeToBackgroundTaskLogs'];
  let waitForBackgroundTaskCompletion: BackgroundTaskModule['waitForBackgroundTaskCompletion'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-background-task-logs-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const backgroundTaskModule = await import('./backgroundTaskService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    __resetBackgroundTasksForTests = backgroundTaskModule.__resetBackgroundTasksForTests;
    appendBackgroundTaskLog = backgroundTaskModule.appendBackgroundTaskLog;
    getBackgroundTask = backgroundTaskModule.getBackgroundTask;
    startBackgroundTask = backgroundTaskModule.startBackgroundTask;
    subscribeToBackgroundTaskLogs = backgroundTaskModule.subscribeToBackgroundTaskLogs;
    waitForBackgroundTaskCompletion = backgroundTaskModule.waitForBackgroundTaskCompletion;
  });

  afterEach(async () => {
    __resetBackgroundTasksForTests();
    await db.delete(schema.events).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('appends log entries in order and exposes them through task lookups', async () => {
    let releaseRunner: (() => void) | null = null;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });

    const { task } = startBackgroundTask(
      {
        type: 'update-center.deploy',
        title: '更新部署',
      },
      async () => {
        await runnerGate;
        return { success: true };
      },
    );

    appendBackgroundTaskLog(task.id, 'Resolving target version');
    appendBackgroundTaskLog(task.id, 'Running helm upgrade');

    const currentTask = getBackgroundTask(task.id);
    expect(currentTask?.logs).toEqual([
      expect.objectContaining({ seq: 1, message: 'Resolving target version' }),
      expect.objectContaining({ seq: 2, message: 'Running helm upgrade' }),
    ]);

    releaseRunner?.();
    await waitForBackgroundTaskCompletion(task.id);
  });

  it('notifies subscribers when new log entries arrive', async () => {
    let releaseRunner: (() => void) | null = null;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });

    const { task } = startBackgroundTask(
      {
        type: 'update-center.deploy',
        title: '更新部署',
      },
      async () => {
        await runnerGate;
        return { success: true };
      },
    );

    const received: string[] = [];
    const unsubscribe = subscribeToBackgroundTaskLogs(task.id, (entry) => {
      received.push(entry.message);
    });

    appendBackgroundTaskLog(task.id, 'Waiting for rollout');
    appendBackgroundTaskLog(task.id, 'Deployment complete');

    expect(received).toEqual([
      'Waiting for rollout',
      'Deployment complete',
    ]);

    unsubscribe();
    releaseRunner?.();
    await waitForBackgroundTaskCompletion(task.id);
  });

  it('trims old log entries to a bounded buffer', async () => {
    let releaseRunner: (() => void) | null = null;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });

    const { task } = startBackgroundTask(
      {
        type: 'update-center.deploy',
        title: '更新部署',
      },
      async () => {
        await runnerGate;
        return { success: true };
      },
    );

    for (let index = 1; index <= 250; index += 1) {
      appendBackgroundTaskLog(task.id, `line-${index}`);
    }

    const currentTask = getBackgroundTask(task.id);
    expect(currentTask?.logs).toHaveLength(200);
    expect(currentTask?.logs[0]).toMatchObject({
      seq: 51,
      message: 'line-51',
    });
    expect(currentTask?.logs.at(-1)).toMatchObject({
      seq: 250,
      message: 'line-250',
    });

    releaseRunner?.();
    await waitForBackgroundTaskCompletion(task.id);
  });

  it('updates the original task event with start and end times instead of appending a terminal event', async () => {
    const { task } = startBackgroundTask(
      {
        type: 'update-center.deploy',
        title: '更新部署',
      },
      async () => ({ success: true }),
    );

    await waitForBackgroundTaskCompletion(task.id);

    const rows = await db.select().from(schema.events).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: '更新部署 已完成',
      level: 'info',
      relatedType: 'task',
    });
    expect(rows[0]?.message).toContain('更新部署 已完成');
    expect(rows[0]?.message).toContain('开始时间：');
    expect(rows[0]?.message).toContain('结束时间：');
  });
});
