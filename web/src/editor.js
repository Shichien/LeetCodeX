import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { history } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import {
  StreamLanguage,
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { dart, csharp, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { scheme } from "@codemirror/legacy-modes/mode/scheme";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search } from "@codemirror/search";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { vscodeKeymap } from "@replit/codemirror-vscode-keymap";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";

export function createCodeEditor({ parent, value, language, colorScheme, vimMode, onChange, onRun, onSave }) {
  const languageSlot = new Compartment();
  const themeSlot = new Compartment();
  const vimSlot = new Compartment();
  let destroyed = false;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        EditorState.tabSize.of(2),
        Prec.highest(keymap.of(editorShortcutBindings({ onRun, onSave }))),
        vimSlot.of(vimMode ? vim() : []),
        keymap.of([
          ...vscodeKeymap,
        ]),
        languageSlot.of(languageExtension(language)),
        themeSlot.of(colorScheme === "dark" ? vscodeDark : vscodeLight),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroyEditorView(view, vimSlot);
    },
    focus: () => view.focus(),
    getValue: () => view.state.doc.toString(),
    setValue(nextValue) {
      const current = view.state.doc.toString();
      if (current === nextValue) return;
      view.dispatch({ changes: { from: 0, to: current.length, insert: nextValue } });
    },
    setLanguage(nextLanguage) {
      view.dispatch({ effects: languageSlot.reconfigure(languageExtension(nextLanguage)) });
    },
    setColorScheme(nextScheme) {
      view.dispatch({ effects: themeSlot.reconfigure(nextScheme === "dark" ? vscodeDark : vscodeLight) });
    },
    setVimMode(enabled) {
      if (vimModeActive(getCM(view)) === enabled) return;
      view.dispatch({ effects: vimSlot.reconfigure(enabled ? vim() : []) });
      const cm = getCM(view);
      if (enabled && cm) Vim.handleKey(cm, "<Esc>");
    },
    handleEscape() {
      if (closeActiveSearchPanel(view)) return true;
      const cm = getCM(view);
      if (!cm) return false;
      Vim.handleKey(cm, "<Esc>");
      return true;
    },
  };
}

export function vimModeActive(cm) {
  return Boolean(cm?.state?.vim);
}

export function destroyEditorView(view, vimSlot, getCodeMirror = getCM) {
  try {
    if (vimModeActive(getCodeMirror(view))) {
      view.dispatch({ effects: vimSlot.reconfigure([]) });
    }
  } finally {
    view.destroy();
  }
}

export function editorShortcutBindings(
  { onRun, onSave },
  { openSearch = openSearchPanel, closeSearch = closeActiveSearchPanel } = {},
) {
  const save = () => (onSave(), true);
  const run = () => (onRun(), true);
  return [
    { key: "Escape", run: closeSearch },
    { key: "Mod-f", preventDefault: true, run: openSearch },
    { key: "Ctrl-f", preventDefault: true, run: openSearch },
    { key: "Mod-s", preventDefault: true, run: save },
    { key: "Ctrl-s", preventDefault: true, run: save },
    { key: "Mod-Enter", preventDefault: true, run },
    { key: "Ctrl-Enter", preventDefault: true, run },
  ];
}

function closeActiveSearchPanel(view) {
  const closeButton = view.dom.querySelector(".cm-panel.cm-search button[aria-label='close']");
  if (typeof closeButton?.click === "function" && closeButton.getClientRects().length > 0) {
    closeButton.click();
    return true;
  }
  return closeSearchPanel(view);
}

function languageExtension(language) {
  switch (language) {
    case "javascript": return javascript();
    case "typescript": return javascript({ typescript: true });
    case "python":
    case "python3": return python();
    case "java": return java();
    case "cpp":
    case "c": return cpp();
    case "csharp": return StreamLanguage.define(csharp);
    case "golang":
    case "go": return go();
    case "rust": return rust();
    case "php": return php({ plain: true });
    case "kotlin": return StreamLanguage.define(kotlin);
    case "scala": return StreamLanguage.define(scala);
    case "swift": return StreamLanguage.define(swift);
    case "dart": return StreamLanguage.define(dart);
    case "ruby": return StreamLanguage.define(ruby);
    case "racket":
    case "scheme": return StreamLanguage.define(scheme);
    case "erlang": return StreamLanguage.define(erlang);
    case "bash": return StreamLanguage.define(shell);
    case "mysql":
    case "mssql":
    case "oraclesql": return sql();
    case "json": return json();
    default: return [];
  }
}
