import { knownProperty } from "@t2code/client-runtime/spaces";
import type { SpaceCellValue, SpaceDatabaseProperty } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { CellValue } from "./CellValue";
import { cellPlainText, type CellTextContext } from "./format";

const property = (type: "formula" | "rollup", config: unknown, computed: Record<string, unknown>) =>
  knownProperty({
    id: "p1",
    name: "Computed",
    type,
    config,
    position: 0,
    computed,
  } as unknown as SpaceDatabaseProperty)!;

const formula = (computed: Record<string, unknown> = { resultType: "text" }, extra = {}) =>
  property("formula", { expression: "1", ...extra }, computed);
const context: CellTextContext = {
  relatedPages: {
    r1: { title: "Alpha", dataSourceId: "ds" },
    r2: { title: "", dataSourceId: "ds" },
  } as never,
  optionHint: () => undefined,
  timeZone: "UTC",
};

async function show(known: ReturnType<typeof formula>, value: SpaceCellValue | undefined) {
  return render(
    <CellValue
      known={known}
      value={value}
      relatedPages={context.relatedPages}
      variant="cell"
      optionHint={context.optionHint}
      timeZone="UTC"
    />,
    { router: false },
  );
}

describe("computed cell values", () => {
  it("shows text, with a color as a chip", async () => {
    await using _plain = await show(formula(), { type: "string", value: "hello" });
    await expect.element(page.getByText("hello")).toBeVisible();
    await using _chip = await show(formula(), { type: "string", value: "Urgent", color: "red" });
    await expect.element(page.getByText("Urgent")).toBeVisible();
  });

  it("formats numbers with the property's format and decimals", async () => {
    const known = formula({ resultType: "number" }, { format: "dollar", decimals: 2 });
    await using _screen = await show(known, { type: "number", value: 1234.5 });
    await expect.element(page.getByText("$1,234.50")).toBeVisible();
    expect(cellPlainText({ type: "number", value: 1234.5 }, known, context)).toBe("$1,234.50");
  });

  it("shows percent rollups as percentages", async () => {
    const known = property(
      "rollup",
      { relationPropertyId: "r", targetPropertyId: "title", function: "percent_checked" },
      { resultType: "number" },
    );
    await using _screen = await show(known, { type: "number", value: 0.25 });
    await expect.element(page.getByText("25%")).toBeVisible();
  });

  it("shows a boolean as a read-only checkbox, unchecked when there is no value", async () => {
    const known = formula({ resultType: "boolean" });
    await using _checked = await show(known, { type: "boolean", value: true });
    await expect.element(page.getByRole("img", { name: "Checked" })).toBeVisible();
    await using _empty = await show(known, undefined);
    await expect.element(page.getByRole("img", { name: "Unchecked" })).toBeInTheDocument();
  });

  it("shows dates, pages and lists, and marks a truncated list", async () => {
    await using _date = await show(formula({ resultType: "date" }), {
      type: "date",
      value: { start: "2026-03-10" },
    });
    await expect.element(page.getByText(/Mar/)).toBeVisible();
    const list = {
      type: "array",
      truncated: true,
      value: [
        { type: "page", value: "r1" },
        { type: "page", value: "r2" },
      ],
    } satisfies SpaceCellValue;
    await using _list = await show(formula({ resultType: { list: { page: "ds" } } }), list);
    await expect.element(page.getByText("Alpha")).toBeVisible();
    await expect.element(page.getByText("Untitled")).toBeVisible();
    expect(cellPlainText(list, formula(), context)).toBe("Alpha, Untitled, …");
  });

  it("shows a muted error for a property in error, with its message as a tooltip", async () => {
    const known = formula({ resultType: "text", error: { message: "The property was deleted." } });
    await using _screen = await show(known, undefined);
    await expect.element(page.getByText("Error")).toBeVisible();
  });
});
