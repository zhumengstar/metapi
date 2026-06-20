const DEFAULT_GROUP = 'default';

export function resolveTokenGroupLabel(
  tokenGroup: string | null | undefined,
  tokenName?: string | null,
): string | null {
  const explicit = (tokenGroup || '').trim();
  if (explicit.length > 0) return explicit;

  const name = (tokenName || '').trim();
  if (!name) return null;
  const normalized = name.toLowerCase();
  if (normalized === DEFAULT_GROUP || normalized === '默认' || /^default($|[-_\s])/.test(normalized)) {
    return DEFAULT_GROUP;
  }
  if (/^token-\d+$/.test(normalized)) return null;
  return name;
}

export function normalizeTokenGroupLookupKey(value: string | null | undefined): string {
  return (value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .replace(/[()[\]{}（）【】「」『』"'`]+/g, '');
}

export function tokenGroupLabelsMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftLabel = (left || '').trim();
  const rightLabel = (right || '').trim();
  if (!leftLabel || !rightLabel) return leftLabel === rightLabel;
  if (leftLabel === rightLabel) return true;
  const leftKey = normalizeTokenGroupLookupKey(leftLabel);
  const rightKey = normalizeTokenGroupLookupKey(rightLabel);
  return !!leftKey && leftKey === rightKey;
}
