import { EnvironmentId } from "@t2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chartQueryInput, chartSetup, chartValueText } from "./chartPanel";
import { dataSource, property, view } from "./databaseFixtures.test-support";

const options = [{ id: "todo1", name: "Todo", color: "red", group: "todo" }];
const source = dataSource([
  property("title", "Name", "title"),
  property("status", "Status", "status", { options }),
  property("points", "Points", "number", { format: "number" }),
]);
const environmentId = EnvironmentId.make("env1");
const opts = { environmentId, timeZone: "UTC" };
const group = { property: "status", by: "option" };

describe("chartQueryInput", () => {
  it("asks for buckets only, with the y aggregate", () => {
    const input = chartQueryInput(
      view("chart", {
        group,
        layout: { chartType: "bar", y: { property: "points", function: "sum" } },
      }),
      source,
      opts,
    );
    expect(input).toMatchObject({
      mode: "groups",
      rowsPerGroup: 0,
      subGroup: null,
      aggregates: [{ property: "points", function: "sum" }],
    });
  });

  it("counts rows without a y and has no query without an X axis", () => {
    expect(chartQueryInput(view("chart", { group }), source, opts)?.aggregates).toEqual([]);
    expect(chartQueryInput(view("chart"), source, opts)).toBeNull();
    expect(chartSetup(view("table", { group }), source)).toBeNull();
  });
});

describe("chartValueText", () => {
  it("rounds and names a missing value", () => {
    expect(chartValueText(3)).toBe("3");
    expect(chartValueText(2.345)).toBe("2.35");
    expect(chartValueText(null)).toBe("No value");
  });
});
