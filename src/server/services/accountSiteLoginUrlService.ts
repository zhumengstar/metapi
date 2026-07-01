import type { schema } from "../db/index.js";
import { decryptAccountPassword } from "./accountCredentialService.js";
import { getAutoReloginConfig } from "./accountExtraConfig.js";

type AccountRow = Pick<typeof schema.accounts.$inferSelect, "extraConfig">;
type SiteRow = Pick<typeof schema.sites.$inferSelect, "url" | "platform">;

const QUERY_LOGIN_PLATFORMS = new Set([
  "anyrouter",
  "done-hub",
  "new-api",
  "one-api",
  "one-hub",
  "sub2api",
  "veloera",
]);

function normalizeSiteUrl(siteUrl: string): string | null {
  const trimmed = siteUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed).toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function buildLoginPageUrl(siteUrl: string): URL {
  return new URL(`${siteUrl.replace(/\/$/, "")}/login`);
}

export function buildAccountSiteLoginUrl(input: {
  account: AccountRow;
  site: SiteRow;
}): { url: string; credentialed: boolean; reason?: string } {
  const siteUrl = normalizeSiteUrl(input.site.url || "");
  if (!siteUrl) {
    return { url: input.site.url || "", credentialed: false, reason: "invalid-site-url" };
  }

  const platform = (input.site.platform || "").trim().toLowerCase();
  if (!QUERY_LOGIN_PLATFORMS.has(platform)) {
    return { url: siteUrl, credentialed: false, reason: "unsupported-platform" };
  }

  const relogin = getAutoReloginConfig(input.account.extraConfig);
  if (!relogin) {
    return { url: siteUrl, credentialed: false, reason: "missing-saved-login" };
  }

  const password = decryptAccountPassword(relogin.passwordCipher);
  if (!password) {
    return { url: siteUrl, credentialed: false, reason: "password-decrypt-failed" };
  }

  const url = buildLoginPageUrl(siteUrl);
  url.searchParams.set("username", relogin.username);
  url.searchParams.set("password", password);
  return { url: url.toString(), credentialed: true };
}
