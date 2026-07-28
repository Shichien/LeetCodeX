import assert from "node:assert/strict";
import test from "node:test";

import {
  destroyEditorView,
  editorShortcutBindings,
  vimModeActive,
} from "../src/editor.js";

test("editor commands take both platform and Windows shortcut forms", () => {
  const calls = [];
  const bindings = editorShortcutBindings(
    {
      onRun: () => calls.push("run"),
      onSave: () => calls.push("save"),
    },
    {
      openSearch: () => (calls.push("search"), true),
      closeSearch: () => (calls.push("escape"), true),
    },
  );
  const byKey = new Map(bindings.map((binding) => [binding.key, binding]));

  assert.deepEqual([...byKey.keys()], [
    "Escape",
    "Mod-f",
    "Ctrl-f",
    "Mod-s",
    "Ctrl-s",
    "Mod-Enter",
    "Ctrl-Enter",
  ]);
  for (const key of ["Mod-f", "Ctrl-f"]) assert.equal(byKey.get(key).run({}), true);
  for (const key of ["Mod-s", "Ctrl-s"]) assert.equal(byKey.get(key).run({}), true);
  for (const key of ["Mod-Enter", "Ctrl-Enter"]) assert.equal(byKey.get(key).run({}), true);
  assert.equal(byKey.get("Escape").run({}), true);
  assert.deepEqual(calls, ["search", "search", "save", "save", "run", "run", "escape"]);
  for (const key of byKey.keys()) {
    if (key !== "Escape") assert.equal(byKey.get(key).preventDefault, true);
  }
});

test("Vim lifecycle is detected from the adapter state", () => {
  assert.equal(vimModeActive(null), false);
  assert.equal(vimModeActive({ state: {} }), false);
  assert.equal(vimModeActive({ state: { vim: null } }), false);
  assert.equal(vimModeActive({ state: { vim: {} } }), true);
});

test("editor destruction removes Vim while the view is live", () => {
  const calls = [];
  const effect = { kind: "disable-vim" };
  const view = {
    dispatch(transaction) {
      calls.push(["dispatch", transaction]);
    },
    destroy() {
      calls.push(["destroy"]);
    },
  };
  const vimSlot = { reconfigure: (extensions) => (assert.deepEqual(extensions, []), effect) };

  destroyEditorView(view, vimSlot, () => ({ state: { vim: {} } }));

  assert.deepEqual(calls, [
    ["dispatch", { effects: effect }],
    ["destroy"],
  ]);
});

test("editor destruction skips Vim cleanup when Vim is already absent", () => {
  const calls = [];
  const view = {
    dispatch() {
      calls.push("dispatch");
    },
    destroy() {
      calls.push("destroy");
    },
  };

  destroyEditorView(view, { reconfigure: () => null }, () => null);

  assert.deepEqual(calls, ["destroy"]);
});
