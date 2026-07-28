import { MAX_RESULT_TEXT_CHARS, truncateDisplayText } from "./content.js";

export const OFFICIAL_JUDGE_TIMEOUT_MS = 60_000;
const MAX_JUDGE_DETAIL_CHARS = 5_000;
const MAX_JUDGE_STATUS_CHARS = 500;

export function judgeRequestTimeout(deadline, now = Date.now(), requestLimit = 20_000) {
  return Math.max(0, Math.min(requestLimit, deadline - now));
}

export function judgePollDelay(deadline, now = Date.now(), pollInterval = 1_000) {
  return Math.max(0, Math.min(pollInterval, deadline - now));
}

export function waitForJudgePoll(milliseconds, signal = null, runtime = globalThis) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Official judge polling cancelled"));
      return;
    }
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      runtime.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("Official judge polling cancelled"));
    const timer = runtime.setTimeout(finish, Math.max(0, milliseconds));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function isPendingJudgeResult(result) {
  const state = String(result?.state ?? "").trim().toUpperCase();
  if (["PENDING", "STARTED"].includes(state)) return true;
  if (state) return false;
  return result?.status_code == null
    && !result?.status_msg
    && !result?.compile_error
    && !result?.full_compile_error
    && !result?.runtime_error
    && !result?.full_runtime_error;
}

export function isAcceptedJudgeResult(result) {
  const statusCode = Number(result?.status_code);
  const statusMessage = String(result?.status_msg ?? "").trim().toLowerCase();
  const comparison = String(result?.compare_result ?? "").trim().toLowerCase();
  return statusCode === 10
    || statusMessage === "accepted"
    || (result?.run_success === true && ["1", "true"].includes(comparison));
}

export function summarizeJudgeResult(result, submit = false) {
  if (isAcceptedJudgeResult(result)) {
    return {
      accepted: true,
      message: [result?.status_msg || (submit ? "Accepted" : "Finished"), result?.runtime, result?.memory]
        .filter(Boolean)
        .map((value) => displayValue(value, MAX_JUDGE_STATUS_CHARS))
        .join(" - "),
    };
  }

  const details = [];
  appendDetail(details, "Compile error", result?.full_compile_error || result?.compile_error);
  appendDetail(details, "Runtime error", result?.full_runtime_error || result?.runtime_error);
  appendDetail(details, "Input", result?.last_testcase);
  appendDetail(details, "Expected", result?.expected_output);
  appendDetail(details, "Output", result?.code_output);
  const status = displayValue(result?.status_msg || "Judge failed", MAX_JUDGE_STATUS_CHARS);
  const message = details.length > 0 ? `${status}\n${details.join("\n")}` : status;
  return {
    accepted: false,
    message: truncateDisplayText(message, MAX_RESULT_TEXT_CHARS),
  };
}

function appendDetail(details, label, value) {
  const text = displayValue(value, MAX_JUDGE_DETAIL_CHARS).trim();
  if (text) details.push(`${label}: ${text}`);
}

function displayValue(value, maximum = MAX_RESULT_TEXT_CHARS) {
  if (value == null) return "";
  if (typeof value === "string") return truncateDisplayText(value, maximum);
  try {
    return truncateDisplayText(JSON.stringify(value), maximum);
  } catch {
    return truncateDisplayText(String(value), maximum);
  }
}
