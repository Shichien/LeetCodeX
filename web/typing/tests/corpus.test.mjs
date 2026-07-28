import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  closestSnippetsByWordCount,
  CORPUS_TOPICS,
  filterCorpusSnippets,
  snippetCategory,
  snippetTopic,
} from "../src/corpus-utils.js";

const corpus = JSON.parse(
  await readFile(new URL("../src/corpus.json", import.meta.url), "utf8"),
);

const languages = [
  "javascript",
  "typescript",
  "python",
  "java",
  "go",
  "rust",
  "sql",
  "csharp",
  "php",
];

test("corpus covers popular programming languages with 1,080 algorithm and 1,080 business snippets", () => {
  assert.deepEqual(Object.keys(corpus), languages);
  const total = Object.values(corpus).reduce((sum, snippets) => sum + snippets.length, 0);
  assert.ok(total >= 2160, `expected at least 2,160 snippets, received ${total}`);
  for (const language of languages) {
    assert.ok(corpus[language].length >= 240, `${language} needs at least 240 snippets`);
    assert.equal(new Set(corpus[language]).size, corpus[language].length, `${language} has duplicate snippets`);
  }
});

test("every snippet is multiline, substantial, and categorized", () => {
  const algorithm = /Binary search|Two pointers|Sliding window|Breadth-first search|Dynamic programming|Union find/;
  const business = /Order management|Payment processing|Inventory fulfillment|Identity and access|Query and pagination|Reporting and analytics/;
  let algorithmCount = 0;
  let businessCount = 0;
  for (const [language, snippets] of Object.entries(corpus)) {
    for (const snippet of snippets) {
      assert.match(snippet, /\n/, `${language} snippet should be multiline`);
      assert.ok(snippet.length >= 80, `${language} snippet is too short`);
      if (algorithm.test(snippet)) algorithmCount += 1;
      if (business.test(snippet)) businessCount += 1;
    }
  }
  assert.ok(algorithmCount >= 1080, `expected 1,080 algorithm snippets, received ${algorithmCount}`);
  assert.ok(businessCount >= 1080, `expected 1,080 business snippets, received ${businessCount}`);
});

test("each language exposes equal algorithm and business sources", () => {
  for (const [language, snippets] of Object.entries(corpus)) {
    const algorithms = filterCorpusSnippets(snippets, "algorithm");
    const business = filterCorpusSnippets(snippets, "business");
    assert.equal(algorithms.length, 120, `${language} algorithm count changed`);
    assert.equal(business.length, 120, `${language} business count changed`);
    assert.ok(algorithms.every((snippet) => snippetCategory(snippet) === "algorithm"));
    assert.ok(business.every((snippet) => snippetCategory(snippet) === "business"));
  }
});

test("every topic has 20 snippets in every language", () => {
  for (const [language, snippets] of Object.entries(corpus)) {
    for (const topic of CORPUS_TOPICS) {
      const filtered = filterCorpusSnippets(snippets, topic.category, topic.id);
      assert.equal(filtered.length, 20, `${language}/${topic.id} count changed`);
      assert.ok(filtered.every((snippet) => snippetTopic(snippet) === topic.id));
    }
  }
});

test("word-count mode chooses from nearby snippets without becoming deterministic", () => {
  const examples = ["one two", "one two three four", "one two three four five six"];
  assert.deepEqual(closestSnippetsByWordCount(examples, 4, 2), [examples[1], examples[0]]);
});
