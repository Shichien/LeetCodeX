export function canonicalizeResult(value, comparison = "exact") {
  if (comparison === "unordered-array" && Array.isArray(value)) {
    return [...value].sort(compareJson);
  }
  if (comparison === "unordered-groups" && Array.isArray(value)) {
    return value
      .map((group) => Array.isArray(group) ? [...group].sort(compareJson) : group)
      .sort(compareJson);
  }
  return value;
}

export function resultsEqual(actual, expected, comparison = "exact") {
  return JSON.stringify(canonicalizeResult(actual, comparison))
    === JSON.stringify(canonicalizeResult(expected, comparison));
}

export function runSolution(
  code,
  entry,
  tests,
  comparison = "exact",
  timeoutMs = 2000,
  runtime = globalThis,
  signal = null,
) {
  return new Promise((resolve) => {
    let worker = null;
    let url = null;
    let timer = null;
    let abortHandler = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (abortHandler !== null) signal?.removeEventListener("abort", abortHandler);
      if (timer !== null) runtime.clearTimeout(timer);
      worker?.terminate();
      if (url !== null) runtime.URL.revokeObjectURL(url);
      resolve(result);
    };
    try {
      if (signal?.aborted) {
        finish({ ok: false, cancelled: true, error: "Execution cancelled" });
        return;
      }
      const source = buildWorkerSource(code, entry);
      url = runtime.URL.createObjectURL(new runtime.Blob([source], { type: "text/javascript" }));
      worker = new runtime.Worker(url);
      timer = runtime.setTimeout(
        () => finish({ ok: false, error: `Execution timed out after ${timeoutMs}ms` }),
        timeoutMs,
      );
      worker.onmessage = ({ data }) => finish(data);
      worker.onerror = (event) => {
        event.preventDefault?.();
        finish({ ok: false, error: event.message || "Worker failed" });
      };
      abortHandler = () => finish({ ok: false, cancelled: true, error: "Execution cancelled" });
      signal?.addEventListener("abort", abortHandler, { once: true });
      worker.postMessage({ tests, comparison });
    } catch (error) {
      finish({ ok: false, error: executionErrorMessage(error) });
    }
  });
}

export function buildWorkerSource(code, entry) {
  return `
      const __leetcodexCompareJson = (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right));
      const __leetcodexCanonicalize = (value, mode) => {
        if (mode === "unordered-array" && Array.isArray(value)) return [...value].sort(__leetcodexCompareJson);
        if (mode === "unordered-groups" && Array.isArray(value)) {
          return value.map((group) => Array.isArray(group) ? [...group].sort(__leetcodexCompareJson) : group).sort(__leetcodexCompareJson);
        }
        return value;
      };
      const __leetcodexEqual = (actual, expected, mode) => JSON.stringify(__leetcodexCanonicalize(actual, mode)) === JSON.stringify(__leetcodexCanonicalize(expected, mode));
      const __leetcodexSolution = (() => {
        ${code}
        if (typeof ${entry} === "function") return ${entry};
        if (typeof Solution === "function") {
          const instance = new Solution();
          return typeof instance[${JSON.stringify(entry)}] === "function" ? instance[${JSON.stringify(entry)}].bind(instance) : null;
        }
        return null;
      })();
      self.onmessage = async ({ data }) => {
        try {
          if (typeof __leetcodexSolution !== "function") throw new Error("Expected ${entry} or Solution.${entry}");
          const results = [];
          for (const test of data.tests) {
            const args = structuredClone(test.args);
            const actual = await __leetcodexSolution(...args);
            results.push({ passed: __leetcodexEqual(actual, test.expected, data.comparison), actual, expected: test.expected });
          }
          self.postMessage({ ok: true, results });
        } catch (error) {
          self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      };
    `;
}

function compareJson(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function executionErrorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error || "Worker failed");
}
