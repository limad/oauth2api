/**
 * `expose-models` filter for /v1/models. Patterns use `*` as a wildcard
 * (`gemini-3.8-*`, `ag/claude-*`); a leading `!` excludes. Empty list = expose
 * everything. Hiding a model from the list is NOT access control: a request that
 * names it directly is still served.
 */
export type ModelFilter = (id: string) => boolean;

function toRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function compileModelFilter(patterns: readonly string[] | undefined): ModelFilter {
  const includes: RegExp[] = [];
  const excludes: RegExp[] = [];
  for (const raw of patterns ?? []) {
    const p = String(raw).trim();
    if (!p) continue;
    if (p.startsWith("!")) {
      if (p.length > 1) excludes.push(toRegExp(p.slice(1)));
    } else {
      includes.push(toRegExp(p));
    }
  }
  return (id: string) =>
    (includes.length === 0 || includes.some((r) => r.test(id))) &&
    !excludes.some((r) => r.test(id));
}
