import { startBackgroundTask } from './backgroundTaskService.js';
import {
  rebuildTokenRoutesFromAvailability,
  refreshModelsAndRebuildRoutes as refreshModelsAndRebuildRoutesViaModelService,
} from './modelService.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';

const ROUTES_ONLY_REBUILD_DEBOUNCE_MS = 1_500;

let scheduledRoutesOnlyRebuildTimer: ReturnType<typeof setTimeout> | null = null;
let scheduledRoutesOnlyRebuildRunning = false;
let scheduledRoutesOnlyRebuildRequested = false;

export async function rebuildRoutesOnly() {
  return rebuildTokenRoutesFromAvailability();
}

export async function rebuildRoutesBestEffort() {
  try {
    await rebuildRoutesOnly();
    return true;
  } catch {
    return false;
  }
}

export async function refreshModelsAndRebuildRoutes() {
  return refreshModelsAndRebuildRoutesViaModelService();
}

async function runScheduledRoutesOnlyRebuild(reason: string) {
  if (scheduledRoutesOnlyRebuildRunning) {
    scheduledRoutesOnlyRebuildRequested = true;
    return;
  }

  scheduledRoutesOnlyRebuildRunning = true;
  try {
    await rebuildRoutesOnly();
    invalidateTokenRouterCache();
  } catch (error: any) {
    console.warn(`[route-refresh] scheduled routes rebuild failed (${reason}): ${error?.message || error}`);
  } finally {
    scheduledRoutesOnlyRebuildRunning = false;
    if (scheduledRoutesOnlyRebuildRequested) {
      scheduledRoutesOnlyRebuildRequested = false;
      scheduleRoutesOnlyRebuild(`${reason}:rerun`);
    }
  }
}

export function scheduleRoutesOnlyRebuild(reason = 'route-affecting-change') {
  if (scheduledRoutesOnlyRebuildTimer) {
    clearTimeout(scheduledRoutesOnlyRebuildTimer);
  }
  scheduledRoutesOnlyRebuildTimer = setTimeout(() => {
    scheduledRoutesOnlyRebuildTimer = null;
    void runScheduledRoutesOnlyRebuild(reason);
  }, ROUTES_ONLY_REBUILD_DEBOUNCE_MS);
}

export function queueRefreshModelsAndRebuildRoutesTask(input: {
  type: string;
  title: string;
  dedupeKey?: string;
  notifyOnFailure?: boolean;
  successMessage: (currentTask: { result?: unknown }) => string;
  failureMessage: (currentTask: { error?: string | null }) => string;
}) {
  return startBackgroundTask(
    {
      type: input.type,
      title: input.title,
      dedupeKey: input.dedupeKey || 'refresh-models-and-rebuild-routes',
      notifyOnFailure: input.notifyOnFailure ?? true,
      successMessage: input.successMessage,
      failureMessage: input.failureMessage,
    },
    async () => refreshModelsAndRebuildRoutes(),
  );
}
