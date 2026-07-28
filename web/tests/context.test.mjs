import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceProblemPageOffset,
  bridgePendingSnapshot,
  canUpdateBackgroundResult,
  connectionFailurePresentation,
  controlAvailability,
  composerReattachDelay,
  composerSurfaceMinHeight,
  canUseOfficialJudge,
  draftProblemIdentity,
  draftWriteContext,
  isPersistedSolvedId,
  isCurrentLoginRequest,
  isCurrentQuestionRequest,
  isCurrentRunRequest,
  isCurrentSiteRequest,
  normalizePersistedSettings,
  problemPageRetryDelay,
  readRemoteCatalog,
  recoverProblemPage,
  resolveDraftCode,
  runButtonState,
  shouldResumeActiveSession,
  siteReconnectRetryDelay,
  storeRemoteCatalog,
} from "../src/context.js";
import { buildWorkerSource } from "../src/runner.js";

test("bridge diagnostics distinguish live requests from stalled timers", () => {
  assert.deepEqual(bridgePendingSnapshot([], 10_000), {
    pendingBridge: 0,
    pendingBridgeOldestMs: null,
    staleBridge: 0,
  });
  assert.deepEqual(bridgePendingSnapshot([
    { startedAt: 8_000, deadlineAt: 12_000 },
    { startedAt: 9_500, deadlineAt: 10_500 },
  ], 10_000), {
    pendingBridge: 2,
    pendingBridgeOldestMs: 2_000,
    staleBridge: 0,
  });
  assert.equal(bridgePendingSnapshot([
    { startedAt: 1_000, deadlineAt: 8_000 },
  ], 10_000).staleBridge, 0);
  assert.equal(bridgePendingSnapshot([
    { startedAt: 1_000, deadlineAt: 7_999 },
  ], 10_000).staleBridge, 1);
});

test("bridge diagnostics ignore malformed timing metadata without hiding queue size", () => {
  assert.deepEqual(bridgePendingSnapshot([
    {},
    { startedAt: Number.NaN, deadlineAt: 1 },
    { startedAt: 11_000, deadlineAt: 12_000 },
    { startedAt: 9_000, deadlineAt: 8_000 },
  ], 10_000), {
    pendingBridge: 4,
    pendingBridgeOldestMs: 1_000,
    staleBridge: 0,
  });
});

test("composer reattach retries quickly and cap at one second", () => {
  assert.equal(composerReattachDelay(1), 200);
  assert.equal(composerReattachDelay(4), 500);
  assert.equal(composerReattachDelay(9), 1000);
  assert.equal(composerReattachDelay(100), 1000);
  assert.equal(composerReattachDelay(Number.NaN), 200);
});

test("connection failures distinguish offline practice from a live bridge failure", () => {
  assert.deepEqual(connectionFailurePresentation(false), {
    label: "Offline practice",
    status: "offline",
    title: "Start the Leetcodex launcher to log in and use official problems",
  });
  assert.deepEqual(connectionFailurePresentation(true, "profile is unavailable"), {
    label: "LeetCode unavailable",
    status: "error",
    title: "profile is unavailable",
  });
});

test("composer surface height respects low viewport budgets", () => {
  assert.equal(composerSurfaceMinHeight(90, 190, 900), 630);
  assert.equal(composerSurfaceMinHeight(90, 190, 600), 576);
  assert.equal(composerSurfaceMinHeight(90, 190, 400), 376);
  assert.equal(composerSurfaceMinHeight(90, 190, Number.NaN), 630);
});

test("only an active older injection resumes after replacement", () => {
  assert.equal(shouldResumeActiveSession({ version: "0.2.8", active: true }, "0.2.9"), true);
  assert.equal(shouldResumeActiveSession({ version: "0.2.8", active: false }, "0.2.9"), false);
  assert.equal(shouldResumeActiveSession({ version: "0.2.9", active: true }, "0.2.9"), false);
  assert.equal(shouldResumeActiveSession(null, "0.2.9"), false);
  assert.equal(shouldResumeActiveSession(null, "0.2.9", true), true);
  assert.equal(shouldResumeActiveSession({ version: "0.2.8", active: false }, "0.2.9", true), false);
});

test("offline drafts ignore a stale remote problem slug", () => {
  const settings = { site: "global", problemId: "two-sum", problemSlug: "add-two-numbers" };
  assert.equal(draftProblemIdentity({ online: false, remoteQuestion: null, settings }), "two-sum");
  assert.equal(
    draftProblemIdentity({ online: true, remoteQuestion: { titleSlug: "valid-parentheses" }, settings }),
    "valid-parentheses",
  );
});

test("draft writes stay with the code currently visible in the editor", () => {
  const visible = { key: "global:longest-substring:cpp", problem: "longest-substring" };
  const incoming = { key: "global:add-two-numbers:cpp", problem: "add-two-numbers" };
  assert.equal(draftWriteContext(visible, incoming), visible);
  assert.equal(draftWriteContext(null, incoming), incoming);
});

test("draft restoration preserves intentional empty and whitespace-only code", () => {
  assert.equal(resolveDraftCode(null, "starter"), "starter");
  assert.equal(resolveDraftCode("", "starter"), "");
  assert.equal(resolveDraftCode("  \n", "starter"), "  \n");
  assert.equal(resolveDraftCode("old starter", "new starter", "old starter"), "new starter");
});

test("persisted solved ids retain local and site-scoped official problems", () => {
  const localIds = new Set(["two-sum"]);
  assert.equal(isPersistedSolvedId("two-sum", localIds), true);
  assert.equal(isPersistedSolvedId("global:add-two-numbers", localIds), true);
  assert.equal(isPersistedSolvedId("china:two-sum", localIds), true);
  assert.equal(isPersistedSolvedId("other:two-sum", localIds), false);
  assert.equal(isPersistedSolvedId("global:../secret", localIds), false);
  assert.equal(isPersistedSolvedId({ id: "two-sum" }, localIds), false);
});

test("persisted settings reject malformed fields and bound hidden search state", () => {
  const defaults = {
    site: "global",
    difficulty: "all",
    problemId: "two-sum",
    problemSlug: "",
    language: "javascript",
    vimMode: false,
    search: "",
    topic: "",
  };
  const normalized = normalizePersistedSettings({
    site: "lookalike",
    difficulty: ["hard"],
    problemId: "missing",
    problemSlug: "../secret",
    language: { slug: "cpp" },
    vimMode: "true",
    search: "abcdef",
    topic: "../graph",
    unexpected: "discarded",
  }, defaults, new Set(["two-sum"]), 5);
  assert.deepEqual(normalized, { ...defaults, search: "abcde" });
});

test("persisted settings retain safe official selections and Unicode search text", () => {
  const defaults = {
    site: "global",
    difficulty: "all",
    problemId: "two-sum",
    problemSlug: "",
    language: "javascript",
    vimMode: false,
    search: "",
    topic: "",
  };
  assert.deepEqual(normalizePersistedSettings({
    site: "china",
    difficulty: "hard",
    problemId: "valid-parentheses",
    problemSlug: "add-two-numbers",
    language: "python3",
    vimMode: true,
    search: "数组题目abc",
    topic: "dynamic-programming",
  }, defaults, new Set(["two-sum", "valid-parentheses"]), 4), {
    site: "china",
    difficulty: "hard",
    problemId: "valid-parentheses",
    problemSlug: "add-two-numbers",
    language: "python3",
    vimMode: true,
    search: "数组题目",
    topic: "dynamic-programming",
  });
});

test("official judging requires an authenticated account", () => {
  assert.equal(canUseOfficialJudge({ isSignedIn: true }), true);
  assert.equal(canUseOfficialJudge({ isSignedIn: false }), false);
  assert.equal(canUseOfficialJudge(null), false);
});

test("stale question responses cannot replace the current selection", () => {
  const state = {
    active: true,
    online: true,
    questionLoadGeneration: 4,
    settings: { site: "global", problemSlug: "two-sum" },
  };
  assert.equal(isCurrentQuestionRequest(state, { generation: 4, site: "global", titleSlug: "two-sum" }), true);
  assert.equal(isCurrentQuestionRequest(state, { generation: 3, site: "global", titleSlug: "two-sum" }), false);
  assert.equal(isCurrentQuestionRequest(state, { generation: 4, site: "global", titleSlug: "three-sum" }), false);
});

test("site and login responses cannot cross a site switch", () => {
  const state = {
    active: true,
    siteGeneration: 3,
    loginGeneration: 8,
    settings: { site: "china" },
  };
  assert.equal(isCurrentSiteRequest(state, { generation: 3, site: "china" }), true);
  assert.equal(isCurrentSiteRequest(state, { generation: 2, site: "china" }), false);
  assert.equal(isCurrentSiteRequest(state, { generation: 3, site: "global" }), false);
  assert.equal(isCurrentLoginRequest(state, { generation: 8, site: "china" }), true);
  assert.equal(isCurrentLoginRequest(state, { generation: 7, site: "china" }), false);
  assert.equal(isCurrentLoginRequest(state, { generation: 8, site: "global" }), false);
});

test("judge responses cannot escape their active problem generation", () => {
  const state = {
    active: true,
    runGeneration: 6,
    remoteQuestion: { titleSlug: "two-sum" },
    settings: { site: "global", language: "cpp", problemId: "offline-problem" },
  };
  const request = { generation: 6, site: "global", language: "cpp", problem: "two-sum" };
  assert.equal(isCurrentRunRequest(state, request), true);
  assert.equal(isCurrentRunRequest({ ...state, active: false }, request), false);
  assert.equal(isCurrentRunRequest({ ...state, runGeneration: 7 }, request), false);
  assert.equal(isCurrentRunRequest({ ...state, settings: { ...state.settings, language: "java" } }, request), false);
  assert.equal(isCurrentRunRequest({ ...state, remoteQuestion: { titleSlug: "three-sum" } }, request), false);
});

test("offline judge responses are scoped to the selected local problem", () => {
  const state = {
    active: true,
    runGeneration: 2,
    remoteQuestion: null,
    settings: { site: "global", language: "javascript", problemId: "two-sum" },
  };
  assert.equal(isCurrentRunRequest(state, {
    generation: 2,
    site: "global",
    language: "javascript",
    problem: "two-sum",
  }), true);
  assert.equal(isCurrentRunRequest({
    ...state,
    settings: { ...state.settings, problemId: "valid-parentheses" },
  }, {
    generation: 2,
    site: "global",
    language: "javascript",
    problem: "two-sum",
  }), false);
});

test("background progress cannot overwrite a newer foreground result", () => {
  const state = { active: true, running: false, resultRevision: 12 };
  assert.equal(canUpdateBackgroundResult(state, 12), true);
  assert.equal(canUpdateBackgroundResult({ ...state, resultRevision: 13 }, 12), false);
  assert.equal(canUpdateBackgroundResult({ ...state, running: true }, 12), false);
  assert.equal(canUpdateBackgroundResult({ ...state, active: false }, 12), false);
  assert.equal(canUpdateBackgroundResult(state, null), false);
});

test("problem pagination retries briefly and advances by raw server batches", () => {
  assert.equal(problemPageRetryDelay(1), 250);
  assert.equal(problemPageRetryDelay(2), 500);
  assert.equal(problemPageRetryDelay(4), 2_000);
  assert.equal(problemPageRetryDelay(20), 2_000);
  assert.equal(advanceProblemPageOffset(100, 100), 200);
  assert.equal(advanceProblemPageOffset(200, 0), 200);
  assert.equal(advanceProblemPageOffset(Number.NaN, 25), 25);
});

test("site reconnect retries back off without becoming unbounded", () => {
  assert.equal(siteReconnectRetryDelay(1), 2_000);
  assert.equal(siteReconnectRetryDelay(2), 4_000);
  assert.equal(siteReconnectRetryDelay(4), 16_000);
  assert.equal(siteReconnectRetryDelay(5), 30_000);
  assert.equal(siteReconnectRetryDelay(20), 30_000);
  assert.equal(siteReconnectRetryDelay(Number.NaN), 2_000);
});

test("remaining problem pages recover at the same offset after longer failures", async () => {
  let calls = 0;
  const waits = [];
  const retries = [];
  const result = await recoverProblemPage(
    async () => {
      calls += 1;
      if (calls <= 2) throw new Error(`failure ${calls}`);
      return { offset: 500 };
    },
    {
      wait: async (milliseconds) => waits.push(milliseconds),
      onRetry: ({ attempt, delay, error }) => retries.push({ attempt, delay, message: error.message }),
    },
  );

  assert.deepEqual(result, { offset: 500 });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2_000, 4_000]);
  assert.deepEqual(retries, [
    { attempt: 1, delay: 2_000, message: "failure 1" },
    { attempt: 2, delay: 4_000, message: "failure 2" },
  ]);
});

test("remaining problem page recovery stops when its selection is stale", async () => {
  let current = true;
  let calls = 0;
  const result = await recoverProblemPage(
    async () => {
      calls += 1;
      throw new Error("temporary failure");
    },
    {
      isCurrent: () => current,
      wait: async () => {
        current = false;
      },
    },
  );

  assert.equal(result, null);
  assert.equal(calls, 1);
});

test("remaining problem page recovery reports its final failure", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    recoverProblemPage(
      async () => {
        calls += 1;
        throw new Error("still unavailable");
      },
      {
        maxRecoveryAttempts: 2,
        wait: async (milliseconds) => waits.push(milliseconds),
      },
    ),
    /still unavailable/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2_000, 4_000]);
});

test("completed remote catalogs are cached by criteria with TTL and LRU bounds", () => {
  const cache = new Map();
  const globalAll = { site: "global", difficulty: "all", search: "", topic: "" };
  const globalHard = { site: "global", difficulty: "hard", search: "", topic: "" };
  const chinaAll = { site: "china", difficulty: "all", search: "", topic: "" };
  const first = [{ titleSlug: "two-sum" }];
  const second = [{ titleSlug: "n-queens" }];
  const third = [{ titleSlug: "add-two-numbers" }];

  assert.equal(storeRemoteCatalog(cache, globalAll, first, 1_000, 2), true);
  assert.equal(storeRemoteCatalog(cache, globalHard, second, 1_000, 2), true);
  assert.deepEqual(readRemoteCatalog(cache, globalAll, 2_000), first);
  assert.equal(storeRemoteCatalog(cache, chinaAll, third, 2_000, 2), true);
  assert.equal(readRemoteCatalog(cache, globalHard, 2_000), null);
  assert.deepEqual(readRemoteCatalog(cache, globalAll, 2_000), first);
  assert.deepEqual(readRemoteCatalog(cache, chinaAll, 2_000), third);
  assert.notEqual(readRemoteCatalog(cache, globalAll, 2_000), first);
  assert.equal(readRemoteCatalog(cache, globalAll, 302_001), null);
});

test("remote catalog cache rejects empty, future, and mismatched entries", () => {
  const cache = new Map();
  const criteria = { site: "global", difficulty: "all", search: "array", topic: "" };
  assert.equal(storeRemoteCatalog(cache, criteria, [], 1_000), false);
  assert.equal(readRemoteCatalog(cache, criteria, 1_000), null);
  assert.equal(storeRemoteCatalog(cache, criteria, [{ titleSlug: "two-sum" }], 2_000), true);
  assert.equal(readRemoteCatalog(cache, criteria, 1_999), null);
  assert.equal(readRemoteCatalog(cache, { ...criteria, search: "graph" }, 2_000), null);
  assert.equal(readRemoteCatalog(cache, { ...criteria, topic: "array" }, 2_000), null);
});

test("Run becomes cancellable Stop while Submit remains locked", () => {
  assert.deepEqual(runButtonState(false, null), {
    canCancel: false,
    disabled: false,
    label: "Run",
    title: "Run official examples",
  });
  assert.deepEqual(runButtonState(true, "run"), {
    canCancel: true,
    disabled: false,
    label: "Stop",
    title: "Stop current run",
  });
  assert.deepEqual(runButtonState(true, "submit"), {
    canCancel: false,
    disabled: true,
    label: "Run",
    title: "Run official examples",
  });
});

test("disabled controls expose the state-specific reason", () => {
  const ready = {
    running: false,
    runningKind: null,
    loadingQuestion: false,
    online: true,
    account: { isSignedIn: false },
    loggingIn: false,
  };
  assert.deepEqual(controlAvailability(ready, "run", "leetcode.cn"), {
    disabled: true,
    reason: "Log in to leetcode.cn to run or submit code",
  });
  assert.deepEqual(controlAvailability({ ...ready, loadingQuestion: true }, "reset"), {
    disabled: true,
    reason: "Wait for the official problem to finish loading",
  });
  assert.deepEqual(controlAvailability({ ...ready, loggingIn: true }, "login"), {
    disabled: true,
    reason: "Wait for the login window to open",
  });
  assert.deepEqual(controlAvailability({ ...ready, running: true, runningKind: "run" }, "run"), {
    disabled: false,
    reason: "",
  });
  assert.deepEqual(controlAvailability({ ...ready, running: true, runningKind: "run" }, "submit"), {
    disabled: true,
    reason: "Wait for the current run to finish",
  });
  assert.deepEqual(controlAvailability({ ...ready, running: true, runningKind: "submit" }, "details"), {
    disabled: false,
    reason: "",
  });
});

test("offline controls disable actions that require the native bridge", () => {
  const state = {
    running: false,
    runningKind: null,
    loadingQuestion: false,
    loggingIn: false,
    online: false,
    account: null,
    bridgeAvailable: false,
    settings: { language: "javascript" },
  };
  assert.deepEqual(controlAvailability(state, "login", "leetcode.com"), {
    disabled: true,
    reason: "Start the Leetcodex launcher to log in",
  });
  state.settings.language = "cpp";
  assert.deepEqual(controlAvailability(state, "run", "leetcode.com"), {
    disabled: true,
    reason: "Offline execution is available for JavaScript only",
  });
  assert.deepEqual(controlAvailability(state, "submit", "leetcode.com"), {
    disabled: true,
    reason: "Offline execution is available for JavaScript only",
  });
  state.loadingQuestion = true;
  assert.deepEqual(controlAvailability(state, "run", "leetcode.com"), {
    disabled: true,
    reason: "Wait for the official problem to finish loading",
  });
});

test("worker source isolates common user variable names", () => {
  const source = buildWorkerSource(`
    const equal = true;
    const compareJson = true;
    const canonicalize = true;
    const resolveSolution = true;
    function twoSum(nums, target) { return [0, 1]; }
  `, "twoSum");
  assert.doesNotThrow(() => new Function(source));
  assert.doesNotMatch(source, /new Function/);
});
