import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ProgramLogs from './ProgramLogs.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getEvents: vi.fn(),
    markEventRead: vi.fn(),
    markAllEventsRead: vi.fn(),
    clearEvents: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ProgramLogs status label', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('treats summary with failed=0 as success', async () => {
    apiMock.getEvents.mockResolvedValue([
      {
        id: 1,
        type: 'status',
        title: '同步全部账号令牌已完成（成功31/跳过0/失败0）',
        message: '全部账号令牌同步完成：成功 31，跳过 0，失败 0',
        level: 'info',
        read: false,
        createdAt: '2026-03-04T06:43:03.000Z',
      },
    ]);

    let root!: WebTestRenderer;
    await act(async () => {
      root = create(
        <MemoryRouter initialEntries={['/events']}>
          <ToastProvider>
            <ProgramLogs />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await flushMicrotasks();

    const rows = root!.root.findAll((node) => node.type === 'tr');
    const targetRow = rows.find((row) => collectText(row).includes('同步全部账号令牌已完成'));
    expect(targetRow).toBeTruthy();

    const tds = targetRow!.findAll((node) => node.type === 'td');
    const statusCell = tds[6];
    expect(collectText(statusCell).trim()).toBe('成功');
    const statusBadge = statusCell.find((node) => node.type === 'span');
    expect(String(statusBadge.props.className || '')).toContain('badge-success');
  });

  it('treats parenthesized counts with failed=0 as success', async () => {
    apiMock.getEvents.mockResolvedValue([
      {
        id: 2,
        type: 'status',
        title: '同步全部账号令牌已完成',
        message: '成功(15): a, b\n跳过(1): c\n失败(0): -',
        level: 'info',
        read: false,
        createdAt: '2026-03-04T06:43:03.000Z',
      },
    ]);

    let root!: WebTestRenderer;
    await act(async () => {
      root = create(
        <MemoryRouter initialEntries={['/events']}>
          <ToastProvider>
            <ProgramLogs />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await flushMicrotasks();

    const rows = root!.root.findAll((node) => node.type === 'tr');
    const targetRow = rows.find((row) => collectText(row).includes('同步全部账号令牌已完成'));
    expect(targetRow).toBeTruthy();

    const tds = targetRow!.findAll((node) => node.type === 'td');
    const statusCell = tds[6];
    expect(collectText(statusCell).trim()).toBe('成功');
    const statusBadge = statusCell.find((node) => node.type === 'span');
    expect(String(statusBadge.props.className || '')).toContain('badge-success');
  });

  it('presents started events as running instead of showing a separate started state', async () => {
    apiMock.getEvents.mockResolvedValue([
      {
        id: 3,
        type: 'status',
        title: '获取全部账号分组并补齐令牌已开始',
        message: '获取全部账号分组并补齐令牌 已开始执行',
        level: 'info',
        read: false,
        createdAt: '2026-06-20T00:58:26.875Z',
      },
      {
        id: 4,
        type: 'status',
        title: '刷新模型并重建路由进行中',
        message: '刷新模型并重建路由 running',
        level: 'info',
        read: false,
        createdAt: '2026-06-20T00:59:26.875Z',
      },
    ]);

    let root!: WebTestRenderer;
    await act(async () => {
      root = create(
        <MemoryRouter initialEntries={['/events']}>
          <ToastProvider>
            <ProgramLogs />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await flushMicrotasks();

    const rows = root!.root.findAll((node) => node.type === 'tr');
    const startedRow = rows.find((row) => collectText(row).includes('获取全部账号分组并补齐令牌已开始'));
    const runningRow = rows.find((row) => collectText(row).includes('刷新模型并重建路由进行中'));

    expect(startedRow).toBeTruthy();
    expect(runningRow).toBeTruthy();
    expect(collectText(startedRow!.findAll((node) => node.type === 'td')[6]).trim()).toBe('进行中');
    expect(collectText(runningRow!.findAll((node) => node.type === 'td')[6]).trim()).toBe('进行中');
  });

  it('shows task start and end time in dedicated columns', async () => {
    apiMock.getEvents.mockResolvedValue([
      {
        id: 5,
        type: 'status',
        title: '获取全部账号分组已完成',
        message: '获取全部账号分组已完成\n开始时间：2026-06-20 01:00:00\n结束时间：2026-06-20 01:02:03',
        level: 'info',
        read: false,
        createdAt: '2026-06-20T01:02:03.000Z',
      },
    ]);

    let root!: WebTestRenderer;
    await act(async () => {
      root = create(
        <MemoryRouter initialEntries={['/events']}>
          <ToastProvider>
            <ProgramLogs />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await flushMicrotasks();

    const rows = root!.root.findAll((node) => node.type === 'tr');
    const targetRow = rows.find((row) => collectText(row).includes('获取全部账号分组已完成'));
    expect(targetRow).toBeTruthy();

    const tds = targetRow!.findAll((node) => node.type === 'td');
    expect(collectText(tds[0])).toContain('2026');
    expect(collectText(tds[1])).toContain('2026');
    expect(collectText(tds[5])).not.toContain('开始时间');
    expect(collectText(tds[5])).not.toContain('结束时间');
  });

  it('uses createdAt as the visible start time when the event has no embedded runtime lines', async () => {
    apiMock.getEvents.mockResolvedValue([
      {
        id: 6,
        type: 'token',
        title: '账号令牌删除成功',
        message: 'default: 删除成功',
        level: 'info',
        read: false,
        createdAt: '2026-06-20T09:29:25.452Z',
      },
    ]);

    let root!: WebTestRenderer;
    await act(async () => {
      root = create(
        <MemoryRouter initialEntries={['/events']}>
          <ToastProvider>
            <ProgramLogs />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await flushMicrotasks();

    const rows = root!.root.findAll((node) => node.type === 'tr');
    const targetRow = rows.find((row) => collectText(row).includes('账号令牌删除成功'));
    expect(targetRow).toBeTruthy();

    const tds = targetRow!.findAll((node) => node.type === 'td');
    expect(collectText(tds[0])).toContain('2026');
    expect(collectText(tds[1])).toContain('2026');
  });
});
