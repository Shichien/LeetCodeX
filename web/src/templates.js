export function localStarter(problem, language) {
  const signature = problemSignature(problem);
  const { entry, params, result } = signature;
  const names = params.map((param) => param.name).join(", ");

  switch (language) {
    case "c":
      return cStarter(signature);
    case "cpp":
      return `class Solution {\npublic:\n  ${typeName(result, "cpp")} ${entry}(${typedParams(params, "cpp", true)}) {\n    \n  }\n};`;
    case "csharp":
      return `public class Solution {\n  public ${typeName(result, "csharp")} ${upperFirst(entry)}(${typedParams(params, "csharp")}) {\n    \n  }\n}`;
    case "golang":
      return `func ${entry}(${typedParams(params, "golang")}) ${typeName(result, "golang")} {\n  \n}`;
    case "java":
      return `class Solution {\n  public ${typeName(result, "java")} ${entry}(${typedParams(params, "java")}) {\n    \n  }\n}`;
    case "javascript":
      return `${jsDoc(params, result)}\nvar ${entry} = function(${names}) {\n  \n};`;
    case "kotlin":
      return `class Solution {\n  fun ${entry}(${typedParams(params, "kotlin")}): ${typeName(result, "kotlin")} {\n    \n  }\n}`;
    case "php":
      return `class Solution {\n  function ${entry}(${params.map((param) => `$${param.name}`).join(", ")}) {\n    \n  }\n}`;
    case "python3":
      return `class Solution:\n    def ${entry}(self${names ? `, ${names}` : ""}):\n        pass`;
    case "ruby":
      return `def ${snakeCase(entry)}(${names})\n  \nend`;
    case "rust":
      return `impl Solution {\n  pub fn ${snakeCase(entry)}(${typedParams(params, "rust")}) -> ${typeName(result, "rust")} {\n    \n  }\n}`;
    case "scala":
      return `object Solution {\n  def ${entry}(${typedParams(params, "scala")}): ${typeName(result, "scala")} = {\n    \n  }\n}`;
    case "swift":
      return `class Solution {\n  func ${entry}(${typedParams(params, "swift")}) -> ${typeName(result, "swift")} {\n    \n  }\n}`;
    case "typescript":
      return `function ${entry}(${typedParams(params, "typescript")}): ${typeName(result, "typescript")} {\n  \n};`;
    default:
      return problem.starter;
  }
}

export function problemSignature(problem) {
  const match = problem.starter.match(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/);
  const names = match?.[1].split(",").map((name) => name.trim()).filter(Boolean) ?? [];
  const params = names.map((name, index) => ({
    name,
    type: inferType(problem.tests.map((test) => test.args[index])),
  }));
  return {
    entry: problem.entry,
    params,
    result: inferType(problem.tests.map((test) => test.expected)),
  };
}

function inferType(values) {
  const value = values.find((candidate) => Array.isArray(candidate) && candidate.length > 0)
    ?? values.find((candidate) => candidate !== undefined && candidate !== null);
  if (Array.isArray(value)) {
    const children = values.filter(Array.isArray).flat();
    return { kind: "array", item: inferType(children.length > 0 ? children : [0]) };
  }
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (typeof value === "number" && !Number.isInteger(value)) return { kind: "number" };
  return { kind: "integer" };
}

function typedParams(params, language, references = false) {
  return params.map(({ name, type }) => {
    const rendered = typeName(type, language);
    if (language === "typescript") return `${name}: ${rendered}`;
    if (language === "kotlin" || language === "scala") return `${name}: ${rendered}`;
    if (language === "rust") return `${name}: ${rendered}`;
    if (language === "swift") return `_${name}: ${rendered}`;
    if (language === "golang") return `${name} ${rendered}`;
    return `${rendered}${references && type.kind === "array" ? "&" : ""} ${name}`;
  }).join(", ");
}

function typeName(type, language) {
  if (type.kind === "array") {
    const item = typeName(type.item, language);
    const arrays = {
      cpp: `vector<${item}>`, csharp: `${item}[]`, golang: `[]${item}`, java: `${item}[]`,
      kotlin: type.item.kind === "integer" ? "IntArray" : type.item.kind === "number" ? "DoubleArray" : `Array<${item}>`,
      rust: `Vec<${item}>`, scala: `Array[${item}]`, swift: `[${item}]`, typescript: `${item}[]`,
    };
    return arrays[language] ?? `${item}*`;
  }
  const names = {
    cpp: { integer: "int", number: "double", string: "string", boolean: "bool" },
    csharp: { integer: "int", number: "double", string: "string", boolean: "bool" },
    golang: { integer: "int", number: "float64", string: "string", boolean: "bool" },
    java: { integer: "int", number: "double", string: "String", boolean: "boolean" },
    kotlin: { integer: "Int", number: "Double", string: "String", boolean: "Boolean" },
    rust: { integer: "i32", number: "f64", string: "String", boolean: "bool" },
    scala: { integer: "Int", number: "Double", string: "String", boolean: "Boolean" },
    swift: { integer: "Int", number: "Double", string: "String", boolean: "Bool" },
    typescript: { integer: "number", number: "number", string: "string", boolean: "boolean" },
  };
  return names[language]?.[type.kind] ?? (type.kind === "string" ? "char*" : type.kind === "boolean" ? "bool" : type.kind === "number" ? "double" : "int");
}

function cStarter({ entry, params, result }) {
  const rendered = [];
  for (const param of params) {
    const type = typeName(param.type, "c");
    rendered.push(`${type} ${param.name}`);
    if (param.type.kind === "array") {
      rendered.push(`int ${param.name}Size`);
      if (param.type.item.kind === "array") rendered.push(`int* ${param.name}ColSize`);
    }
  }
  if (result.kind === "array") {
    rendered.push("int* returnSize");
    if (result.item.kind === "array") rendered.push("int** returnColumnSizes");
  }
  return `${typeName(result, "c")} ${entry}(${rendered.join(", ")}) {\n  \n}`;
}

function jsDoc(params, result) {
  const lines = params.map(({ name, type }) => ` * @param {${typeName(type, "typescript")}} ${name}`);
  lines.push(` * @return {${typeName(result, "typescript")}}`);
  return ["/**", ...lines, " */"].join("\n");
}

function snakeCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function upperFirst(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
