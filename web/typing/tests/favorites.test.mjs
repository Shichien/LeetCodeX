import test from "node:test";
import assert from "node:assert/strict";
import {
  favoriteSnippets,
  isFavorite,
  toggleFavorite,
} from "../src/favorites.js";

test("favorites are isolated by language and reject malformed entries", () => {
  const profile = {
    typescript: ["const value = 1;", "", "const value = 1;", 42],
    python: ["value = 1"],
  };
  assert.deepEqual(favoriteSnippets(profile, "typescript"), ["const value = 1;"]);
  assert.deepEqual(favoriteSnippets(profile, "python"), ["value = 1"]);
  assert.deepEqual(favoriteSnippets(null, "typescript"), []);
});

test("toggleFavorite adds newest first and removes exact matches", () => {
  const added = toggleFavorite({}, "typescript", "type Invoice = { total: number };");
  assert.equal(isFavorite(added, "typescript", "type Invoice = { total: number };"), true);
  const removed = toggleFavorite(added, "typescript", "type Invoice = { total: number };");
  assert.deepEqual(favoriteSnippets(removed, "typescript"), []);
});

test("toggleFavorite enforces a per-language capacity without mutating other languages", () => {
  const profile = { typescript: ["second", "first"], python: ["print('kept')"] };
  const next = toggleFavorite(profile, "typescript", "newest", 2);
  assert.deepEqual(favoriteSnippets(next, "typescript"), ["newest", "second"]);
  assert.deepEqual(favoriteSnippets(next, "python"), ["print('kept')"]);
  assert.deepEqual(profile.typescript, ["second", "first"]);
});
