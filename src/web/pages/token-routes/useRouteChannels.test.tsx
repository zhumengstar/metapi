import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useRouteChannels } from './useRouteChannels.js';
import type { RouteChannel } from './types.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getRouteChannels: vi.fn(),
  },
}));

vi.mock('../../api.js', () => ({
  api: apiMock,
}));

function buildChannel(id: number, overrides: Partial<RouteChannel> = {}): RouteChannel {
  return {
    id,
    routeId: 1,
    accountId: id,
    tokenId: null,
    sourceModel: 'gpt-5.5',
    priority: 0,
    weight: 1,
    enabled: true,
    manualOverride: false,
    successCount: 0,
    failCount: 0,
    account: { username: `user-${id}` },
    site: { id, name: `site-${id}`, platform: 'new-api' },
    token: null,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useRouteChannels', () => {
  it('keeps existing rows visible during forced refresh and preserves stable order', async () => {
    let hook!: ReturnType<typeof useRouteChannels>;
    const Host = () => {
      hook = useRouteChannels();
      const loading = hook.loadingChannelsByRouteId[1] ? 'loading' : 'idle';
      const channelIds = (hook.channelsByRouteId[1] || []).map((channel) => channel.id).join(',');
      return <span>{loading}:{channelIds}</span>;
    };

    let root!: ReactTestRenderer;
    apiMock.getRouteChannels.mockResolvedValueOnce([
      buildChannel(1),
      buildChannel(2),
    ]);

    await act(async () => {
      root = create(<Host />);
    });

    await act(async () => {
      await hook.loadChannels(1);
    });
    expect(root.toJSON()).toMatchObject({ children: ['idle', ':', '1,2'] });

    const refresh = createDeferred<RouteChannel[]>();
    apiMock.getRouteChannels.mockReturnValueOnce(refresh.promise);

    let refreshPromise!: Promise<RouteChannel[]>;
    await act(async () => {
      refreshPromise = hook.loadChannels(1, true);
      await Promise.resolve();
    });

    expect(root.toJSON()).toMatchObject({ children: ['idle', ':', '1,2'] });

    await act(async () => {
      refresh.resolve([
        buildChannel(2, { successCount: 8 }),
        buildChannel(1, { successCount: 4 }),
      ]);
      await refreshPromise;
    });

    expect(root.toJSON()).toMatchObject({ children: ['idle', ':', '1,2'] });
  });
});
