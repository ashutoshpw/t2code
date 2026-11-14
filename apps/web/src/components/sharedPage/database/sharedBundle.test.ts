// @effect-diagnostics nodeBuiltinImport:off - reads the viewer's own source files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

// The public viewer may reuse these read-only primitives and nothing else of the database UI.
const ALLOWED_DATABASE_IMPORTS = new Set([
  "~/spaces/databases/primitives/CellValue",
  "~/spaces/databases/primitives/ComputedValue",
  "~/spaces/databases/primitives/OptionChip",
  "~/spaces/databases/primitives/TextRuns",
  "~/spaces/databases/primitives/colors",
  "~/spaces/databases/primitives/coverSource",
  "~/spaces/databases/chart/ChartSvg",
  "~/spaces/databases/chart/chartColors",
  "~/spaces/databases/form/FormFields",
]);
const FORBIDDEN = [
  /\/rpc\//,
  /^~\/state\//,
  /^~\/environments?\//,
  /client-runtime\/state/,
  /DatabaseBlock$/,
  /\/data\//,
  /\/cells\//,
  /\/row\//,
  /parseCell|dateValue|\/errors$/,
];

const sources = NodeFS.readdirSync(here)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser\.test|testkit)\.tsx?$/.test(file))
  .map((file) => ({ file, text: NodeFS.readFileSync(NodePath.join(here, file), "utf8") }));

const specifiers = (text: string) =>
  [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]!);

describe("shared database viewer imports", () => {
  it("finds the viewer's files", () => {
    expect(sources.length).toBeGreaterThan(8);
  });

  it.each(sources)("$file reaches only read-only database modules", ({ text }) => {
    for (const specifier of specifiers(text)) {
      if (specifier.startsWith("~/spaces/databases/"))
        expect(ALLOWED_DATABASE_IMPORTS).toContain(specifier);
      for (const pattern of FORBIDDEN) expect(specifier).not.toMatch(pattern);
    }
  });
});

// The static import closure of the page the public viewer loads, following relative, `~/` and
// workspace-package imports. Dynamic `import()` and type-only imports are not part of it, and a
// barrel is followed only through the names a file asks it for, as a bundler tree-shakes it.
const webSrc = NodePath.resolve(here, "../../..");
const repoRoot = NodePath.resolve(webSrc, "../../..");
const sharedPage = NodePath.join(webSrc, "components/sharedPage/SharedPage.tsx");

const FORBIDDEN_FILES = [
  "apps/web/src/spaces/sessionRuntime.ts",
  "apps/web/src/spaces/draftStore.ts",
  "apps/web/src/spaces/imageDraftStore.ts",
  "apps/web/src/spaces/structureDraftStore.ts",
  "apps/web/src/spaces/draftDatabase.ts",
  "packages/client-runtime/src/spaces/databases/writer.ts",
  "packages/client-runtime/src/spaces/databases/querySession.ts",
];

const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const isFile = (path: string) => NodeFS.existsSync(path) && NodeFS.statSync(path).isFile();
const firstFile = (base: string) =>
  EXTENSIONS.map((extension) => base + extension).find((path) => isFile(path));

const packageEntry = (specifier: string) => {
  const [, name, ...rest] = specifier.split("/");
  const dir = NodePath.join(repoRoot, "packages", name!);
  const manifest = NodePath.join(dir, "package.json");
  if (!NodeFS.existsSync(manifest)) return undefined;
  const { exports } = JSON.parse(NodeFS.readFileSync(manifest, "utf8")) as {
    exports?: Record<string, { default?: string } | string>;
  };
  const entry = exports?.[rest.length === 0 ? "." : `./${rest.join("/")}`];
  const target = typeof entry === "string" ? entry : entry?.default;
  return target === undefined ? undefined : firstFile(NodePath.join(dir, target));
};

const resolveSpecifier = (from: string, specifier: string) => {
  const bare = specifier.split("?")[0]!;
  if (bare.startsWith(".")) return firstFile(NodePath.resolve(NodePath.dirname(from), bare));
  if (bare.startsWith("~/")) return firstFile(NodePath.join(webSrc, bare.slice(2)));
  if (bare.startsWith("@t2code/")) return packageEntry(bare);
  return undefined;
};

interface Edge {
  readonly specifier: string;
  /** Names a re-export or import asks for; "all" for a namespace, default, bare or `export *`. */
  readonly names: readonly string[] | "all";
  readonly reexport: boolean;
}

const STATEMENT = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;"'`]*?)\s*from\s*["']([^"']+)["']/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;

const edgesOf = (text: string): readonly Edge[] => {
  const edges: Edge[] = [];
  for (const [, keyword, typeOnly, clause, specifier] of text.matchAll(STATEMENT)) {
    if (typeOnly !== undefined) continue;
    const braces = /\{([^}]*)\}/.exec(clause!);
    const hasDefaultOrNamespace = /^\s*[\w$]+\s*,|^\s*\*|^[\w$]+$/.test(clause!);
    const names = (braces?.[1] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "" && !part.startsWith("type "))
      .map((part) =>
        keyword === "export" ? part.split(/\s+as\s+/).at(-1)! : part.split(/\s+as\s+/)[0]!,
      );
    if (braces !== null && names.length === 0 && !hasDefaultOrNamespace) continue;
    edges.push({
      specifier: specifier!,
      names: braces === null || hasDefaultOrNamespace ? "all" : names,
      reexport: keyword === "export",
    });
  }
  for (const match of text.matchAll(BARE_IMPORT))
    edges.push({ specifier: match[1]!, names: "all", reexport: false });
  return edges;
};

const read = (path: string) => NodeFS.readFileSync(path, "utf8");

/** Whether `file` (or what it re-exports) declares `name`, read from its source text. */
const declares = (file: string, name: string, seen = new Set<string>()): boolean => {
  if (seen.has(file)) return false;
  seen.add(file);
  const text = read(file);
  const own = new RegExp(
    `export\\s+(?:declare\\s+)?(?:async\\s+)?(?:const|let|var|function\\*?|class|abstract\\s+class|enum)\\s+${name}\\b`,
  );
  const listed = [...text.matchAll(/export\s*\{([^}]*)\}/g)].some((match) =>
    match[1]!.split(",").some(
      (part) =>
        part
          .trim()
          .split(/\s+as\s+/)
          .at(-1) === name,
    ),
  );
  if (own.test(text) || listed) return true;
  return edgesOf(text).some((edge) => {
    if (!edge.reexport) return false;
    const target = resolveSpecifier(file, edge.specifier);
    if (target === undefined) return false;
    return edge.names === "all" ? declares(target, name, seen) : edge.names.includes(name);
  });
};

const closureOf = (entry: string) => {
  const reached = new Map<string, Set<string> | "all">();
  const via = new Map<string, string>();
  const walk = (file: string, wanted: readonly string[] | "all", parent?: string) => {
    if (parent !== undefined && !via.has(file)) via.set(file, parent);
    const known = reached.get(file);
    if (known === "all") return;
    const before = known?.size ?? -1;
    if (wanted === "all") reached.set(file, "all");
    else {
      const merged = known ?? new Set<string>();
      for (const name of wanted) merged.add(name);
      reached.set(file, merged);
      if (merged.size === before) return;
    }
    const now = reached.get(file)!;
    for (const edge of edgesOf(read(file))) {
      const target = resolveSpecifier(file, edge.specifier);
      if (target === undefined || !/\.tsx?$/.test(target)) continue;
      if (!edge.reexport) {
        walk(target, edge.names, file);
        continue;
      }
      const asked =
        now === "all"
          ? edge.names === "all"
            ? "all"
            : edge.names
          : edge.names === "all"
            ? [...now].filter((name) => declares(target, name))
            : edge.names.filter((name) => now.has(name));
      if (asked === "all" || asked.length > 0) walk(target, asked, file);
    }
  };
  walk(entry, "all");
  const chain = (file: string): string[] => {
    const parent = via.get(file);
    return [...(parent === undefined ? [] : chain(parent)), NodePath.relative(repoRoot, file)];
  };
  return [...reached.keys()].map((file) => ({
    file: NodePath.relative(repoRoot, file),
    chain: chain(file).join(" -> "),
  }));
};

describe("shared page import closure", () => {
  const closure = closureOf(sharedPage);

  it("walks the editor the viewer renders pages with", () => {
    expect(closure.map((entry) => entry.file)).toContain("apps/web/src/spaces/SpaceEditor.tsx");
    expect(closure.length).toBeGreaterThan(40);
  });

  it("loads the database and row views on demand", () => {
    const files = closure.map((entry) => entry.file);
    for (const lazy of ["SharedDatabase.tsx", "SharedRowPage.tsx"])
      expect(files).not.toContain(`apps/web/src/components/sharedPage/database/${lazy}`);
  });

  it("never reaches the signed-in editor's data layer", () => {
    expect(
      closure
        .filter(
          ({ file }) =>
            FORBIDDEN_FILES.includes(file) ||
            file.startsWith("apps/web/src/spaces/databases/data/"),
        )
        .map((entry) => entry.chain),
    ).toEqual([]);
  });
});
