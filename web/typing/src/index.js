import { APP_VERSION, CSS_TEXT, CORPUS } from "virtual:cotypex-assets";
import {
  characterState,
  createSession,
  extractLines,
  pauseSession,
  refreshSession,
  resumeSession,
  sessionAnalysis,
  sessionMetrics,
  splitCharacters,
  updateSession,
} from "./engine.js";
import {
  closestSnippetsByWordCount,
  filterCorpusSnippets,
  topicsForCategory,
} from "./corpus-utils.js";
import {
  favoriteSnippets,
  isFavorite,
  toggleFavorite,
} from "./favorites.js";
import {
  normalizeDailyProgress,
  recordDailyCompletion,
} from "./daily.js";

const VERSION = APP_VERSION;
const GLOBAL_KEY = "__COTYPEX__";
const STYLE_ID = "cotypex-style";
const ROOT_ATTRIBUTE = "data-cotypex-root";
const ACTIVE_EDITOR_ATTRIBUTE = "data-cotypex-editor";
const ACTIVE_SURFACE_ATTRIBUTE = "data-cotypex-surface";
const SETTINGS_KEY = "cotypex.settings.v1";
const HISTORY_KEY = "cotypex.history.v1";
const WEAKSPOT_KEY = "cotypex.weakspots.v1";
const FAVORITES_KEY = "cotypex.favorites.v1";
const DAILY_KEY = "cotypex.daily.v1";
const HISTORY_LIMIT = 80;
const PRESETS = [
  { id: "time-15", label: "15s", mode: "time", limit: 15 },
  { id: "time-30", label: "30s", mode: "time", limit: 30 },
  { id: "time-60", label: "60s", mode: "time", limit: 60 },
  { id: "words-25", label: "25w", mode: "words", limit: 25 },
  { id: "words-50", label: "50w", mode: "words", limit: 50 },
  { id: "quote", label: "snippet", mode: "quote", limit: null },
  { id: "weakspot", label: "weak", mode: "weakspot", limit: null },
];
const LANGUAGE_OPTIONS = [
  { value: "javascript", label: "JS" },
  { value: "typescript", label: "TS" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "sql", label: "SQL" },
  { value: "csharp", label: "C#" },
  { value: "php", label: "PHP" },
];
const PRACTICE_LANGUAGE_LABELS = {
  c: "C",
  cpp: "C++",
  golang: "Go",
  kotlin: "Kotlin",
  python3: "Python 3",
  ruby: "Ruby",
  scala: "Scala",
  swift: "Swift",
};

const previous = window[GLOBAL_KEY];
if (previous?.version === VERSION) {
  previous.ensure?.();
} else {
  previous?.destroy?.();
  install();
}

function install() {
  installStyle();
  const initialFavorites = loadFavorites();
  const initialSettings = loadSettings(initialFavorites);
  const initialWeakspots = loadWeakspots();
  const initialDaily = loadDailyProgress();
  const state = {
    active: false,
    editor: null,
    surface: null,
    overlay: null,
    hud: null,
    result: null,
    settingsPanel: null,
    session: createSession(buildTarget(initialSettings, -1, initialWeakspots, initialFavorites), 0, sessionOptions(initialSettings)),
    settings: initialSettings,
    history: loadHistory(),
    weakspots: initialWeakspots,
    favorites: initialFavorites,
    daily: initialDaily,
    draftSnippet: null,
    settingsBeforeOverride: null,
    promptIndex: -1,
    lastTarget: null,
    lastSession: null,
    lastWpm: 0,
    snapshot: null,
    surfaceStyles: null,
    editorStyles: null,
    surfaceBaseHeight: 0,
    editorBaseHeight: 0,
    composing: false,
    syncing: false,
    resultSaved: false,
    lastLineBreakKeydownAt: -Infinity,
    warningPlayed: false,
    audioContext: null,
    nextTimer: 0,
    ensureTimer: 0,
    statsTimer: 0,
    layoutFrame: 0,
    layoutPasses: 0,
    layoutObserver: null,
  };

  const onKeyDown = (event) => {
    if (isToggleShortcut(event)) {
      stopEvent(event);
      state.active ? deactivate() : activate();
      return;
    }
    if (!state.active) return;
    if (isNextShortcut(event)) {
      stopEvent(event);
      startPrompt(true);
      return;
    }
    if (isRestartShortcut(event)) {
      stopEvent(event);
      startPrompt(true, state.session.target.join(""));
      return;
    }
    if (event.key === "Escape") {
      stopEvent(event);
      deactivate();
      return;
    }
    if (event.target instanceof Element && event.target.closest(`[${ROOT_ATTRIBUTE}]`)) return;
    if (state.settings.autoPause) resumePractice();
    if (event.key === "Backspace") {
      if (state.settings.confidence === "max") {
        stopEvent(event);
        playSound("error");
        return;
      }
      if (state.settings.confidence === "on" && atCurrentLineBoundary()) {
        stopEvent(event);
        playSound("error");
        return;
      }
      if (removeIndentationLevel()) {
        stopEvent(event);
        return;
      }
    }
    if (event.key === "Enter") {
      // Codex can retarget composer events while React replaces the editor node.
      // Always consume Enter during practice so it can never reach its submit handler.
      stopEvent(event);
      handleLineBreak(event);
      return;
    }
    if (event.key === "Tab") {
      stopEvent(event);
      if (eventTargetsEditor(event, state.editor) || editorHasFocus(state.editor)) {
        if (!insertExpectedIndentation()) rejectPracticeKey("\t");
      } else {
        focusEditor(state.editor);
      }
      return;
    }
    if (state.composing || event.isComposing) return;
    if (!eventTargetsEditor(event, state.editor)) return;
    if (state.session.completedAt !== null) {
      stopEvent(event);
      focusEditor(state.editor);
      return;
    }
    if (isCaretNavigation(event) || ((event.ctrlKey || event.metaKey) && event.code === "KeyA")) {
      stopEvent(event);
      moveCaretToEnd(state.editor);
    }
  };

  const onBeforeInput = (event) => {
    if (!state.active) return;
    if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) {
      stopEvent(event);
      handleLineBreak(event);
      return;
    }
    if (state.syncing || !eventTargetsEditor(event, state.editor)) return;
    if (event.inputType === "insertText" && insertExpectedClosingBracket(event.data)) {
      stopEvent(event);
      return;
    }
    if (state.settings.autoPairs && event.inputType === "insertText" && insertExpectedPair(event.data)) {
      stopEvent(event);
      return;
    }
    if (state.session.completedAt !== null) {
      stopEvent(event);
      return;
    }
    if (["insertFromPaste", "insertFromDrop", "historyUndo", "historyRedo"].includes(event.inputType)) {
      stopEvent(event);
    }
  };

  const onKeyPressOrUp = (event) => {
    if (!state.active) return;
    if (event.target instanceof Element && event.target.closest(`[${ROOT_ATTRIBUTE}]`)) return;
    if (event.key === "Enter" || event.key === "Tab") stopEvent(event);
  };

  const onInput = (event) => {
    if (!state.active || state.syncing || !eventTargetsEditor(event, state.editor)) return;
    state.composing ? render(readEditorText(state.editor)) : processInput();
  };

  const onCompositionStart = (event) => {
    if (!state.active || !eventTargetsEditor(event, state.editor)) return;
    state.composing = true;
  };

  const onCompositionEnd = (event) => {
    if (!state.active || !eventTargetsEditor(event, state.editor)) return;
    state.composing = false;
    processInput();
  };

  const onPointerDown = (event) => {
    if (!state.active) return;
    if (event.target instanceof Element && event.target.closest(`[${ROOT_ATTRIBUTE}]`)) return;
    if (eventTargetsEditor(event, state.editor)) {
      stopEvent(event);
      focusEditor(state.editor);
      return;
    }
    if (isSubmissionControl(event.target, state.editor)) {
      stopEvent(event);
      focusEditor(state.editor);
      return;
    }
    deactivate();
  };

  const onClick = (event) => {
    if (state.active && event.target instanceof Element && event.target.closest(`[${ROOT_ATTRIBUTE}]`)) return;
    if (!state.active || !isSubmissionControl(event.target, state.editor)) return;
    stopEvent(event);
    focusEditor(state.editor);
  };

  const onSubmit = (event) => {
    if (!state.active) return;
    stopEvent(event);
    focusEditor(state.editor);
  };

  const onScroll = (event) => {
    if (!state.active) return;
    if (event.target === state.editor) syncOverlayScroll();
    scheduleLayout();
  };

  const onResize = () => scheduleLayout();
  const onWindowBlur = () => {
    if (state.active && state.settings.autoPause) pausePractice();
  };
  const onWindowFocus = () => {
    if (state.active && state.settings.autoPause && state.settingsPanel?.hidden) resumePractice();
  };
  const onVisibilityChange = () => {
    if (!state.active || !state.settings.autoPause) return;
    if (document.hidden) pausePractice();
    else if (state.settingsPanel?.hidden) resumePractice();
  };
  const onBeforeUnload = () => {
    if (state.active) restoreSnapshot();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keypress", onKeyPressOrUp, true);
  window.addEventListener("keyup", onKeyPressOrUp, true);
  window.addEventListener("beforeinput", onBeforeInput, true);
  window.addEventListener("input", onInput, true);
  window.addEventListener("compositionstart", onCompositionStart, true);
  window.addEventListener("compositionend", onCompositionEnd, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("submit", onSubmit, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("focus", onWindowFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("beforeunload", onBeforeUnload);

  const observer = new MutationObserver((records) => {
    if (!state.active) return;
    const hostChanged = records.some((record) => {
      const target = record.target instanceof Element
        ? record.target
        : record.target.parentElement;
      return !target?.closest?.(`[${ROOT_ATTRIBUTE}]`);
    });
    if (!hostChanged) return;
    window.clearTimeout(state.ensureTimer);
    state.ensureTimer = window.setTimeout(ensureAttached, 80);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  function activate(practiceOverride = null) {
    if (window.__LEETCODEX__?.active) window.__LEETCODEX__.toggle();
    const editor = findMainComposer();
    if (!editor) return false;
    const snapshot = captureEditor(editor);
    try {
      const overrideSnippet = practiceableDraft(practiceOverride?.text);
      const draftSnippet = overrideSnippet ?? practiceableDraft(snapshot.text);
      state.active = true;
      state.editor = editor;
      state.surface = findComposerSurface(editor);
      state.snapshot = snapshot;
      state.draftSnippet = draftSnippet;
      if (overrideSnippet) {
        state.settingsBeforeOverride = { ...state.settings };
        state.settings = {
          ...state.settings,
          presetId: "quote",
          language: normalizePracticeLanguage(practiceOverride?.language),
          category: "draft",
          topic: "all",
        };
      }
      if (state.settings.category === "draft" && !state.draftSnippet) {
        state.settings = { ...state.settings, category: "mix", topic: "all" };
        saveSettings(state.settings);
      }
      state.surfaceStyles = captureInlineStyles(state.surface, ["minHeight", "transition"]);
      state.editorStyles = captureInlineStyles(state.editor, ["minHeight", "transition"]);
      state.surfaceBaseHeight = Math.ceil(state.surface.getBoundingClientRect().height);
      state.editorBaseHeight = Math.ceil(state.editor.getBoundingClientRect().height);
      state.promptIndex = -1;
      state.editor.setAttribute(ACTIVE_EDITOR_ATTRIBUTE, "true");
      state.surface.setAttribute(ACTIVE_SURFACE_ATTRIBUTE, "true");
      applyComposerLift();
      createChrome();
      watchComposerLayout();
      startPrompt(true);
      scheduleLayout(4);
      state.statsTimer = window.setInterval(tickSession, 250);
      return true;
    } catch (error) {
      console.error("CoTypeX activation failed", error);
      deactivate();
      return false;
    }
  }

  function deactivate() {
    if (!state.active) return true;
    state.active = false;
    state.composing = false;
    state.lastLineBreakKeydownAt = -Infinity;
    window.clearTimeout(state.nextTimer);
    window.clearTimeout(state.ensureTimer);
    window.clearInterval(state.statsTimer);
    window.cancelAnimationFrame(state.layoutFrame);
    state.layoutObserver?.disconnect();
    restoreSnapshot();
    restoreInlineStyles(state.surface, state.surfaceStyles);
    restoreInlineStyles(state.editor, state.editorStyles);
    state.editor?.removeAttribute(ACTIVE_EDITOR_ATTRIBUTE);
    state.surface?.removeAttribute(ACTIVE_SURFACE_ATTRIBUTE);
    state.overlay?.remove();
    state.hud?.remove();
    state.settingsPanel?.remove();
    state.result?.remove();
    state.overlay = null;
    state.hud = null;
    state.settingsPanel = null;
    state.result = null;
    state.editor = null;
    state.surface = null;
    state.snapshot = null;
    state.draftSnippet = null;
    if (state.settingsBeforeOverride) {
      state.settings = state.settingsBeforeOverride;
      state.settingsBeforeOverride = null;
      saveSettings(state.settings);
    }
    state.surfaceStyles = null;
    state.editorStyles = null;
    state.surfaceBaseHeight = 0;
    state.editorBaseHeight = 0;
    state.layoutFrame = 0;
    state.layoutPasses = 0;
    state.layoutObserver = null;
    return true;
  }

  function restoreSnapshot() {
    if (!state.editor || !state.snapshot || !state.editor.isConnected) return false;
    state.syncing = true;
    restoreEditorContent(state.editor, state.snapshot);
    state.syncing = false;
    restoreEditorSelection(state.editor, state.snapshot.selection);
    return true;
  }

  function createChrome() {
    state.overlay?.remove();
    state.hud?.remove();
    state.settingsPanel?.remove();
    state.result?.remove();

    const overlay = document.createElement("div");
    overlay.className = "cotypex-overlay";
    overlay.setAttribute(ROOT_ATTRIBUTE, "true");
    overlay.setAttribute("aria-hidden", "true");
    document.body.appendChild(overlay);
    state.overlay = overlay;

    const hud = document.createElement("div");
    hud.className = "cotypex-hud";
    hud.setAttribute(ROOT_ATTRIBUTE, "true");
    hud.addEventListener("pointerdown", stopHudPropagation);
    hud.addEventListener("click", onHudClick);
    hud.addEventListener("change", onHudChange);
    const editorBranch = directChildContaining(state.surface, state.editor);
    if (!editorBranch) throw new Error("The Codex editor is outside its composer surface");
    state.surface.insertBefore(hud, editorBranch);
    state.hud = hud;

    const settingsPanel = document.createElement("div");
    settingsPanel.className = "cotypex-options";
    settingsPanel.setAttribute(ROOT_ATTRIBUTE, "true");
    settingsPanel.hidden = true;
    settingsPanel.addEventListener("pointerdown", stopHudPropagation);
    settingsPanel.addEventListener("change", onSettingsChange);
    createSettingsContents(settingsPanel, state.settings, state.favorites, state.draftSnippet);
    state.surface.insertBefore(settingsPanel, editorBranch);
    state.settingsPanel = settingsPanel;

    const result = document.createElement("div");
    result.className = "cotypex-result";
    result.setAttribute(ROOT_ATTRIBUTE, "true");
    result.hidden = true;
    result.addEventListener("pointerdown", stopHudPropagation);
    result.addEventListener("click", onResultClick);
    state.surface.insertBefore(result, editorBranch.nextSibling);
    state.result = result;

    renderHud();
    syncOverlayLayout();
    scheduleLayout(4);
  }

  function watchComposerLayout() {
    state.layoutObserver?.disconnect();
    if (typeof ResizeObserver !== "function" || !state.editor || !state.surface) return;
    state.layoutObserver = new ResizeObserver(() => scheduleLayout(2));
    state.layoutObserver.observe(state.editor);
    if (state.surface !== state.editor) state.layoutObserver.observe(state.surface);
  }

  function ensureAttached() {
    if (!state.active) return;
    installStyle();
    if (!state.editor?.isConnected || !state.surface?.isConnected) {
      deactivate();
      return;
    }
    if (!state.overlay?.isConnected || !state.hud?.isConnected
      || !state.settingsPanel?.isConnected || !state.result?.isConnected) {
      createChrome();
    }
    applyComposerLift();
    syncOverlayLayout();
  }

  function processInput(input = {}) {
    if (!state.editor) return;
    if (state.session.completedAt !== null) {
      replaceEditorText(state.editor, state.session.typed.join(""));
      focusEditor(state.editor);
      return;
    }
    const maxLength = state.session.target.length;
    const value = splitCharacters(readEditorText(state.editor)).slice(0, maxLength).join("");
    if (value !== readEditorText(state.editor)) replaceEditorText(state.editor, value);
    const previousSession = state.session;
    const wasComplete = previousSession.completedAt !== null;
    state.session = updateSession(previousSession, value, Date.now(), input);
    const newError = state.session.errors > previousSession.errors;
    if (newError) playSound("error");
    else if (state.session.typed.length > previousSession.typed.length) playSound("click");
    if (newError && state.settings.stopOnError && state.session.completedReason !== "master") {
      const mismatch = firstIncorrectPosition(state.session);
      if (mismatch >= 0) {
        state.session = { ...state.session, typed: state.session.typed.slice(0, mismatch) };
        replaceEditorText(state.editor, state.session.typed.join(""));
      }
    }
    render();
    renderHud();
    if (!wasComplete && state.session.completedAt !== null) {
      finishSession();
    }
  }

  function insertExpectedWhitespace(character) {
    const index = state.session.typed.length;
    if (state.session.target[index] !== character) return false;
    replaceEditorText(state.editor, `${state.session.typed.join("")}${character}`);
    processInput();
    return true;
  }

  function insertExpectedLineBreak() {
    const index = state.session.typed.length;
    if (state.session.target[index] !== "\n") return false;
    if (state.settings.difficulty === "expert" && currentLineHasError()) {
      playSound("error");
      return true;
    }
    const remaining = state.session.target.slice(index + 1).join("");
    const indentation = remaining.match(/^[ \t]*/)?.[0] ?? "";
    replaceEditorText(state.editor, `${state.session.typed.join("")}\n${indentation}`);
    processInput({ automaticSuffix: indentation.length });
    return true;
  }

  function handleLineBreak(event) {
    const eventTime = Number(event.timeStamp) || performance.now();
    if (event.type !== "keydown" && eventTime - state.lastLineBreakKeydownAt < 120) return;
    if (event.type === "keydown") state.lastLineBreakKeydownAt = eventTime;
    state.composing = false;
    if (state.syncing || !(eventTargetsEditor(event, state.editor) || editorHasFocus(state.editor))) {
      focusEditor(state.editor);
      return;
    }
    if (!insertExpectedLineBreak()) rejectPracticeKey("\n");
  }

  function rejectPracticeKey(character) {
    if (state.session.completedAt !== null) return;
    const typed = state.session.typed;
    const wasComplete = state.session.completedAt !== null;
    state.session = updateSession(state.session, `${typed.join("")}${character}`);
    if (state.session.completedReason !== "master") state.session = { ...state.session, typed };
    playSound("error");
    render();
    renderHud();
    if (!wasComplete && state.session.completedAt !== null) finishSession();
    focusEditor(state.editor);
  }

  function insertExpectedIndentation() {
    const remaining = state.session.target.slice(state.session.typed.length).join("");
    const indentation = remaining.match(/^[ \t]+/)?.[0];
    if (!indentation) return false;
    replaceEditorText(state.editor, `${state.session.typed.join("")}${indentation}`);
    processInput({ automaticSuffix: Math.max(0, splitCharacters(indentation).length - 1) });
    return true;
  }

  function removeIndentationLevel() {
    const typed = state.session.typed.join("");
    const leading = typed.match(/(?:^|\n)([ \t]+)$/)?.[1];
    if (!leading) return false;
    const unit = leading.endsWith("\t") ? 1 : Math.min(leading.length, indentationWidth(state.settings.language));
    replaceEditorText(state.editor, splitCharacters(typed).slice(0, -unit).join(""));
    processInput();
    return true;
  }

  function atCurrentLineBoundary() {
    const typed = state.session.typed.join("");
    return typed.length <= typed.lastIndexOf("\n") + 1;
  }

  function currentLineHasError() {
    const typed = state.session.typed;
    const lineStart = typed.lastIndexOf("\n") + 1;
    return typed.slice(lineStart).some((character, offset) => character !== state.session.target[lineStart + offset]);
  }

  function insertExpectedPair(character) {
    const pair = { "(": ")", "[": "]", "{": "}", "\"": "\"", "'": "'", "`": "`" }[character];
    if (!pair) return false;
    const index = state.session.typed.length;
    if (state.session.target[index] !== character || state.session.target[index + 1] !== pair) return false;
    replaceEditorText(state.editor, `${state.session.typed.join("")}${character}${pair}`);
    processInput({ automaticSuffix: 1 });
    return true;
  }

  function insertExpectedClosingBracket(character) {
    if (!["}", ")", "]"].includes(character)) return false;
    const typedText = state.session.typed.join("");
    const targetText = state.session.target.join("");
    const typedLineStart = typedText.lastIndexOf("\n") + 1;
    const targetLineStart = targetText.lastIndexOf("\n", state.session.typed.length - 1) + 1;
    if (typedText.slice(0, typedLineStart) !== targetText.slice(0, targetLineStart)) return false;
    const typedLine = typedText.slice(typedLineStart);
    const expected = targetText.slice(targetLineStart).match(/^([ \t]*)([})\]])/);
    if (!expected || expected[2] !== character || !/^[ \t]*$/.test(typedLine)) return false;
    const indentation = expected[1];
    const base = typedText.slice(0, typedLineStart);
    if (typedLine !== indentation) {
      replaceEditorText(state.editor, `${base}${indentation}`);
      processInput({ automaticSuffix: Math.max(0, indentation.length - typedLine.length) });
    }
    replaceEditorText(state.editor, `${base}${indentation}${character}`);
    processInput();
    return true;
  }

  function startPrompt(advance, targetOverride = null) {
    window.clearTimeout(state.nextTimer);
    const text = targetOverride ?? (!advance && state.promptIndex >= 0 && activePreset().mode === "quote"
      ? practiceCorpus(state.settings, state.favorites, state.draftSnippet)[state.promptIndex]
      : buildTarget(state.settings, state.promptIndex, state.weakspots, state.favorites, state.draftSnippet));
    state.promptIndex = activePreset().mode === "quote"
      ? practiceCorpus(state.settings, state.favorites, state.draftSnippet).indexOf(text)
      : -1;
    state.session = createSession(text, Date.now(), sessionOptions(state.settings));
    state.resultSaved = false;
    state.warningPlayed = false;
    if (state.result) state.result.hidden = true;
    replaceEditorText(state.editor, "");
    render();
    renderHud();
    focusEditor(state.editor);
  }

  function tickSession() {
    if (!state.active || !state.editor) return;
    if (state.session.pausedAt !== null) {
      renderHud();
      return;
    }
    const wasComplete = state.session.completedAt !== null;
    state.session = refreshSession(state.session);
    if (!wasComplete && state.session.completedAt !== null) finishSession();
    const metrics = sessionMetrics(state.session);
    if (!state.warningPlayed && state.settings.warningSeconds > 0
      && metrics.remainingMs !== null && metrics.remainingMs <= state.settings.warningSeconds * 1000) {
      state.warningPlayed = true;
      playSound("warning");
    }
    if (state.settings.pace !== "off" && state.session.completedAt === null) render();
    renderHud();
  }

  function finishSession() {
    if (state.resultSaved) return;
    state.resultSaved = true;
    state.lastTarget = state.session.target.join("");
    state.lastSession = state.session;
    state.lastWpm = sessionMetrics(state.session, state.session.completedAt ?? Date.now()).wpm;
    saveResult();
    renderHud();
    renderResult();
  }

  function onHudClick(event) {
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (!target) return;
    if (target.dataset.action === "leetcode") {
      deactivate();
      window.__LEETCODEX__?.toggle?.();
      return;
    }
    if (target.dataset.action === "settings") {
      const opening = state.settingsPanel.hidden;
      state.settingsPanel.hidden = !opening;
      if (state.settings.autoPause) {
        if (opening) pausePractice();
        else resumePractice();
      }
      scheduleLayout(2);
      return;
    }
    if (target.dataset.preset) {
      state.settings = { ...state.settings, presetId: target.dataset.preset };
      saveSettings(state.settings);
      startPrompt(true);
      return;
    }
  }

  function onResultClick(event) {
    event.stopPropagation();
    const button = event.target instanceof Element ? event.target.closest("button[data-result-action]") : null;
    if (!button || button.disabled || !state.lastSession || !state.lastTarget) return;
    const action = button.dataset.resultAction;
    if (action === "repeat") {
      startPrompt(true, state.lastTarget);
      return;
    }
    if (action === "errors") {
      const lines = extractLines(state.lastTarget, sessionAnalysis(state.lastSession).errorLineIndices);
      if (lines) startPrompt(true, lines);
      return;
    }
    if (action === "weakspot") {
      state.settings = { ...state.settings, presetId: "weakspot" };
      saveSettings(state.settings);
      startPrompt(true);
      return;
    }
    if (action === "favorite") {
      state.favorites = toggleFavorite(state.favorites, state.settings.language, state.lastTarget);
      saveFavorites(state.favorites);
      if (state.settings.category === "saved"
        && favoriteSnippets(state.favorites, state.settings.language).length === 0) {
        state.settings = { ...state.settings, category: "mix", topic: "all" };
        saveSettings(state.settings);
      }
      syncSourceControls();
      updateFavoriteAction(button);
      return;
    }
    if (action === "next") startPrompt(true);
  }

  function onHudChange(event) {
    event.stopPropagation();
    if (!(event.target instanceof HTMLSelectElement) || event.target.dataset.setting !== "language") return;
    const language = event.target.value;
    const savedAvailable = favoriteSnippets(state.favorites, language).length > 0;
    state.settings = {
      ...state.settings,
      language,
      category: state.settings.category === "saved" && !savedAvailable ? "mix" : state.settings.category,
      topic: state.settings.category === "saved" && !savedAvailable ? "all" : state.settings.topic,
    };
    saveSettings(state.settings);
    syncSourceControls();
    startPrompt(true);
  }

  function onSettingsChange(event) {
    event.stopPropagation();
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    const option = target.dataset.option;
    if (!option) return;
    let value = target instanceof HTMLInputElement && target.type === "checkbox"
      ? target.checked
      : target instanceof HTMLInputElement && target.type === "number"
        ? Number(target.value)
        : target.value;
    if (["warningSeconds", "dailyGoal"].includes(option)) value = Number(value);
    if (option === "paceWpm") value = Math.min(300, Math.max(10, Number(value) || 80));
    let nextSettings = { ...state.settings, [option]: value };
    if (option === "category" && ["saved", "draft"].includes(value)) nextSettings = { ...nextSettings, topic: "all" };
    if (option === "category" && value === "draft") nextSettings = { ...nextSettings, presetId: "quote" };
    if (option === "category"
      && nextSettings.topic !== "all"
      && !topicsForCategory(nextSettings.category).some((topic) => topic.id === nextSettings.topic)) {
      nextSettings = { ...nextSettings, topic: "all" };
    }
    state.settings = nextSettings;
    if (option === "category") syncSourceControls();
    saveSettings(state.settings);
    if (option === "autoPause") {
      if (value && !state.settingsPanel.hidden) pausePractice();
      else if (!value) resumePractice();
    }
    if (["difficulty", "category", "topic"].includes(option)) startPrompt(true);
    else {
      render();
      if (option === "dailyGoal" && !state.result?.hidden && state.lastSession) renderResult();
    }
  }

  function syncSourceControls() {
    const source = state.settingsPanel?.querySelector("[data-option='category']");
    if (source instanceof HTMLSelectElement) {
      replaceSelectOptions(source, sourceChoices(state.favorites, state.settings.language, state.draftSnippet), state.settings.category);
    }
    const topic = state.settingsPanel?.querySelector("[data-option='topic']");
    if (topic instanceof HTMLSelectElement) {
      replaceSelectOptions(topic, topicChoices(state.settings.category), state.settings.topic);
      topic.disabled = ["saved", "draft"].includes(state.settings.category);
    }
  }

  function updateFavoriteAction(button) {
    const saved = isFavorite(state.favorites, state.settings.language, state.lastTarget);
    button.textContent = saved ? "saved" : "save";
    button.dataset.active = String(saved);
    button.setAttribute("aria-pressed", String(saved));
  }

  function stopHudPropagation(event) {
    event.stopPropagation();
  }

  function saveResult() {
    const metrics = sessionAnalysis(state.session, state.session.completedAt ?? Date.now());
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      presetId: state.settings.presetId,
      language: state.settings.language,
      category: state.settings.category,
      topic: state.settings.topic,
      wpm: metrics.wpm,
      rawWpm: metrics.rawWpm,
      accuracy: metrics.accuracy,
      errors: metrics.errors,
      consistency: metrics.consistency,
      fastestLineWpm: metrics.fastestLineWpm,
      elapsedMs: metrics.elapsedMs,
      createdAt: new Date().toISOString(),
    };
    state.history = [entry, ...state.history].slice(0, HISTORY_LIMIT);
    saveHistory(state.history);
    state.weakspots = mergeWeakspots(state.weakspots, state.settings.language, state.session.timeline);
    saveWeakspots(state.weakspots);
    state.daily = recordDailyCompletion(state.daily);
    saveDailyProgress(state.daily);
  }

  function bestResult() {
    return comparableHistory()
      .sort((left, right) => right.wpm - left.wpm || right.accuracy - left.accuracy)[0] ?? null;
  }

  function comparableHistory() {
    return state.history.filter((entry) => entry.presetId === state.settings.presetId
      && entry.language === state.settings.language
      && (entry.category ?? "mix") === state.settings.category
      && (entry.topic ?? "all") === state.settings.topic);
  }

  function activePreset() {
    return PRESETS.find((preset) => preset.id === state.settings.presetId) ?? PRESETS[2];
  }

  function applyComposerLift() {
    if (!state.editor || !state.surface) return;
    const liftedEditorHeight = Math.max(96, state.editorBaseHeight + 56);
    const liftedSurfaceHeight = Math.max(state.surfaceBaseHeight + 76, liftedEditorHeight + 74);
    state.editor.style.transition = appendTransition(state.editorStyles?.transition, "min-height 180ms ease");
    state.editor.style.minHeight = `${liftedEditorHeight}px`;
    state.surface.style.transition = appendTransition(state.surfaceStyles?.transition, "min-height 180ms ease");
    state.surface.style.minHeight = `${liftedSurfaceHeight}px`;
  }

  function replaceEditorText(editor, text) {
    if (!editor || readEditorText(editor) === text) return true;
    state.syncing = true;
    const changed = writeEditorText(editor, text);
    state.syncing = false;
    if (changed) moveCaretToEnd(editor);
    return changed;
  }

  function render(draftValue = null) {
    if (!state.overlay) return;
    const draft = draftValue === null
      ? state.session
      : { ...state.session, typed: splitCharacters(draftValue).slice(0, state.session.target.length) };
    const fragment = document.createDocumentFragment();
    const currentLine = lineIndexAt(state.session.target, draft.typed.length);
    const paceIndex = paceCharacterIndex();
    let lineIndex = 0;
    state.overlay.dataset.focusMode = state.settings.focusMode;
    state.overlay.dataset.paused = String(state.session.pausedAt !== null);
    state.session.target.forEach((character, index) => {
      const span = document.createElement("span");
      span.className = "cotypex-char";
      span.dataset.state = characterState(draft, index);
      span.dataset.line = lineIndex < currentLine
        ? "past"
        : lineIndex === currentLine
          ? "current"
          : lineIndex === currentLine + 1 ? "next" : "future";
      if (index === paceIndex && index !== draft.typed.length) span.dataset.pace = "true";
      span.textContent = state.settings.focusMode === "tape" && character === "\n" ? " ↵ " : character;
      fragment.appendChild(span);
      if (character === "\n") lineIndex += 1;
    });
    state.overlay.replaceChildren(fragment);
    syncOverlayLayout();
    window.requestAnimationFrame(scrollCurrentCharacterIntoView);
  }

  function renderHud() {
    if (!state.hud) return;
    const preset = activePreset();
    const metrics = sessionMetrics(state.session);
    if (!state.hud.firstElementChild) createHudContents(state.hud);
    state.hud.dataset.warning = String(state.warningPlayed && state.session.completedAt === null);

    for (const button of state.hud.querySelectorAll("[data-preset]")) {
      button.dataset.active = String(button.dataset.preset === state.settings.presetId);
    }
    const language = state.hud.querySelector("[data-setting='language']");
    if (language instanceof HTMLSelectElement) {
      let current = language.querySelector(`option[value='${CSS.escape(state.settings.language)}']`);
      if (!current && state.settingsBeforeOverride) {
        current = document.createElement("option");
        current.value = state.settings.language;
        current.textContent = PRACTICE_LANGUAGE_LABELS[state.settings.language] ?? state.settings.language;
        language.appendChild(current);
      }
      language.value = state.settings.language;
    }
    const progress = state.session.pausedAt !== null
      ? ["state", "pause"]
      : [preset.mode === "time" ? "left" : "done", progressLabel(metrics, preset)];
    const values = [
      ["wpm", metrics.wpm],
      ["acc", `${metrics.accuracy}%`],
      ["err", metrics.errors],
      progress,
    ];
    const stats = state.hud.querySelectorAll(".cotypex-stats > .cotypex-stat");
    values.forEach(([label, value], index) => updateStatNode(stats[index], label, value));
  }

  function renderResult() {
    if (!state.result) return;
    const metrics = sessionAnalysis(state.session, state.session.completedAt ?? Date.now());
    const best = bestResult();
    const recent = comparableHistory().slice(0, 5);
    const previous = recent[1] ?? null;
    const delta = previous ? metrics.wpm - previous.wpm : null;
    state.result.hidden = false;
    const summary = document.createElement("div");
    summary.className = "cotypex-result-summary";
    summary.appendChild(resultMetric("wpm", metrics.wpm));
    summary.appendChild(resultMetric("raw", metrics.rawWpm));
    summary.appendChild(resultMetric("acc", `${metrics.accuracy}%`));
    summary.appendChild(resultMetric("err", metrics.errors));
    summary.appendChild(resultMetric("cons", `${metrics.consistency}%`));
    summary.appendChild(resultMetric("burst", metrics.fastestLineWpm));
    summary.appendChild(resultMetric("best", best ? best.wpm : metrics.wpm));
    summary.appendChild(resultMetric("delta", delta === null ? "-" : `${delta >= 0 ? "+" : ""}${delta}`));
    summary.appendChild(resultMetric(
      "today",
      state.settings.dailyGoal > 0 ? `${state.daily.count}/${state.settings.dailyGoal}` : state.daily.count,
    ));
    summary.appendChild(resultMetric("streak", `${state.daily.streak}d`));

    const detail = document.createElement("div");
    detail.className = "cotypex-result-detail";
    const chart = document.createElement("canvas");
    chart.className = "cotypex-chart";
    chart.width = 560;
    chart.height = 88;
    chart.setAttribute("aria-label", "WPM and raw WPM history");
    detail.appendChild(chart);
    detail.appendChild(createHeatmap(metrics.heatmap));

    const lists = document.createElement("div");
    lists.className = "cotypex-analysis-lists";
    lists.appendChild(analysisList("slow", metrics.slowestCharacters.map((item) => `${item.character} ${item.averageDelayMs}ms`), "none"));
    lists.appendChild(analysisList("errors", metrics.errorDistribution.map((item) => `${item.character} x${item.errors}`), "none"));
    lists.appendChild(analysisList("recent", recent.map((item) => `${item.wpm}/${item.accuracy}%`), "first run"));
    detail.appendChild(lists);

    const actions = document.createElement("div");
    actions.className = "cotypex-result-actions";
    const favorite = activePreset().mode === "time"
      ? null
      : resultAction(
        "favorite",
        isFavorite(state.favorites, state.settings.language, state.lastTarget) ? "saved" : "save",
      );
    if (favorite) {
      favorite.dataset.active = String(isFavorite(state.favorites, state.settings.language, state.lastTarget));
      favorite.setAttribute("aria-pressed", favorite.dataset.active);
    }
    actions.append(
      resultAction("repeat", "repeat"),
      resultAction("errors", "error lines", metrics.errorLineIndices.length === 0),
      resultAction("weakspot", "weak"),
      ...(favorite ? [favorite] : []),
      resultAction("next", "next"),
    );
    state.result.replaceChildren(summary, detail, actions);
    drawSpeedChart(chart, metrics.speedSamples, getComputedStyle(state.result));
    syncOverlayLayout();
  }

  function paceCharacterIndex(now = Date.now()) {
    if (state.settings.pace === "off" || state.session.startedAt === null || state.session.completedAt !== null) return -1;
    const targetWpm = state.settings.pace === "last"
      ? state.lastWpm
      : state.settings.pace === "pb"
        ? (bestResult()?.wpm ?? 0)
        : state.settings.paceWpm;
    if (!(targetWpm > 0)) return -1;
    const elapsedMinutes = Math.max(0, now - state.session.startedAt) / 60000;
    return Math.min(state.session.target.length - 1, Math.floor(targetWpm * 5 * elapsedMinutes));
  }

  function scrollCurrentCharacterIntoView() {
    if (!state.overlay?.isConnected) return;
    const current = state.overlay.querySelector('.cotypex-char[data-state="current"]');
    if (!(current instanceof HTMLElement)) return;
    if (state.settings.focusMode === "tape") {
      state.overlay.scrollLeft = Math.max(0, current.offsetLeft - state.overlay.clientWidth * 0.35);
      state.overlay.scrollTop = 0;
    } else {
      const top = current.offsetTop;
      const bottom = top + current.offsetHeight;
      if (top < state.overlay.scrollTop + 8) state.overlay.scrollTop = Math.max(0, top - 8);
      if (bottom > state.overlay.scrollTop + state.overlay.clientHeight - 8) {
        state.overlay.scrollTop = bottom - state.overlay.clientHeight + 8;
      }
    }
    if (state.editor) {
      state.editor.scrollTop = state.overlay.scrollTop;
      state.editor.scrollLeft = state.overlay.scrollLeft;
    }
  }

  function playSound(kind) {
    const mode = state.settings.sound;
    if (mode === "off" || (mode === "error" && kind === "click")) return;
    try {
      state.audioContext ??= new AudioContext();
      const context = state.audioContext;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = kind === "click" ? "sine" : "triangle";
      oscillator.frequency.setValueAtTime(kind === "warning" ? 620 : kind === "error" ? 180 : 360, now);
      gain.gain.setValueAtTime(kind === "click" ? 0.018 : 0.035, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === "warning" ? 0.11 : 0.045));
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + (kind === "warning" ? 0.12 : 0.05));
    } catch {
      // Audio is optional and some webviews block AudioContext until a user gesture.
    }
  }

  function pausePractice() {
    const paused = pauseSession(state.session);
    if (paused === state.session) return;
    state.session = paused;
    render();
    renderHud();
  }

  function resumePractice() {
    const resumed = resumeSession(state.session);
    if (resumed === state.session) return;
    state.session = resumed;
    render();
    renderHud();
  }

  function scheduleLayout(passes = 1) {
    state.layoutPasses = Math.max(state.layoutPasses, passes);
    if (state.layoutFrame) return;
    state.layoutFrame = window.requestAnimationFrame(runLayoutPass);
  }

  function runLayoutPass() {
    state.layoutFrame = 0;
    if (!state.active) {
      state.layoutPasses = 0;
      return;
    }
    syncOverlayLayout();
    state.layoutPasses = Math.max(0, state.layoutPasses - 1);
    if (state.layoutPasses > 0) {
      state.layoutFrame = window.requestAnimationFrame(runLayoutPass);
    }
  }

  function syncOverlayLayout() {
    if (!state.active || !state.editor?.isConnected || !state.overlay) return;
    const rect = state.editor.getBoundingClientRect();
    const computed = state.snapshot.appearance;
    const palette = chromePalette(computed.color);
    Object.assign(state.overlay.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      padding: computed.padding,
      borderWidth: computed.borderWidth,
      borderStyle: "solid",
      font: computed.font,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      lineHeight: computed.lineHeight,
      letterSpacing: computed.letterSpacing,
      textAlign: computed.textAlign,
      textIndent: computed.textIndent,
      textTransform: computed.textTransform,
      whiteSpace: computed.whiteSpace === "normal" ? "pre-wrap" : computed.whiteSpace,
      wordBreak: computed.wordBreak,
      overflowWrap: computed.overflowWrap,
      tabSize: computed.tabSize,
      direction: computed.direction,
      color: computed.color,
    });
    if (state.hud) {
      Object.assign(state.hud.style, {
        "--cotypex-fg": palette.fg,
        "--cotypex-muted": palette.muted,
        "--cotypex-strong": palette.strong,
        "--cotypex-panel": palette.panel,
        "--cotypex-active": palette.active,
        "--cotypex-border": palette.border,
        "--cotypex-focus": palette.focus,
      });
      if (state.result) {
        Object.assign(state.result.style, {
          "--cotypex-fg": palette.fg,
          "--cotypex-muted": palette.muted,
          "--cotypex-strong": palette.strong,
          "--cotypex-panel": palette.panel,
          "--cotypex-active": palette.active,
          "--cotypex-border": palette.border,
          "--cotypex-focus": palette.focus,
        });
      }
      if (state.settingsPanel) {
        Object.assign(state.settingsPanel.style, {
          "--cotypex-fg": palette.fg,
          "--cotypex-muted": palette.muted,
          "--cotypex-strong": palette.strong,
          "--cotypex-panel": palette.panel,
          "--cotypex-active": palette.active,
          "--cotypex-border": palette.border,
          "--cotypex-focus": palette.focus,
        });
      }
    }
    syncOverlayScroll();
  }

  function syncOverlayScroll() {
    if (!state.editor || !state.overlay) return;
    state.overlay.scrollTop = state.editor.scrollTop;
    state.overlay.scrollLeft = state.editor.scrollLeft;
  }

  function destroy() {
    deactivate();
    observer.disconnect();
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keypress", onKeyPressOrUp, true);
    window.removeEventListener("keyup", onKeyPressOrUp, true);
    window.removeEventListener("beforeinput", onBeforeInput, true);
    window.removeEventListener("input", onInput, true);
    window.removeEventListener("compositionstart", onCompositionStart, true);
    window.removeEventListener("compositionend", onCompositionEnd, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("submit", onSubmit, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("blur", onWindowBlur);
    window.removeEventListener("focus", onWindowFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("beforeunload", onBeforeUnload);
    document.getElementById(STYLE_ID)?.remove();
    delete window[GLOBAL_KEY];
    return true;
  }

  window[GLOBAL_KEY] = {
    version: VERSION,
    get active() {
      return state.active;
    },
    toggle: () => (state.active ? deactivate() : activate()),
    practice: (source) => {
      const text = practiceableDraft(source?.text);
      if (!text) return false;
      if (state.active) deactivate();
      return activate({ text, language: source?.language });
    },
    ensure: ensureAttached,
    destroy,
  };
}

function normalizePracticeLanguage(value) {
  const language = String(value ?? "").toLowerCase();
  return /^[a-z0-9_+#.-]{1,32}$/.test(language) ? language : "typescript";
}

function defaultSettings() {
  return {
    presetId: "time-60",
    language: "typescript",
    category: "mix",
    topic: "all",
    difficulty: "normal",
    confidence: "off",
    stopOnError: false,
    autoPairs: false,
    pace: "off",
    paceWpm: 80,
    focusMode: "all",
    sound: "off",
    warningSeconds: 0,
    autoPause: true,
    dailyGoal: 0,
  };
}

function loadSettings(favorites = {}) {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    const settings = { ...defaultSettings(), ...(saved && typeof saved === "object" ? saved : {}) };
    if (!PRESETS.some((preset) => preset.id === settings.presetId)) settings.presetId = "time-60";
    if (!LANGUAGE_OPTIONS.some((option) => option.value === settings.language)) settings.language = "typescript";
    if (!["mix", "algorithm", "business", "saved", "draft"].includes(settings.category)) settings.category = "mix";
    if (settings.category === "draft"
      || (settings.category === "saved" && favoriteSnippets(favorites, settings.language).length === 0)) {
      settings.category = "mix";
    }
    if (settings.topic !== "all" && !topicsForCategory(settings.category).some((topic) => topic.id === settings.topic)) {
      settings.topic = "all";
    }
    if (!["normal", "expert", "master"].includes(settings.difficulty)) settings.difficulty = "normal";
    if (!["off", "on", "max"].includes(settings.confidence)) settings.confidence = "off";
    if (!["off", "last", "pb", "custom"].includes(settings.pace)) settings.pace = "off";
    if (!["all", "line", "tape"].includes(settings.focusMode)) settings.focusMode = "all";
    if (!["off", "click", "error"].includes(settings.sound)) settings.sound = "off";
    settings.paceWpm = Math.min(300, Math.max(10, Number(settings.paceWpm) || 80));
    settings.warningSeconds = [0, 3, 5].includes(Number(settings.warningSeconds)) ? Number(settings.warningSeconds) : 0;
    settings.dailyGoal = [0, 5, 10, 25].includes(Number(settings.dailyGoal)) ? Number(settings.dailyGoal) : 0;
    settings.stopOnError = Boolean(settings.stopOnError);
    settings.autoPairs = Boolean(settings.autoPairs);
    settings.autoPause = settings.autoPause !== false;
    return settings;
  } catch {
    return defaultSettings();
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Local storage can be unavailable in hardened webviews.
  }
}

function loadHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
  } catch {
    // Stats are nice to keep, but practice should continue without storage.
  }
}

function loadFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(
      LANGUAGE_OPTIONS.map(({ value }) => [value, favoriteSnippets(saved, value).slice(0, 100)]),
    );
  } catch {
    return {};
  }
}

function saveFavorites(favorites) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  } catch {
    // A full or unavailable local store should not interrupt practice.
  }
}

function loadDailyProgress() {
  try {
    return normalizeDailyProgress(JSON.parse(localStorage.getItem(DAILY_KEY) ?? "null"));
  } catch {
    return normalizeDailyProgress(null);
  }
}

function saveDailyProgress(progress) {
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify(normalizeDailyProgress(progress)));
  } catch {
    // A daily counter is optional and never blocks a completed result.
  }
}

function loadWeakspots() {
  try {
    const saved = JSON.parse(localStorage.getItem(WEAKSPOT_KEY) ?? "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function saveWeakspots(weakspots) {
  try {
    localStorage.setItem(WEAKSPOT_KEY, JSON.stringify(weakspots));
  } catch {
    // Weakspot training remains usable for the current session without storage.
  }
}

function mergeWeakspots(weakspots, language, timeline) {
  const profile = { ...(weakspots[language] ?? {}) };
  for (const entry of timeline) {
    const key = entry.expected;
    const current = profile[key] ?? { attempts: 0, errors: 0, totalDelayMs: 0, samples: 0 };
    current.attempts += 1;
    current.errors += Number(!entry.correct);
    if (entry.delayMs > 0) {
      current.totalDelayMs += entry.delayMs;
      current.samples += 1;
    }
    profile[key] = current;
  }
  return { ...weakspots, [language]: profile };
}

function sessionOptions(settings) {
  const preset = presetFor(settings.presetId);
  return { mode: preset.mode, limit: preset.limit, difficulty: settings.difficulty };
}

function buildTarget(settings, previousIndex = -1, weakspots = {}, favorites = {}, draftSnippet = null) {
  const preset = presetFor(settings.presetId);
  if (preset.mode === "quote") return selectPrompt(previousIndex, settings, favorites, draftSnippet);
  const snippets = practiceCorpus(settings, favorites, draftSnippet);
  if (snippets.length === 0) throw new Error("CoTypeX practice corpus must not be empty");
  if (preset.mode === "weakspot") {
    const profile = weakspots[settings.language] ?? {};
    const ranked = snippets
      .map((snippet) => ({ snippet, score: weakspotScore(snippet, profile) }))
      .sort((left, right) => right.score - left.score);
    const candidates = ranked.slice(0, Math.min(24, ranked.length)).filter((entry) => entry.score > 0);
    return (candidates[randomIndex(candidates.length)] ?? ranked[randomIndex(ranked.length)]).snippet;
  }
  if (preset.mode === "words") {
    const candidates = closestSnippetsByWordCount(snippets, preset.limit);
    return candidates[randomIndex(candidates.length)] ?? snippets[0];
  }
  const parts = [];
  const targetLength = Math.max(160, preset.limit * 10);
  while (parts.join("\n\n").length < targetLength) {
    const previous = parts.at(-1);
    const choices = snippets.filter((snippet) => snippet !== previous);
    parts.push(choices[randomIndex(choices.length)] ?? snippets[0]);
  }
  return parts.join("\n\n");
}

function weakspotScore(snippet, profile) {
  return splitCharacters(snippet).reduce((score, character) => {
    const item = profile[character];
    if (!item) return score;
    const errorRate = item.attempts ? item.errors / item.attempts : 0;
    const delay = item.samples ? item.totalDelayMs / item.samples : 0;
    return score + errorRate * 8 + Math.min(4, delay / 250);
  }, 0);
}

function createHudContents(hud) {
  const presets = document.createElement("div");
  presets.className = "cotypex-hud-group";
  for (const item of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cotypex-hud-button";
    button.dataset.preset = item.id;
    button.textContent = item.label;
    presets.appendChild(button);
  }

  const settings = document.createElement("div");
  settings.className = "cotypex-hud-group cotypex-hud-settings";
  const leetcode = document.createElement("button");
  leetcode.type = "button";
  leetcode.className = "cotypex-hud-button";
  leetcode.dataset.action = "leetcode";
  leetcode.textContent = "LeetCode";
  leetcode.title = "Switch to LeetCode practice";
  settings.appendChild(leetcode);
  const language = document.createElement("select");
  language.className = "cotypex-select";
  language.dataset.setting = "language";
  language.title = "Programming language";
  for (const option of LANGUAGE_OPTIONS) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    language.appendChild(element);
  }
  settings.appendChild(language);
  const options = document.createElement("button");
  options.type = "button";
  options.className = "cotypex-hud-button cotypex-options-button";
  options.dataset.action = "settings";
  options.textContent = "opts";
  options.title = "Practice options";
  settings.appendChild(options);

  const stats = document.createElement("div");
  stats.className = "cotypex-stats";
  stats.appendChild(statNode("wpm", 0));
  stats.appendChild(statNode("acc", "100%"));
  stats.appendChild(statNode("err", 0));
  stats.appendChild(statNode("left", "0s"));
  hud.append(presets, settings, stats);
}

function createSettingsContents(panel, settings, favorites, draftSnippet) {
  panel.append(
    optionSelect("source", "category", settings.category, sourceChoices(favorites, settings.language, draftSnippet)),
    optionSelect("topic", "topic", settings.topic, topicChoices(settings.category)),
    optionToggle("pause", "autoPause", settings.autoPause),
    optionSelect("level", "difficulty", settings.difficulty, [
      ["normal", "normal"], ["expert", "expert"], ["master", "master"],
    ]),
    optionSelect("confidence", "confidence", settings.confidence, [
      ["off", "off"], ["on", "line"], ["max", "max"],
    ]),
    optionToggle("stop", "stopOnError", settings.stopOnError),
    optionToggle("pairs", "autoPairs", settings.autoPairs),
    optionSelect("pace", "pace", settings.pace, [
      ["off", "off"], ["last", "last"], ["pb", "pb"], ["custom", "custom"],
    ]),
    optionNumber("wpm", "paceWpm", settings.paceWpm, 10, 300),
    optionSelect("focus", "focusMode", settings.focusMode, [
      ["all", "all"], ["line", "line"], ["tape", "tape"],
    ]),
    optionSelect("sound", "sound", settings.sound, [
      ["off", "off"], ["click", "keys"], ["error", "errors"],
    ]),
    optionSelect("warn", "warningSeconds", String(settings.warningSeconds), [
      ["0", "off"], ["3", "3s"], ["5", "5s"],
    ]),
    optionSelect("goal", "dailyGoal", String(settings.dailyGoal), [
      ["0", "off"], ["5", "5"], ["10", "10"], ["25", "25"],
    ]),
  );
  const topic = panel.querySelector("[data-option='topic']");
  if (topic instanceof HTMLSelectElement) topic.disabled = ["saved", "draft"].includes(settings.category);
}

function optionSelect(label, key, value, choices) {
  const wrapper = optionWrapper(label);
  const select = document.createElement("select");
  select.className = "cotypex-option-control";
  select.dataset.option = key;
  replaceSelectOptions(select, choices, value);
  wrapper.appendChild(select);
  return wrapper;
}

function topicChoices(category) {
  return [["all", "all"], ...topicsForCategory(category).map((topic) => [topic.id, topic.label])];
}

function sourceChoices(favorites, language, draftSnippet = null) {
  return [
    ["mix", "mix"],
    ["algorithm", "algorithm"],
    ["business", "business"],
    ["saved", "saved", favoriteSnippets(favorites, language).length === 0],
    ["draft", "draft", !practiceableDraft(draftSnippet)],
  ];
}

function replaceSelectOptions(select, choices, value) {
  const options = choices.map(([choiceValue, choiceLabel, disabled = false]) => {
    const option = document.createElement("option");
    option.value = choiceValue;
    option.textContent = choiceLabel;
    option.selected = String(value) === choiceValue;
    option.disabled = disabled;
    return option;
  });
  select.replaceChildren(...options);
}

function optionToggle(label, key, checked) {
  const wrapper = optionWrapper(label);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.option = key;
  input.checked = checked;
  wrapper.appendChild(input);
  return wrapper;
}

function optionNumber(label, key, value, min, max) {
  const wrapper = optionWrapper(label);
  const input = document.createElement("input");
  input.type = "number";
  input.className = "cotypex-option-number";
  input.dataset.option = key;
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  wrapper.appendChild(input);
  return wrapper;
}

function optionWrapper(label) {
  const wrapper = document.createElement("label");
  wrapper.className = "cotypex-option";
  const text = document.createElement("span");
  text.textContent = label;
  wrapper.appendChild(text);
  return wrapper;
}

function statNode(label, value) {
  const node = document.createElement("span");
  node.className = "cotypex-stat";
  const name = document.createElement("span");
  name.className = "cotypex-stat-name";
  name.textContent = label;
  const number = document.createElement("span");
  number.className = "cotypex-stat-value";
  number.textContent = String(value);
  node.append(name, number);
  return node;
}

function updateStatNode(node, label, value) {
  if (!(node instanceof Element)) return;
  const name = node.querySelector(".cotypex-stat-name");
  const number = node.querySelector(".cotypex-stat-value");
  if (name) name.textContent = String(label);
  if (number) number.textContent = String(value);
}

function resultMetric(label, value) {
  const node = document.createElement("span");
  node.className = "cotypex-result-metric";
  node.append(statNode(label, value));
  return node;
}

function resultAction(action, label, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cotypex-result-action";
  button.dataset.resultAction = action;
  button.textContent = label;
  button.disabled = disabled;
  return button;
}

function analysisList(label, values, emptyLabel) {
  const node = document.createElement("div");
  node.className = "cotypex-analysis-list";
  const title = document.createElement("span");
  title.className = "cotypex-analysis-label";
  title.textContent = label;
  const content = document.createElement("span");
  content.className = "cotypex-analysis-values";
  content.textContent = values.length ? values.join("  ") : emptyLabel;
  node.append(title, content);
  return node;
}

function createHeatmap(samples) {
  const wrapper = document.createElement("div");
  wrapper.className = "cotypex-heatmap-wrap";
  wrapper.title = "Character timing heatmap";
  const label = document.createElement("span");
  label.className = "cotypex-analysis-label";
  label.textContent = "timing";
  const heatmap = document.createElement("div");
  heatmap.className = "cotypex-heatmap";
  heatmap.setAttribute("aria-hidden", "true");
  const maximum = Math.max(1, ...samples.map((sample) => sample.delayMs));
  for (const sample of samples) {
    const cell = document.createElement("span");
    cell.className = "cotypex-heat-cell";
    if (sample.error) cell.dataset.error = "true";
    cell.style.setProperty("--heat-percent", `${Math.round(18 + Math.min(1, sample.delayMs / maximum) * 72)}%`);
    cell.title = `${sample.character}: ${sample.delayMs}ms${sample.error ? ", error" : ""}`;
    heatmap.appendChild(cell);
  }
  wrapper.append(label, heatmap);
  return wrapper;
}

function drawSpeedChart(canvas, samples, computed) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  const padding = 8;
  const strong = computed.getPropertyValue("--cotypex-strong").trim() || "#ffffff";
  const muted = computed.getPropertyValue("--cotypex-muted").trim() || "rgba(255,255,255,.45)";
  const border = computed.getPropertyValue("--cotypex-border").trim() || "rgba(255,255,255,.12)";
  context.clearRect(0, 0, width, height);
  context.strokeStyle = border;
  context.lineWidth = 1;
  for (let row = 1; row <= 2; row += 1) {
    const y = padding + ((height - padding * 2) * row) / 3;
    context.beginPath();
    context.moveTo(padding, y);
    context.lineTo(width - padding, y);
    context.stroke();
  }
  if (!samples.length) return;
  const maximum = Math.max(10, ...samples.flatMap((sample) => [sample.wpm, sample.rawWpm]));
  const drawLine = (key, color) => {
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    samples.forEach((sample, index) => {
      const x = padding + (index / Math.max(1, samples.length - 1)) * (width - padding * 2);
      const y = height - padding - (sample[key] / maximum) * (height - padding * 2);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  };
  drawLine("rawWpm", muted);
  drawLine("wpm", strong);
}

function firstIncorrectPosition(session) {
  return session.typed.findIndex((character, index) => character !== session.target[index]);
}

function indentationWidth(language) {
  return language === "python" ? 4 : 2;
}

function lineIndexAt(target, position) {
  let line = 0;
  for (let index = 0; index < Math.min(position, target.length); index += 1) {
    if (target[index] === "\n") line += 1;
  }
  return line;
}

function progressLabel(metrics, preset) {
  if (preset.mode === "time") return `${Math.ceil((metrics.remainingMs ?? preset.limit * 1000) / 1000)}s`;
  return `${Math.round(metrics.progress * 100)}%`;
}

function presetFor(id) {
  return PRESETS.find((preset) => preset.id === id) ?? PRESETS[2];
}

function quoteCorpus(language = "typescript", category = "mix", topic = "all") {
  const source = CORPUS && typeof CORPUS === "object" ? CORPUS[language] : null;
  const fallback = Array.isArray(CORPUS?.typescript) ? CORPUS.typescript : [];
  return filterCorpusSnippets(Array.isArray(source) && source.length > 0 ? source : fallback, category, topic);
}

function practiceCorpus(settings, favorites = {}, draftSnippet = null) {
  if (settings.category === "saved") return favoriteSnippets(favorites, settings.language);
  if (settings.category === "draft") return practiceableDraft(draftSnippet) ? [draftSnippet] : [];
  return quoteCorpus(settings.language, settings.category, settings.topic);
}

function practiceableDraft(text) {
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

function randomIndex(length) {
  if (length <= 1) return 0;
  return crypto.getRandomValues(new Uint32Array(1))[0] % length;
}

function chromePalette(color) {
  const rgb = parseRgb(color);
  const lightText = rgb ? relativeLuminance(rgb) > 0.55 : true;
  if (lightText) {
    return {
      fg: "rgba(238, 242, 240, 0.88)",
      muted: "rgba(238, 242, 240, 0.58)",
      strong: "#ffffff",
      panel: "rgba(18, 21, 22, 0.86)",
      active: "rgba(255, 255, 255, 0.14)",
      border: "rgba(255, 255, 255, 0.12)",
      focus: "rgba(255, 255, 255, 0.34)",
    };
  }
  return {
    fg: "rgba(26, 31, 32, 0.86)",
    muted: "rgba(26, 31, 32, 0.58)",
    strong: "#111516",
    panel: "rgba(255, 255, 255, 0.88)",
    active: "rgba(0, 0, 0, 0.08)",
    border: "rgba(0, 0, 0, 0.10)",
    focus: "rgba(0, 0, 0, 0.28)",
  };
}

function parseRgb(color) {
  const match = String(color).match(/rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance([red, green, blue]) {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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
  return event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey
    && event.code === "KeyT";
}

function isNextShortcut(event) {
  return event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey
    && event.code === "KeyN";
}

function isRestartShortcut(event) {
  return event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey
    && event.code === "KeyR";
}

function isCaretNavigation(event) {
  return ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key);
}

function stopEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

function eventTargetsEditor(event, editor) {
  if (!editor) return false;
  return event.composedPath?.().includes(editor) || event.target === editor || editor.contains(event.target);
}

function editorHasFocus(editor) {
  if (!editor) return false;
  const active = document.activeElement;
  return active === editor || editor.contains(active) || active?.contains?.(editor);
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
  while (branch?.parentElement && branch.parentElement !== container) {
    branch = branch.parentElement;
  }
  return branch?.parentElement === container ? branch : null;
}

function composerScore(node) {
  const rect = node.getBoundingClientRect();
  if (rect.width < 180 || rect.height < 20 || rect.bottom <= 0 || rect.top >= innerHeight) return -Infinity;
  if (rect.bottom < innerHeight * 0.45) return -Infinity;
  const horizontalCenter = rect.left + rect.width / 2;
  const centerDistance = Math.abs(horizontalCenter - innerWidth / 2) / Math.max(1, innerWidth);
  const lowerPosition = rect.bottom / Math.max(1, innerHeight);
  const widthShare = Math.min(1, rect.width / Math.max(1, innerWidth));
  const composerClass = node.closest(".composer-surface-chrome") ? 30 : 0;
  const editorClass = node.matches("div.ProseMirror") ? 20 : 0;
  return lowerPosition * 100 + widthShare * 36 - centerDistance * 42 + composerClass + editorClass;
}

function captureInlineStyles(element, properties) {
  if (!element) return null;
  return Object.fromEntries(properties.map((property) => [property, element.style[property] ?? ""]));
}

function restoreInlineStyles(element, saved) {
  if (!element || !saved) return;
  for (const [property, value] of Object.entries(saved)) {
    element.style[property] = value;
  }
}

function appendTransition(existing, addition) {
  const value = String(existing ?? "").trim();
  if (!value) return addition;
  return value.includes(addition) ? value : `${value}, ${addition}`;
}

function captureEditor(editor) {
  const computed = getComputedStyle(editor);
  return {
    text: readEditorText(editor),
    html: isTextControl(editor) ? null : editor.innerHTML,
    selection: captureEditorSelection(editor),
    appearance: {
      padding: computed.padding,
      borderWidth: computed.borderWidth,
      font: computed.font,
      lineHeight: computed.lineHeight,
      letterSpacing: computed.letterSpacing,
      textAlign: computed.textAlign,
      textIndent: computed.textIndent,
      textTransform: computed.textTransform,
      whiteSpace: computed.whiteSpace,
      wordBreak: computed.wordBreak,
      overflowWrap: computed.overflowWrap,
      tabSize: computed.tabSize,
      direction: computed.direction,
      color: resolveEditorColor(computed),
    },
  };
}

function resolveEditorColor(computed) {
  const bodyColor = document.body ? getComputedStyle(document.body).color : "";
  for (const color of [computed.color, computed.caretColor, bodyColor]) {
    if (isVisibleCssColor(color)) return color;
  }
  return "rgb(238, 242, 240)";
}

function isVisibleCssColor(color) {
  const value = String(color ?? "").trim();
  if (!value || value === "auto" || value === "transparent") return false;
  const alpha = value.match(/rgba?\([^/]*[,/]\s*(0(?:\.0+)?|\.0+)\s*\)$/)?.[1];
  return alpha === undefined;
}

function readEditorText(editor) {
  if (isTextControl(editor)) return editor.value;
  if (editor.matches(".ProseMirror")) {
    return Array.from(editor.childNodes, serializeEditorBlock).join("\n");
  }
  return editor.textContent ?? "";
}

function serializeEditorBlock(node) {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? "").replaceAll("\u00a0", " ");
  if (!(node instanceof Element)) return "";
  if (node.tagName === "BR") return "\n";
  if (node.childNodes.length === 1 && node.firstChild instanceof HTMLBRElement) return "";
  return Array.from(node.childNodes, serializeEditorBlock).join("");
}

function writeEditorText(editor, text) {
  editor.focus({ preventScroll: true });
  if (isTextControl(editor)) {
    const prototype = editor instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(editor, text);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return editor.value === text;
  }
  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  const command = text.length > 0 ? "insertText" : "delete";
  const changed = document.execCommand(command, false, text);
  return changed && readEditorText(editor) === text;
}

function restoreEditorContent(editor, snapshot) {
  if (isTextControl(editor)) return writeEditorText(editor, snapshot.text);
  editor.focus({ preventScroll: true });
  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  const command = snapshot.html ? "insertHTML" : "delete";
  return document.execCommand(command, false, snapshot.html ?? "");
}

function isTextControl(editor) {
  return editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement;
}

function captureEditorSelection(editor) {
  if (isTextControl(editor)) {
    return { start: editor.selectionStart ?? editor.value.length, end: editor.selectionEnd ?? editor.value.length };
  }
  const selection = document.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) {
    const end = splitCharacters(readEditorText(editor)).length;
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

function focusEditor(editor) {
  editor?.focus?.({ preventScroll: true });
  moveCaretToEnd(editor);
}

function moveCaretToEnd(editor) {
  if (!editor) return;
  if (isTextControl(editor)) {
    const end = editor.value.length;
    editor.setSelectionRange(end, end);
    return;
  }
  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function textOffset(root, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return splitCharacters(range.toString()).length;
}

function textPosition(root, characterOffset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = characterOffset;
  let last = root;
  while (walker.nextNode()) {
    last = walker.currentNode;
    const length = splitCharacters(last.nodeValue).length;
    if (remaining <= length) {
      const codeUnitOffset = splitCharacters(last.nodeValue).slice(0, remaining).join("").length;
      return { node: last, offset: codeUnitOffset };
    }
    remaining -= length;
  }
  return { node: last, offset: last === root ? root.childNodes.length : last.nodeValue.length };
}

function isSubmissionControl(target, editor) {
  if (!(target instanceof Element) || !editor) return false;
  const control = target.closest("button,input[type='submit'],[role='button']");
  if (!control) return false;
  const form = editor.closest("form");
  const surface = form ?? editor.closest(".composer-surface-chrome") ?? editor.parentElement;
  if (!surface?.contains(control) && !(form && control.form === form)) return false;
  if (control.matches("button[type='submit'],input[type='submit']")) return true;
  const label = `${control.getAttribute("aria-label") ?? ""} ${control.getAttribute("title") ?? ""}`.trim();
  return /(^|\s)(send|submit|发送|提交)(\s|$)/i.test(label);
}

function selectPrompt(previousIndex, settings, favorites = {}, draftSnippet = null) {
  const corpus = practiceCorpus(settings, favorites, draftSnippet);
  if (corpus.length === 0) throw new Error("CoTypeX corpus must not be empty");
  if (corpus.length === 1) return corpus[0];
  const random = randomIndex(corpus.length);
  const index = random === previousIndex ? (random + 1) % corpus.length : random;
  return corpus[index];
}
