import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RESULT_TEXT_CHARS,
  normalizeProblemText,
  problemFrontendId,
  serializeProblemNode,
  truncateDisplayText,
} from "../src/content.js";

function text(value) {
  return { nodeType: 3, nodeValue: value };
}

function element(tagName, ...childNodes) {
  const textContent = childNodes.map((child) => child.textContent ?? child.nodeValue ?? "").join("");
  return { nodeType: 1, tagName, childNodes, textContent };
}

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

test("problem markup preserves paragraphs and marks inline code", () => {
  const body = element(
    "body",
    element("p", text("Return "), element("code", text("[3, 4, 5]")), text(" from the service.")),
    element("p", text("Then persist the result.")),
  );
  assert.equal(
    normalizeProblemText(serializeProblemNode(body)),
    "Return `[3, 4, 5]` from the service.\n\nThen persist the result.",
  );
});

test("problem markup keeps block code separate from inline code markers", () => {
  const body = element(
    "body",
    element("p", text("Example:")),
    element("pre", text("nums = [1, 2, 3]")),
    element("ul", element("li", text("Return the first match")), element("li", text("Otherwise return -1"))),
  );
  assert.equal(
    normalizeProblemText(serializeProblemNode(body)),
    "Example:\n\nnums = [1, 2, 3]\n\n- Return the first match\n- Otherwise return -1",
  );
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
