import { describe, expect, it } from "vite-plus/test";
import { compile, completions, renderSource, type FormulaProperty } from "./index.ts";
import { PROJECTS, TASKS, check, makeSchema, schema } from "./testkit.ts";

const names = (renames: Record<string, string>) => (_ds: string, id: string) => renames[id];

describe("renderSource", () => {
  const source = 'prop("Count") + length(prop("Project").map(current.prop("Budget"))) // keep  me';
  const refs = check(source).compiled?.refs ?? [];

  it("returns the source byte for byte when no name changed", () => {
    expect(
      renderSource(
        source,
        refs,
        names({ t_count: "Count", t_project: "Project", p_budget: "Budget" }),
      ),
    ).toBe(source);
    expect(renderSource(source, refs, () => undefined)).toBe(source);
  });

  it("rewrites renamed properties, longer and shorter, leaving everything else alone", () => {
    expect(
      renderSource(source, refs, names({ t_count: "Total number of things", p_budget: "B" })),
    ).toBe(
      'prop("Total number of things") + length(prop("Project").map(current.prop("B"))) // keep  me',
    );
  });

  it("passes the data source and property id of each ref", () => {
    const seen: string[] = [];
    renderSource(source, refs, (ds, id) => {
      seen.push(`${ds}:${id}`);
      return undefined;
    });
    expect(seen.toSorted()).toEqual([
      `${PROJECTS}:p_budget`,
      `${TASKS}:t_count`,
      `${TASKS}:t_project`,
    ]);
  });

  it("quotes names with quotes, backslashes, newlines and unicode so they compile back to the same property", () => {
    for (const name of [
      'Say "hi"',
      "back\\slash",
      "line\nbreak",
      "tab\there",
      "é\u{1F600}",
      "a b",
      "\u0001",
    ]) {
      const rendered = renderSource(
        'prop("Count")',
        check('prop("Count")').compiled?.refs ?? [],
        names({ t_count: name }),
      );
      const s = makeSchema().properties.map((p) => (p.id === "t_count" ? { ...p, name } : p));
      const result = compile(rendered, { ...schema, properties: s });
      expect(result.diagnostics, JSON.stringify(name)).toEqual([]);
      expect(result.compiled?.deps.own).toEqual(["t_count"]);
    }
  });

  it("leaves a literal that already decodes to the current name", () => {
    const text = String.raw`prop("Count")`;
    const r = check(text).compiled?.refs ?? [];
    expect(r).toHaveLength(1);
    expect(renderSource(text, r, names({ t_count: "Count" }))).toBe(text);
  });

  it("ignores refs that do not fit the source", () => {
    const bad = [
      { start: -1, end: 3, dataSourceId: TASKS, propertyId: "t_count" },
      { start: 5, end: 5, dataSourceId: TASKS, propertyId: "t_count" },
      { start: 2, end: 999, dataSourceId: TASKS, propertyId: "t_count" },
    ];
    expect(renderSource("abcdef", bad, () => "X")).toBe("abcdef");
    const overlap = [
      { start: 0, end: 4, dataSourceId: TASKS, propertyId: "a" },
      { start: 2, end: 6, dataSourceId: TASKS, propertyId: "b" },
    ];
    expect(() => renderSource("abcdefgh", overlap, () => "X")).not.toThrow();
  });

  it("round-trips: rendering then compiling keeps the same dependencies", () => {
    const original = check(source).compiled;
    const renamed = makeSchema().properties.map((p) =>
      p.id === "t_count" ? { ...p, name: "Total" } : p,
    );
    const rendered = renderSource(source, refs, names({ t_count: "Total" }));
    const again = compile(rendered, { ...schema, properties: renamed }).compiled;
    expect(again?.deps).toEqual(original?.deps);
    expect(again?.ast).toEqual(original?.ast);
  });
});

describe("completions", () => {
  const at = (source: string, offset = source.length, s = schema) => completions(source, offset, s);
  const labels = (source: string, offset?: number, s = schema) =>
    at(source, offset, s).map((c) => c.label);

  it('offers live properties inside prop("', () => {
    const all = labels('prop("');
    expect(all).toEqual([
      "Name",
      "Count",
      "Done",
      "Due",
      "Tags",
      "Notes",
      "Project",
      "Blocked by",
      "Age",
    ]);
    expect(all).not.toContain("Old");
    expect(all).not.toContain("Bad");
  });

  it("filters by the typed prefix, prefix matches first, and closes an open string", () => {
    expect(labels('prop("Co')).toEqual(["Count"]);
    expect(labels('prop("o')).toEqual(["Count", "Done", "Notes", "Project", "Blocked by"]);
    expect(labels('prop("n')).toEqual(["Name", "Notes", "Count", "Done"]);
    const hit = at('prop("Co')[0];
    expect(hit).toMatchObject({
      kind: "property",
      insert: 'Count"',
      from: 6,
      to: 8,
      detail: "number",
    });
  });

  it("replaces up to the closing quote of a terminated string", () => {
    const source = 'prop("Co") + 1';
    const hit = at(source, 8)[0];
    expect(hit).toMatchObject({ label: "Count", insert: "Count", from: 6, to: 8 });
    expect(source.slice(hit?.from, hit?.to)).toBe("Co");
  });

  it("escapes names in the inserted text", () => {
    const s = makeSchema([{ id: "t_q", name: 'Say "hi"', type: "text" }]);
    expect(at('prop("Say', undefined, s)[0]?.insert).toBe('Say \\"hi\\""');
  });

  it('offers the properties of related databases after .prop("', () => {
    const l = labels('prop("Project").map(current.prop("');
    expect(l).toContain("Budget");
    expect(l).toContain("Tasks");
    expect(l.filter((n) => n === "Name")).toHaveLength(1);
    expect(labels('x.prop("Bu')).toEqual(["Budget"]);
  });

  it("offers nothing inside other strings or numbers", () => {
    expect(at('"abc')).toEqual([]);
    expect(at('upper("abc")', 8)).toEqual([]);
    expect(at("12")).toEqual([]);
    expect(at("1.5")).toEqual([]);
  });

  it("offers functions after a dot, replacing the whole word", () => {
    const l = at('prop("Tags").ma');
    expect(l.map((c) => c.label)).toEqual(expect.arrayContaining(["map", "match", "max"]));
    expect(l.every((c) => c.kind === "function")).toBe(true);
    const map = l.find((c) => c.label === "map");
    expect(map).toMatchObject({ insert: "map(", from: 13, to: 15 });
    expect(map?.detail).toBe("map(list, expression)");
    const mid = at("upper(x).up", 10);
    expect(mid.find((c) => c.label === "upper")).toMatchObject({ from: 9, to: 11 });
    expect(at("x.", 2).length).toBe(50);
  });

  it("offers functions and prop at a bare word", () => {
    const l = labels("if");
    expect(l.slice(0, 2)).toEqual(["if", "ifs"]);
    expect(at("pr").find((c) => c.label === "prop")?.insert).toBe('prop("');
    expect(at("upp(", 3)[0]).toMatchObject({ label: "upper", insert: "upper(", from: 0, to: 3 });
    const mid = at('upper("a")', 3);
    expect(mid.find((c) => c.label === "upper")).toMatchObject({ from: 0, to: 5 });
    expect(at("", 0).length).toBe(50);
    expect(at("1 + ", 4)[0]?.label).toBe("prop");
    expect(at("x", 99)).toBeDefined();
  });

  it("offers let variables only where they are in scope", () => {
    const vars = (s: string) =>
      at(s)
        .filter((c) => c.kind === "variable")
        .map((c) => c.label);
    expect(vars("let(total, 5, to")).toEqual(["total"]);
    expect(vars("let(x, ")).toEqual([]);
    expect(vars("let(x, 1, ")).toEqual(["x"]);
    expect(vars("lets(a, 1, b, 2, ")).toEqual(["b", "a"]);
    expect(vars("lets(a, 1, b, ")).toEqual(["a"]);
    expect(vars("let(x, 1, x) + ")).toEqual([]);
    expect(vars("let(x, 1, let(y, 2, ")).toEqual(["y", "x"]);
    expect(at("let(total, 5, to").find((c) => c.label === "total")?.kind).toBe("variable");
  });

  it("offers current and index only inside a list function", () => {
    const vars = (s: string) =>
      at(s)
        .filter((c) => c.kind === "variable")
        .map((c) => c.label);
    expect(vars('prop("Tags").map(')).toEqual(["current", "index"]);
    expect(vars("[1].map(cu")).toEqual(["current"]);
    expect(vars("map([1], ")).toEqual(["current", "index"]);
    expect(vars("[1].map(current + 1) + ")).toEqual([]);
    expect(vars("cu")).toEqual([]);
    expect(vars("[1].map(1, ")).toEqual([]);
    expect(vars("[1].sort(")).toEqual(["current", "index"]);
  });

  it("works without any related data loaded", () => {
    const s = { ...schema, source: () => undefined };
    expect(labels('x.prop("', undefined, s)).toEqual([]);
    expect(labels('prop("', undefined, s as typeof schema).length).toBeGreaterThan(0);
  });

  it("keeps ranges inside the source", () => {
    for (const source of ['prop("', 'prop("Co', "upper(", "a.b", "let(x, 1, ", "x"]) {
      for (let offset = 0; offset <= source.length; offset += 1) {
        for (const c of completions(source, offset, schema)) {
          expect(c.from).toBeGreaterThanOrEqual(0);
          expect(c.to).toBeGreaterThanOrEqual(c.from);
          expect(c.to).toBeLessThanOrEqual(source.length);
        }
      }
    }
  });

  it("skips deleted and broken properties of related databases", () => {
    const extra: FormulaProperty[] = [
      { id: "p_gone", name: "Gone", type: "text", deleted: true },
      { id: "p_err", name: "Err", type: "any", broken: true },
    ];
    const s = makeSchema([], { [PROJECTS]: [...(schema.source(PROJECTS) ?? []), ...extra] });
    const l = labels('x.prop("', undefined, s);
    expect(l).not.toContain("Gone");
    expect(l).not.toContain("Err");
  });
});
