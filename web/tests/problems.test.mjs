import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localStarter } from "../src/templates.js";

const problems = JSON.parse(
  await readFile(new URL("../src/problems.json", import.meta.url), "utf8"),
);

test("problem bank covers all difficulty levels", () => {
  assert.ok(problems.length >= 12);
  assert.deepEqual(
    [...new Set(problems.map((problem) => problem.difficulty))].sort(),
    ["easy", "hard", "medium"],
  );
});

test("every problem has runnable local tests", () => {
  const ids = new Set();
  for (const problem of problems) {
    assert.ok(!ids.has(problem.id), `duplicate id: ${problem.id}`);
    ids.add(problem.id);
    assert.match(problem.entry, /^[A-Za-z_$][\w$]*$/);
    assert.match(problem.starter, new RegExp(`function\\s+${problem.entry}\\s*\\(`));
    assert.ok(problem.examples.length >= 1, `${problem.id} needs an example`);
    assert.ok(problem.tests.length >= 4, `${problem.id} needs at least four tests`);
    assert.ok(problem.tests.some((item) => item.hidden), `${problem.id} needs hidden tests`);
  }
});

test("offline starters use LeetCode-style language frameworks", () => {
  const twoSum = problems.find((problem) => problem.id === "two-sum");
  const groups = problems.find((problem) => problem.id === "group-anagrams");
  const intervals = problems.find((problem) => problem.id === "merge-intervals");

  assert.match(localStarter(twoSum, "javascript"), /var twoSum = function\(nums, target\)/);
  assert.match(localStarter(twoSum, "java"), /public int\[\] twoSum\(int\[\] nums, int target\)/);
  assert.match(localStarter(twoSum, "python3"), /class Solution:[\s\S]*def twoSum\(self, nums, target\)/);
  assert.match(localStarter(twoSum, "rust"), /pub fn two_sum\(nums: Vec<i32>, target: i32\) -> Vec<i32>/);
  assert.match(localStarter(groups, "java"), /String\[\]\[\] groupAnagrams\(String\[\] strs\)/);
  assert.doesNotMatch(localStarter(twoSum, "cpp"), /#include|using namespace|runtime_error/);
  assert.match(localStarter(intervals, "c"), /int\* intervalsColSize/);
  assert.match(localStarter(intervals, "c"), /int\*\* returnColumnSizes/);
  assert.doesNotMatch(localStarter(groups, "c"), /strsColSize/);
});
