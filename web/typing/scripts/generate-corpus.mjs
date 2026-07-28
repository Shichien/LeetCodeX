import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(here, "..", "src");

const LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "java",
  "go",
  "rust",
  "sql",
  "csharp",
  "php",
];

const ALGORITHMS = [
  {
    id: "binary-search",
    title: "Binary search",
    scenarios: [
      "find an exact order id", "find the first available time slot", "find an insertion index",
      "find the lower price bound", "find the upper price bound", "find a version number",
      "find a rotated array pivot", "find a square-root floor", "find a peak element",
      "find the first failed build", "find the minimum capacity", "find the shipping deadline",
      "find a median partition", "find the closest timestamp", "find a duplicate boundary",
      "find the kth missing number", "find a monotonic threshold", "find a sorted matrix row",
      "find a range start", "find a range end",
    ],
  },
  {
    id: "two-pointers",
    title: "Two pointers",
    scenarios: [
      "find two values with a target sum", "deduplicate a sorted array", "merge sorted event streams",
      "check a palindrome", "move zero values to the end", "sort three categories",
      "find a container with max area", "trap rain water", "reverse a character buffer",
      "compare backspace strings", "find a three-value sum", "partition positive and negative values",
      "find the closest pair sum", "remove a target value", "intersect sorted lists",
      "validate a subsequence", "compress repeated values", "pair boats by capacity",
      "find a sorted square array", "reorder a linked list",
    ],
  },
  {
    id: "sliding-window",
    title: "Sliding window",
    scenarios: [
      "find the longest unique substring", "find a minimum cover substring", "find a fixed window maximum",
      "count anagram windows", "find a maximum average", "find a fruit basket range",
      "find the longest replacement range", "count subarrays with target sum", "find a minimum length sum",
      "find a permutation in a string", "find the longest ones streak", "count distinct values per window",
      "find a max card score", "find the shortest unsorted window", "find the longest vowel range",
      "find a maximum product window", "count good binary substrings", "find a longest bounded range",
      "find a minimum window subsequence", "find a fixed-size distinct count",
    ],
  },
  {
    id: "breadth-first-search",
    title: "Breadth-first search",
    scenarios: [
      "find the shortest grid path", "count connected islands", "fill a surrounded region",
      "find tree level order", "find word ladder steps", "find nearest zero distance",
      "find a rotting time", "clone a graph", "check bipartite groups",
      "find course semesters", "find a maze exit", "find a minimum knight path",
      "find the deepest leaves", "find a multi-source distance", "serialize a tree by levels",
      "find an employee hierarchy", "find a lock combination", "find a bus transfer count",
      "find a shortest bridge", "find a safe-state traversal",
    ],
  },
  {
    id: "dynamic-programming",
    title: "Dynamic programming",
    scenarios: [
      "solve zero-one knapsack", "find a longest common subsequence", "find an edit distance",
      "count coin combinations", "find a minimum coin count", "find a house robber maximum",
      "find a longest increasing subsequence", "decode digit messages", "count unique grid paths",
      "find a minimum path sum", "split a palindrome string", "match wildcard patterns",
      "find a target subset sum", "find a maximum stock profit", "calculate climbing ways",
      "find a maximum square", "find an interleaving string", "find a word break", 
      "find a maximum circular sum", "find a partition difference",
    ],
  },
  {
    id: "union-find",
    title: "Union find",
    scenarios: [
      "merge customer accounts", "find redundant connections", "count network components",
      "find a minimum spanning tree", "group similar strings", "validate graph cycles",
      "merge overlapping profiles", "count provinces", "find an earliest connection time",
      "find a dynamic island count", "group email aliases", "resolve equality constraints",
      "find an equation ratio group", "connect data centers", "merge calendar rooms",
      "find a friend circle", "find a lexicographic swap group", "cluster nearby sensors",
      "connect server racks", "group shared permissions",
    ],
  },
];

const BUSINESS_FLOWS = [
  {
    id: "order-management",
    title: "Order management",
    service: "orders",
    action: "createOrUpdate",
    event: "order.changed",
    scenarios: [
      "create an idempotent checkout order", "confirm an order after payment", "cancel an unpaid order",
      "split an order by warehouse", "apply a promotional discount", "calculate shipping charges",
      "validate an address before fulfillment", "merge duplicate draft orders", "reopen a returned order",
      "schedule a delivery window", "assign an order to a fulfillment queue", "record an order note",
      "replace an unavailable item", "reprice an order before payment", "lock an order for review",
      "expire an abandoned checkout", "attach a tax calculation", "create an exchange order",
      "sync an order to an ERP", "archive a completed order",
    ],
  },
  {
    id: "payment-processing",
    title: "Payment processing",
    service: "payments",
    action: "authorizeAndCapture",
    event: "payment.updated",
    scenarios: [
      "authorize a card payment", "capture an approved payment", "issue a partial refund",
      "handle a payment provider webhook", "retry a transient payment failure", "validate a webhook signature",
      "store a payment method token", "reconcile a settlement batch", "mark a disputed payment",
      "apply a gift-card balance", "split a payment across methods", "void an authorization",
      "calculate a payment fee", "create a subscription invoice", "record a bank transfer",
      "detect a duplicate charge", "schedule a recurring collection", "process a chargeback",
      "convert a payment currency", "close a daily payment ledger",
    ],
  },
  {
    id: "inventory-fulfillment",
    title: "Inventory fulfillment",
    service: "inventory",
    action: "reserveAndCommit",
    event: "inventory.changed",
    scenarios: [
      "reserve stock during checkout", "release an expired reservation", "commit stock after payment",
      "transfer inventory between warehouses", "reorder a low-stock SKU", "allocate stock by proximity",
      "reconcile a cycle count", "receive a supplier shipment", "adjust damaged inventory",
      "backorder an unavailable item", "reserve a bundle component", "prevent an oversell race",
      "calculate available-to-promise", "pick the nearest fulfillment location", "sync warehouse quantities",
      "hold inventory for fraud review", "schedule a replenishment job", "track a serial number",
      "mark an item as discontinued", "audit an inventory movement",
    ],
  },
  {
    id: "identity-access",
    title: "Identity and access",
    service: "identity",
    action: "verifyAndGrant",
    event: "identity.changed",
    scenarios: [
      "register a customer account", "verify an email address", "reset a forgotten password",
      "rotate a refresh token", "enforce multi-factor authentication", "create a role assignment",
      "check a resource permission", "revoke an employee session", "invite a workspace member",
      "accept a team invitation", "link a social identity", "lock a suspicious account",
      "create an API key", "expire an API key", "record a consent decision",
      "apply an organization policy", "validate a signed session", "audit an administrator action",
      "remove a stale device", "resolve a tenant membership",
    ],
  },
  {
    id: "query-pagination",
    title: "Query and pagination",
    service: "queries",
    action: "filterAndPage",
    event: "query.completed",
    scenarios: [
      "list orders with cursor pagination", "filter customers by status", "search products by prefix",
      "sort invoices by due date", "page audit events", "filter subscriptions by plan",
      "load a customer timeline", "query active sessions", "search support tickets",
      "list warehouse movements", "filter reports by date range", "load a dashboard summary",
      "paginate API keys", "search an organization directory", "filter payments by state",
      "list unread notifications", "fetch a product catalog", "query feature flags",
      "export a filtered customer list", "build a saved search",
    ],
  },
  {
    id: "reporting-analytics",
    title: "Reporting and analytics",
    service: "reports",
    action: "aggregateAndStore",
    event: "report.updated",
    scenarios: [
      "calculate daily revenue", "calculate monthly recurring revenue", "measure checkout conversion",
      "aggregate product sales", "build a retention cohort", "calculate inventory turnover",
      "summarize payment failures", "measure support response time", "calculate average order value",
      "build a customer lifetime value report", "track subscription churn", "report tax liability",
      "aggregate warehouse throughput", "calculate campaign attribution", "measure active users",
      "build an executive dashboard", "compare period-over-period revenue", "export a financial close report",
      "calculate refund rate", "monitor a service-level objective",
    ],
  },
];

const camel = (value) => value.replace(/[^a-z0-9]+(.)/gi, (_, letter) => letter.toUpperCase()).replace(/^[A-Z]/, (letter) => letter.toLowerCase());
const pascal = (value) => {
  const result = camel(value);
  return result[0].toUpperCase() + result.slice(1);
};

function header(language, algorithm, scenario, number) {
  const comment = language === "sql" ? "--" : language === "python" ? "#" : "//";
  return `${comment} ${algorithm.title}: ${scenario} (exercise ${number})`;
}

function javascript(algorithm, name) {
  const bodies = {
    "binary-search": `function ${name}(values, target) {\n  let left = 0;\n  let right = values.length - 1;\n  while (left <= right) {\n    const middle = left + Math.floor((right - left) / 2);\n    if (values[middle] === target) return middle;\n    if (values[middle] < target) left = middle + 1;\n    else right = middle - 1;\n  }\n  return -1;\n}`,
    "two-pointers": `function ${name}(values, target) {\n  let left = 0;\n  let right = values.length - 1;\n  while (left < right) {\n    const sum = values[left] + values[right];\n    if (sum === target) return [left, right];\n    if (sum < target) left += 1;\n    else right -= 1;\n  }\n  return [];\n}`,
    "sliding-window": `function ${name}(text) {\n  const seen = new Map();\n  let start = 0;\n  let best = 0;\n  for (let end = 0; end < text.length; end += 1) {\n    const previous = seen.get(text[end]);\n    if (previous !== undefined && previous >= start) start = previous + 1;\n    seen.set(text[end], end);\n    best = Math.max(best, end - start + 1);\n  }\n  return best;\n}`,
    "breadth-first-search": `function ${name}(graph, source, target) {\n  const queue = [source];\n  const distance = new Map([[source, 0]]);\n  for (let head = 0; head < queue.length; head += 1) {\n    const node = queue[head];\n    if (node === target) return distance.get(node);\n    for (const next of graph.get(node) ?? []) {\n      if (!distance.has(next)) {\n        distance.set(next, distance.get(node) + 1);\n        queue.push(next);\n      }\n    }\n  }\n  return -1;\n}`,
    "dynamic-programming": `function ${name}(weights, values, capacity) {\n  const dp = Array(capacity + 1).fill(0);\n  for (let item = 0; item < weights.length; item += 1) {\n    for (let room = capacity; room >= weights[item]; room -= 1) {\n      dp[room] = Math.max(dp[room], dp[room - weights[item]] + values[item]);\n    }\n  }\n  return dp[capacity];\n}`,
    "union-find": `function ${name}(size, edges) {\n  const parent = Array.from({ length: size }, (_, index) => index);\n  const find = (node) => parent[node] === node ? node : (parent[node] = find(parent[node]));\n  for (const [left, right] of edges) {\n    const rootLeft = find(left);\n    const rootRight = find(right);\n    if (rootLeft !== rootRight) parent[rootLeft] = rootRight;\n  }\n  return new Set(parent.map(find)).size;\n}`,
  };
  return bodies[algorithm.id];
}

function python(algorithm, name) {
  const bodies = {
    "binary-search": `def ${name}(values, target):\n    left, right = 0, len(values) - 1\n    while left <= right:\n        middle = left + (right - left) // 2\n        if values[middle] == target:\n            return middle\n        if values[middle] < target:\n            left = middle + 1\n        else:\n            right = middle - 1\n    return -1`,
    "two-pointers": `def ${name}(values, target):\n    left, right = 0, len(values) - 1\n    while left < right:\n        total = values[left] + values[right]\n        if total == target:\n            return [left, right]\n        if total < target:\n            left += 1\n        else:\n            right -= 1\n    return []`,
    "sliding-window": `def ${name}(text):\n    seen = {}\n    start = best = 0\n    for end, character in enumerate(text):\n        if character in seen and seen[character] >= start:\n            start = seen[character] + 1\n        seen[character] = end\n        best = max(best, end - start + 1)\n    return best`,
    "breadth-first-search": `def ${name}(graph, source, target):\n    queue = [source]\n    distance = {source: 0}\n    for node in queue:\n        if node == target:\n            return distance[node]\n        for next_node in graph.get(node, []):\n            if next_node not in distance:\n                distance[next_node] = distance[node] + 1\n                queue.append(next_node)\n    return -1`,
    "dynamic-programming": `def ${name}(weights, values, capacity):\n    dp = [0] * (capacity + 1)\n    for weight, value in zip(weights, values):\n        for room in range(capacity, weight - 1, -1):\n            dp[room] = max(dp[room], dp[room - weight] + value)\n    return dp[capacity]`,
    "union-find": `def ${name}(size, edges):\n    parent = list(range(size))\n    def find(node):\n        if parent[node] != node:\n            parent[node] = find(parent[node])\n        return parent[node]\n    for left, right in edges:\n        root_left, root_right = find(left), find(right)\n        if root_left != root_right:\n            parent[root_left] = root_right\n    return len({find(node) for node in range(size)})`,
  };
  return bodies[algorithm.id];
}

function javaLike(language, algorithm, name) {
  const isCpp = language === "csharp";
  const prefix = isCpp ? "public static" : "public static";
  const list = isCpp ? "int[]" : "int[]";
  const map = isCpp ? "Dictionary<Character, int>" : "Map<Character, Integer>";
  const bodies = {
    "binary-search": `${prefix} int ${name}(${list} values, int target) {\n  int left = 0;\n  int right = values.Length - 1;\n  while (left <= right) {\n    int middle = left + (right - left) / 2;\n    if (values[middle] == target) return middle;\n    if (values[middle] < target) left = middle + 1;\n    else right = middle - 1;\n  }\n  return -1;\n}`,
    "two-pointers": `${prefix} ${list} ${name}(${list} values, int target) {\n  int left = 0, right = values.Length - 1;\n  while (left < right) {\n    int total = values[left] + values[right];\n    if (total == target) return new[] { left, right };\n    if (total < target) left++;\n    else right--;\n  }\n  return Array.Empty<int>();\n}`,
    "sliding-window": `${prefix} int ${name}(string text) {\n  var seen = new ${map}();\n  int start = 0, best = 0;\n  for (int end = 0; end < text.Length; end++) {\n    if (seen.TryGetValue(text[end], out int previous) && previous >= start) start = previous + 1;\n    seen[text[end]] = end;\n    best = Math.Max(best, end - start + 1);\n  }\n  return best;\n}`,
    "breadth-first-search": `${prefix} int ${name}(Dictionary<int, List<int>> graph, int source, int target) {\n  var queue = new Queue<int>();\n  var distance = new Dictionary<int, int> { [source] = 0 };\n  queue.Enqueue(source);\n  while (queue.Count > 0) {\n    int node = queue.Dequeue();\n    if (node == target) return distance[node];\n    foreach (int next in graph.GetValueOrDefault(node, new List<int>())) {\n      if (!distance.ContainsKey(next)) { distance[next] = distance[node] + 1; queue.Enqueue(next); }\n    }\n  }\n  return -1;\n}`,
    "dynamic-programming": `${prefix} int ${name}(${list} weights, ${list} values, int capacity) {\n  var dp = new int[capacity + 1];\n  for (int item = 0; item < weights.Length; item++) {\n    for (int room = capacity; room >= weights[item]; room--) {\n      dp[room] = Math.Max(dp[room], dp[room - weights[item]] + values[item]);\n    }\n  }\n  return dp[capacity];\n}`,
    "union-find": `${prefix} int ${name}(int size, ${list} lefts, ${list} rights) {\n  var parent = Enumerable.Range(0, size).ToArray();\n  int Find(int node) => parent[node] == node ? node : parent[node] = Find(parent[node]);\n  for (int index = 0; index < lefts.Length; index++) {\n    int a = Find(lefts[index]), b = Find(rights[index]);\n    if (a != b) parent[a] = b;\n  }\n  return parent.Select(Find).Distinct().Count();\n}`,
  };
  return bodies[algorithm.id];
}

function java(algorithm, name) {
  const bodies = {
    "binary-search": `public static int ${name}(int[] values, int target) {\n  int left = 0;\n  int right = values.length - 1;\n  while (left <= right) {\n    int middle = left + (right - left) / 2;\n    if (values[middle] == target) return middle;\n    if (values[middle] < target) left = middle + 1;\n    else right = middle - 1;\n  }\n  return -1;\n}`,
    "two-pointers": `public static int[] ${name}(int[] values, int target) {\n  int left = 0, right = values.length - 1;\n  while (left < right) {\n    int total = values[left] + values[right];\n    if (total == target) return new int[] { left, right };\n    if (total < target) left++;\n    else right--;\n  }\n  return new int[0];\n}`,
    "sliding-window": `public static int ${name}(String text) {\n  Map<Character, Integer> seen = new HashMap<>();\n  int start = 0, best = 0;\n  for (int end = 0; end < text.length(); end++) {\n    char character = text.charAt(end);\n    Integer previous = seen.get(character);\n    if (previous != null && previous >= start) start = previous + 1;\n    seen.put(character, end);\n    best = Math.max(best, end - start + 1);\n  }\n  return best;\n}`,
    "breadth-first-search": `public static int ${name}(Map<Integer, List<Integer>> graph, int source, int target) {\n  Queue<Integer> queue = new ArrayDeque<>();\n  Map<Integer, Integer> distance = new HashMap<>();\n  queue.add(source);\n  distance.put(source, 0);\n  while (!queue.isEmpty()) {\n    int node = queue.remove();\n    if (node == target) return distance.get(node);\n    for (int next : graph.getOrDefault(node, List.of())) {\n      if (!distance.containsKey(next)) { distance.put(next, distance.get(node) + 1); queue.add(next); }\n    }\n  }\n  return -1;\n}`,
    "dynamic-programming": `public static int ${name}(int[] weights, int[] values, int capacity) {\n  int[] dp = new int[capacity + 1];\n  for (int item = 0; item < weights.length; item++) {\n    for (int room = capacity; room >= weights[item]; room--) {\n      dp[room] = Math.max(dp[room], dp[room - weights[item]] + values[item]);\n    }\n  }\n  return dp[capacity];\n}`,
    "union-find": `public static int ${name}(int size, int[][] edges) {\n  int[] parent = IntStream.range(0, size).toArray();\n  for (int[] edge : edges) {\n    int left = edge[0], right = edge[1];\n    while (parent[left] != left) { parent[left] = parent[parent[left]]; left = parent[left]; }\n    while (parent[right] != right) { parent[right] = parent[parent[right]]; right = parent[right]; }\n    if (left != right) parent[left] = right;\n  }\n  Set<Integer> groups = new HashSet<>();\n  for (int node = 0; node < size; node++) { while (parent[node] != node) node = parent[node]; groups.add(node); }\n  return groups.size();\n}`,
  };
  return bodies[algorithm.id];
}

function go(algorithm, name) {
  const bodies = {
    "binary-search": `func ${name}(values []int, target int) int {\n\tleft, right := 0, len(values)-1\n\tfor left <= right {\n\t\tmiddle := left + (right-left)/2\n\t\tif values[middle] == target { return middle }\n\t\tif values[middle] < target { left = middle + 1 } else { right = middle - 1 }\n\t}\n\treturn -1\n}`,
    "two-pointers": `func ${name}(values []int, target int) []int {\n\tleft, right := 0, len(values)-1\n\tfor left < right {\n\t\ttotal := values[left] + values[right]\n\t\tif total == target { return []int{left, right} }\n\t\tif total < target { left++ } else { right-- }\n\t}\n\treturn nil\n}`,
    "sliding-window": `func ${name}(text string) int {\n\tseen := map[rune]int{}\n\tstart, best := 0, 0\n\tfor end, character := range []rune(text) {\n\t\tif previous, ok := seen[character]; ok && previous >= start { start = previous + 1 }\n\t\tseen[character] = end\n\t\tif end-start+1 > best { best = end - start + 1 }\n\t}\n\treturn best\n}`,
    "breadth-first-search": `func ${name}(graph map[int][]int, source, target int) int {\n\tqueue := []int{source}\n\tdistance := map[int]int{source: 0}\n\tfor head := 0; head < len(queue); head++ {\n\t\tnode := queue[head]\n\t\tif node == target { return distance[node] }\n\t\tfor _, next := range graph[node] {\n\t\t\tif _, seen := distance[next]; !seen { distance[next] = distance[node] + 1; queue = append(queue, next) }\n\t\t}\n\t}\n\treturn -1\n}`,
    "dynamic-programming": `func ${name}(weights, values []int, capacity int) int {\n\tdp := make([]int, capacity+1)\n\tfor item, weight := range weights {\n\t\tfor room := capacity; room >= weight; room-- {\n\t\t\tcandidate := dp[room-weight] + values[item]\n\t\t\tif candidate > dp[room] { dp[room] = candidate }\n\t\t}\n\t}\n\treturn dp[capacity]\n}`,
    "union-find": `func ${name}(size int, edges [][2]int) int {\n\tparent := make([]int, size)\n\tfor index := range parent { parent[index] = index }\n\tvar find func(int) int\n\tfind = func(node int) int { if parent[node] != node { parent[node] = find(parent[node]) }; return parent[node] }\n\tfor _, edge := range edges { left, right := find(edge[0]), find(edge[1]); if left != right { parent[left] = right } }\n\tgroups := map[int]bool{}\n\tfor node := range parent { groups[find(node)] = true }\n\treturn len(groups)\n}`,
  };
  return bodies[algorithm.id];
}

function rust(algorithm, name) {
  const bodies = {
    "binary-search": `fn ${name}(values: &[i32], target: i32) -> i32 {\n    let (mut left, mut right) = (0_i32, values.len() as i32 - 1);\n    while left <= right {\n        let middle = left + (right - left) / 2;\n        let value = values[middle as usize];\n        if value == target { return middle; }\n        if value < target { left = middle + 1; } else { right = middle - 1; }\n    }\n    -1\n}`,
    "two-pointers": `fn ${name}(values: &[i32], target: i32) -> Option<(usize, usize)> {\n    let (mut left, mut right) = (0_usize, values.len().saturating_sub(1));\n    while left < right {\n        let total = values[left] + values[right];\n        if total == target { return Some((left, right)); }\n        if total < target { left += 1; } else { right -= 1; }\n    }\n    None\n}`,
    "sliding-window": `fn ${name}(text: &str) -> usize {\n    use std::collections::HashMap;\n    let mut seen = HashMap::new();\n    let (mut start, mut best) = (0, 0);\n    for (end, character) in text.chars().enumerate() {\n        if let Some(&previous) = seen.get(&character) { start = start.max(previous + 1); }\n        seen.insert(character, end);\n        best = best.max(end - start + 1);\n    }\n    best\n}`,
    "breadth-first-search": `fn ${name}(graph: &[Vec<usize>], source: usize, target: usize) -> i32 {\n    use std::collections::VecDeque;\n    let mut queue = VecDeque::from([source]);\n    let mut distance = vec![-1; graph.len()];\n    distance[source] = 0;\n    while let Some(node) = queue.pop_front() {\n        if node == target { return distance[node]; }\n        for &next in &graph[node] {\n            if distance[next] < 0 { distance[next] = distance[node] + 1; queue.push_back(next); }\n        }\n    }\n    -1\n}`,
    "dynamic-programming": `fn ${name}(weights: &[usize], values: &[i32], capacity: usize) -> i32 {\n    let mut dp = vec![0; capacity + 1];\n    for (&weight, &value) in weights.iter().zip(values) {\n        for room in (weight..=capacity).rev() {\n            dp[room] = dp[room].max(dp[room - weight] + value);\n        }\n    }\n    dp[capacity]\n}`,
    "union-find": `fn ${name}(size: usize, edges: &[(usize, usize)]) -> usize {\n    fn find(parent: &mut [usize], node: usize) -> usize {\n        if parent[node] != node { parent[node] = find(parent, parent[node]); }\n        parent[node]\n    }\n    let mut parent: Vec<usize> = (0..size).collect();\n    for &(left, right) in edges { let a = find(&mut parent, left); let b = find(&mut parent, right); if a != b { parent[a] = b; } }\n    (0..size).map(|node| find(&mut parent, node)).collect::<std::collections::HashSet<_>>().len()\n}`,
  };
  return bodies[algorithm.id];
}

function php(algorithm, name) {
  const bodies = {
    "binary-search": `function ${name}(array $values, int $target): int\n{\n    $left = 0;\n    $right = count($values) - 1;\n    while ($left <= $right) {\n        $middle = $left + intdiv($right - $left, 2);\n        if ($values[$middle] === $target) return $middle;\n        if ($values[$middle] < $target) $left = $middle + 1;\n        else $right = $middle - 1;\n    }\n    return -1;\n}`,
    "two-pointers": `function ${name}(array $values, int $target): array\n{\n    $left = 0;\n    $right = count($values) - 1;\n    while ($left < $right) {\n        $total = $values[$left] + $values[$right];\n        if ($total === $target) return [$left, $right];\n        if ($total < $target) $left++;\n        else $right--;\n    }\n    return [];\n}`,
    "sliding-window": `function ${name}(string $text): int\n{\n    $seen = [];\n    $start = $best = 0;\n    for ($end = 0; $end < strlen($text); $end++) {\n        $character = $text[$end];\n        if (isset($seen[$character]) && $seen[$character] >= $start) $start = $seen[$character] + 1;\n        $seen[$character] = $end;\n        $best = max($best, $end - $start + 1);\n    }\n    return $best;\n}`,
    "breadth-first-search": `function ${name}(array $graph, int $source, int $target): int\n{\n    $queue = [$source];\n    $distance = [$source => 0];\n    for ($head = 0; $head < count($queue); $head++) {\n        $node = $queue[$head];\n        if ($node === $target) return $distance[$node];\n        foreach ($graph[$node] ?? [] as $next) {\n            if (!array_key_exists($next, $distance)) { $distance[$next] = $distance[$node] + 1; $queue[] = $next; }\n        }\n    }\n    return -1;\n}`,
    "dynamic-programming": `function ${name}(array $weights, array $values, int $capacity): int\n{\n    $dp = array_fill(0, $capacity + 1, 0);\n    foreach ($weights as $item => $weight) {\n        for ($room = $capacity; $room >= $weight; $room--) {\n            $dp[$room] = max($dp[$room], $dp[$room - $weight] + $values[$item]);\n        }\n    }\n    return $dp[$capacity];\n}`,
    "union-find": `function ${name}(int $size, array $edges): int\n{\n    $parent = range(0, $size - 1);\n    $find = function (int $node) use (&$parent, &$find): int {\n        if ($parent[$node] !== $node) $parent[$node] = $find($parent[$node]);\n        return $parent[$node];\n    };\n    foreach ($edges as [$left, $right]) { $a = $find($left); $b = $find($right); if ($a !== $b) $parent[$a] = $b; }\n    return count(array_unique(array_map($find, range(0, $size - 1))));\n}`,
  };
  return bodies[algorithm.id];
}

function sql(algorithm, name) {
  const bodies = {
    "binary-search": `WITH RECURSIVE bounds AS (\n  SELECT 0 AS low, MAX(position) AS high FROM sorted_values\n  UNION ALL\n  SELECT CASE WHEN value < :target THEN middle + 1 ELSE low END,\n         CASE WHEN value < :target THEN high ELSE middle - 1 END\n  FROM bounds\n  CROSS JOIN LATERAL (SELECT (low + high) / 2 AS middle) midpoint\n  JOIN sorted_values ON position = middle\n  WHERE low <= high\n)\nSELECT position FROM sorted_values\nWHERE value = :target\nORDER BY position LIMIT 1;`,
    "two-pointers": `WITH ranked AS (\n  SELECT position, value,\n         ROW_NUMBER() OVER (ORDER BY value) AS left_rank,\n         ROW_NUMBER() OVER (ORDER BY value DESC) AS right_rank\n  FROM sorted_values\n)\nSELECT left_value.position, right_value.position\nFROM ranked left_value\nJOIN ranked right_value ON left_value.left_rank < right_value.right_rank\nWHERE left_value.value + right_value.value = :target\nORDER BY left_value.position, right_value.position\nLIMIT 1;`,
    "sliding-window": `WITH numbered AS (\n  SELECT event_time, value,\n         ROW_NUMBER() OVER (ORDER BY event_time) AS sequence\n  FROM events\n), windows AS (\n  SELECT event_time,\n         SUM(value) OVER (ORDER BY sequence ROWS BETWEEN :window_size - 1 PRECEDING AND CURRENT ROW) AS window_total\n  FROM numbered\n)\nSELECT event_time, window_total\nFROM windows\nORDER BY window_total DESC\nLIMIT 1;`,
    "breadth-first-search": `WITH RECURSIVE traversal AS (\n  SELECT :source AS node_id, 0 AS depth, ARRAY[:source] AS path\n  UNION ALL\n  SELECT edges.to_id, traversal.depth + 1, path || edges.to_id\n  FROM traversal\n  JOIN graph_edges edges ON edges.from_id = traversal.node_id\n  WHERE NOT edges.to_id = ANY(traversal.path)\n)\nSELECT depth, path\nFROM traversal\nWHERE node_id = :target\nORDER BY depth\nLIMIT 1;`,
    "dynamic-programming": `WITH RECURSIVE choices AS (\n  SELECT 0 AS item_index, 0 AS used_capacity, 0 AS total_value\n  UNION ALL\n  SELECT item_index + 1, used_capacity, total_value\n  FROM choices WHERE item_index < (SELECT COUNT(*) FROM items)\n  UNION ALL\n  SELECT choices.item_index + 1, choices.used_capacity + items.weight, choices.total_value + items.value\n  FROM choices JOIN items ON items.id = choices.item_index + 1\n  WHERE choices.used_capacity + items.weight <= :capacity\n)\nSELECT MAX(total_value) AS best_value\nFROM choices;`,
    "union-find": `WITH RECURSIVE groups AS (\n  SELECT node_id, node_id AS root_id FROM graph_nodes\n  UNION\n  SELECT edges.to_id, groups.root_id\n  FROM groups\n  JOIN graph_edges edges ON edges.from_id = groups.node_id\n), normalized AS (\n  SELECT node_id, MIN(root_id) AS component_id\n  FROM groups\n  GROUP BY node_id\n)\nSELECT component_id, COUNT(*) AS component_size\nFROM normalized\nGROUP BY component_id\nORDER BY component_size DESC;`,
  };
  return bodies[algorithm.id].replaceAll("${name}", name);
}

function businessJavaScript(flow, name) {
  return `async function ${name}(input, services) {\n  const existing = await services.${flow.service}.findById(input.id);\n  if (existing?.status === "completed") return existing;\n  const validated = await services.validation.validate(input);\n  const result = await services.${flow.service}.${flow.action}(validated, existing);\n  await services.outbox.publish("${flow.event}", { id: result.id, version: result.version });\n  return result;\n}`;
}

function businessPython(flow, name) {
  return `async def ${name}(input, services):\n    existing = await services.${flow.service}.find_by_id(input.id)\n    if existing and existing.status == "completed":\n        return existing\n    validated = await services.validation.validate(input)\n    result = await services.${flow.service}.${flow.action}(validated, existing)\n    await services.outbox.publish("${flow.event}", {"id": result.id, "version": result.version})\n    return result`;
}

function businessJava(flow, name) {
  return `public static CompletableFuture<Record> ${name}(Request input, Services services) {\n  return services.${flow.service}.findById(input.id())\n      .thenCompose(existing -> services.validation.validate(input)\n          .thenCompose(validated -> services.${flow.service}.${flow.action}(validated, existing)))\n      .thenCompose(result -> services.outbox.publish("${flow.event}", result.id(), result.version())\n          .thenApply(ignored -> result));\n}`;
}

function businessCSharp(flow, name) {
  return `public static async Task<Record> ${name}(Request input, Services services)\n{\n  var existing = await services.${flow.service}.FindByIdAsync(input.Id);\n  if (existing?.Status == "completed") return existing;\n  var validated = await services.Validation.ValidateAsync(input);\n  var result = await services.${flow.service}.${pascal(flow.action)}Async(validated, existing);\n  await services.Outbox.PublishAsync("${flow.event}", new { result.Id, result.Version });\n  return result;\n}`;
}

function businessGo(flow, name) {
  return `func ${name}(ctx context.Context, input Request, services Services) (Record, error) {\n\texisting, err := services.${pascal(flow.service)}.FindByID(ctx, input.ID)\n\tif err != nil { return Record{}, err }\n\tif existing.Status == "completed" { return existing, nil }\n\tvalidated, err := services.Validation.Validate(ctx, input)\n\tif err != nil { return Record{}, err }\n\tresult, err := services.${pascal(flow.service)}.${pascal(flow.action)}(ctx, validated, existing)\n\tif err != nil { return Record{}, err }\n\treturn result, services.Outbox.Publish(ctx, "${flow.event}", result.ID)\n}`;
}

function businessRust(flow, name) {
  return `async fn ${name}(input: Request, services: &Services) -> Result<Record, ServiceError> {\n    let existing = services.${flow.service}.find_by_id(&input.id).await?;\n    if existing.as_ref().is_some_and(|record| record.status == "completed") {\n        return Ok(existing.unwrap());\n    }\n    let validated = services.validation.validate(input).await?;\n    let result = services.${flow.service}.${flow.action}(validated, existing).await?;\n    services.outbox.publish("${flow.event}", &result.id).await?;\n    Ok(result)\n}`;
}

function businessPhp(flow, name) {
  return `function ${name}(Request $input, Services $services): Record\n{\n    $existing = $services->${flow.service}->findById($input->id);\n    if ($existing?->status === 'completed') return $existing;\n    $validated = $services->validation->validate($input);\n    $result = $services->${flow.service}->${flow.action}($validated, $existing);\n    $services->outbox->publish('${flow.event}', ['id' => $result->id, 'version' => $result->version]);\n    return $result;\n}`;
}

function businessSql(flow) {
  const bodies = {
    "order-management": `BEGIN;\nINSERT INTO orders (id, customer_id, status, total, version)\nVALUES (:id, :customer_id, 'pending', :total, 1)\nON CONFLICT (id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP\nRETURNING id, status, version;\nCOMMIT;`,
    "payment-processing": `BEGIN;\nUPDATE payments\nSET status = 'captured', captured_at = CURRENT_TIMESTAMP, provider_reference = :reference\nWHERE id = :payment_id AND status = 'authorized';\nINSERT INTO payment_events (payment_id, event_type, created_at)\nVALUES (:payment_id, 'captured', CURRENT_TIMESTAMP);\nCOMMIT;`,
    "inventory-fulfillment": `UPDATE inventory\nSET reserved = reserved + :quantity,\n    available = available - :quantity,\n    updated_at = CURRENT_TIMESTAMP\nWHERE sku = :sku\n  AND warehouse_id = :warehouse_id\n  AND available >= :quantity\nRETURNING sku, available, reserved;`,
    "identity-access": `WITH membership AS (\n  SELECT role FROM workspace_members\n  WHERE workspace_id = :workspace_id AND user_id = :user_id AND revoked_at IS NULL\n)\nSELECT EXISTS (\n  SELECT 1 FROM membership\n  JOIN role_permissions USING (role)\n  WHERE permission = :permission\n) AS is_allowed;`,
    "query-pagination": `SELECT id, status, created_at\nFROM orders\nWHERE customer_id = :customer_id\n  AND (:after_created_at IS NULL OR (created_at, id) < (:after_created_at, :after_id))\nORDER BY created_at DESC, id DESC\nLIMIT :page_size;`,
    "reporting-analytics": `INSERT INTO daily_metrics (metric_date, revenue, order_count, refreshed_at)\nSELECT DATE(paid_at), SUM(total_amount), COUNT(*), CURRENT_TIMESTAMP\nFROM orders\nWHERE status = 'paid' AND paid_at >= :from AND paid_at < :to\nGROUP BY DATE(paid_at)\nON CONFLICT (metric_date) DO UPDATE\nSET revenue = EXCLUDED.revenue, order_count = EXCLUDED.order_count, refreshed_at = EXCLUDED.refreshed_at;`,
  };
  return bodies[flow.id];
}

function business(language, flow, name) {
  if (language === "javascript" || language === "typescript") return businessJavaScript(flow, name);
  if (language === "python") return businessPython(flow, name);
  if (language === "java") return businessJava(flow, pascal(name));
  if (language === "csharp") return businessCSharp(flow, pascal(name));
  if (language === "go") return businessGo(flow, name);
  if (language === "rust") return businessRust(flow, name);
  if (language === "php") return businessPhp(flow, name);
  return businessSql(flow);
}

function snippet(language, topic, scenario, number) {
  const name = camel(`${topic.id} ${scenario} ${number}`);
  const title = header(language, topic, scenario, number);
  if (BUSINESS_FLOWS.includes(topic)) return `${title}\n${business(language, topic, name)}`;
  const body = language === "javascript" || language === "typescript"
    ? javascript(topic, name)
    : language === "python"
      ? python(topic, name)
      : language === "java"
        ? java(topic, pascal(name))
        : language === "csharp"
          ? javaLike(language, topic, pascal(name))
        : language === "go"
          ? go(topic, name)
          : language === "rust"
            ? rust(topic, name)
            : language === "php"
              ? php(topic, name)
              : sql(topic, name);
  return `${title}\n${body}`;
}

const corpus = Object.fromEntries(LANGUAGES.map((language) => [
  language,
  [...ALGORITHMS, ...BUSINESS_FLOWS].flatMap((topic) => topic.scenarios.map((scenario, index) => (
    snippet(language, topic, scenario, index + 1)
  ))),
]));

const total = Object.values(corpus).reduce((sum, snippets) => sum + snippets.length, 0);
if (total < 2000) throw new Error(`Expected at least 2,000 snippets, received ${total}`);

await mkdir(sourceDirectory, { recursive: true });
await writeFile(
  path.join(sourceDirectory, "corpus.json"),
  `${JSON.stringify(corpus, null, 2)}\n`,
  "utf8",
);
console.log(`Generated ${total} algorithm and business snippets across ${LANGUAGES.length} languages.`);
