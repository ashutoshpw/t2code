import { describe, expect, it } from "vite-plus/test";
import { compile, evaluate, recheck, typeLabel, type FormulaProperty } from "./index.ts";
import {
  PROJECTS,
  TASKS,
  check,
  context,
  errors,
  makeSchema,
  schema,
  taskProps,
} from "./testkit.ts";

const typeOf = (source: string): string => {
  const { compiled, diagnostics } = check(source);
  if (compiled === null) throw new Error(diagnostics.map((d) => d.message).join("|"));
  return typeLabel(compiled.type);
};

const firstError = (source: string, s = schema) => {
  const d = compile(source, s).diagnostics[0];
  if (d === undefined) throw new Error(`no diagnostic for ${source}`);
  return { code: d.code, message: d.message, text: source.slice(d.start, d.end) };
};

describe("types", () => {
  it.each([
    ["1", "number"],
    ['"a"', "text"],
    ["true", "boolean"],
    ["[]", "list of empty"],
    ["[1, 2]", "list of number"],
    ['[1, "a"]', "list of any"],
    ['prop("Count")', "number"],
    ['prop("Tags")', "list of text"],
    ['prop("Project")', "list of page"],
    ['prop("Due")', "date"],
    ['prop("Count") + 1', "number"],
    ['prop("Name") + 1', "text"],
    ['1 + prop("Name")', "text"],
    ['prop("Count") > 1', "boolean"],
    ["now()", "date"],
    ['prop("Tags").map(upper(current))', "list of text"],
    ['prop("Tags").map(length(current))', "list of number"],
    ['prop("Tags").filter(current == "a")', "list of text"],
    ['prop("Tags").find(current == "a")', "text"],
    ['prop("Tags").first()', "text"],
    ["[[1], [2]].flat()", "list of number"],
    ["[1].flat()", "list of number"],
    ["concat([1], [2])", "list of number"],
    ["if(true, [], [1])", "list of number"],
    ["if(true, 1, empty())", "number"],
    ["ifs(true, 1, false, 2)", "number"],
    ["ifs(true, 1, false, 2, 3)", "number"],
    ["empty()", "empty"],
    ["empty(1)", "boolean"],
    ["let(x, 1, x)", "number"],
    ['let(x, 1, let(x, "a", x))', "text"],
    ["lets(a, 1, b, a + 1, b)", "number"],
    ['prop("Project").map(current.prop("Budget"))', "list of number"],
    ['prop("Project").first().prop("Name")', "text"],
    ['prop("Project").map(current.prop("Tasks"))', "list of list of page"],
    ["[1, 2].map(index)", "list of number"],
    ["id()", "text"],
    ['prop("Project").first().id()', "text"],
    ["min(1, [2, 3])", "number"],
    ["pi()", "number"],
  ])("types %s as %s", (source, expected) => {
    expect(typeOf(source)).toBe(expected);
  });

  it("unifies empty and any with other types", () => {
    expect(typeOf('if(true, prop("Count"), empty())')).toBe("number");
    expect(typeOf('prop("Count") + empty()')).toBe("number");
    expect(typeOf('[prop("Count")] == []')).toBe("boolean");
  });

  it("types a property of unknown result as any and lets any through", () => {
    const anyProp: FormulaProperty = { id: "t_any", name: "Loose", type: "any" };
    const s = makeSchema([anyProp]);
    const result = compile('prop("Loose") + 1', s);
    expect(result.compiled && typeLabel(result.compiled.type)).toBe("any");
    expect(compile('upper(prop("Loose"))', s).diagnostics).toEqual([]);
    expect(compile('if(prop("Loose"), 1, 2)', s).diagnostics).toEqual([]);
    expect(compile('prop("Loose") == 1', s).diagnostics).toEqual([]);
  });
});

describe("type errors", () => {
  it.each([
    ['prop("Due") + 1', "Cannot use + on date and number."],
    ['prop("Tags") + prop("Tags")', "Cannot use + on list of text and list of text."],
    ['prop("Count") - "a"', "Cannot use - on number and text."],
    ["true * 2", "Cannot use * on boolean and number."],
    ["if(1, 2, 3)", "if expects boolean here, got number."],
    ['if(true, 1, "a")', "Both results of if must be the same type, got number and text."],
    ['true ? 1 : "a"', "Both results of if must be the same type, got number and text."],
    ['1 == "a"', "Cannot compare number with text."],
    ['prop("Tags") == "x"', "Cannot compare list of text with text."],
    ['prop("Tags") < prop("Tags")', "Cannot compare list of text with list of text."],
    ['1 < "a"', "Cannot compare number with text."],
    ["1 and true", "and expects boolean here, got number."],
    ["1 && true", "&& expects boolean here, got number."],
    ["not 1", "not expects boolean here, got number."],
    ["upper(1)", "upper expects text here, got number."],
    ['substring("a", "b")', "substring expects number here, got text."],
    ['dateAdd(1, 1, "days")', "dateAdd expects date here, got number."],
    ["length(1)", "length expects text or list here, got number."],
    ['sum("a")', "sum expects number here, got text."],
    ['first("a")', "first expects list here, got text."],
    ['includes([1], "a")', "Cannot compare number with text."],
    ["[1].filter(current)", "filter expects boolean here, got number."],
    ['[1].map(current + "a").sort().first() * 2', "Cannot use * on text and number."],
    ['prop("Name").prop("X")', "prop expects page here, got text."],
    [
      'prop("Project").prop("Budget")',
      "This is a list of pages. Use map to read a property of each page.",
    ],
    ["concat(1, [2])", "concat expects list here, got number."],
    ["id(1)", "id expects page here, got number."],
  ])("rejects %s", (source, message) => {
    expect(errors(source)).toEqual([message]);
  });

  it("points type errors at the offending argument or operator call", () => {
    expect(firstError("upper(1)")).toMatchObject({ text: "1" });
    expect(firstError('substring("a", "b")')).toMatchObject({ text: '"b"' });
    expect(firstError('if(true, 1, "a")')).toMatchObject({ text: '"a"' });
    expect(firstError("1 + true").text).toBe("1 + true");
  });

  it("reports every independent error, in source order", () => {
    expect(errors("upper(1) + lower(2) + nope(3)")).toEqual([
      "upper expects text here, got number.",
      "lower expects text here, got number.",
      'There is no function named "nope".',
    ]);
  });

  it("does not cascade an error into its parents", () => {
    expect(errors("upper(nope) + 1")).toEqual(['"nope" is not defined.']);
    expect(errors('prop("Nope").map(current)')).toEqual(['There is no property named "Nope".']);
  });
});

describe("names and arity", () => {
  it("rejects unknown functions at the name", () => {
    expect(firstError("foo(1)")).toEqual({
      code: "unknown_function",
      message: 'There is no function named "foo".',
      text: "foo",
    });
    expect(firstError("1.5.nope()")).toMatchObject({ code: "unknown_function" });
  });

  it.each([
    ['prop("Nope")', 'There is no property named "Nope".'],
    ['prop("Old")', 'The property "Old" was deleted.'],
    ['prop("Bad")', 'The property "Bad" has an error.'],
    ['prop("Project").first().prop("Missing")', 'There is no property named "Missing".'],
  ])("explains the property %s", (source, message) => {
    const error = firstError(source);
    expect(error.code).toBe("unknown_property");
    expect(error.message).toBe(message);
    expect(error.text.startsWith('"')).toBe(true);
  });

  it("matches property names exactly", () => {
    expect(errors('prop("count")')).toEqual(['There is no property named "count".']);
    expect(errors('prop("Count ")')).toHaveLength(1);
  });

  it.each([
    ['substring("a")', "substring takes 2 to 3 arguments, got 1."],
    ['upper("a", "b")', "upper takes 1 argument, got 2."],
    ["pi(1)", "pi takes 0 arguments, got 1."],
    ["let(x, 1)", "let takes 3 arguments, got 2."],
    ["lets(a, 1)", "lets takes an odd number of arguments (at least 3), got 2."],
    ["lets(a, 1, b, 2)", "lets takes an odd number of arguments (at least 3), got 4."],
    ["if(true, 1)", "if takes 3 arguments, got 2."],
    ["and(true)", "and takes at least 2 arguments, got 1."],
    ["min()", "min takes at least 1 argument, got 0."],
    ["now(1)", "now takes 0 arguments, got 1."],
  ])("counts the arguments of %s", (source, message) => {
    expect(errors(source)).toEqual([message]);
    expect(firstError(source).code).toBe("arity");
  });

  it("accepts people functions as unsupported", () => {
    expect(firstError('name(prop("Name"))')).toMatchObject({
      code: "unsupported",
      message: "People properties are not supported.",
    });
    expect(firstError('email("x")').code).toBe("unsupported");
  });

  it("rejects current and index outside a lambda", () => {
    expect(firstError("current")).toEqual({
      code: "unknown_variable",
      message: '"current" can only be used inside a list function such as map or filter.',
      text: "current",
    });
    expect(errors("index + 1")).toEqual([
      '"index" can only be used inside a list function such as map or filter.',
    ]);
    expect(errors("[1].map(2) + current")).toHaveLength(1);
  });

  it("rejects undefined variables", () => {
    expect(firstError("x + 1")).toMatchObject({
      code: "unknown_variable",
      message: '"x" is not defined.',
    });
    expect(errors("let(x, 1, 2) + x")).toEqual(['"x" is not defined.']);
    expect(errors("lets(a, b, b, 1, a)")).toEqual(['"b" is not defined.']);
  });

  it("requires plain names in let", () => {
    expect(errors("let(current, 1, 2)")).toEqual(["Expected a variable name."]);
    expect(errors("let(true, 1, 2)")).toEqual(["Expected a variable name."]);
    expect(errors("let(1, 1, 2)")).toEqual(["Expected a variable name."]);
    expect(errors("lets(a, 1, index, 2, a)")).toEqual(["Expected a variable name."]);
  });

  it("scopes let bindings to their body and lets them shadow", () => {
    expect(errors("let(x, 1, x + 1)")).toEqual([]);
    expect(errors("lets(a, 1, b, a + 1, a + b)")).toEqual([]);
    expect(typeOf('let(x, 1, [x].map(let(x, "a", x)))')).toBe("list of text");
  });

  it("lets nested lambdas shadow current and index", () => {
    expect(typeOf("[[1, 2], [3]].map(current.map(current + 1))")).toBe("list of list of number");
    expect(typeOf('[["a"]].map(current.map(index))')).toBe("list of list of number");
    expect(errors("[[true]].map(current.map(current + 1))")).toEqual([
      "Cannot use + on boolean and number.",
    ]);
    expect(typeOf('[["a"]].map(current.map(current + 1))')).toBe("list of list of text");
  });

  it("checks regex and unit and style literals", () => {
    expect(errors('test("a", "(?=b)")')).toEqual([
      "Unsupported regular expression: lookahead is not supported.",
    ]);
    expect(errors(String.raw`test("a", "(\\1)")`)).toEqual([
      "Unsupported regular expression: backreferences are not supported.",
    ]);
    expect(errors('replace("a", "(", "b")')).toEqual([
      "Unsupported regular expression: missing ).",
    ]);
    expect(errors('dateAdd(now(), 1, "fortnights")')).toEqual(['Unknown unit "fortnights".']);
    expect(errors('dateBetween(now(), now(), "decades")')).toEqual(['Unknown unit "decades".']);
    expect(errors('style("a", "sparkly")')).toEqual(['Unknown style "sparkly".']);
    expect(errors('dateAdd(now(), 1, prop("Name"))')).toEqual([]);
    expect(errors('test("a", prop("Name"))')).toEqual([]);
  });
});

describe("relations", () => {
  it("reads one relation away", () => {
    expect(errors('prop("Project").map(current.prop("Budget"))')).toEqual([]);
    expect(errors('prop("Project").first().prop("Name")')).toEqual([]);
    expect(errors('prop("Project").map(current.prop("Tasks")).flat().length()')).toEqual([]);
  });

  it("rejects a second hop with the database name when known", () => {
    expect(errors('prop("Project").map(current.prop("Tasks").map(current.prop("Count")))')).toEqual(
      [
        "Formulas can read properties one relation away. Add a formula or rollup on that database to reach further.",
      ],
    );
    const named = makeSchema([], {});
    const withName = {
      ...named,
      databaseName: (id: string) => (id === TASKS ? "Tasks" : undefined),
    };
    expect(
      compile('prop("Project").map(current.prop("Tasks").map(current.prop("Count")))', withName)
        .diagnostics[0]?.message,
    ).toBe(
      'Formulas can read properties one relation away. Add a formula or rollup on "Tasks" to reach further.',
    );
  });

  it("allows counting, picking and comparing far pages but not reading or printing them", () => {
    expect(errors('prop("Project").map(current.prop("Tasks").length())')).toEqual([]);
    expect(errors('prop("Project").map(current.prop("Tasks").first())')).toEqual([]);
    expect(errors('prop("Project").map(id(current.prop("Tasks").first()))')).toEqual([]);
    expect(
      errors('prop("Project").map(current.prop("Tasks").includes(first(prop("Blocked by"))))'),
    ).toEqual([]);
    expect(errors('prop("Project").map(format(current.prop("Tasks")))')).toEqual([
      "Pages from a related database cannot be converted to text.",
    ]);
    expect(errors('prop("Project").map(join(current.prop("Tasks"), ","))')).toEqual([
      "Pages from a related database cannot be converted to text.",
    ]);
    expect(errors('prop("Project").map("x" + current.prop("Tasks").first())')).toEqual([
      "Pages from a related database cannot be converted to text.",
    ]);
  });

  it("allows formatting pages reached directly", () => {
    expect(errors('format(prop("Project"))')).toEqual([]);
    expect(errors('join(prop("Project"), ", ")')).toEqual([]);
  });

  it("fails when the target data source is not loaded", () => {
    const s = { ...schema, source: () => undefined };
    expect(compile('prop("Project").map(current.prop("Budget"))', s).diagnostics[0]?.message).toBe(
      "The properties of that database are not available.",
    );
  });
});

describe("volatility", () => {
  it.each([
    ["now()", true],
    ["today()", true],
    ['prop("Age") + 1', true],
    ['dateBetween(prop("Due"), today(), "days")', true],
    ['prop("Count")', false],
    ['prop("Due")', false],
    ["1", false],
    ["", false],
  ])("marks %s volatile=%s", (source, volatile) => {
    expect(check(source).compiled?.volatile).toBe(volatile);
  });

  it("rejects reading a volatile property through a relation", () => {
    expect(errors('prop("Project").map(current.prop("Aged"))')).toEqual([
      "A property that uses now() or today() cannot be read from another page.",
    ]);
  });
});

describe("dependencies", () => {
  it("lists own properties once, in first-use order", () => {
    const own = check('prop("Count") + prop("Count") + length(prop("Name"))').compiled?.deps;
    expect(own).toEqual({ own: ["t_count", "t_name"], related: [] });
  });

  it("lists related reads per relation with the title always included", () => {
    const deps = check('prop("Project").map(current.prop("Budget") + current.prop("Budget"))')
      .compiled?.deps;
    expect(deps).toEqual({
      own: ["t_project"],
      related: [
        {
          relationPropertyId: "t_project",
          dataSourceId: PROJECTS,
          propertyIds: ["p_budget", "title"],
        },
      ],
    });
    expect(check('prop("Project").length()').compiled?.deps).toEqual({
      own: ["t_project"],
      related: [
        { relationPropertyId: "t_project", dataSourceId: PROJECTS, propertyIds: ["title"] },
      ],
    });
  });

  it("attributes page reads to every own relation to that data source", () => {
    const s = makeSchema([
      { id: "t_second", name: "Second", type: { list: { page: PROJECTS } }, relationTo: PROJECTS },
    ]);
    const deps = compile('prop("Project").first().prop("Budget") + length(prop("Second"))', s)
      .compiled?.deps;
    expect(deps?.related.map((r) => r.relationPropertyId).toSorted()).toEqual([
      "t_project",
      "t_second",
    ]);
    expect(deps?.related.every((r) => r.propertyIds.includes("p_budget"))).toBe(true);
  });

  it("records one ref per prop literal with its span and property", () => {
    const source = 'prop("Count") + prop("Project").first().prop("Budget")';
    const refs = check(source).compiled?.refs ?? [];
    expect(refs.map((r) => [source.slice(r.start, r.end), r.dataSourceId, r.propertyId])).toEqual([
      ['"Count"', TASKS, "t_count"],
      ['"Project"', TASKS, "t_project"],
      ['"Budget"', PROJECTS, "p_budget"],
    ]);
  });

  it("compiles the empty source to the empty value", () => {
    const compiled = check("  ").compiled;
    expect(compiled).toMatchObject({
      type: "empty",
      deps: { own: [], related: [] },
      volatile: false,
    });
    expect(compiled && evaluate(compiled, context())).toBeNull();
  });
});

describe("recheck and renames", () => {
  const source = 'prop("Count") + 1 + length(prop("Project"))';

  it("rebuilds the same result from the stored tree", () => {
    const compiled = check(source).compiled;
    if (compiled === null) throw new Error("compile");
    expect(recheck(compiled, schema).compiled).toEqual(compiled);
  });

  it("keeps no property names in the stored tree and survives a rename", () => {
    const compiled = check('prop("Count") * 2').compiled;
    if (compiled === null) throw new Error("compile");
    expect(JSON.stringify(compiled.ast)).not.toContain("Count");
    const renamed = makeSchema().properties.map((p) =>
      p.id === "t_count" ? { ...p, name: "Total" } : p,
    );
    const s = { ...schema, properties: renamed };
    const again = recheck(compiled, s);
    expect(again.diagnostics).toEqual([]);
    const store = { row1: { t_count: 21 } };
    expect(again.compiled && evaluate(again.compiled, context(store))).toBe(42);
    expect(evaluate(compiled, context(store))).toBe(42);
    expect(compile('prop("Count") * 2', s).diagnostics).toHaveLength(1);
    expect(compile('prop("Total") * 2', s).diagnostics).toEqual([]);
  });

  it("reports a deleted input at its original span", () => {
    const compiled = check(source).compiled;
    if (compiled === null) throw new Error("compile");
    const s = {
      ...schema,
      properties: taskProps.map((p) => (p.id === "t_count" ? { ...p, deleted: true } : p)),
    };
    const result = recheck(compiled, s);
    expect(result.compiled).toBeNull();
    const d = result.diagnostics[0];
    expect(d?.message).toBe('The property "Count" was deleted.');
    expect(d && source.slice(d.start, d.end)).toBe('"Count"');
  });

  it("reports an input that now has an error, and one that is gone entirely", () => {
    const compiled = check(source).compiled;
    if (compiled === null) throw new Error("compile");
    const broken = {
      ...schema,
      properties: taskProps.map((p) => (p.id === "t_count" ? { ...p, broken: true } : p)),
    };
    expect(recheck(compiled, broken).diagnostics[0]?.message).toBe(
      'The property "Count" has an error.',
    );
    const gone = { ...schema, properties: taskProps.filter((p) => p.id !== "t_count") };
    expect(recheck(compiled, gone).diagnostics[0]?.message).toBe(
      'There is no property named "t_count".',
    );
  });

  it("re-decides number addition versus text joining when an input changes type", () => {
    const compiled = check('prop("Count") + 1').compiled;
    if (compiled === null) throw new Error("compile");
    expect(compiled.type).toBe("number");
    const retyped = {
      ...schema,
      properties: taskProps.map((p) => (p.id === "t_count" ? { ...p, type: "text" as const } : p)),
    };
    const again = recheck(compiled, retyped);
    expect(again.compiled?.type).toBe("text");
    expect(again.compiled && evaluate(again.compiled, context({ row1: { t_count: "x" } }))).toBe(
      "x1",
    );
    const back = again.compiled && recheck(again.compiled, schema);
    expect(back?.compiled?.type).toBe("number");
  });

  it("fails when an input changes to a type the formula cannot use", () => {
    const compiled = check('upper(prop("Name"))').compiled;
    if (compiled === null) throw new Error("compile");
    const retyped = {
      ...schema,
      properties: taskProps.map((p) => (p.id === "t_name" ? { ...p, type: "number" as const } : p)),
    };
    expect(recheck(compiled, retyped).diagnostics[0]?.message).toBe(
      "upper expects text here, got number.",
    );
  });

  it("picks up a relation retarget", () => {
    const compiled = check('prop("Project").map(current.prop("Budget"))').compiled;
    if (compiled === null) throw new Error("compile");
    const s = { ...schema, source: (id: string) => (id === PROJECTS ? [] : schema.source(id)) };
    expect(recheck(compiled, s).diagnostics[0]?.code).toBe("unknown_property");
  });
});
