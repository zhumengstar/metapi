import React from 'react';
import { Link } from 'react-router-dom';
import { getAuthToken } from '../authSession.js';

type SiteBadgeLinkProps = {
  accountId?: number | null;
  siteId?: number | null;
  siteName?: string | null;
  siteUrl?: string | null;
  className?: string;
  badgeClassName?: string;
  badgeStyle?: React.CSSProperties;
};

export default function SiteBadgeLink({
  accountId,
  siteId,
  siteName,
  siteUrl,
  className = 'badge-link',
  badgeClassName = 'badge badge-muted',
  badgeStyle,
}: SiteBadgeLinkProps) {
  const label = String(siteName || '').trim() || '-';
  const externalUrl = String(siteUrl || '').trim();
  const normalizedSiteId = Number(siteId);
  const normalizedAccountId = Number(accountId);

  const openSiteForAccount = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!Number.isFinite(normalizedAccountId) || normalizedAccountId <= 0) return;
    event.preventDefault();

    let targetUrl = externalUrl;
    try {
      const token = getAuthToken(localStorage);
      const response = await fetch(`/api/accounts/${Math.trunc(normalizedAccountId)}/site-login-url`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (response.ok) {
        const payload = await response.json() as { url?: string };
        if (typeof payload.url === 'string' && /^https?:\/\//i.test(payload.url)) {
          targetUrl = payload.url;
        }
      }
    } catch {
      targetUrl = externalUrl;
    }

    globalThis.open?.(targetUrl, '_blank', 'noopener,noreferrer');
  };

  if (/^https?:\/\//i.test(externalUrl)) {
    return (
      <a
        href={externalUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onClick={openSiteForAccount}
      >
        <span className={badgeClassName} style={badgeStyle}>
          {label}
        </span>
      </a>
    );
  }

  if (!Number.isFinite(normalizedSiteId) || normalizedSiteId <= 0) {
    return (
      <span className={badgeClassName} style={badgeStyle}>
        {label}
      </span>
    );
  }

  return (
    <Link to={`/sites?focusSiteId=${Math.trunc(normalizedSiteId)}`} className={className}>
      <span className={badgeClassName} style={badgeStyle}>
        {label}
      </span>
    </Link>
  );
}
