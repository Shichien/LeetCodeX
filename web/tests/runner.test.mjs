import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeResult, resultsEqual, runSolution } from "../src/runner.js";

test("exact comparison preserves order", () => {
  assert.equal(resultsEqual([1, 2], [1, 2]), true);
  assert.equal(resultsEqual([2, 1], [1, 2]), false);
});

test("unordered group comparison normalizes groups and values", () => {
  const actual = [["tea", "eat"], ["bat"]];
  const expected = [["bat"], ["eat", "tea"]];
  assert.equal(resultsEqual(actual, expected, "unordered-groups"), true);
  assert.deepEqual(canonicalizeResult(actual, "unordered-groups"), [["bat"], ["eat", "tea"]]);
});

test("worker construction failures resolve safely and revoke the Blob URL", async () => {
  const runtime = fakeWorkerRuntime({ constructError: new Error("Worker construction blocked") });
  assert.deepEqual(await runSolution("function solve() {}", "solve", [], "exact", 2000, runtime), {
    ok: false,
    error: "Worker construction blocked",
  });
  assert.equal(runtime.state.revoked, 1);
  assert.equal(runtime.state.terminated, 0);
  assert.equal(runtime.state.cleared, 0);
});

test("postMessage failures terminate the worker, clear the timer, and revoke the URL", async () => {
  const runtime = fakeWorkerRuntime({ postError: new Error("Worker message blocked") });
  assert.deepEqual(await runSolution("function solve() {}", "solve", [], "exact", 2000, runtime), {
    ok: false,
    error: "Worker message blocked",
  });
  assert.equal(runtime.state.revoked, 1);
  assert.equal(runtime.state.terminated, 1);
  assert.equal(runtime.state.cleared, 1);
});

test("worker errors are consumed and clean up every execution resource", async () => {
  const runtime = fakeWorkerRuntime({ workerError: "Unexpected token" });
  assert.deepEqual(await runSolution("invalid code", "solve", [], "exact", 2000, runtime), {
    ok: false,
    error: "Unexpected token",
  });
  assert.equal(runtime.state.prevented, 1);
  assert.equal(runtime.state.revoked, 1);
  assert.equal(runtime.state.terminated, 1);
  assert.equal(runtime.state.cleared, 1);
});

test("an already-aborted run does not allocate Worker resources", async () => {
  const runtime = fakeWorkerRuntime();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await runSolution("function solve() {}", "solve", [], "exact", 2000, runtime, controller.signal),
    { ok: false, cancelled: true, error: "Execution cancelled" },
  );
  assert.equal(runtime.state.created, 0);
  assert.equal(runtime.state.revoked, 0);
  assert.equal(runtime.state.terminated, 0);
});

test("aborting an active run immediately releases every Worker resource", async () => {
  const runtime = fakeWorkerRuntime();
  const controller = new AbortController();
  const execution = runSolution(
    "function solve() { while (true) {} }",
    "solve",
    [],
    "exact",
    2000,
    runtime,
    controller.signal,
  );
  controller.abort();
  assert.deepEqual(await execution, { ok: false, cancelled: true, error: "Execution cancelled" });
  assert.equal(runtime.state.created, 1);
  assert.equal(runtime.state.revoked, 1);
  assert.equal(runtime.state.terminated, 1);
  assert.equal(runtime.state.cleared, 1);
});

function fakeWorkerRuntime({ constructError = null, postError = null, workerError = null } = {}) {
  const state = { cleared: 0, created: 0, prevented: 0, revoked: 0, terminated: 0 };
  class FakeBlob {}
  class FakeWorker {
    constructor() {
      if (constructError) throw constructError;
      state.created += 1;
    }

    terminate() {
      state.terminated += 1;
    }

    postMessage() {
      if (postError) throw postError;
      if (workerError) {
        queueMicrotask(() => this.onerror({
          message: workerError,
          preventDefault: () => { state.prevented += 1; },
        }));
      }
    }
  }
  return {
    Blob: FakeBlob,
    Worker: FakeWorker,
    URL: {
      createObjectURL: () => "blob:leetcodex-test",
      revokeObjectURL: () => { state.revoked += 1; },
    },
    clearTimeout: () => { state.cleared += 1; },
    setTimeout: () => 1,
    state,
  };
}
