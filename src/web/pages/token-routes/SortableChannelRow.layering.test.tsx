import { describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableChannelRow } from './SortableChannelRow.js';
import type { RouteChannel } from './types.js';

function buildChannel(overrides: Partial<RouteChannel> = {}): RouteChannel {
  return {
    id: 301,
    routeId: 88,
    accountId: 7,
    tokenId: null,
    sourceModel: 'gpt-4.1',
    priority: 0,
    weight: 100,
    enabled: true,
    manualOverride: true,
    successCount: 12,
    failCount: 1,
    cooldownUntil: null,
    account: {
      username: 'cc',
      accessToken: null,
      extraConfig: null,
      credentialMode: 'oauth',
    },
    site: {
      id: 99,
      name: 'codelab',
      url: 'https://codelab.example.com',
      platform: 'openai',
    },
    token: null,
    ...overrides,
  };
}

describe('SortableChannelRow layering', () => {
  it('renders channel site badge as an external link when site url is available', () => {
    const channel = buildChannel({
      site: {
        id: 99,
        name: 'codelab',
        url: 'https://codelab.example.com',
        platform: 'openai',
      },
    });
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
            onSiteBlockModel={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const link = root.root.find((node) => node.type === 'a' && node.props.href === 'https://codelab.example.com/');
    expect(link.props.target).toBe('_blank');
    expect(link.props.rel).toBe('noopener noreferrer');
    expect(String(link.props.className || '')).toContain('badge-link');
    expect(link.children.some((child) => typeof child !== 'string' && child.children.includes('codelab'))).toBe(true);
  });

  it('does not force a base z-index on desktop rows when they are not being dragged', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
            onSiteBlockModel={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const row = root.root.find((node) => (
      node.type === 'div'
      && node.props['data-layer-root']
    ));

    expect(row.props.style.zIndex).toBeUndefined();
    expect(row.props.style.borderLeft).toBeUndefined();
  });

  it('disables row tooltips while a drag interaction is in progress', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            dragInProgress
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
            onSiteBlockModel={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const tooltipNodes = root.root.findAll((node) => node.props['data-tooltip'] !== undefined);
    expect(tooltipNodes).toHaveLength(0);
  });

  it('treats channel-management-disabled rows as non-interactive for the drag handle', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            channelManagementDisabled
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
            onSiteBlockModel={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const dragHandle = root.root.find((node) => (
      node.type === 'button'
      && node.props['aria-label'] === '拖拽调整优先级桶'
    ));

    expect(dragHandle.props.disabled).toBe(true);
    expect(dragHandle.props['data-tooltip']).toBe('该路由当前不可编辑优先级');
  });

  it('renders desktop token controls in a full-width config row', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
            onSiteBlockModel={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const row = root.root.find((node) => (
      node.type === 'div'
      && node.props['data-layer-root']
    ));
    const configRow = root.root.find((node) => (
      node.type === 'div'
      && node.props['data-channel-config-row']
    ));

    expect(row.props.style.gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(configRow.props.style.width).toBe('100%');
    expect(configRow.props.style.gridTemplateColumns).toContain('minmax(240px, 1fr)');

    const inlineSelect = configRow.find((node) => (
      node.type === 'div'
      && typeof node.props.className === 'string'
      && node.props.className.includes('modern-select')
    ));
    expect(inlineSelect.props.className).toContain('is-inline-menu');
  });

  it('toggles channel status directly from the status badge', () => {
    const channel = buildChannel({ enabled: true });
    const onToggleEnabled = vi.fn();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={onToggleEnabled}
            onSiteBlockModel={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const statusButton = root.root.find((node) => (
      node.type === 'button'
      && node.props['aria-label'] === '点击禁用此通道'
    ));

    statusButton.props.onClick({ stopPropagation: vi.fn() });
    expect(onToggleEnabled).toHaveBeenCalledWith(false);
  });

  it('can re-enable a disabled channel from the status badge', () => {
    const channel = buildChannel({ enabled: false });
    const onToggleEnabled = vi.fn();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={onToggleEnabled}
            onSiteBlockModel={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const statusButton = root.root.find((node) => (
      node.type === 'button'
      && node.props['aria-label'] === '点击启用此通道'
    ));

    statusButton.props.onClick({ stopPropagation: vi.fn() });
    expect(onToggleEnabled).toHaveBeenCalledWith(true);
  });
});
