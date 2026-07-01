import { describe, expect, it } from 'vitest';
import { encryptAccountPassword } from './accountCredentialService.js';
import { buildAccountSiteLoginUrl } from './accountSiteLoginUrlService.js';

describe('accountSiteLoginUrlService', () => {
  it('adds saved login credentials for New API style login pages', () => {
    const result = buildAccountSiteLoginUrl({
      account: {
        extraConfig: JSON.stringify({
          autoRelogin: {
            username: 'demo@example.com',
            passwordCipher: encryptAccountPassword('secret pass'),
          },
        }),
      },
      site: {
        url: 'https://upstream.example.com',
        platform: 'new-api',
      },
    });

    expect(result.credentialed).toBe(true);
    const url = new URL(result.url);
    expect(url.origin).toBe('https://upstream.example.com');
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('username')).toBe('demo@example.com');
    expect(url.searchParams.get('password')).toBe('secret pass');
  });

  it('falls back to the site URL when saved login credentials are unavailable', () => {
    expect(buildAccountSiteLoginUrl({
      account: { extraConfig: null },
      site: { url: 'https://upstream.example.com/', platform: 'new-api' },
    })).toEqual({
      url: 'https://upstream.example.com',
      credentialed: false,
      reason: 'missing-saved-login',
    });
  });
});
