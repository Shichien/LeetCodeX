export function dailyDateKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function normalizeDailyProgress(value) {
  if (!value || typeof value !== "object") return { date: null, count: 0, streak: 0 };
  const date = typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value.date : null;
  const count = positiveInteger(value.count);
  const streak = positiveInteger(value.streak);
  return date ? { date, count, streak } : { date: null, count: 0, streak: 0 };
}

export function recordDailyCompletion(progress, now = new Date()) {
  const date = dailyDateKey(now);
  if (!date) return normalizeDailyProgress(progress);
  const current = normalizeDailyProgress(progress);
  if (current.date === date) return { ...current, count: current.count + 1 };
  return {
    date,
    count: 1,
    streak: isPreviousDay(current.date, date) ? Math.max(1, current.streak) + 1 : 1,
  };
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function isPreviousDay(previous, next) {
  if (!previous || !next) return false;
  const previousDate = new Date(`${previous}T12:00:00`);
  previousDate.setDate(previousDate.getDate() + 1);
  return dailyDateKey(previousDate) === next;
}
