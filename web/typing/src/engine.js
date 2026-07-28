export function splitCharacters(value) {
  return Array.from(String(value ?? "").normalize("NFC"));
}

export function createSession(targetText, now = 0, options = {}) {
  const target = splitCharacters(targetText);
  if (target.length === 0) throw new Error("target text must not be empty");
  return {
    target,
    typed: [],
    mode: options.mode ?? "quote",
    limit: options.limit ?? null,
    difficulty: options.difficulty ?? "normal",
    startedAt: null,
    updatedAt: now,
    completedAt: null,
    completedReason: null,
    pausedAt: null,
    keystrokes: 0,
    errors: 0,
    timeline: [],
    errorPositions: [],
    lastInputAt: null,
  };
}

export function updateSession(session, nextValue, now = Date.now(), input = {}) {
  if (session.pausedAt !== null) session = resumeSession(session, now);
  const next = splitCharacters(nextValue).slice(0, session.target.length);
  const previous = session.typed;
  const common = commonPrefixLength(previous, next);
  let keystrokes = session.keystrokes;
  let errors = session.errors;
  let lastInputAt = session.lastInputAt;
  const timeline = [...session.timeline];
  const errorPositions = new Set(session.errorPositions);
  const automaticSuffix = Math.max(0, Number(input.automaticSuffix) || 0);
  let masterFailed = false;

  if (next.length > common) {
    for (let index = common; index < next.length; index += 1) {
      const automatic = index >= next.length - automaticSuffix;
      if (automatic) continue;
      const correct = next[index] === session.target[index];
      const delayMs = lastInputAt === null ? 0 : Math.max(0, now - lastInputAt);
      keystrokes += 1;
      if (!correct) {
        errors += 1;
        errorPositions.add(index);
        masterFailed ||= session.difficulty === "master";
      }
      timeline.push({
        at: now,
        index,
        character: next[index],
        expected: session.target[index],
        correct,
        delayMs,
      });
      lastInputAt = now;
    }
  }

  const startedAt = session.startedAt ?? (next.length > 0 ? now : null);
  const targetComplete = next.length === session.target.length
    && next.every((character, index) => character === session.target[index]);
  const timeComplete = isTimedOut({ ...session, startedAt }, now);
  const complete = targetComplete || timeComplete || masterFailed;

  return {
    ...session,
    typed: next,
    startedAt,
    updatedAt: now,
    completedAt: complete ? (session.completedAt ?? now) : null,
    completedReason: complete
      ? (session.completedReason ?? (masterFailed ? "master" : timeComplete ? "time" : "target"))
      : null,
    keystrokes,
    errors,
    timeline,
    errorPositions: [...errorPositions].sort((left, right) => left - right),
    lastInputAt,
  };
}

export function refreshSession(session, now = Date.now()) {
  if (session.pausedAt !== null) return { ...session, updatedAt: now };
  if (session.completedAt !== null || !isTimedOut(session, now)) {
    return { ...session, updatedAt: now };
  }
  return {
    ...session,
    updatedAt: now,
    completedAt: now,
    completedReason: "time",
  };
}

export function sessionMetrics(session, now = Date.now()) {
  const elapsedMs = session.startedAt === null
    ? 0
    : Math.max(0, (session.completedAt ?? session.pausedAt ?? now) - session.startedAt);
  const correctPositions = session.typed.reduce(
    (total, character, index) => total + Number(character === session.target[index]),
    0,
  );
  const minutes = Math.max(elapsedMs / 60000, 1 / 60);
  const accuracy = session.keystrokes === 0
    ? 100
    : Math.max(0, ((session.keystrokes - session.errors) / session.keystrokes) * 100);
  const remainingMs = session.mode === "time" && Number.isFinite(session.limit)
    ? Math.max(0, session.limit * 1000 - elapsedMs)
    : null;
  const incorrectPositions = session.typed.reduce(
    (total, character, index) => total + Number(character !== session.target[index]),
    0,
  );
  return {
    elapsedMs,
    remainingMs,
    correctPositions,
    incorrectPositions,
    charactersTyped: session.typed.length,
    keystrokes: session.keystrokes,
    errors: session.errors,
    progress: correctPositions / session.target.length,
    wpm: Math.round((correctPositions / 5) / minutes),
    rawWpm: Math.round((session.keystrokes / 5) / minutes),
    accuracy: Math.round(accuracy),
    complete: session.completedAt !== null,
  };
}

export function characterState(session, index) {
  if (index >= session.typed.length) return index === session.typed.length ? "current" : "pending";
  return session.typed[index] === session.target[index] ? "correct" : "incorrect";
}

export function pauseSession(session, now = Date.now()) {
  if (session.startedAt === null || session.completedAt !== null || session.pausedAt !== null) return session;
  return { ...session, pausedAt: now, updatedAt: now };
}

export function resumeSession(session, now = Date.now()) {
  if (session.pausedAt === null) return session;
  const shift = Math.max(0, now - session.pausedAt);
  return {
    ...session,
    startedAt: session.startedAt === null ? null : session.startedAt + shift,
    updatedAt: now,
    pausedAt: null,
    lastInputAt: session.lastInputAt === null ? null : session.lastInputAt + shift,
    timeline: session.timeline.map((entry) => ({ ...entry, at: entry.at + shift })),
  };
}

export function sessionAnalysis(session, now = Date.now()) {
  const metrics = sessionMetrics(session, now);
  const manual = session.timeline.filter((entry) => !entry.automatic);
  const byCharacter = new Map();
  const byLine = new Map();
  const lineByPosition = lineIndexByPosition(session.target);

  for (const entry of manual) {
    const character = printableCharacter(entry.expected);
    const characterStat = byCharacter.get(character) ?? {
      character,
      attempts: 0,
      errors: 0,
      totalDelayMs: 0,
      samples: 0,
    };
    characterStat.attempts += 1;
    characterStat.errors += Number(!entry.correct);
    if (entry.delayMs > 0) {
      characterStat.totalDelayMs += entry.delayMs;
      characterStat.samples += 1;
    }
    byCharacter.set(character, characterStat);

    const lineIndex = lineByPosition[entry.index] ?? 0;
    const line = byLine.get(lineIndex) ?? { lineIndex, correct: 0, startedAt: entry.at, endedAt: entry.at };
    line.correct += Number(entry.correct);
    line.startedAt = Math.min(line.startedAt, entry.at);
    line.endedAt = Math.max(line.endedAt, entry.at);
    byLine.set(lineIndex, line);
  }

  const characterStats = [...byCharacter.values()].map((entry) => ({
    ...entry,
    averageDelayMs: entry.samples ? Math.round(entry.totalDelayMs / entry.samples) : 0,
    errorRate: entry.attempts ? entry.errors / entry.attempts : 0,
  }));
  const slowestCharacters = [...characterStats]
    .filter((entry) => entry.samples > 0)
    .sort((left, right) => right.averageDelayMs - left.averageDelayMs || right.errors - left.errors)
    .slice(0, 5);
  const errorDistribution = [...characterStats]
    .filter((entry) => entry.errors > 0)
    .sort((left, right) => right.errors - left.errors || right.errorRate - left.errorRate);
  const lineBursts = [...byLine.values()].map((line) => {
    const minutes = Math.max((line.endedAt - line.startedAt) / 60000, 1 / 60);
    return { lineIndex: line.lineIndex, wpm: Math.round((line.correct / 5) / minutes) };
  });
  const speedSamples = buildSpeedSamples(session, metrics.elapsedMs);
  const wpms = speedSamples.map((sample) => sample.wpm).filter((value) => value > 0);
  const mean = wpms.length ? wpms.reduce((sum, value) => sum + value, 0) / wpms.length : 0;
  const deviation = wpms.length
    ? Math.sqrt(wpms.reduce((sum, value) => sum + (value - mean) ** 2, 0) / wpms.length)
    : 0;
  const consistency = mean > 0 ? Math.max(0, Math.round((1 - deviation / mean) * 100)) : 100;
  const positionSamples = new Map(manual.map((entry) => [entry.index, entry]));
  const heatmap = session.target.map((character, index) => {
    const sample = positionSamples.get(index);
    return {
      index,
      character: printableCharacter(character),
      delayMs: sample?.delayMs ?? 0,
      error: session.errorPositions.includes(index),
    };
  });

  return {
    ...metrics,
    consistency,
    speedSamples,
    heatmap,
    characterStats,
    slowestCharacters,
    errorDistribution,
    lineBursts,
    fastestLineWpm: Math.max(0, ...lineBursts.map((line) => line.wpm)),
    errorLineIndices: errorLineIndices(session),
  };
}

export function errorLineIndices(session) {
  const lines = lineIndexByPosition(session.target);
  return [...new Set(session.errorPositions.map((index) => lines[index] ?? 0))].sort((a, b) => a - b);
}

export function extractLines(targetText, lineIndices) {
  const lines = String(targetText).split("\n");
  return [...new Set(lineIndices)]
    .filter((index) => index >= 0 && index < lines.length)
    .map((index) => lines[index])
    .join("\n");
}

function buildSpeedSamples(session, elapsedMs) {
  if (session.startedAt === null || elapsedMs <= 0) return [];
  const finalSecond = Math.max(1, Math.ceil(elapsedMs / 1000));
  const samples = [];
  for (let second = 1; second <= finalSecond; second += 1) {
    const cutoff = session.startedAt + second * 1000;
    const entries = session.timeline.filter((entry) => entry.at <= cutoff);
    const correct = entries.filter((entry) => entry.correct).length;
    const minutes = second / 60;
    samples.push({
      second,
      wpm: Math.round((correct / 5) / minutes),
      rawWpm: Math.round((entries.length / 5) / minutes),
    });
  }
  return samples;
}

function lineIndexByPosition(target) {
  const result = [];
  let line = 0;
  target.forEach((character, index) => {
    result[index] = line;
    if (character === "\n") line += 1;
  });
  return result;
}

function printableCharacter(character) {
  if (character === " ") return "space";
  if (character === "\n") return "enter";
  if (character === "\t") return "tab";
  return character;
}

function commonPrefixLength(left, right) {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}

function isTimedOut(session, now) {
  return session.mode === "time"
    && Number.isFinite(session.limit)
    && session.startedAt !== null
    && now - session.startedAt >= session.limit * 1000;
}
