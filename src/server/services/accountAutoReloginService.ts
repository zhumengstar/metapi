import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getAutoReloginConfig,
  getProxyUrlFromExtraConfig,
  mergeAccountExtraConfig,
} from './accountExtraConfig.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import { getAdapter } from './platforms/index.js';
import { withAccountProxyOverride } from './siteProxy.js';

export type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

export type AccountAutoReloginResult =
  | { status: 'not-needed'; row: AccountWithSiteRow }
  | { status: 'not-available'; message: string }
  | { status: 'success'; row: AccountWithSiteRow }
  | { status: 'failed'; message: string };

export async function autoReloginAccount(
  row: AccountWithSiteRow,
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<AccountAutoReloginResult> {
  if (!options.force && (row.accounts.status || 'active') === 'active') {
    return { status: 'not-needed', row };
  }

  const relogin = getAutoReloginConfig(row.accounts.extraConfig);
  if (!relogin) {
    return { status: 'not-available', message: '账号缺少自动重登录配置' };
  }

  const adapter = getAdapter(row.sites.platform);
  if (!adapter) {
    return { status: 'failed', message: '站点平台不支持账号密码重新登录' };
  }

  const password = decryptAccountPassword(relogin.passwordCipher);
  if (!password) {
    return { status: 'failed', message: '登录凭证密码解密失败，无法自动重新登录' };
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const loginResult = await Promise.race([
      withAccountProxyOverride(
        getProxyUrlFromExtraConfig(row.accounts.extraConfig),
        () => adapter.login(row.sites.url, relogin.username, password),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`自动重新登录超时（${Math.max(1, Math.round(timeoutMs / 1000))}s）`)), timeoutMs);
      }),
    ]);

    if (!loginResult.success || !loginResult.accessToken) {
      return { status: 'failed', message: loginResult.message || '账号密码重新登录失败' };
    }

    const nextExtraConfig = mergeAccountExtraConfig(row.accounts.extraConfig, {
      credentialMode: 'session',
      autoRelogin: {
        username: relogin.username,
        passwordCipher: relogin.passwordCipher,
        updatedAt: new Date().toISOString(),
      },
      ...(loginResult.refreshToken ? {
        sub2apiAuth: {
          refreshToken: loginResult.refreshToken,
          tokenExpiresAt: loginResult.tokenExpiresAt,
        },
      } : {}),
    });

    await db.update(schema.accounts).set({
      accessToken: loginResult.accessToken,
      status: 'active',
      extraConfig: nextExtraConfig,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.accounts.id, row.accounts.id)).run();

    const refreshed = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, row.accounts.id)).get();

    return {
      status: 'success',
      row: {
        accounts: refreshed || {
          ...row.accounts,
          accessToken: loginResult.accessToken,
          status: 'active',
          extraConfig: nextExtraConfig,
        },
        sites: row.sites,
      },
    };
  } catch (error: any) {
    return { status: 'failed', message: `账号密码重新登录失败：${String(error?.message || 'unknown error')}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isUpstreamAuthenticationError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || error || '').toLowerCase();
  return [
    '401', '403', 'unauthorized', 'forbidden', 'invalid token', 'token invalid',
    'token expired', 'expired token', 'access token', '令牌过期', '令牌无效',
    '登录已过期', '未登录', '鉴权失败',
  ].some((fragment) => message.includes(fragment));
}
