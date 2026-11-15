/**
 * Claude refuses a whole request when one tool declares an `input_schema`
 * property key outside ^[a-zA-Z0-9_.-]{1,64}$, while MCP servers and
 * OpenAI-style clients commonly use names such as "not[labels]". Clients resend
 * their tools on every turn, so one such tool breaks the whole conversation.
 *
 * Such a tool is sent with an open object schema and its original schema
 * embedded verbatim in the description (port of CLIProxyAPI f0c9c2d0, #7389).
 * Nothing is renamed or dropped: the model sees every original name and
 * constraint and calls the tool with the original names, so neither past
 * tool_use inputs nor tool calls in responses need rewriting. Claude no longer
 * enforces that schema structurally, so `strict` is removed. Tools Claude
 * accepts are left byte-identical.
 */

const PROPERTY_KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const MAX_INSPECT_DEPTH = 256;
const FALLBACK_PREFIX =
  "The input object must conform to the following JSON Schema. Use its property names exactly as written, including any characters such as brackets:\n";

const isObject = (v: any): boolean =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * True when the schema, or a subschema reached through JSON Schema applicator
 * and definition keywords, declares a `properties` key Claude refuses. Keywords
 * are only read at schema positions: values of const/default/enum/examples and
 * unknown annotations are data. Schemas nested beyond the inspection depth are
 * reported as rejected so they take the fallback, which keeps the full text.
 */
function hasRejectedPropertyKey(schema: any, depth = 0): boolean {
  if (!isObject(schema)) return false;
  if (depth > MAX_INSPECT_DEPTH) return true;
  const sub = (v: any) => hasRejectedPropertyKey(v, depth + 1);
  const subs = (v: any) =>
    (Array.isArray(v) ? v : isObject(v) ? Object.values(v) : []).some(sub);
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case "properties":
        if (!isObject(value)) break;
        for (const [name, item] of Object.entries(value as object)) {
          if (!PROPERTY_KEY_RE.test(name) || sub(item)) return true;
        }
        break;
      // Maps of named subschemas (dependencies may also hold name arrays).
      case "$defs":
      case "definitions":
      case "patternProperties":
      case "dependentSchemas":
      case "dependencies":
        if (isObject(value) && subs(value)) return true;
        break;
      case "allOf":
      case "anyOf":
      case "oneOf":
      case "prefixItems":
        if (Array.isArray(value) && subs(value)) return true;
        break;
      case "items":
        if (Array.isArray(value) ? subs(value) : sub(value)) return true;
        break;
      case "additionalProperties":
      case "unevaluatedProperties":
      case "additionalItems":
      case "unevaluatedItems":
      case "contains":
      case "propertyNames":
      case "not":
      case "if":
      case "then":
      case "else":
      case "contentSchema":
        if (sub(value)) return true;
        break;
    }
  }
  return false;
}

/** Client tools only: server tools (web_search_*, bash_*...) carry no input_schema of ours. */
function needsFallback(tool: any): boolean {
  if (!isObject(tool)) return false;
  if (tool.type && tool.type !== "custom") return false;
  return isObject(tool.input_schema) && hasRejectedPropertyKey(tool.input_schema);
}

function withFallback(tool: any): any {
  const existing =
    typeof tool.description === "string" && tool.description.trim()
      ? `${tool.description}\n\n`
      : "";
  const { strict: _strict, ...rest } = tool;
  return {
    ...rest,
    description: existing + FALLBACK_PREFIX + JSON.stringify(tool.input_schema),
    input_schema: { type: "object" },
  };
}

/**
 * Returns the body unchanged when every tool is accepted, otherwise a copy with
 * the fallback applied to `tools[]` and to inline `tool_addition` definitions.
 */
export function normalizeClaudeToolPropertyNames(body: any): any {
  if (!isObject(body)) return body;
  let out = body;
  if (Array.isArray(body.tools) && body.tools.some(needsFallback)) {
    out = {
      ...out,
      tools: body.tools.map((t: any) => (needsFallback(t) ? withFallback(t) : t)),
    };
  }
  if (Array.isArray(body.messages)) {
    let changed = false;
    const messages = body.messages.map((m: any) => {
      if (!Array.isArray(m?.content)) return m;
      let partChanged = false;
      const content = m.content.map((part: any) => {
        if (
          part?.type !== "tool_addition" ||
          part.tool?.type !== "tool_definition" ||
          !needsFallback(part.tool.definition)
        ) {
          return part;
        }
        partChanged = true;
        return {
          ...part,
          tool: { ...part.tool, definition: withFallback(part.tool.definition) },
        };
      });
      if (!partChanged) return m;
      changed = true;
      return { ...m, content };
    });
    if (changed) out = { ...out, messages };
  }
  return out;
}
