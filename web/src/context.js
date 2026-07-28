export function draftProblemIdentity({ online, remoteQuestion, settings }) {
  return remoteQuestion?.titleSlug
    || (online ? settings.problemSlug : settings.problemId)
    || "unknown";
}

export function draftWriteContext(editorDraftContext, currentContext) {
  return editorDraftContext ?? currentContext;
}

export function resolveDraftCode(draft, starter, legacyStarter = null) {
  return draft === null || draft === legacyStarter ? starter : draft;
}

export function isPersistedSolvedId(value, localProblemIds) {
  if (typeof value !== "string") return false;
  if (localProblemIds.has(value)) return true;
  if (value.length > 224) return false;
  return /^(global|china):[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function normalizePersistedSettings(saved, defaults, localProblemIds, maxSearchChars = 200) {
  const source = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const problemSlug = typeof source.problemSlug === "string"
    && (source.problemSlug === "" || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source.problemSlug))
    && source.problemSlug.length <= 200
    ? source.problemSlug
    : defaults.problemSlug;
  const language = typeof source.language === "string"
    && /^[A-Za-z0-9_-]+$/.test(source.language)
    && source.language.length <= 64
    ? source.language
    : defaults.language;
  const search = typeof source.search === "string"
    ? Array.from(source.search).slice(0, maxSearchChars).join("")
    : defaults.search;
  return {
    site: ["global", "china"].includes(source.site) ? source.site : defaults.site,
    difficulty: ["all", "easy", "medium", "hard"].includes(source.difficulty)
      ? source.difficulty
      : defaults.difficulty,
    problemId: typeof source.problemId === "string" && localProblemIds.has(source.problemId)
      ? source.problemId
      : defaults.problemId,
    problemSlug,
    language,
    vimMode: source.vimMode === true,
    search,
  };
}

export function canUseOfficialJudge(account) {
  return account?.isSignedIn === true;
}

export function connectionFailurePresentation(bridgeAvailable, errorMessage = "") {
  if (!bridgeAvailable) {
    return {
      label: "Offline practice",
      status: "offline",
      title: "Start the Leetcodex launcher to log in and use official problems",
    };
  }
  return {
    label: "LeetCode unavailable",
    status: "error",
    title: errorMessage || "The LeetCode connection is unavailable",
  };
}

export function composerReattachDelay(attempt) {
  const normalized = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(1000, 100 + normalized * 100);
}

export function composerSurfaceMinHeight(surfaceBaseHeight, editorHeight, viewportHeight) {
  const base = Number.isFinite(surfaceBaseHeight) ? Math.max(0, surfaceBaseHeight) : 0;
  const editor = Number.isFinite(editorHeight) ? Math.max(0, editorHeight) : 190;
  const desired = Math.max(base + 500, editor + 440);
  if (!Number.isFinite(viewportHeight)) return desired;
  const viewportLimit = Math.max(360, Math.floor(viewportHeight) - 24);
  return Math.min(desired, viewportLimit);
}

export function shouldResumeActiveSession(previous, nextVersion, persistedActive = false) {
  if (previous) return previous.version !== nextVersion && previous.active === true;
  return persistedActive === true;
}

export function isCurrentQuestionRequest(state, request) {
  return state.active
    && state.online
    && request.generation === state.questionLoadGeneration
    && request.site === state.settings.site
    && request.titleSlug === state.settings.problemSlug;
}

export function isCurrentSiteRequest(state, request) {
  return state.active
    && request.generation === state.siteGeneration
    && request.site === state.settings.site;
}

export function isCurrentLoginRequest(state, request) {
  return state.active
    && request.generation === state.loginGeneration
    && request.site === state.settings.site;
}

export function isCurrentRunRequest(state, request) {
  const problem = state.remoteQuestion?.titleSlug || state.settings.problemId;
  return state.active
    && request.generation === state.runGeneration
    && request.site === state.settings.site
    && request.language === state.settings.language
    && request.problem === problem;
}

export function canUpdateBackgroundResult(state, ownerRevision) {
  return state.active && !state.running && state.resultRevision === ownerRevision;
}

export function problemPageRetryDelay(attempt) {
  const normalized = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(2_000, 250 * (2 ** (normalized - 1)));
}

export function siteReconnectRetryDelay(attempt) {
  const normalized = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(30_000, 2_000 * (2 ** (normalized - 1)));
}

export const REMOTE_CATALOG_CACHE_TTL_MS = 5 * 60 * 1_000;

export function storeRemoteCatalog(cache, criteria, problems, now = Date.now(), maxEntries = 8) {
  if (!(cache instanceof Map) || !Array.isArray(problems) || problems.length === 0) return false;
  const key = remoteCatalogCacheKey(criteria);
  cache.delete(key);
  cache.set(key, { storedAt: now, problems: [...problems] });
  const limit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 8;
  while (cache.size > limit) cache.delete(cache.keys().next().value);
  return true;
}

export function readRemoteCatalog(
  cache,
  criteria,
  now = Date.now(),
  ttl = REMOTE_CATALOG_CACHE_TTL_MS,
) {
  if (!(cache instanceof Map)) return null;
  const key = remoteCatalogCacheKey(criteria);
  const entry = cache.get(key);
  const age = now - entry?.storedAt;
  if (!entry || !Array.isArray(entry.problems) || entry.problems.length === 0
    || !Number.isFinite(age) || age < 0 || age > ttl) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return [...entry.problems];
}

function remoteCatalogCacheKey(criteria) {
  return JSON.stringify([
    criteria?.site ?? "",
    criteria?.difficulty ?? "",
    criteria?.search ?? "",
  ]);
}

export async function recoverProblemPage(
  load,
  {
    isCurrent = () => true,
    onRetry = () => {},
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    maxRecoveryAttempts = 5,
  } = {},
) {
  let recoveryAttempt = 0;
  while (isCurrent()) {
    try {
      return await load();
    } catch (error) {
      recoveryAttempt += 1;
      if (!isCurrent() || recoveryAttempt > maxRecoveryAttempts) throw error;
      const delay = siteReconnectRetryDelay(recoveryAttempt);
      onRetry({ attempt: recoveryAttempt, delay, error });
      await wait(delay);
    }
  }
  return null;
}

export function advanceProblemPageOffset(offset, batchLength) {
  const current = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const received = Number.isFinite(batchLength) ? Math.max(0, Math.floor(batchLength)) : 0;
  return current + received;
}

export function runButtonState(running, runningKind) {
  const canCancel = running === true && runningKind === "run";
  return {
    canCancel,
    disabled: running === true && !canCancel,
    label: canCancel ? "Stop" : "Run",
    title: canCancel ? "Stop current run" : "Run official examples",
  };
}

export function controlAvailability(state, role, siteLabel = "LeetCode") {
  const runPresentation = runButtonState(state.running, state.runningKind);
  const cancellableRun = runPresentation.canCancel && role === "run";
  if (cancellableRun) return { disabled: false, reason: "" };
  if (state.running && !cancellableRun && role !== "details") {
    return {
      disabled: true,
      reason: `Wait for the current ${state.runningKind === "submit" ? "submission" : "run"} to finish`,
    };
  }
  if (state.loadingQuestion && ["language", "run", "submit", "reset"].includes(role)) {
    return { disabled: true, reason: "Wait for the official problem to finish loading" };
  }
  if (role === "login" && state.bridgeAvailable === false) {
    return { disabled: true, reason: "Start the Leetcodex launcher to log in" };
  }
  if (state.online && !canUseOfficialJudge(state.account) && ["run", "submit"].includes(role)) {
    return { disabled: true, reason: `Log in to ${siteLabel} to run or submit code` };
  }
  if (!state.online && state.settings?.language !== "javascript" && ["run", "submit"].includes(role)) {
    return { disabled: true, reason: "Offline execution is available for JavaScript only" };
  }
  if (state.loggingIn && role === "login") {
    return { disabled: true, reason: "Wait for the login window to open" };
  }
  return { disabled: false, reason: "" };
}
