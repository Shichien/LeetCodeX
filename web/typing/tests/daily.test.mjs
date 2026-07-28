import test from "node:test";
import assert from "node:assert/strict";
import {
  dailyDateKey,
  normalizeDailyProgress,
  recordDailyCompletion,
} from "../src/daily.js";

test("dailyDateKey uses the local calendar date", () => {
  assert.equal(dailyDateKey(new Date(2026, 6, 28, 23, 59)), "2026-07-28");
  assert.equal(dailyDateKey("not a date"), null);
});

test("daily progress ignores malformed persisted data", () => {
  assert.deepEqual(normalizeDailyProgress({ date: "today", count: -1, streak: "2" }), {
    date: null,
    count: 0,
    streak: 0,
  });
});

test("daily progress increments within the same day", () => {
  const first = recordDailyCompletion({}, new Date(2026, 6, 28, 9));
  const second = recordDailyCompletion(first, new Date(2026, 6, 28, 17));
  assert.deepEqual(second, { date: "2026-07-28", count: 2, streak: 1 });
});

test("daily progress grows a consecutive streak and resets after a gap", () => {
  const first = { date: "2026-07-26", count: 3, streak: 4 };
  const continued = recordDailyCompletion(first, new Date(2026, 6, 27, 8));
  assert.deepEqual(continued, { date: "2026-07-27", count: 1, streak: 5 });
  const reset = recordDailyCompletion(continued, new Date(2026, 6, 30, 8));
  assert.deepEqual(reset, { date: "2026-07-30", count: 1, streak: 1 });
});
