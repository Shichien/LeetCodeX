export const CORPUS_TOPICS = [
  { id: "binary-search", title: "Binary search", label: "binary", category: "algorithm" },
  { id: "two-pointers", title: "Two pointers", label: "two ptr", category: "algorithm" },
  { id: "sliding-window", title: "Sliding window", label: "window", category: "algorithm" },
  { id: "breadth-first-search", title: "Breadth-first search", label: "bfs", category: "algorithm" },
  { id: "dynamic-programming", title: "Dynamic programming", label: "dp", category: "algorithm" },
  { id: "union-find", title: "Union find", label: "union", category: "algorithm" },
  { id: "order-management", title: "Order management", label: "orders", category: "business" },
  { id: "payment-processing", title: "Payment processing", label: "payments", category: "business" },
  { id: "inventory-fulfillment", title: "Inventory fulfillment", label: "inventory", category: "business" },
  { id: "identity-access", title: "Identity and access", label: "identity", category: "business" },
  { id: "query-pagination", title: "Query and pagination", label: "query", category: "business" },
  { id: "reporting-analytics", title: "Reporting and analytics", label: "reports", category: "business" },
];

export function snippetCategory(snippet) {
  return topicForSnippet(snippet)?.category ?? "unknown";
}

export function snippetTopic(snippet) {
  return topicForSnippet(snippet)?.id ?? "unknown";
}

export function filterCorpusSnippets(snippets, category = "mix", topic = "all") {
  if (!Array.isArray(snippets)) return [];
  const filtered = snippets.filter((snippet) => {
    const item = topicForSnippet(snippet);
    if (!item) return false;
    return (category === "mix" || item.category === category) && (topic === "all" || item.id === topic);
  });
  return filtered.length > 0 ? filtered : snippets;
}

export function topicsForCategory(category = "mix") {
  return CORPUS_TOPICS.filter((topic) => category === "mix" || topic.category === category);
}

export function closestSnippetsByWordCount(snippets, target, limit = 24) {
  const desired = Math.max(1, Number(target) || 1);
  return [...snippets]
    .map((snippet) => ({ snippet, distance: Math.abs(wordCount(snippet) - desired) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.snippet);
}

function wordCount(value) {
  return String(value).trim().split(/\s+/).filter(Boolean).length;
}

function topicForSnippet(snippet) {
  const firstLine = String(snippet).split("\n", 1)[0];
  return CORPUS_TOPICS.find((topic) => firstLine.includes(topic.title)) ?? null;
}
