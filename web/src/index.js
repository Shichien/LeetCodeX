import { APP_VERSION, CSS_TEXT, PROBLEMS } from "virtual:leetcodex-assets";
import {
  advanceProblemPageOffset,
  bridgePendingSnapshot,
  canUpdateBackgroundResult,
  connectionFailurePresentation,
  controlAvailability,
  canUseOfficialJudge,
  composerReattachDelay,
  composerSurfaceMinHeight,
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
} from "./context.js";
import { createCodeEditor } from "./editor.js";
import {
  normalizeProblemText,
  problemFrontendId,
  serializeProblemNode,
  truncateDisplayText,
} from "./content.js";
import {
  OFFICIAL_JUDGE_TIMEOUT_MS,
  isPendingJudgeResult,
  judgePollDelay,
  judgeRequestTimeout,
  summarizeJudgeResult,
  waitForJudgePoll,
} from "./judge.js";
import { runSolution } from "./runner.js";
import { localStarter } from "./templates.js";

const VERSION = APP_VERSION;
const BRIDGE_TOKEN = "__LEETCODEX_BRIDGE_TOKEN__";
const BRIDGE_TIMEOUT_MS = 20_000;
const MAX_BRIDGE_PAYLOAD_BYTES = 1_500_000;
const BRIDGE_STATE_KEY = "__LEETCODEX_BRIDGE_STATE__";
const bridgeState = window[BRIDGE_STATE_KEY] ?? { pending: new Map(), sequence: 0 };
window[BRIDGE_STATE_KEY] = bridgeState;
const GLOBAL_KEY = "__LEETCODEX__";
const STYLE_ID = "leetcodex-style";
const ROOT_ATTRIBUTE = "data-leetcodex-root";
const ACTIVE_EDITOR_ATTRIBUTE = "data-leetcodex-editor";
const ACTIVE_SURFACE_ATTRIBUTE = "data-leetcodex-surface";
const SETTINGS_KEY = "leetcodex.settings.v1";
const SOLVED_KEY = "leetcodex.solved.v1";
const DRAFT_KEY_PREFIX = "leetcodex.draft.v1";
const ACTIVE_SESSION_KEY = "leetcodex.active.v1";
const DIFFICULTIES = ["all", "easy", "medium", "hard"];
const MAX_SEARCH_CHARS = 200;
const SUBMISSION_LANGUAGES = [
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["golang", "Go"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["kotlin", "Kotlin"],
  ["php", "PHP"],
  ["python3", "Python 3"],
  ["ruby", "Ruby"],
  ["rust", "Rust"],
  ["scala", "Scala"],
  ["swift", "Swift"],
  ["typescript", "TypeScript"],
];

const previous = window[GLOBAL_KEY];
if (previous?.version === VERSION) {
  previous.ensure?.();
} else {
  const resumeActive = shouldResumeActiveSession(previous, VERSION, loadActiveSession());
  previous?.destroy?.();
  install({ resumeActive });
}

function install({ resumeActive = false } = {}) {
  installStyle();
  const state = {
    active: false,
    running: false,
    runningKind: null,
    editor: null,
    codeEditor: null,
    codeHost: null,
    surface: null,
    editorBranch: null,
    editorBranchStyles: null,
    panel: null,
    snapshot: null,
    editorStyles: null,
    surfaceStyles: null,
    editorBaseHeight: 0,
    surfaceBaseHeight: 0,
    settings: loadSettings(),
    solved: loadSolved(),
    remoteProblems: [],
    remoteCatalogCache: new Map(),
    remoteLoadGeneration: 0,
    remoteRetryAttempt: 0,
    remoteRetryTimer: 0,
    questionLoadGeneration: 0,
    siteGeneration: 0,
    loginGeneration: 0,
    runGeneration: 0,
    runAbortController: null,
    resultRevision: 0,
    loadingQuestion: false,
    loggingIn: false,
    remoteQuestion: null,
    account: null,
    online: false,
    bridgeAvailable: typeof window.leetcodexBridge === "function",
    ensureTimer: 0,
    reattachAttempts: 0,
    searchTimer: 0,
    loginTimer: 0,
    draftSaveTimer: 0,
    draftLoadGeneration: 0,
    editorDraftContext: null,
    applyingCode: false,
    problemExpanded: false,
    controlTitles: new WeakMap(),
  };

  const observer = new MutationObserver((records) => {
    if (!state.active) return;
    const hostChanged = records.some((record) => !isLeetcodexMutation(record));
    if (!hostChanged) return;
    window.clearTimeout(state.ensureTimer);
    state.ensureTimer = 0;
    ensureAttached();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const onKeyDown = (event) => {
    if (isToggleShortcut(event)) {
      stopEvent(event);
      state.active ? deactivate() : activate();
      return;
    }
    if (state.active && event.key === "Escape" && state.codeHost?.contains(event.target)) {
      stopEvent(event);
      handlePracticeEscape();
      return;
    }
    if (!state.active || !eventTargetsEditor(event, state.editor)) return;
    if (event.key === "Escape") {
      stopEvent(event);
      deactivate();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      stopEvent(event);
      executeTests(false);
      return;
    }
    if (event.key === "Enter") {
      stopEvent(event);
      insertLineBreak();
      return;
    }
    if (event.key === "Tab") {
      stopEvent(event);
      document.execCommand("insertText", false, "  ");
    }
  };

  const onKeyPressOrUp = (event) => {
    if (!state.active || !eventTargetsEditor(event, state.editor)) return;
    if (event.key === "Enter" || event.key === "Tab") stopEvent(event);
  };

  const onBeforeInput = (event) => {
    if (!state.active || !eventTargetsEditor(event, state.editor)) return;
    if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) {
      stopEvent(event);
      insertLineBreak();
    }
  };

  const onSubmit = (event) => {
    if (!state.active) return;
    stopEvent(event);
    focusEditor();
  };

  const flushDraftBeforeSuspension = () => {
    if (state.active) saveCurrentDraft();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") flushDraftBeforeSuspension();
  };

  const onResize = () => {
    if (state.active) applyComposerSize();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keypress", onKeyPressOrUp, true);
  window.addEventListener("keyup", onKeyPressOrUp, true);
  window.addEventListener("beforeinput", onBeforeInput, true);
  window.addEventListener("submit", onSubmit, true);
  window.addEventListener("pagehide", flushDraftBeforeSuspension, true);
  document.addEventListener("freeze", flushDraftBeforeSuspension, true);
  document.addEventListener("visibilitychange", onVisibilityChange, true);
  window.addEventListener("resize", onResize, { passive: true });

  function activate() {
    if (document.querySelector("[data-cotypex-editor='true']")) {
      window.__COTYPEX__?.toggle?.();
    }
    const editor = findMainComposer();
    if (!editor) return false;
    state.active = true;
    saveActiveSession(true);
    try {
      mountComposer(editor);
      return true;
    } catch (error) {
      console.error("Leetcodex activation failed", error);
      state.active = false;
      saveActiveSession(false);
      invalidateActiveWork();
      teardownMountedComposer(true);
      return false;
    }
  }

  function deactivate() {
    if (!state.active) return true;
    saveCurrentDraft();
    state.active = false;
    saveActiveSession(false);
    invalidateActiveWork();
    teardownMountedComposer(true);
    return true;
  }

  function mountComposer(editor) {
    state.editor = editor;
    state.surface = findComposerSurface(editor);
    state.editorBranch = directChildContaining(state.surface, editor);
    if (!state.editorBranch) throw new Error("Codex editor branch was not found");
    state.snapshot = captureEditor(editor);
    state.editorStyles = captureInlineStyles(editor, ["min-height", "transition"]);
    state.editorBranchStyles = captureInlineStyles(state.editorBranch, ["display"]);
    state.surfaceStyles = captureInlineStyles(state.surface, ["min-height", "transition"]);
    state.editorBaseHeight = Math.ceil(editor.getBoundingClientRect().height);
    state.surfaceBaseHeight = Math.ceil(state.surface.getBoundingClientRect().height);
    editor.setAttribute(ACTIVE_EDITOR_ATTRIBUTE, "true");
    state.surface.setAttribute(ACTIVE_SURFACE_ATTRIBUTE, "true");
    state.editorBranch.style.setProperty("display", "none", "important");
    applyComposerSize();
    createPanel();
    createEditorSurface();
    loadProblem(activeProblem(), true);
    if (state.bridgeAvailable) {
      setAccount("Connecting...", "pending");
      setQuestionLoading(true);
      setResult("Connecting to LeetCode...", "running");
    }
    connectSite();
    state.reattachAttempts = 0;
    focusEditor();
  }

  function invalidateActiveWork() {
    state.runAbortController?.abort();
    state.runAbortController = null;
    state.running = false;
    state.runningKind = null;
    state.loadingQuestion = false;
    state.loggingIn = false;
    state.remoteLoadGeneration += 1;
    state.questionLoadGeneration += 1;
    state.siteGeneration += 1;
    state.loginGeneration += 1;
    state.runGeneration += 1;
    window.clearTimeout(state.ensureTimer);
    window.clearTimeout(state.searchTimer);
    window.clearTimeout(state.loginTimer);
    window.clearTimeout(state.remoteRetryTimer);
    window.clearTimeout(state.draftSaveTimer);
    state.remoteRetryTimer = 0;
    state.remoteRetryAttempt = 0;
    state.draftLoadGeneration += 1;
    state.account = null;
    state.online = false;
    state.remoteProblems = [];
    state.remoteQuestion = null;
  }

  function teardownMountedComposer(restoreOriginal) {
    if (restoreOriginal) restoreSnapshot();
    if (restoreOriginal) restoreInlineStyles(state.editor, state.editorStyles);
    if (restoreOriginal) restoreInlineStyles(state.editorBranch, state.editorBranchStyles);
    if (restoreOriginal) restoreInlineStyles(state.surface, state.surfaceStyles);
    state.editor?.removeAttribute(ACTIVE_EDITOR_ATTRIBUTE);
    state.surface?.removeAttribute(ACTIVE_SURFACE_ATTRIBUTE);
    state.panel?.remove();
    state.codeEditor?.destroy();
    state.codeHost?.remove();
    state.editor = null;
    state.codeEditor = null;
    state.editorDraftContext = null;
    state.codeHost = null;
    state.surface = null;
    state.editorBranch = null;
    state.editorBranchStyles = null;
    state.panel = null;
    state.snapshot = null;
    state.editorStyles = null;
    state.surfaceStyles = null;
    state.editorBaseHeight = 0;
    state.surfaceBaseHeight = 0;
  }

  function createEditorSurface() {
    const host = document.createElement("section");
    host.className = "leetcodex-code-editor";
    host.setAttribute(ROOT_ATTRIBUTE, "true");
    host.setAttribute("aria-label", "Code editor");
    state.surface.insertBefore(host, state.editorBranch);
    state.codeHost = host;
    state.codeEditor = createCodeEditor({
      parent: host,
      value: "",
      language: state.settings.language,
      colorScheme: state.panel?.dataset.colorScheme ?? "dark",
      vimMode: state.settings.vimMode,
      onChange: (value) => {
        if (state.applyingCode) return;
        const context = currentDraftWriteContext();
        saveDraft(context.key, value);
        scheduleNativeDraftSave(context, value);
      },
      onRun: () => executeTests(false),
      onSave: () => {
        saveCurrentDraft();
        setResult("Draft saved", "success");
      },
    });
  }

  function createPanel() {
    state.panel?.remove();
    const panel = document.createElement("section");
    panel.className = "leetcodex-panel";
    panel.setAttribute(ROOT_ATTRIBUTE, "true");
    panel.addEventListener("pointerdown", stopPropagation);
    panel.addEventListener("click", onPanelClick);
    panel.addEventListener("change", onPanelChange);
    panel.addEventListener("input", onPanelInput);
    panel.innerHTML = `
      <div class="leetcodex-toolbar">
        <div class="leetcodex-brand">Leetcodex</div>
        <select class="leetcodex-select leetcodex-site" data-setting="site" title="LeetCode site">
          <option value="global">leetcode.com</option>
          <option value="china">leetcode.cn</option>
        </select>
        <button type="button" class="leetcodex-login" data-action="login" aria-label="Log in to selected LeetCode site">Login</button>
        <span class="leetcodex-account" data-field="account">Offline</span>
        <input class="leetcodex-search" data-setting="search" type="search" placeholder="Search problems" autocomplete="off" maxlength="${MAX_SEARCH_CHARS}" aria-label="Search official problems">
        <select class="leetcodex-select" data-setting="difficulty" title="Difficulty" aria-label="Difficulty"></select>
        <select class="leetcodex-select leetcodex-problem-select" data-setting="problem" title="Problem" aria-label="Problem"></select>
        <select class="leetcodex-select leetcodex-language" data-setting="language" title="Submission language" aria-label="Submission language"></select>
        <label class="leetcodex-vim-toggle" title="Vim mode">
          <input type="checkbox" data-setting="vim" aria-label="Vim mode">
          <span>Vim</span>
        </label>
        <div class="leetcodex-actions">
          <button type="button" data-action="reset">Reset</button>
          <button type="button" data-action="run">Run</button>
          <button type="button" data-action="submit" class="leetcodex-primary">Submit</button>
          <button type="button" data-action="next">Next</button>
        </div>
      </div>
      <div class="leetcodex-problem">
        <div class="leetcodex-heading">
          <strong data-field="title"></strong>
          <span class="leetcodex-difficulty" data-field="difficulty"></span>
          <span class="leetcodex-solved" data-field="solved" hidden>Solved</span>
          <button type="button" class="leetcodex-details-toggle" data-action="details" aria-label="Expand problem details" aria-expanded="false" title="Expand problem details">+</button>
        </div>
        <p data-field="description"></p>
        <div class="leetcodex-example"><span>Example</span><code data-field="example"></code></div>
      </div>
      <div class="leetcodex-result" data-field="result" data-status="idle" role="status" aria-live="polite">Ready</div>
    `;
    populateFallbackLanguageOptions(panel.querySelector("[data-setting='language']"));
    syncColorScheme(panel);
    const difficulty = panel.querySelector("[data-setting='difficulty']");
    for (const value of DIFFICULTIES) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = titleCase(value);
      difficulty.appendChild(option);
    }
    panel.querySelector("[data-setting='site']").value = state.settings.site;
    panel.querySelector("[data-setting='search']").value = state.settings.search;
    panel.querySelector("[data-setting='vim']").checked = state.settings.vimMode;
    difficulty.value = state.settings.difficulty;
    state.surface.insertBefore(panel, state.editorBranch);
    state.panel = panel;
    syncProblemDetails();
    rebuildProblemOptions();
    updateControlDisabledState();
  }

  function onPanelClick(event) {
    event.stopPropagation();
    const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
    if (!button) return;
    const action = button.dataset.action;
    if (action === "details") {
      toggleProblemDetails();
      return;
    }
    if (state.running) {
      if (action === "run" && state.runningKind === "run") cancelRun();
      return;
    }
    if (action === "login") beginLogin();
    if (action === "run") executeTests(false);
    if (action === "submit") executeTests(true);
    if (action === "next") nextProblem();
    if (action === "reset") {
      if (state.remoteQuestion) {
        const snippet = activeCodeSnippet();
        if (snippet) setEditorCode(snippet.code);
        saveCurrentDraft();
        focusEditor();
      } else {
        const problem = activeProblem();
        setEditorCode(localStarter(problem, state.settings.language));
        saveCurrentDraft();
        setResult("Starter restored", "idle");
        focusEditor();
      }
    }
  }

  function onPanelChange(event) {
    event.stopPropagation();
    if (event.target instanceof HTMLInputElement && event.target.dataset.setting === "vim") {
      state.settings.vimMode = event.target.checked;
      saveSettings(state.settings);
      state.codeEditor?.setVimMode(state.settings.vimMode);
      focusEditor();
      return;
    }
    if (!(event.target instanceof HTMLSelectElement)) return;
    if (event.target.dataset.setting === "site") {
      saveCurrentDraft();
      state.questionLoadGeneration += 1;
      state.siteGeneration += 1;
      state.loginGeneration += 1;
      state.loggingIn = false;
      window.clearTimeout(state.loginTimer);
      setQuestionLoading(false);
      state.settings.site = event.target.value === "china" ? "china" : "global";
      state.settings.problemSlug = "";
      state.remoteProblems = [];
      state.remoteQuestion = null;
      state.account = null;
      state.online = false;
      saveSettings(state.settings);
      setAccount("Connecting...", "pending");
      updateControlDisabledState();
      connectSite();
      return;
    }
    if (event.target.dataset.setting === "difficulty") {
      state.settings.difficulty = DIFFICULTIES.includes(event.target.value) ? event.target.value : "all";
      saveSettings(state.settings);
      if (state.online) loadRemoteProblems();
      else {
        const first = filteredProblems()[0];
        if (first) state.settings.problemId = first.id;
        rebuildProblemOptions();
        loadProblem(activeProblem(), true);
      }
    }
    if (event.target.dataset.setting === "problem") {
      saveCurrentDraft();
      if (state.online) {
        state.settings.problemSlug = event.target.value;
        saveSettings(state.settings);
        loadRemoteQuestion(event.target.value);
      } else {
        state.settings.problemId = event.target.value;
        saveSettings(state.settings);
        loadProblem(activeProblem(), true);
      }
    }
    if (event.target.dataset.setting === "language") {
      if (state.loadingQuestion) return;
      saveCurrentDraft();
      state.settings.language = event.target.value;
      saveSettings(state.settings);
      if (state.remoteQuestion) {
        const snippet = activeCodeSnippet();
        if (snippet) loadCodeForCurrentContext(snippet.code);
      } else {
        const problem = activeProblem();
        loadCodeForCurrentContext(localStarter(problem, state.settings.language), problem.starter);
        if (state.settings.language === "javascript") {
          setResult("Offline problem ready", "idle");
        } else {
          setResult(
            state.bridgeAvailable
              ? `Reconnect to LeetCode to run or submit ${activeLanguageLabel()}`
              : "Offline execution is available for JavaScript only",
            "idle",
          );
        }
      }
      updateControlDisabledState();
      focusEditor();
    }
  }

  function onPanelInput(event) {
    if (!(event.target instanceof HTMLInputElement) || event.target.dataset.setting !== "search") return;
    state.settings.search = event.target.value;
    saveSettings(state.settings);
    if (!state.online) return;
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(loadRemoteProblems, 300);
  }

  async function beginLogin() {
    if (state.loggingIn) return;
    const site = state.settings.site;
    const generation = ++state.loginGeneration;
    state.loggingIn = true;
    updateControlDisabledState();
    setAccount("Opening login...", "pending");
    try {
      await bridgeRequest("/api/login", { site });
      if (!isCurrentLoginRequest(state, { site, generation })) return;
      setAccount("Finish login in browser", "pending");
      pollLoginStatus(0, site, generation);
    } catch (error) {
      if (isCurrentLoginRequest(state, { site, generation })) setAccount(error.message, "error");
    } finally {
      if (generation === state.loginGeneration) {
        state.loggingIn = false;
        updateControlDisabledState();
      }
    }
  }

  async function connectSite({ retry = false } = {}) {
    if (!retry) resetSiteReconnect();
    const site = state.settings.site;
    const generation = state.siteGeneration;
    try {
      const payload = await bridgeRequest("/api/status", { site });
      if (!isCurrentSiteRequest(state, { site, generation })) return;
      const account = payload?.data?.userStatus ?? null;
      state.account = account;
      state.online = true;
      setAccount(account?.isSignedIn ? account.username || account.realName || "Signed in" : "Not signed in", account?.isSignedIn ? "online" : "pending");
      updateControlDisabledState();
      await loadRemoteProblems();
    } catch (error) {
      if (!isCurrentSiteRequest(state, { site, generation })) return;
      saveCurrentDraft();
      state.account = null;
      state.online = false;
      state.questionLoadGeneration += 1;
      setQuestionLoading(false);
      state.remoteQuestion = null;
      const presentation = connectionFailurePresentation(
        state.bridgeAvailable,
        error instanceof Error ? error.message : String(error),
      );
      setAccount(presentation.label, presentation.status);
      const account = state.panel?.querySelector("[data-field='account']");
      if (account) account.title = presentation.title;
      if (presentation.status === "error") console.warn("Leetcodex site connection failed", error);
      loadProblem(activeProblem(), true);
      scheduleSiteReconnect();
    }
  }

  function resetSiteReconnect() {
    window.clearTimeout(state.remoteRetryTimer);
    state.remoteRetryTimer = 0;
    state.remoteRetryAttempt = 0;
  }

  function scheduleSiteReconnect() {
    window.clearTimeout(state.remoteRetryTimer);
    state.remoteRetryTimer = 0;
    if (!state.active || !state.bridgeAvailable || state.remoteRetryAttempt >= 5) return false;
    const site = state.settings.site;
    const generation = state.siteGeneration;
    const attempt = ++state.remoteRetryAttempt;
    state.remoteRetryTimer = window.setTimeout(() => {
      state.remoteRetryTimer = 0;
      if (!isCurrentSiteRequest(state, { site, generation })) return;
      void connectSite({ retry: true });
    }, siteReconnectRetryDelay(attempt));
    return true;
  }

  function pollLoginStatus(attempt, site, generation) {
    window.clearTimeout(state.loginTimer);
    if (!isCurrentLoginRequest(state, { site, generation })) return;
    if (attempt >= 90) {
      setAccount("Login check timed out", "error");
      return;
    }
    state.loginTimer = window.setTimeout(async () => {
      try {
        const payload = await bridgeRequest("/api/status", { site });
        if (!isCurrentLoginRequest(state, { site, generation })) return;
        const account = payload?.data?.userStatus ?? null;
        if (account?.isSignedIn) {
          state.account = account;
          state.online = true;
          setAccount(account.username || account.realName || "Signed in", "online");
          await loadRemoteProblems();
          return;
        }
      } catch {
        // The login tab may still be starting.
      }
      pollLoginStatus(attempt + 1, site, generation);
    }, 2000);
  }

  async function loadRemoteProblems() {
    if (!state.active) return;
    const generation = ++state.remoteLoadGeneration;
    const criteria = {
      site: state.settings.site,
      difficulty: state.settings.difficulty,
      search: state.settings.search,
    };
    setQuestionLoading(true);
    setResult("Loading official problem set...", "running");
    const cachedProblems = readRemoteCatalog(state.remoteCatalogCache, criteria);
    if (cachedProblems) {
      state.remoteProblems = cachedProblems;
      state.online = true;
      const selected = state.remoteProblems.find((problem) => problem.titleSlug === state.settings.problemSlug)
        ?? state.remoteProblems[0];
      state.settings.problemSlug = selected.titleSlug;
      saveSettings(state.settings);
      rebuildProblemOptions();
      const questionLoaded = await loadRemoteQuestion(selected.titleSlug);
      if (questionLoaded && isCurrentProblemLoad(generation, criteria)) {
        setResult(`All ${state.remoteProblems.length} official problems ready`, "idle");
      }
      return;
    }
    try {
      const payload = await requestProblemPage(generation, criteria, 0);
      if (!payload) return;
      if (!isCurrentProblemLoad(generation, criteria)) return;
      resetSiteReconnect();
      const list = payload?.data?.problemsetQuestionList;
      const firstBatch = Array.isArray(list?.questions) ? list.questions : [];
      state.remoteProblems = firstBatch;
      state.online = true;
      const selected = state.remoteProblems.find((problem) => problem.titleSlug === state.settings.problemSlug)
        ?? state.remoteProblems[0];
      if (!selected) {
        rebuildProblemOptions();
        setQuestionLoading(false);
        setResult("No official problems match this filter", "idle");
        return;
      }
      state.settings.problemSlug = selected.titleSlug;
      saveSettings(state.settings);
      rebuildProblemOptions();
      const questionLoaded = await loadRemoteQuestion(selected.titleSlug);
      const resultRevision = questionLoaded ? state.resultRevision : null;
      void loadRemainingRemoteProblems(
        generation,
        criteria,
        Number(list?.total) || state.remoteProblems.length,
        firstBatch.length,
        resultRevision,
      );
    } catch (error) {
      if (!isCurrentProblemLoad(generation, criteria)) return;
      saveCurrentDraft();
      state.online = false;
      state.questionLoadGeneration += 1;
      setQuestionLoading(false);
      state.remoteProblems = [];
      state.remoteQuestion = null;
      rebuildProblemOptions();
      loadProblem(activeProblem(), true);
      const retrying = scheduleSiteReconnect();
      setResult(`Offline bank - ${error.message}${retrying ? " - retrying" : ""}`, "error");
    }
  }

  async function loadRemainingRemoteProblems(generation, criteria, total, initialOffset, resultRevision) {
    let nextOffset = initialOffset;
    let ownedResultRevision = resultRevision;
    const updateBackgroundResult = (message, status) => {
      if (!canUpdateBackgroundResult(state, ownedResultRevision)) return false;
      ownedResultRevision = setResult(message, status);
      return true;
    };
    while (nextOffset < total && isCurrentProblemLoad(generation, criteria)) {
      const loaded = state.remoteProblems.length;
      updateBackgroundResult(`Loading official problems ${loaded} / ${total}...`, "running");
      try {
        const payload = await recoverProblemPage(
          async () => {
            const page = await requestProblemPage(generation, criteria, nextOffset);
            const questions = page?.data?.problemsetQuestionList?.questions;
            if (page && (!Array.isArray(questions) || questions.length === 0)) {
              throw new Error("LeetCode returned an empty problem page");
            }
            return page;
          },
          {
            isCurrent: () => isCurrentProblemLoad(generation, criteria),
            onRetry: ({ delay: retryDelay, error }) => {
              updateBackgroundResult(
                `${state.remoteProblems.length} of ${total} problems loaded - retrying in ${retryDelay / 1000}s - ${error.message}`,
                "error",
              );
            },
            wait: delay,
          },
        );
        if (!payload) return;
        if (!isCurrentProblemLoad(generation, criteria)) return;
        const batch = payload?.data?.problemsetQuestionList?.questions;
        if (!Array.isArray(batch) || batch.length === 0) break;
        nextOffset = advanceProblemPageOffset(nextOffset, batch.length);
        const known = new Set(state.remoteProblems.map((problem) => problem.titleSlug));
        state.remoteProblems.push(...batch.filter((problem) => !known.has(problem.titleSlug)));
        rebuildProblemOptions();
      } catch (error) {
        if (isCurrentProblemLoad(generation, criteria)) {
          updateBackgroundResult(
            `${state.remoteProblems.length} of ${total} problems loaded - ${error.message}`,
            "error",
          );
        }
        return;
      }
    }
    if (isCurrentProblemLoad(generation, criteria)) {
      storeRemoteCatalog(state.remoteCatalogCache, criteria, state.remoteProblems);
      updateBackgroundResult(`All ${state.remoteProblems.length} official problems ready`, "idle");
    }
  }

  async function requestProblemPage(generation, criteria, skip) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (!isCurrentProblemLoad(generation, criteria)) return null;
      try {
        return await bridgeRequest("/api/problems", {
          ...criteria,
          skip,
          limit: 100,
        });
      } catch (error) {
        lastError = error;
        if (attempt >= 3 || !isCurrentProblemLoad(generation, criteria)) break;
        await delay(problemPageRetryDelay(attempt));
      }
    }
    throw lastError ?? new Error("Official problem page request failed");
  }

  function isCurrentProblemLoad(generation, criteria) {
    return state.active
      && generation === state.remoteLoadGeneration
      && criteria.site === state.settings.site
      && criteria.difficulty === state.settings.difficulty
      && criteria.search === state.settings.search;
  }

  async function loadRemoteQuestion(titleSlug) {
    if (!titleSlug) return false;
    saveCurrentDraft();
    const generation = ++state.questionLoadGeneration;
    const site = state.settings.site;
    state.remoteQuestion = null;
    setQuestionLoading(true);
    setResult("Loading official problem...", "running");
    try {
      const payload = await bridgeRequest("/api/question", {
        site,
        titleSlug,
      });
      if (!isCurrentQuestionLoad(generation, site, titleSlug)) return false;
      const question = payload?.data?.question;
      if (!question) throw new Error("LeetCode returned no question data");
      state.remoteQuestion = question;
      state.settings.problemSlug = question.titleSlug;
      populateLanguageOptions(question.codeSnippets ?? []);
      saveSettings(state.settings);
      renderRemoteProblem(question);
      const snippet = activeCodeSnippet();
      if (snippet) loadCodeForCurrentContext(snippet.code);
      setResult(question.isPaidOnly ? "Premium problem - submission may require Premium" : "Official problem ready", "idle");
      focusEditor();
      return true;
    } catch (error) {
      if (isCurrentQuestionLoad(generation, site, titleSlug)) setResult(error.message, "error");
      return false;
    } finally {
      if (generation === state.questionLoadGeneration) setQuestionLoading(false);
    }
  }

  function isCurrentQuestionLoad(generation, site, titleSlug) {
    return isCurrentQuestionRequest(state, { generation, site, titleSlug });
  }

  function populateLanguageOptions(snippets) {
    const select = state.panel?.querySelector("[data-setting='language']");
    if (!(select instanceof HTMLSelectElement)) return;
    if (snippets.length === 0) {
      populateFallbackLanguageOptions(select);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const snippet of snippets) {
      const option = document.createElement("option");
      option.value = snippet.langSlug;
      option.textContent = snippet.lang;
      fragment.appendChild(option);
    }
    select.replaceChildren(fragment);
    const preferred = snippets.some((snippet) => snippet.langSlug === state.settings.language)
      ? state.settings.language
      : snippets.find((snippet) => snippet.langSlug === "javascript")?.langSlug ?? snippets[0]?.langSlug ?? "javascript";
    state.settings.language = preferred;
    select.value = preferred;
  }

  function populateFallbackLanguageOptions(select) {
    if (!(select instanceof HTMLSelectElement)) return;
    const fragment = document.createDocumentFragment();
    for (const [value, label] of SUBMISSION_LANGUAGES) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      fragment.appendChild(option);
    }
    select.replaceChildren(fragment);
    if (!SUBMISSION_LANGUAGES.some(([value]) => value === state.settings.language)) {
      state.settings.language = "javascript";
    }
    select.value = state.settings.language;
  }

  function activeLanguageLabel() {
    const option = state.panel?.querySelector(`[data-setting='language'] option[value='${CSS.escape(state.settings.language)}']`);
    return option?.textContent ?? state.settings.language;
  }

  function activeCodeSnippet() {
    return state.remoteQuestion?.codeSnippets?.find((snippet) => snippet.langSlug === state.settings.language)
      ?? state.remoteQuestion?.codeSnippets?.[0]
      ?? null;
  }

  function renderRemoteProblem(question) {
    const listItem = state.remoteProblems.find((problem) => problem.titleSlug === question.titleSlug);
    state.panel.querySelector("[data-field='title']").textContent = `#${problemFrontendId(question)} ${question.title}`;
    const difficulty = state.panel.querySelector("[data-field='difficulty']");
    difficulty.textContent = question.difficulty;
    difficulty.dataset.level = question.difficulty.toLowerCase();
    state.panel.querySelector("[data-field='description']").textContent = htmlToText(question.content) || "Description unavailable";
    const sample = question.exampleTestcases || question.sampleTestCase || "No sample input";
    state.panel.querySelector("[data-field='example']").textContent = sample;
    state.panel.querySelector("[data-field='solved']").hidden = !isAcceptedStatus(listItem?.status)
      && !state.solved.has(`${state.settings.site}:${question.titleSlug}`);
  }

  function setAccount(label, status) {
    const account = state.panel?.querySelector("[data-field='account']");
    if (!account) return;
    account.textContent = label;
    account.dataset.status = status;
    account.title = label;
  }

  function toggleProblemDetails() {
    state.problemExpanded = !state.problemExpanded;
    syncProblemDetails();
  }

  function syncProblemDetails() {
    const problem = state.panel?.querySelector(".leetcodex-problem");
    const button = state.panel?.querySelector("button[data-action='details']");
    if (!problem || !button) return;
    problem.dataset.expanded = String(state.problemExpanded);
    button.textContent = state.problemExpanded ? "-" : "+";
    const label = state.problemExpanded ? "Collapse problem details" : "Expand problem details";
    button.setAttribute("aria-expanded", String(state.problemExpanded));
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  async function executeTests(submit) {
    if (state.running || state.loadingQuestion || !state.codeEditor) return;
    if (state.remoteQuestion && state.online && canUseOfficialJudge(state.account)) {
      await executeRemote(submit);
      return;
    }
    if (state.online) {
      setResult(canUseOfficialJudge(state.account)
        ? "Wait for the official problem to finish loading"
        : "Log in to LeetCode before running or submitting code", "error");
      return;
    }
    if (state.settings.language !== "javascript") {
      setResult(`Log in to LeetCode to run or submit ${activeLanguageLabel()}`, "error");
      return;
    }
    const problem = activeProblem();
    const tests = submit ? problem.tests : problem.tests.filter((test) => !test.hidden);
    const request = {
      generation: ++state.runGeneration,
      site: state.settings.site,
      language: state.settings.language,
      problem: problem.id,
    };
    setRunning(true, submit ? "submit" : "run");
    setResult(submit ? "Checking all tests..." : "Running examples...", "running");
    const runAbortController = new AbortController();
    state.runAbortController = runAbortController;
    let result;
    try {
      result = await runSolution(
        readCurrentCode(),
        problem.entry,
        tests,
        problem.comparison,
        2000,
        globalThis,
        runAbortController.signal,
      );
    } catch (error) {
      if (!isCurrentRunRequest(state, request)) return;
      setRunning(false);
      setResult(error instanceof Error ? error.message : String(error), "error");
      return;
    } finally {
      if (state.runAbortController === runAbortController) state.runAbortController = null;
    }
    if (!isCurrentRunRequest(state, request)) return;
    setRunning(false);
    if (!result.ok) {
      setResult(result.error, "error");
      return;
    }
    const passed = result.results.filter((test) => test.passed).length;
    const failedIndex = result.results.findIndex((test) => !test.passed);
    if (failedIndex >= 0) {
      const failed = result.results[failedIndex];
      setResult(
        `Failed ${failedIndex + 1}/${tests.length}: expected ${formatValue(failed.expected)}, received ${formatValue(failed.actual)}`,
        "error",
      );
      return;
    }
    if (submit) {
      state.solved.add(problem.id);
      saveSolved(state.solved);
      renderProblem(problem);
      setResult(`Accepted - ${passed}/${tests.length} tests passed`, "success");
    } else {
      setResult(`${passed}/${tests.length} examples passed`, "success");
    }
  }

  async function executeRemote(submit) {
    const question = state.remoteQuestion;
    const code = readCurrentCode();
    if (!question || !code.trim()) return;
    const site = state.settings.site;
    const language = state.settings.language;
    const request = {
      generation: ++state.runGeneration,
      site,
      language,
      problem: question.titleSlug,
    };
    setRunning(true, submit ? "submit" : "run");
    setResult(submit ? "Submitting to official judge..." : "Running on official examples...", "running");
    const runAbortController = new AbortController();
    state.runAbortController = runAbortController;
    try {
      const payload = {
        site,
        titleSlug: question.titleSlug,
        questionId: question.questionId,
        lang: language,
        code,
      };
      if (!submit) payload.dataInput = question.exampleTestcases || question.sampleTestCase || "";
      const started = await bridgeRequest(
        submit ? "/api/submit" : "/api/run",
        payload,
        "POST",
        BRIDGE_TIMEOUT_MS,
        runAbortController.signal,
      );
      if (!isCurrentRunRequest(state, request)) return;
      const submissionId = String(started.submission_id ?? started.interpret_id ?? "");
      if (!submissionId) throw new Error("LeetCode returned no submission id");
      const result = await pollSubmission(request, submissionId, runAbortController.signal);
      if (!result || !isCurrentRunRequest(state, request)) return;
      const outcome = summarizeJudgeResult(result, submit);
      if (!outcome.accepted) {
        setResult(outcome.message, "error");
        return;
      }
      if (submit) {
        state.solved.add(`${site}:${question.titleSlug}`);
        saveSolved(state.solved);
        const listItem = state.remoteProblems.find((problem) => problem.titleSlug === question.titleSlug);
        if (listItem) listItem.status = "ac";
        if (state.remoteQuestion?.titleSlug === question.titleSlug && state.settings.site === site) {
          renderRemoteProblem(question);
          rebuildProblemOptions();
        }
      }
      setResult(outcome.message, "success");
    } catch (error) {
      if (isCurrentRunRequest(state, request)) setResult(error.message, "error");
    } finally {
      if (state.runAbortController === runAbortController) state.runAbortController = null;
      if (request.generation === state.runGeneration) setRunning(false);
    }
  }

  async function pollSubmission(request, submissionId, signal) {
    const deadline = Date.now() + OFFICIAL_JUDGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!isCurrentRunRequest(state, request)) return null;
      const requestTimeout = judgeRequestTimeout(deadline);
      let result;
      try {
        result = await bridgeRequest("/api/check", {
          site: request.site,
          submissionId,
        }, "POST", requestTimeout, signal);
      } catch (error) {
        if (Date.now() >= deadline) break;
        throw error;
      }
      if (!isCurrentRunRequest(state, request)) return null;
      if (!isPendingJudgeResult(result)) return result;
      const pollDelay = judgePollDelay(deadline);
      if (pollDelay <= 0) break;
      await waitForJudgePoll(pollDelay, signal, window);
    }
    throw new Error(`Official judge timed out after ${OFFICIAL_JUDGE_TIMEOUT_MS / 1000} seconds`);
  }

  function cancelRun() {
    if (!state.running || state.runningKind !== "run") return false;
    state.runAbortController?.abort();
    state.runAbortController = null;
    state.runGeneration += 1;
    setRunning(false);
    setResult("Run cancelled", "idle");
    focusEditor();
    return true;
  }

  function setRunning(running, kind = null) {
    state.running = running;
    state.runningKind = running ? kind : null;
    const runButton = state.panel?.querySelector("button[data-action='run']");
    if (runButton) {
      const presentation = runButtonState(state.running, state.runningKind);
      runButton.textContent = presentation.label;
      runButton.title = presentation.title;
      runButton.setAttribute("aria-label", presentation.title);
    }
    updateControlDisabledState();
  }

  function setQuestionLoading(loading) {
    state.loadingQuestion = loading;
    updateControlDisabledState();
  }

  function updateControlDisabledState() {
    const runPresentation = runButtonState(state.running, state.runningKind);
    for (const control of state.panel?.querySelectorAll("button, select, input") ?? []) {
      if (!state.controlTitles.has(control)) state.controlTitles.set(control, control.getAttribute("title"));
      const role = controlRole(control);
      const availability = controlAvailability(state, role, activeSiteLabel());
      control.disabled = availability.disabled;
      if (availability.disabled) {
        control.title = availability.reason;
      } else if (role === "run") {
        control.title = runPresentation.title;
      } else {
        const originalTitle = state.controlTitles.get(control);
        if (originalTitle === null) control.removeAttribute("title");
        else control.title = originalTitle;
      }
    }
  }

  function activeSiteLabel() {
    return state.settings.site === "china" ? "leetcode.cn" : "leetcode.com";
  }

  function setResult(message, status) {
    state.resultRevision += 1;
    const revision = state.resultRevision;
    const result = state.panel?.querySelector("[data-field='result']");
    if (!result) return revision;
    result.textContent = truncateDisplayText(message);
    result.dataset.status = status;
    return revision;
  }

  function nextProblem() {
    if (state.online && state.remoteProblems.length > 0) {
      const index = state.remoteProblems.findIndex((problem) => problem.titleSlug === state.settings.problemSlug);
      const next = state.remoteProblems[(index + 1) % state.remoteProblems.length];
      state.settings.problemSlug = next.titleSlug;
      saveSettings(state.settings);
      rebuildProblemOptions();
      loadRemoteQuestion(next.titleSlug);
      return;
    }
    const problems = filteredProblems();
    if (problems.length === 0) return;
    const index = problems.findIndex((problem) => problem.id === state.settings.problemId);
    const next = problems[(index + 1) % problems.length];
    state.settings.problemId = next.id;
    saveSettings(state.settings);
    rebuildProblemOptions();
    loadProblem(next, true);
  }

  function loadProblem(problem, resetCode) {
    if (!problem) return;
    state.remoteQuestion = null;
    state.settings.problemId = problem.id;
    if (!SUBMISSION_LANGUAGES.some(([value]) => value === state.settings.language)) {
      state.settings.language = "javascript";
    }
    saveSettings(state.settings);
    const language = state.panel?.querySelector("[data-setting='language']");
    populateFallbackLanguageOptions(language);
    state.codeEditor?.setLanguage(state.settings.language);
    if (resetCode) loadCodeForCurrentContext(localStarter(problem, state.settings.language), problem.starter);
    const select = state.panel?.querySelector("[data-setting='problem']");
    if (select instanceof HTMLSelectElement) select.value = problem.id;
    renderProblem(problem);
    setResult(
      state.settings.language === "javascript"
        ? "Ready"
        : `Log in to LeetCode to run or submit ${activeLanguageLabel()}`,
      "idle",
    );
    focusEditor();
  }

  function renderProblem(problem) {
    if (!state.panel) return;
    state.panel.querySelector("[data-field='title']").textContent = `#${problem.number} ${problem.title}`;
    const difficulty = state.panel.querySelector("[data-field='difficulty']");
    difficulty.textContent = titleCase(problem.difficulty);
    difficulty.dataset.level = problem.difficulty;
    state.panel.querySelector("[data-field='description']").textContent = problem.description;
    state.panel.querySelector("[data-field='example']").textContent = problem.examples
      .map((example, index) => `${index + 1}. ${example.input} -> ${example.output}`)
      .join("\n");
    state.panel.querySelector("[data-field='solved']").hidden = !state.solved.has(problem.id);
  }

  function rebuildProblemOptions() {
    const select = state.panel?.querySelector("[data-setting='problem']");
    if (!(select instanceof HTMLSelectElement)) return;
    const fragment = document.createDocumentFragment();
    if (state.online && state.remoteProblems.length > 0) {
      for (const problem of state.remoteProblems) {
        const option = document.createElement("option");
        option.value = problem.titleSlug;
        option.textContent = `${problemFrontendId(problem)}. ${problem.title}${isAcceptedStatus(problem.status) ? " (Solved)" : ""}${problem.paidOnly ? " (Premium)" : ""}`;
        fragment.appendChild(option);
      }
    } else {
      for (const problem of filteredProblems()) {
        const option = document.createElement("option");
        option.value = problem.id;
        option.textContent = `${problem.number}. ${problem.title}${state.solved.has(problem.id) ? " (Solved)" : ""}`;
        fragment.appendChild(option);
      }
    }
    select.replaceChildren(fragment);
    select.value = state.online ? state.settings.problemSlug : state.settings.problemId;
  }

  function filteredProblems() {
    const filtered = state.settings.difficulty === "all"
      ? PROBLEMS
      : PROBLEMS.filter((problem) => problem.difficulty === state.settings.difficulty);
    return filtered.length > 0 ? filtered : PROBLEMS;
  }

  function activeProblem() {
    const available = filteredProblems();
    return available.find((problem) => problem.id === state.settings.problemId) ?? available[0];
  }

  function applyComposerSize() {
    if (!state.editor || !state.surface) return;
    const editorHeight = Math.max(190, state.editorBaseHeight + 140);
    const surfaceHeight = composerSurfaceMinHeight(state.surfaceBaseHeight, editorHeight, window.innerHeight);
    state.editor.style.setProperty("transition", appendTransition(state.editorStyles?.["transition"]?.value, "min-height 180ms ease"));
    state.editor.style.setProperty("min-height", `${editorHeight}px`, "important");
    state.surface.style.setProperty("transition", appendTransition(state.surfaceStyles?.["transition"]?.value, "min-height 180ms ease"));
    state.surface.style.setProperty("min-height", `${surfaceHeight}px`, "important");
  }

  function ensureAttached() {
    if (!state.active) return;
    installStyle();
    if (state.editor?.isConnected && state.surface?.isConnected && state.codeHost?.isConnected) {
      if (!state.panel?.isConnected) createPanel();
      syncColorScheme(state.panel);
      state.codeEditor?.setColorScheme(state.panel?.dataset.colorScheme ?? "dark");
      applyComposerSize();
      return;
    }
    if (state.editor || state.codeEditor || state.panel) {
      saveCurrentDraft();
      invalidateActiveWork();
      teardownMountedComposer(true);
    }
    const editor = findMainComposer();
    if (editor) {
      try {
        mountComposer(editor);
        return;
      } catch (error) {
        console.error("Leetcodex remount failed", error);
        invalidateActiveWork();
        teardownMountedComposer(true);
      }
    }
    scheduleComposerReattach();
  }

  function scheduleComposerReattach() {
    if (!state.active) return;
    state.reattachAttempts += 1;
    const delay = composerReattachDelay(state.reattachAttempts);
    window.clearTimeout(state.ensureTimer);
    state.ensureTimer = window.setTimeout(ensureAttached, delay);
  }

  function insertLineBreak() {
    focusEditor();
    document.execCommand("insertLineBreak", false);
  }

  function focusEditor() {
    state.codeEditor?.focus();
  }

  function closeVisibleSearchPanel() {
    const closeButton = state.codeHost?.querySelector(".cm-panel.cm-search button[aria-label='close']");
    if (typeof closeButton?.click !== "function" || closeButton.getClientRects().length === 0) return false;
    window.setTimeout(() => {
      state.codeHost?.querySelector(".cm-panel.cm-search button[aria-label='close']")?.click?.();
    }, 0);
    return true;
  }

  function handlePracticeEscape() {
    if (!state.active) return false;
    return closeVisibleSearchPanel() || state.codeEditor?.handleEscape() === true;
  }

  function readCurrentCode() {
    return state.codeEditor?.getValue() ?? "";
  }

  function loadCodeForCurrentContext(starter, legacyStarter = null) {
    const context = currentDraftContext();
    const generation = ++state.draftLoadGeneration;
    const draft = loadDraft(context.key);
    const code = resolveDraftCode(draft, starter, legacyStarter);
    state.editorDraftContext = context;
    state.codeEditor?.setLanguage(state.settings.language);
    setEditorCode(code);
    if (draft !== null) return;
    void bridgeRequest("/api/draft/load", context).then((payload) => {
      if (!state.active || generation !== state.draftLoadGeneration) return;
      if (state.editorDraftContext?.key !== context.key || currentDraftContext().key !== context.key || loadDraft(context.key) !== null) return;
      const nativeDraft = typeof payload?.code === "string" ? payload.code : null;
      if (nativeDraft === null) return;
      const restoredCode = resolveDraftCode(nativeDraft, starter, legacyStarter);
      setEditorCode(restoredCode);
      saveDraft(context.key, restoredCode);
      setResult("Draft restored from native backup", "success");
    }).catch(() => {
      // Codex++ can run the user script without the native launcher.
    });
  }

  function saveCurrentDraft() {
    if (!state.codeEditor) return;
    const context = currentDraftWriteContext();
    const code = state.codeEditor.getValue();
    saveDraft(context.key, code);
    scheduleNativeDraftSave(context, code, true);
  }

  function currentDraftStorageKey() {
    return currentDraftWriteContext().key;
  }

  function currentDraftWriteContext() {
    return draftWriteContext(state.editorDraftContext, currentDraftContext());
  }

  function currentDraftContext() {
    const problem = draftProblemIdentity(state);
    return {
      key: draftStorageKey(state.settings, problem),
      site: state.settings.site,
      problem,
      language: state.settings.language,
    };
  }

  function scheduleNativeDraftSave(context, code, immediate = false) {
    window.clearTimeout(state.draftSaveTimer);
    const persist = () => {
      state.draftSaveTimer = 0;
      void bridgeRequest("/api/draft/save", { ...context, code }).catch(() => {
        // localStorage remains the primary store when the native bridge is unavailable.
      });
    };
    if (immediate) persist();
    else state.draftSaveTimer = window.setTimeout(persist, 600);
  }

  function setEditorCode(code) {
    state.applyingCode = true;
    try {
      state.codeEditor?.setValue(code);
    } finally {
      state.applyingCode = false;
    }
  }

  function restoreSnapshot() {
    if (!state.editor || !state.snapshot || !state.editor.isConnected) return;
    restoreEditorContent(state.editor, state.snapshot);
    restoreEditorSelection(state.editor, state.snapshot.selection);
  }

  function destroy() {
    const resumeAfterDestroy = state.active;
    deactivate();
    if (resumeAfterDestroy) saveActiveSession(true);
    for (const pending of bridgeState.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("Leetcodex bridge disconnected"));
    }
    bridgeState.pending.clear();
    delete window.__LEETCODEX_BRIDGE_RESOLVE__;
    observer.disconnect();
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keypress", onKeyPressOrUp, true);
    window.removeEventListener("keyup", onKeyPressOrUp, true);
    window.removeEventListener("beforeinput", onBeforeInput, true);
    window.removeEventListener("submit", onSubmit, true);
    window.removeEventListener("pagehide", flushDraftBeforeSuspension, true);
    document.removeEventListener("freeze", flushDraftBeforeSuspension, true);
    document.removeEventListener("visibilitychange", onVisibilityChange, true);
    window.removeEventListener("resize", onResize);
    document.getElementById(STYLE_ID)?.remove();
    delete window[GLOBAL_KEY];
    return true;
  }

  window[GLOBAL_KEY] = {
    version: VERSION,
    get active() {
      return state.active;
    },
    toggle: () => state.active ? deactivate() : activate(),
    handleEscape: handlePracticeEscape,
    ensure: ensureAttached,
    diagnostic: () => bridgePendingSnapshot(bridgeState.pending.values()),
    destroy,
  };

  if (resumeActive) {
    state.active = true;
    saveActiveSession(true);
    ensureAttached();
  }
}

function loadActiveSession() {
  try {
    return sessionStorage.getItem(ACTIVE_SESSION_KEY) === "true";
  } catch {
    return false;
  }
}

function saveActiveSession(active) {
  try {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, active ? "true" : "false");
  } catch {
    // Session persistence is optional in restricted renderer contexts.
  }
}

function defaultSettings() {
  return {
    site: "global",
    difficulty: "all",
    problemId: PROBLEMS[0]?.id ?? "",
    problemSlug: "",
    language: "javascript",
    vimMode: false,
    search: "",
  };
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    return normalizePersistedSettings(
      saved,
      defaultSettings(),
      new Set(PROBLEMS.map((problem) => problem.id)),
      MAX_SEARCH_CHARS,
    );
  } catch {
    return defaultSettings();
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Local settings are optional in hardened webviews.
  }
}

function draftStorageKey(settings, problem) {
  return `${DRAFT_KEY_PREFIX}:${encodeURIComponent(`${settings.site}:${problem}:${settings.language}`)}`;
}

function loadDraft(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveDraft(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Draft persistence is best effort in hardened webviews.
  }
}

function loadSolved() {
  try {
    const value = JSON.parse(localStorage.getItem(SOLVED_KEY) ?? "[]");
    const localProblemIds = new Set(PROBLEMS.map((problem) => problem.id));
    return new Set(Array.isArray(value) ? value.filter((id) => isPersistedSolvedId(id, localProblemIds)) : []);
  } catch {
    return new Set();
  }
}

function saveSolved(solved) {
  try {
    localStorage.setItem(SOLVED_KEY, JSON.stringify([...solved]));
  } catch {
    // Solved history is optional.
  }
}

function installStyle() {
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  if (style.textContent !== CSS_TEXT) style.textContent = CSS_TEXT;
}

function isToggleShortcut(event) {
  return event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey && event.code === "KeyL";
}

function stopEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

function stopPropagation(event) {
  event.stopPropagation();
}

function controlRole(control) {
  return control.dataset.action || control.dataset.setting || "other";
}

function isLeetcodexMutation(record) {
  const target = mutationElement(record.target);
  if (target?.closest?.(`#${STYLE_ID}`)) return true;
  if (target?.closest?.(`[${ROOT_ATTRIBUTE}]`)) return true;
  const changedNodes = [...record.addedNodes, ...record.removedNodes];
  return changedNodes.length > 0
    && changedNodes.every((node) => mutationElement(node)?.closest?.(`[${ROOT_ATTRIBUTE}]`));
}

function mutationElement(node) {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

function eventTargetsEditor(event, editor) {
  if (!editor) return false;
  return event.composedPath?.().includes(editor) || event.target === editor || editor.contains(event.target);
}

function findMainComposer() {
  const selectors = ["div.ProseMirror", "[contenteditable='true']", "textarea", "[role='textbox']"];
  const candidates = Array.from(document.querySelectorAll(selectors.join(",")))
    .filter((node) => node instanceof HTMLElement)
    .filter((node) => !node.closest(`[${ROOT_ATTRIBUTE}]`))
    .filter((node) => !node.closest("aside,nav,[role='dialog'],[aria-modal='true'],[role='menu'],[role='listbox']"))
    .map((node) => ({ node, score: composerScore(node) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.node ?? null;
}

function findComposerSurface(editor) {
  return editor.closest(".composer-surface-chrome, form, [data-testid*='composer'], [class*='composer']")
    ?? editor.parentElement
    ?? document.body;
}

function directChildContaining(container, descendant) {
  let branch = descendant;
  while (branch?.parentElement && branch.parentElement !== container) branch = branch.parentElement;
  return branch?.parentElement === container ? branch : null;
}

function composerScore(node) {
  const rect = node.getBoundingClientRect();
  if (rect.width < 180 || rect.height < 20 || rect.bottom <= 0 || rect.top >= innerHeight) return -Infinity;
  if (rect.bottom < innerHeight * 0.25) return -Infinity;
  const centerDistance = Math.abs(rect.left + rect.width / 2 - innerWidth / 2) / Math.max(1, innerWidth);
  return rect.bottom / Math.max(1, innerHeight) * 100
    + Math.min(1, rect.width / Math.max(1, innerWidth)) * 36
    - centerDistance * 42
    + (node.closest(".composer-surface-chrome") ? 30 : 0)
    + (node.matches("div.ProseMirror") ? 20 : 0);
}

function captureEditor(editor) {
  return {
    text: readEditorText(editor),
    html: isTextControl(editor) ? null : editor.innerHTML,
    selection: captureEditorSelection(editor),
  };
}

function readEditorText(editor) {
  if (isTextControl(editor)) return editor.value;
  if (editor.matches(".ProseMirror")) return Array.from(editor.childNodes, serializeEditorBlock).join("\n");
  return editor.textContent ?? "";
}

function serializeEditorBlock(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (!(node instanceof Element)) return "";
  if (node.tagName === "BR") return "\n";
  if (node.childNodes.length === 1 && node.firstChild instanceof HTMLBRElement) return "";
  return Array.from(node.childNodes, serializeEditorBlock).join("");
}

function writeEditorText(editor, text) {
  editor.focus({ preventScroll: true });
  if (isTextControl(editor)) {
    const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(editor, text);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return;
  }
  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand(text.length > 0 ? "insertText" : "delete", false, text);
}

function restoreEditorContent(editor, snapshot) {
  if (isTextControl(editor)) {
    writeEditorText(editor, snapshot.text);
    return;
  }
  editor.focus({ preventScroll: true });
  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand(snapshot.html ? "insertHTML" : "delete", false, snapshot.html ?? "");
}

function isTextControl(editor) {
  return editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement;
}

function captureEditorSelection(editor) {
  if (isTextControl(editor)) return { start: editor.selectionStart ?? 0, end: editor.selectionEnd ?? 0 };
  const selection = document.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) {
    const end = readEditorText(editor).length;
    return { start: end, end };
  }
  return {
    start: textOffset(editor, selection.anchorNode, selection.anchorOffset),
    end: textOffset(editor, selection.focusNode, selection.focusOffset),
  };
}

function restoreEditorSelection(editor, saved) {
  editor.focus({ preventScroll: true });
  if (isTextControl(editor)) {
    editor.setSelectionRange(saved.start, saved.end);
    return;
  }
  const selection = document.getSelection();
  const range = document.createRange();
  const start = textPosition(editor, saved.start);
  const end = textPosition(editor, saved.end);
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function textOffset(root, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

function textPosition(root, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last = root;
  while (walker.nextNode()) {
    last = walker.currentNode;
    if (remaining <= last.nodeValue.length) return { node: last, offset: remaining };
    remaining -= last.nodeValue.length;
  }
  return { node: last, offset: last === root ? root.childNodes.length : last.nodeValue.length };
}

function captureInlineStyles(element, properties) {
  return Object.fromEntries(properties.map((property) => [property, {
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  }]));
}

function restoreInlineStyles(element, saved) {
  if (!element || !saved) return;
  for (const [property, style] of Object.entries(saved)) {
    if (style.value) element.style.setProperty(property, style.value, style.priority);
    else element.style.removeProperty(property);
  }
}

function appendTransition(existing, addition) {
  const value = String(existing ?? "").trim();
  if (!value) return addition;
  return value.includes(addition) ? value : `${value}, ${addition}`;
}

function syncColorScheme(element) {
  if (!element) return;
  const channels = getComputedStyle(element).color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length < 3) return;
  const luminance = (channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722) / 255;
  element.dataset.colorScheme = luminance > 0.55 ? "dark" : "light";
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isAcceptedStatus(value) {
  return ["ac", "accepted"].includes(String(value ?? "").toLowerCase());
}

function formatValue(value) {
  const formatted = JSON.stringify(value);
  return formatted === undefined ? String(value) : formatted;
}

window.__LEETCODEX_BRIDGE_RESOLVE__ = (id, payload) => {
  const pending = bridgeState.pending.get(id);
  if (!pending) return;
  pending.cleanup();
  if (payload?.ok) pending.resolve(payload.data);
  else pending.reject(new Error(payload?.error || "Account bridge request failed"));
};

function bridgeRequest(
  path,
  body = null,
  method = "POST",
  timeoutMs = BRIDGE_TIMEOUT_MS,
  signal = null,
) {
  if (typeof window.leetcodexBridge !== "function") {
    return Promise.reject(new Error("Account bridge is not connected; restart the Leetcodex launcher"));
  }
  if (signal?.aborted) return Promise.reject(new Error("Account bridge request cancelled"));
  const id = `${Date.now().toString(36)}-${(++bridgeState.sequence).toString(36)}`;
  const payload = JSON.stringify({ id, token: BRIDGE_TOKEN, path, method, body });
  if (new TextEncoder().encode(payload).byteLength > MAX_BRIDGE_PAYLOAD_BYTES) {
    return Promise.reject(new Error("Request is too large to send safely"));
  }
  const effectiveTimeout = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(BRIDGE_TIMEOUT_MS, timeoutMs))
    : BRIDGE_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadlineAt = startedAt + effectiveTimeout;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      bridgeState.pending.delete(id);
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error("Account bridge request cancelled"));
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Account bridge timed out"));
    }, effectiveTimeout);
    bridgeState.pending.set(id, { resolve, reject, cleanup, startedAt, deadlineAt });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      window.leetcodexBridge(payload);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function htmlToText(value) {
  const documentValue = new DOMParser().parseFromString(String(value ?? ""), "text/html");
  return normalizeProblemText(serializeProblemNode(documentValue.body));
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
