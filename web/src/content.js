export const MAX_RESULT_TEXT_CHARS = 24_000;

export function truncateDisplayText(value, maximum = MAX_RESULT_TEXT_CHARS) {
  const text = String(value ?? "");
  const limit = Number.isFinite(maximum) ? Math.max(32, Math.floor(maximum)) : MAX_RESULT_TEXT_CHARS;
  if (text.length <= limit) return text;
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  const marker = "\n... result truncated ...\n";
  const markerLength = Array.from(marker).length;
  const available = Math.max(0, limit - markerLength);
  const headLength = Math.ceil(available * 0.75);
  const tailLength = available - headLength;
  return `${characters.slice(0, headLength).join("")}${marker}${characters.slice(-tailLength).join("")}`;
}

export function normalizeProblemText(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function problemFrontendId(problem) {
  for (const value of [problem?.frontendQuestionId, problem?.questionFrontendId]) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return "?";
}
