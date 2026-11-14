import {
  SpaceOptionId,
  type SpaceGroupBucket,
  type SpaceKnownDatabaseProperty,
  type SpaceKnownDatabaseView,
  type SpaceKnownGroup,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  arcPath,
  bandLayout,
  chartAggregates,
  chartConfig,
  chartData,
  chartTitle,
  donutAngles,
  donutSlices,
  linePath,
  linearScale,
  niceTicks,
  type ChartConfig,
} from "./chart.ts";

const config = (patch: Partial<ChartConfig> = {}): ChartConfig => ({
  kind: "bar",
  y: null,
  colorByOption: true,
  sortByValue: null,
  showValues: false,
  ...patch,
});
const bucket = (optionId: string, count: number, sum?: number): SpaceGroupBucket =>
  ({
    key: { kind: "option", optionId },
    count,
    rows: [],
    nextCursor: null,
    ...(sum === undefined ? {} : { aggregates: [{ property: "n", function: "sum", number: sum }] }),
  }) as unknown as SpaceGroupBucket;
const property = {
  id: "st",
  type: "select",
  config: {
    options: [
      { id: "a", name: "Alpha", color: "red" },
      { id: "b", name: "Beta", color: "blue" },
      { id: "c", name: "Gamma", color: "green" },
    ],
  },
} as unknown as SpaceKnownDatabaseProperty;
const run = (groups: SpaceGroupBucket[], cfg: ChartConfig, group: Partial<SpaceKnownGroup> = {}) =>
  chartData({
    groups,
    config: cfg,
    group: { property: "st", ...group } as SpaceKnownGroup,
    groupProperty: property,
    propertyName: "Status",
    optionHint: () => undefined,
  });

describe("niceTicks", () => {
  it.each([
    [0, 7, [0, 2, 4, 6, 8]],
    [0, 0, [0, 1]],
    [0, 1234, [0, 500, 1000, 1500]],
    [-3, 8, [-5, 0, 5, 10]],
    [0, 0.3, [0, 0.1, 0.2, 0.3]],
  ])("covers %d to %d", (min, max, ticks) => {
    const result = niceTicks(min, max);
    expect(result.ticks).toEqual(ticks);
    expect(result.min).toBeLessThanOrEqual(Math.min(min, 0));
    expect(result.max).toBeGreaterThanOrEqual(Math.max(max, 0));
    expect(result.ticks.length).toBeLessThanOrEqual(6);
  });
});

describe("scales and shapes", () => {
  it("maps the domain ends to the range ends", () => {
    const scale = linearScale([0, 10], [100, 0]);
    expect([scale(0), scale(10), scale(5)]).toEqual([100, 0, 50]);
    expect(linearScale([3, 3], [5, 9])(3)).toBe(5);
  });

  it("keeps band offsets increasing and inside the length", () => {
    const { band, offset } = bandLayout(7, 300);
    const offsets = [0, 1, 2, 3, 4, 5, 6].map(offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(offset(6) + band).toBeLessThanOrEqual(300);
    expect(bandLayout(500, 100).band).toBeGreaterThanOrEqual(1);
  });

  it("sums donut angles to a full turn and gives zeros an empty arc", () => {
    const angles = donutAngles([3, 0, 1]);
    expect(angles[1]?.end).toBe(angles[1]?.start);
    expect(angles.reduce((sum, angle) => sum + (angle.end - angle.start), 0)).toBeCloseTo(
      Math.PI * 2,
    );
  });

  it("draws a full circle as two arcs and a segment as one", () => {
    const full = arcPath(50, 50, 40, 20, -Math.PI / 2, (Math.PI * 3) / 2);
    expect(full.match(/A /g)).toHaveLength(4);
    expect(arcPath(50, 50, 40, 0, 0, 1).match(/A /g)).toHaveLength(1);
    expect(
      linePath([
        { x: 0, y: 1 },
        { x: 2, y: 3 },
      ]),
    ).toBe("M 0 1 L 2 3");
  });
});

describe("chartData", () => {
  it("drops hidden keys and empty groups, and follows manual order", () => {
    const groups = [bucket("a", 1), bucket("b", 0), bucket("c", 2)];
    const hidden = run(groups, config(), {
      hidden: [{ kind: "option", optionId: SpaceOptionId.make("a") }],
    });
    expect(hidden.data.map((datum) => datum.label)).toEqual(["Beta", "Gamma"]);
    const hideEmpty = run(groups, config(), { hideEmpty: true });
    expect(hideEmpty.data.map((datum) => datum.label)).toEqual(["Alpha", "Gamma"]);
    const manual = run(groups, config(), {
      sort: "manual",
      order: [
        { kind: "option", optionId: SpaceOptionId.make("c") },
        { kind: "option", optionId: SpaceOptionId.make("a") },
      ],
    });
    expect(manual.data.map((datum) => datum.label)).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("colours by option unless told not to and sorts by value with gaps last", () => {
    const groups = [bucket("a", 1, 5), bucket("b", 1), bucket("c", 1, 9)];
    const y = { property: "n", function: "sum" } as ChartConfig["y"];
    const result = run(groups, config({ y, sortByValue: "descending" }));
    expect(result.data.map((datum) => [datum.label, datum.value, datum.color])).toEqual([
      ["Gamma", 9, "green"],
      ["Alpha", 5, "red"],
      ["Beta", null, "blue"],
    ]);
    expect(run(groups, config({ colorByOption: false })).data[0]?.color).toBeNull();
  });

  it("caps the bars and reports what was cut", () => {
    const many = Array.from({ length: 60 }, (_, index) => bucket(`o${index}`, 1));
    const result = run(many, config());
    expect(result.data).toHaveLength(50);
    expect(result.omitted).toBe(10);
  });
});

describe("donutSlices", () => {
  const data = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    key: { kind: "empty" as const },
    label: `L${index}`,
    color: null,
    count: 1,
    value: 12 - index,
  }));

  it("folds the tail into Other for counts and sums, not for averages", () => {
    const counted = donutSlices(data, config());
    expect(counted.slices).toHaveLength(9);
    expect(counted.other).toBe(3 + 2 + 1);
    const average = config({ y: { property: "n", function: "average" } as ChartConfig["y"] });
    expect(donutSlices(data, average).other).toBeNull();
  });
});

describe("chartConfig", () => {
  it("defaults to a coloured count bar chart", () => {
    const known = { type: "chart", layout: {} } as Extract<
      SpaceKnownDatabaseView,
      { type: "chart" }
    >;
    expect(chartConfig(known)).toEqual(config());
    expect(chartAggregates(config())).toEqual([]);
    const y = { property: "n", function: "max" } as ChartConfig["y"];
    expect(chartAggregates(config({ y }))).toEqual([{ property: "n", function: "max" }]);
    expect(chartTitle(config(), "Status", null)).toBe("Count by Status");
    expect(
      chartTitle(
        config({ y: { property: "n", function: "sum" } as ChartConfig["y"] }),
        "Status",
        "Estimate",
      ),
    ).toBe("Sum of Estimate by Status");
  });
});
