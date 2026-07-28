import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RESULT_TEXT_CHARS,
  normalizeProblemText,
  problemFrontendId,
  truncateDisplayText,
} from "../src/content.js";

test("problem text preserves meaningful paragraphs and list lines", () => {
  assert.equal(
    normalizeProblemText("  First paragraph  \r\n\n\n Second paragraph \n - item one \n - item two  "),
    "First paragraph\n\nSecond paragraph\n- item one\n- item two",
  );
});

test("problem text removes horizontal HTML formatting noise", () => {
  assert.equal(normalizeProblemText("Input:   nums = [1, 2]\nOutput:\t2"), "Input: nums = [1, 2]\nOutput: 2");
  assert.equal(normalizeProblemText(null), "");
});

test("problem labels accept both LeetCode frontend ID field names", () => {
  assert.equal(problemFrontendId({ frontendQuestionId: "1" }), "1");
  assert.equal(problemFrontendId({ questionFrontendId: 2 }), "2");
  assert.equal(problemFrontendId({ frontendQuestionId: "", questionFrontendId: "3" }), "3");
  assert.equal(problemFrontendId(null), "?");
});

test("display text keeps useful head and tail context within a Unicode-safe bound", () => {
  const value = `${"A".repeat(100)}${"😀".repeat(100)}${"Z".repeat(100)}`;
  const truncated = truncateDisplayText(value, 80);
  assert.ok(Array.from(truncated).length <= 80);
  assert.match(truncated, /^A+/);
  assert.match(truncated, /result truncated/);
  assert.match(truncated, /Z+$/);
  assert.doesNotMatch(truncated, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  assert.equal(truncateDisplayText("short", 80), "short");
  assert.equal(MAX_RESULT_TEXT_CHARS, 24_000);
});
