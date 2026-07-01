import { afterEach, describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import SiteBadgeLink from './SiteBadgeLink.js';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(String(key)) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => values.delete(String(key))),
    setItem: vi.fn((key: string, value: string) => {
      values.set(String(key), String(value));
    }),
  };
}

describe('SiteBadgeLink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the upstream site when a site URL is provided', () => {
    const root = create(
      <MemoryRouter>
        <SiteBadgeLink siteId={7} siteName="Demo Site" siteUrl="https://example.com" />
      </MemoryRouter>,
    );

    const link = root.root.findByType('a');
    expect(link.props.href).toBe('https://example.com');
    expect(link.props.target).toBe('_blank');
    expect(link.props.rel).toBe('noopener noreferrer');

    root.unmount();
  });

  it('fetches an account-specific login URL before opening the upstream site', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    localStorage.setItem('auth_token', 'admin-token');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      url: 'https://example.com/login?username=demo&password=secret',
    })));
    const openMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('open', openMock);

    const root = create(
      <MemoryRouter>
        <SiteBadgeLink
          accountId={9}
          siteId={7}
          siteName="Demo Site"
          siteUrl="https://example.com"
        />
      </MemoryRouter>,
    );

    await root.root.findByType('a').props.onClick({
      preventDefault: vi.fn(),
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/accounts/9/site-login-url', {
      headers: { Authorization: 'Bearer admin-token' },
    });
    expect(openMock).toHaveBeenCalledWith(
      'https://example.com/login?username=demo&password=secret',
      '_blank',
      'noopener,noreferrer',
    );

    root.unmount();
  });

  it('renders a focus-navigation link when site id is valid', () => {
    const root = create(
      <MemoryRouter>
        <SiteBadgeLink siteId={7} siteName="Demo Site" />
      </MemoryRouter>,
    );

    const link = root.root.findByType('a');
    expect(String(link.props.href || '')).toContain('/sites?focusSiteId=7');
    expect(String(link.props.className || '')).toContain('badge-link');
    expect(root.root.findByProps({ className: 'badge badge-muted' }).children.join('')).toContain('Demo Site');

    root.unmount();
  });

  it('falls back to plain badge text when site id is invalid', () => {
    const root = create(
      <MemoryRouter>
        <SiteBadgeLink siteId={0} siteName="Unknown Site" />
      </MemoryRouter>,
    );

    expect(root.root.findAllByType('a')).toHaveLength(0);
    expect(root.root.findByProps({ className: 'badge badge-muted' }).children.join('')).toContain('Unknown Site');

    root.unmount();
  });
});
