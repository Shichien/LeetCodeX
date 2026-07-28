const DEFAULT_LIMIT = 100;

export function favoriteSnippets(profile, language) {
  if (!profile || typeof profile !== "object" || typeof language !== "string") return [];
  const snippets = profile[language];
  if (!Array.isArray(snippets)) return [];
  return [...new Set(snippets.filter((snippet) => typeof snippet === "string" && snippet.trim().length > 0))];
}

export function isFavorite(profile, language, snippet) {
  return typeof snippet === "string" && favoriteSnippets(profile, language).includes(snippet);
}

export function toggleFavorite(profile, language, snippet, limit = DEFAULT_LIMIT) {
  const current = favoriteSnippets(profile, language);
  if (typeof snippet !== "string" || snippet.trim().length === 0) return { ...profile };
  const next = current.includes(snippet)
    ? current.filter((item) => item !== snippet)
    : [snippet, ...current].slice(0, normalizedLimit(limit));
  return { ...(profile && typeof profile === "object" ? profile : {}), [language]: next };
}

function normalizedLimit(limit) {
  return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
}
