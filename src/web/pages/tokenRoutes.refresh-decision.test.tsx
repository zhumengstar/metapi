import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import TokenRoutes from './TokenRoutes.js';

const { apiMock, getBrandMock } = vi.hoisted(() => ({
  apiMock: {
    getRoutesSummary: vi.fn(),
    refreshRouteDecisionSnapshots: vi.fn(),
    getRouteChannels: vi.fn(),
    getTask: vi.fn(),
    getTasks: vi.fn(),
    getModelTokenCandidates: vi.fn(),
    getRouteDecisionsBatch: vi.fn(),
    getRouteDecisionsByRouteBatch: vi.fn(),
    getRouteWideDecisionsBatch: vi.fn(),
  },
  getBrandMock: vi.fn(),
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: ({ brand, icon, model }: { brand?: { name?: string } | null; icon?: string | null; model?: string | null }) => (
    <span>{brand?.name || icon || model || ''}</span>
  ),
  InlineBrandIcon: ({ model }: { model: string }) => model ? <span>{model}</span> : null,
  getBrand: (...args: unknown[]) => getBrandMock(...args),
  hashColor: () => 'linear-gradient(135deg,#4f46e5,#818cf8)',
  normalizeBrandIconKey: (icon: string) => icon,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
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

describe('TokenRoutes refresh decision action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBrandMock.mockReset();
    getBrandMock.mockReturnValue(null);
    apiMock.getRoutesSummary.mockResolvedValue([
      {
        id: 1, modelPattern: 'gpt-4o-mini', displayName: 'gpt-4o-mini',
        displayIcon: null, modelMapping: null, enabled: true,
        channelCount: 0, enabledChannelCount: 0, siteNames: [],
        decisionSnapshot: null, decisionRefreshedAt: null,
      },
      {
        id: 2, modelPattern: 're:^claude-(opus|sonnet)-4-6$', displayName: 'claude-group',
        displayIcon: null, modelMapping: null, enabled: true,
        channelCount: 0, enabledChannelCount: 0, siteNames: [],
        decisionSnapshot: null, decisionRefreshedAt: null,
      },
    ]);
    apiMock.getRouteChannels.mockResolvedValue([]);
    apiMock.refreshRouteDecisionSnapshots.mockResolvedValue({ queued: true, jobId: 'task-1', status: 'pending' });
    apiMock.getTasks.mockResolvedValue({ tasks: [] });
    apiMock.getTask.mockResolvedValue({ task: { id: 'task-1', status: 'succeeded' } });
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.getRouteDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.getRouteDecisionsByRouteBatch.mockResolvedValue({ decisions: {} });
    apiMock.getRouteWideDecisionsBatch.mockResolvedValue({ decisions: {} });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('removes the manual probability refresh action and relies on visible-route refresh', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(collectText(root.root)).not.toContain('刷新选中概率');
      expect(apiMock.refreshRouteDecisionSnapshots).not.toHaveBeenCalled();
      expect(apiMock.getRouteDecisionsByRouteBatch).toHaveBeenCalled();
      expect(apiMock.getRouteWideDecisionsBatch).toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });

  it('silently refreshes visible route probabilities after the route list loads', async () => {
    let root!: ReactTestRenderer;
    try {
      apiMock.getRoutesSummary.mockResolvedValue([
        {
          id: 1, modelPattern: 'gpt-4o-mini', displayName: 'gpt-4o-mini',
          displayIcon: null, modelMapping: null, enabled: true,
          channelCount: 1, enabledChannelCount: 1, siteNames: ['auto-site'],
          decisionSnapshot: null, decisionRefreshedAt: null,
        },
      ]);
      apiMock.getRouteChannels.mockResolvedValue([
        {
          id: 11,
          accountId: 101,
          tokenId: 1001,
          sourceModel: 'gpt-4o-mini',
          priority: 0,
          weight: 10,
          enabled: true,
          manualOverride: false,
          successCount: 0,
          failCount: 0,
          account: { username: 'auto-user' },
          site: { name: 'auto-site' },
          token: { id: 1001, name: 'auto-token', accountId: 101, enabled: true, isDefault: true },
        },
      ]);
      apiMock.getRouteDecisionsByRouteBatch.mockResolvedValue({
        decisions: {
          '1': {
            'gpt-4o-mini': {
              requestedModel: 'gpt-4o-mini',
              actualModel: 'gpt-4o-mini',
              matched: true,
              selectedChannelId: 11,
              selectedLabel: 'auto-user @ auto-site / auto-token',
              summary: ['自动刷新'],
              candidates: [
                {
                  channelId: 11,
                  accountId: 101,
                  username: 'auto-user',
                  siteName: 'auto-site',
                  tokenName: 'auto-token',
                  priority: 0,
                  weight: 10,
                  eligible: true,
                  recentlyFailed: false,
                  avoidedByRecentFailure: false,
                  probability: 72.5,
                  reason: '自动刷新',
                },
              ],
            },
          },
        },
      });

      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();
      await flushMicrotasks();

      expect(apiMock.getRouteDecisionsByRouteBatch).toHaveBeenCalledWith([
        { routeId: 1, model: 'gpt-4o-mini' },
      ]);
      expect(collectText(root.root)).toContain('已缓存');

      const expandBtn = root.root.find((node) =>
        node.type === 'div' && String(node.props.className || '').includes('route-card-collapsed'),
      );
      await act(async () => {
        expandBtn.props.onClick();
      });
      await flushMicrotasks();

      expect(collectText(root.root)).toContain('72.5%');
    } finally {
      root?.unmount();
    }
  });
});
