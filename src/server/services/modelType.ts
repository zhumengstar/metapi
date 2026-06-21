const IMAGE_MODEL_PATTERNS: RegExp[] = [
  /(^|[-_/])image($|[-_/])/i,
  /(^|[-_/])images($|[-_/])/i,
  /(^|[-_/])img($|[-_/])/i,
  /(^|[-_/])imagen($|[-_/])/i,
  /(^|[-_/])flux($|[-_/])/i,
  /(^|[-_/])sd(?:xl)?($|[-_/])/i,
  /(^|[-_/])stable[-_]?diffusion($|[-_/])/i,
  /(^|[-_/])dall[-_]?e($|[-_/])/i,
  /(^|[-_/])midjourney($|[-_/])/i,
  /(^|[-_/])mj($|[-_/])/i,
  /(^|[-_/])kling($|[-_/])/i,
  /(^|[-_/])kolors($|[-_/])/i,
  /(^|[-_/])jimeng($|[-_/])/i,
  /(^|[-_/])wanx($|[-_/])/i,
  /(^|[-_/])seedream($|[-_/])/i,
  /(^|[-_/])ideogram($|[-_/])/i,
  /(^|[-_/])recraft($|[-_/])/i,
  /(^|[-_/])playground($|[-_/])/i,
];

export function isImageGenerationModel(modelName: unknown): boolean {
  const normalized = String(modelName || '').trim();
  if (!normalized) return false;
  return IMAGE_MODEL_PATTERNS.some((pattern) => pattern.test(normalized));
}

