import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import { TokensPanel } from './Tokens.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccountTokens: vi.fn(),
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getAccountTokenGroups: vi.fn(),
    batchUpdateAccountTokens: vi.fn(),
    testAccountTokenModelAvailability: vi.fn(),
    getAccountTokenUiSettings: vi.fn(),
    updateAccountTokenUiSettings: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Tokens batch actions', () => {
  const localStorageState = new Map<string, string>();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorageState.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => (localStorageState.has(key) ? localStorageState.get(key)! : null)),
        setItem: vi.fn((key: string, value: string) => {
          localStorageState.set(String(key), String(value));
        }),
        removeItem: vi.fn((key: string) => {
          localStorageState.delete(String(key));
        }),
        clear: vi.fn(() => {
          localStorageState.clear();
        }),
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: globalThis.localStorage,
      },
      configurable: true,
      writable: true,
    });
    installAccountsSnapshotCompat(apiMock);
    apiMock.getAccountTokenUiSettings.mockResolvedValue({ maxGroupRatioFilter: '' });
    apiMock.updateAccountTokenUiSettings.mockImplementation(async (data: any) => ({ maxGroupRatioFilter: data?.maxGroupRatioFilter || '' }));
    apiMock.getAccountTokens.mockResolvedValue([
      {
        id: 1,
        accountId: 1,
        name: 'token-1',
        tokenMasked: 'sk-***1',
        enabled: true,
        isDefault: false,
        modelNames: ['gpt-5.5', 'claude-sonnet-4-6'],
        groupRatioAvailable: true,
        groupRatio: 0.04,
        account: { username: 'alpha' },
        site: { name: 'Site A', url: 'https://site-a.example.com' },
      },
      {
        id: 2,
        accountId: 1,
        name: 'token-2',
        tokenMasked: 'sk-***2',
        enabled: true,
        isDefault: false,
        modelNames: ['gpt-4o-mini'],
        groupRatioAvailable: true,
        groupRatio: 0.09,
        account: { username: 'alpha' },
        site: { name: 'Site A', url: 'https://site-a.example.com' },
      },
    ]);
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        username: 'alpha',
        accessToken: 'session-alpha',
        status: 'active',
        site: { id: 1, name: 'Site A', status: 'active' },
      },
    ]);
    apiMock.getAccountTokenGroups.mockResolvedValue({ groups: ['default'] });
    apiMock.batchUpdateAccountTokens.mockResolvedValue({
      success: true,
      successIds: [1, 2],
      failedItems: [],
    });
    apiMock.testAccountTokenModelAvailability.mockImplementation(async ({ model, tokenIds }: { model: string; tokenIds: number[] }) => ({
      success: true,
      results: tokenIds.map((tokenId) => ({
        tokenId,
        model,
        available: true,
        checkedAt: '2026-06-20T00:00:00.000Z',
      })),
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('deletes selected tokens through the batch toolbar', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
              <TokensPanel />
            </MemoryRouter>
          </ToastProvider>,
        );
      });
      await flushMicrotasks();

      const checkboxA = root.root.find((node) => node.props['data-testid'] === 'token-select-1');
      const checkboxB = root.root.find((node) => node.props['data-testid'] === 'token-select-2');
      await act(async () => {
        checkboxA.props.onChange({ target: { checked: true } });
        checkboxB.props.onChange({ target: { checked: true } });
      });

      const batchButton = root.root.find((node) => node.props['data-testid'] === 'tokens-batch-delete');
      await act(async () => {
        batchButton.props.onClick();
      });
      await flushMicrotasks();

      const confirmButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => Array.isArray(node.children) && node.children.some((child) => child === '确认删除'));
      expect(confirmButton).toBeTruthy();

      await act(async () => {
        confirmButton!.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateAccountTokens).toHaveBeenCalledWith({
        ids: [1, 2],
        action: 'delete',
      });
    } finally {
      root?.unmount();
    }
  });

  it('does not select visible tokens by default and toggles a token when clicking the row', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
              <TokensPanel />
            </MemoryRouter>
          </ToastProvider>,
        );
      });
      await flushMicrotasks();

      const row = root.root.find((node) => node.props['data-testid'] === 'token-row-1');
      const checkboxBefore = root.root.find((node) => node.props['data-testid'] === 'token-select-1');
      expect(checkboxBefore.props.checked).toBe(false);

      await act(async () => {
        row.props.onClick({ target: { closest: () => null } });
      });
      await flushMicrotasks();

      const checkboxAfter = root.root.find((node) => node.props['data-testid'] === 'token-select-1');
      expect(checkboxAfter.props.checked).toBe(true);
    } finally {
      root?.unmount();
    }
  });

  it('does not select exact model search results by default', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
              <TokensPanel />
            </MemoryRouter>
          </ToastProvider>,
        );
      });
      await flushMicrotasks();

      const modelInput = root.root.find((node) => node.type === 'input' && node.props.placeholder === '输入完整模型名称精准筛选');
      await act(async () => {
        modelInput.props.onChange({ target: { value: 'gpt-5.5' } });
      });
      await flushMicrotasks();

      const checkboxA = root.root.find((node) => node.props['data-testid'] === 'token-select-1');
      expect(checkboxA.props.checked).toBe(false);
      expect(root.root.findAll((node) => node.props['data-testid'] === 'token-select-2')).toHaveLength(0);
    } finally {
      root?.unmount();
    }
  });

  it('keeps the batch toolbar visible and disabled without selected tokens', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
              <TokensPanel />
            </MemoryRouter>
          </ToastProvider>,
        );
      });
      await flushMicrotasks();

      const batchEnableButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => Array.isArray(node.children) && node.children.includes('批量启用'));
      const batchDisableButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => Array.isArray(node.children) && node.children.includes('批量禁用'));
      const batchDeleteButton = root.root.find((node) => node.props['data-testid'] === 'tokens-batch-delete');

      expect(batchEnableButton).toBeTruthy();
      expect(batchDisableButton).toBeTruthy();
      expect(batchEnableButton!.props.disabled).toBe(true);
      expect(batchDisableButton!.props.disabled).toBe(true);
      expect(batchDeleteButton.props.disabled).toBe(true);
    } finally {
      root?.unmount();
    }
  });

  it('persists and restores the max group ratio filter from local storage', async () => {
    vi.useFakeTimers();
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
              <TokensPanel />
            </MemoryRouter>
          </ToastProvider>,
        );
      });
      await flushMicrotasks();

      const ratioInput = root.root.find((node) => node.type === 'input' && node.props['aria-label'] === '只展示小于该倍率的令牌');
      await act(async () => {
        ratioInput.props.onChange({ target: { value: '0.05' } });
      });
      await flushMicrotasks();
      await act(async () => {
        vi.advanceTimersByTime(350);
        await Promise.resolve();
      });
      await flushMicrotasks();

      expect(localStorage.getItem('metapi.tokens.maxGroupRatioFilter')).toBe('0.05');
      expect(apiMock.updateAccountTokenUiSettings).toHaveBeenCalledWith({ maxGroupRatioFilter: '0.05' });
      expect(root.root.findAll((node) => node.props['data-testid'] === 'token-row-1')).toHaveLength(1);
      expect(root.root.findAll((node) => node.props['data-testid'] === 'token-row-2')).toHaveLength(0);

      root.unmount();
      apiMock.getAccountTokenUiSettings.mockResolvedValue({ maxGroupRatioFilter: '0.05' });

      await act(async () => {
        root = create(
          <ToastProvider>
            <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
              <TokensPanel />
            </MemoryRouter>
          </ToastProvider>,
        );
      });
      await flushMicrotasks();

      const restoredRatioInput = root.root.find((node) => node.type === 'input' && node.props['aria-label'] === '只展示小于该倍率的令牌');
      expect(restoredRatioInput.props.value).toBe('0.05');
      expect(root.root.findAll((node) => node.props['data-testid'] === 'token-row-1')).toHaveLength(1);
      expect(root.root.findAll((node) => node.props['data-testid'] === 'token-row-2')).toHaveLength(0);
    } finally {
      root?.unmount();
      vi.useRealTimers();
    }
  });

  it('uses gpt-5.5 or the first token model when batch testing without an input model', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
              <TokensPanel />
            </MemoryRouter>
          </ToastProvider>,
        );
      });
      await flushMicrotasks();

      const checkboxA = root.root.find((node) => node.props['data-testid'] === 'token-select-1');
      const checkboxB = root.root.find((node) => node.props['data-testid'] === 'token-select-2');
      await act(async () => {
        checkboxA.props.onChange({ target: { checked: true } });
        checkboxB.props.onChange({ target: { checked: true } });
      });
      await flushMicrotasks();

      const batchTestButton = root.root
        .findAll((node) => node.type === 'button')
        .find((node) => Array.isArray(node.children) && node.children.includes('批量检测'));

      expect(batchTestButton).toBeTruthy();
      expect(batchTestButton!.props.disabled).toBe(false);
      expect(batchTestButton!.props.title).toBe('未输入模型时默认检测 gpt-5.5，没有则检测令牌的第一个模型');

      await act(async () => {
        batchTestButton!.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.testAccountTokenModelAvailability).toHaveBeenCalledTimes(2);
      expect(apiMock.testAccountTokenModelAvailability).toHaveBeenNthCalledWith(1, {
        model: 'gpt-5.5',
        tokenIds: [1],
        async: true,
      });
      expect(apiMock.testAccountTokenModelAvailability).toHaveBeenNthCalledWith(2, {
        model: 'gpt-4o-mini',
        tokenIds: [2],
        async: true,
      });
    } finally {
      root?.unmount();
    }
  });
});
