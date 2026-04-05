const MIN_TARGET_FPS = 15;
const MAX_TARGET_FPS = 240;

export function normalizeTargetFramerate(target: number, fallback = 60): number {
  const value = Number.isFinite(target) ? target : fallback;
  return Math.max(MIN_TARGET_FPS, Math.min(MAX_TARGET_FPS, Math.round(value)));
}

export function getAnimationFrameBudgetMs(
  targetFramerate: number,
  unlockFramerate: boolean,
  fallback = 60,
): number {
  if (unlockFramerate) return 0;
  return 1000 / normalizeTargetFramerate(targetFramerate, fallback);
}
