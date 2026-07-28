import test from "node:test";
import assert from "node:assert/strict";

import {
  OFFICIAL_JUDGE_TIMEOUT_MS,
  isAcceptedJudgeResult,
  isPendingJudgeResult,
  judgePollDelay,
  judgeRequestTimeout,
  summarizeJudgeResult,
  waitForJudgePoll,
} from "../src/judge.js";

test("official judge timing is bounded by one wall-clock deadline", () => {
  assert.equal(OFFICIAL_JUDGE_TIMEOUT_MS, 60_000);
  assert.equal(judgeRequestTimeout(100_000, 70_000), 20_000);
  assert.equal(judgeRequestTimeout(100_000, 95_500), 4_500);
  assert.equal(judgeRequestTimeout(100_000, 100_001), 0);
  assert.equal(judgePollDelay(100_000, 98_750), 1_000);
  assert.equal(judgePollDelay(100_000, 99_650), 350);
  assert.equal(judgePollDelay(100_000, 100_001), 0);
});

test("official judge polling releases its timer and abort listener when cancelled", async () => {
  const controller = new AbortController();
  const timers = new Map();
  let timerId = 0;
  const runtime = {
    setTimeout(callback) {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const wait = waitForJudgePoll(1_000, controller.signal, runtime);
  assert.equal(timers.size, 1);
  controller.abort();
  await assert.rejects(wait, /polling cancelled/);
  assert.equal(timers.size, 0);
});

test("official judge polling does not allocate a timer after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  let timerAllocated = false;
  await assert.rejects(
    waitForJudgePoll(1_000, controller.signal, {
      setTimeout() {
        timerAllocated = true;
      },
      clearTimeout() {},
    }),
    /polling cancelled/,
  );
  assert.equal(timerAllocated, false);
});

test("judge polling waits for pending, started, and incomplete responses", () => {
  assert.equal(isPendingJudgeResult({ state: "PENDING" }), true);
  assert.equal(isPendingJudgeResult({ state: "started" }), true);
  assert.equal(isPendingJudgeResult({}), true);
  assert.equal(isPendingJudgeResult({ state: "SUCCESS", status_code: 10 }), false);
  assert.equal(isPendingJudgeResult({ status_msg: "Wrong Answer" }), false);
});

test("run_success alone never turns a wrong answer into Accepted", () => {
  const result = {
    state: "SUCCESS",
    status_code: 11,
    status_msg: "Wrong Answer",
    run_success: true,
    compare_result: "0",
    last_testcase: "[2,7,11,15]\n9",
    expected_output: "[0,1]",
    code_output: "[1,0]",
  };
  assert.equal(isAcceptedJudgeResult(result), false);
  assert.deepEqual(summarizeJudgeResult(result), {
    accepted: false,
    message: "Wrong Answer\nInput: [2,7,11,15]\n9\nExpected: [0,1]\nOutput: [1,0]",
  });
});

test("accepted results support official status and comparison forms", () => {
  assert.equal(isAcceptedJudgeResult({ status_code: 10 }), true);
  assert.equal(isAcceptedJudgeResult({ status_msg: "Accepted" }), true);
  assert.equal(isAcceptedJudgeResult({ run_success: true, compare_result: "1" }), true);
  assert.deepEqual(
    summarizeJudgeResult({ status_msg: "Accepted", runtime: "3 ms", memory: "18.2 MB" }, true),
    { accepted: true, message: "Accepted - 3 ms - 18.2 MB" },
  );
});

test("compile and runtime failures prefer complete official diagnostics", () => {
  assert.deepEqual(
    summarizeJudgeResult({
      status_msg: "Compile Error",
      compile_error: "short",
      full_compile_error: "line 4: expected semicolon",
    }),
    { accepted: false, message: "Compile Error\nCompile error: line 4: expected semicolon" },
  );
  assert.deepEqual(
    summarizeJudgeResult({
      status_msg: "Runtime Error",
      runtime_error: "short",
      full_runtime_error: "AddressSanitizer: heap-buffer-overflow",
      last_testcase: [1, 2, 3],
    }),
    {
      accepted: false,
      message: "Runtime Error\nRuntime error: AddressSanitizer: heap-buffer-overflow\nInput: [1,2,3]",
    },
  );
});

test("large official diagnostics retain bounded head and tail context", () => {
  const compileError = `compiler-start\n${"x".repeat(20_000)}\ncompiler-end`;
  const outcome = summarizeJudgeResult({
    status_msg: "Compile Error",
    full_compile_error: compileError,
    last_testcase: `input-start-${"😀".repeat(8_000)}-input-end`,
  });
  assert.equal(outcome.accepted, false);
  assert.ok(Array.from(outcome.message).length <= 24_000);
  assert.match(outcome.message, /compiler-start/);
  assert.match(outcome.message, /compiler-end/);
  assert.match(outcome.message, /input-start/);
  assert.match(outcome.message, /input-end/);
  assert.match(outcome.message, /result truncated/);
});
