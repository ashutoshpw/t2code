import {
  arcPath,
  bandLayout,
  chartData,
  chartTitle,
  donutAngles,
  donutSlices,
  linePath,
  linearScale,
  niceTicks,
  viewDependencies,
  type ChartDatum,
} from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDataSource, SpaceDatabaseView } from "@t2code/contracts/spaces";
import { useState } from "react";
import { View, useColorScheme } from "react-native";
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";

import { AppText as Text } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { viewerZone } from "../../../state/spacesDatabases";
import { chartQueryInput, chartSetup, chartValueText, PICK_X_AXIS_MESSAGE } from "./chartPanel";
import { optionColor } from "./optionColors";
import { useViewRows } from "./useViewRows";

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 40 };
const noHint = () => undefined;

const palette = (scheme: "light" | "dark") =>
  scheme === "dark"
    ? { series: "#6ea0ff", text: "#d0d0d0", grid: "#3a3a3a", surface: "#1c1c1e" }
    : { series: "#2f6fed", text: "#4a4a4a", grid: "#e1e1e1", surface: "#ffffff" };

/** A read-only chart: one grouped query drawn with SVG, plus a plain list that is the accessible version. */
export function ChartPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly view: SpaceDatabaseView;
  readonly dataSource: SpaceDataSource;
}) {
  const { view, dataSource } = props;
  const setup = chartSetup(view, dataSource);
  const input =
    setup === null
      ? null
      : chartQueryInput(view, dataSource, {
          environmentId: props.environmentId,
          timeZone: viewerZone(),
        });
  const watch =
    input === null
      ? null
      : viewDependencies(
          view,
          undefined,
          dataSource,
          input.aggregates?.map((a) => a.property) ?? [],
        );
  const rows = useViewRows(props.environmentId, dataSource.id, input, watch);
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const [width, setWidth] = useState(0);
  if (setup === null)
    return <Text className="px-4 py-2 text-base text-foreground-muted">{PICK_X_AXIS_MESSAGE}</Text>;
  if (rows.error !== null)
    return (
      <View className="items-start gap-2 px-4 py-2">
        <Text className="text-base text-foreground-muted">{rows.error}</Text>
        <ControlPill variant="pill" label="Retry" onPress={rows.retry} />
      </View>
    );
  if (rows.groups === null)
    return <Text className="px-4 py-2 text-base text-foreground-muted">Loading chart…</Text>;
  const { data, omitted } = chartData({
    groups: rows.groups,
    config: setup.config,
    group: setup.group,
    groupProperty: setup.groupProperty,
    propertyName: setup.propertyName,
    optionHint: noHint,
  });
  if (data.length === 0)
    return <Text className="px-4 py-2 text-base text-foreground-muted">No data to chart.</Text>;
  const title = chartTitle(setup.config, setup.propertyName, setup.yName);
  const colors = palette(scheme);
  return (
    <View className="gap-2 px-4 py-2">
      <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
        {title}
      </Text>
      <View onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}>
        {width > 0 ? (
          <Svg
            width={width}
            height={HEIGHT}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {setup.config.kind === "donut" ? (
              <Donut data={data} config={setup.config} width={width} scheme={scheme} />
            ) : setup.config.kind === "horizontal_bar" ? (
              <HorizontalBars data={data} width={width} scheme={scheme} />
            ) : (
              <Columns
                data={data}
                width={width}
                scheme={scheme}
                line={setup.config.kind === "line"}
              />
            )}
          </Svg>
        ) : null}
      </View>
      {omitted > 0 ? (
        <Text className="text-sm text-foreground-muted">{`${omitted} more not shown.`}</Text>
      ) : null}
      <View accessibilityRole="list" className="gap-1" style={{ borderColor: colors.grid }}>
        {data.map((datum) => (
          <View key={datum.id} accessibilityRole="text" className="flex-row justify-between gap-3">
            <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
              {datum.label}
            </Text>
            <Text className="text-sm text-foreground-muted">{chartValueText(datum.value)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const fillOf = (datum: ChartDatum, scheme: "light" | "dark") =>
  datum.color === null ? palette(scheme).series : optionColor(datum.color, scheme).background;
const strokeOf = (datum: ChartDatum, scheme: "light" | "dark") =>
  datum.color === null ? "none" : optionColor(datum.color, scheme).text;

const extent = (data: ReadonlyArray<ChartDatum>) => {
  const values = data.map((datum) => datum.value ?? 0);
  return niceTicks(Math.min(0, ...values), Math.max(0, ...values));
};

function Columns(props: {
  readonly data: ReadonlyArray<ChartDatum>;
  readonly width: number;
  readonly scheme: "light" | "dark";
  readonly line: boolean;
}) {
  const colors = palette(props.scheme);
  const { data } = props;
  const axis = extent(data);
  const plotWidth = props.width - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const y = linearScale([axis.min, axis.max], [PAD.top + plotHeight, PAD.top]);
  const bands = bandLayout(data.length, plotWidth);
  const labelEvery = Math.max(1, Math.ceil(44 / (plotWidth / data.length)));
  const centers = data.map((_, index) => PAD.left + bands.offset(index) + bands.band / 2);
  return (
    <>
      {axis.ticks.map((tick) => (
        <G key={tick}>
          <Line
            x1={PAD.left}
            x2={PAD.left + plotWidth}
            y1={y(tick)}
            y2={y(tick)}
            stroke={colors.grid}
            strokeWidth={1}
          />
          <SvgText
            x={PAD.left - 6}
            y={y(tick) + 4}
            fontSize={10}
            textAnchor="end"
            fill={colors.text}
          >
            {chartValueText(tick)}
          </SvgText>
        </G>
      ))}
      {props.line ? (
        <>
          <Path
            d={linePath(
              data.flatMap((datum, index) =>
                datum.value === null ? [] : [{ x: centers[index] ?? 0, y: y(datum.value) }],
              ),
            )}
            stroke={colors.series}
            strokeWidth={2}
            fill="none"
          />
          {data.map((datum, index) =>
            datum.value === null ? null : (
              <Circle
                key={datum.id}
                cx={centers[index] ?? 0}
                cy={y(datum.value)}
                r={4}
                fill={colors.series}
                stroke={colors.surface}
                strokeWidth={1}
              />
            ),
          )}
        </>
      ) : (
        data.map((datum, index) => {
          const top = y(Math.max(datum.value ?? 0, 0));
          const bottom = y(Math.min(datum.value ?? 0, 0));
          return (
            <Rect
              key={datum.id}
              x={PAD.left + bands.offset(index)}
              y={top}
              width={bands.band}
              height={Math.max(1, bottom - top)}
              rx={bands.band < 12 ? 2 : 4}
              fill={fillOf(datum, props.scheme)}
              stroke={strokeOf(datum, props.scheme)}
              strokeWidth={1}
            />
          );
        })
      )}
      {data.map((datum, index) =>
        index % labelEvery === 0 ? (
          <SvgText
            key={datum.id}
            x={centers[index] ?? 0}
            y={HEIGHT - 10}
            fontSize={10}
            textAnchor="middle"
            fill={colors.text}
          >
            {datum.label.length > 8 ? `${datum.label.slice(0, 7)}…` : datum.label}
          </SvgText>
        ) : null,
      )}
    </>
  );
}

function HorizontalBars(props: {
  readonly data: ReadonlyArray<ChartDatum>;
  readonly width: number;
  readonly scheme: "light" | "dark";
}) {
  const colors = palette(props.scheme);
  const { data } = props;
  const left = 84;
  const axis = extent(data);
  const plotWidth = props.width - left - PAD.right;
  const rowHeight = 24;
  const height = data.length * rowHeight;
  const x = linearScale([axis.min, axis.max], [left, left + plotWidth]);
  return (
    <>
      {axis.ticks.map((tick) => (
        <Line
          key={tick}
          x1={x(tick)}
          x2={x(tick)}
          y1={0}
          y2={height}
          stroke={colors.grid}
          strokeWidth={1}
        />
      ))}
      {data.map((datum, index) => {
        const a = x(Math.min(datum.value ?? 0, 0));
        const b = x(Math.max(datum.value ?? 0, 0));
        return (
          <G key={datum.id}>
            <SvgText
              x={left - 6}
              y={index * rowHeight + 16}
              fontSize={11}
              textAnchor="end"
              fill={colors.text}
            >
              {datum.label.length > 12 ? `${datum.label.slice(0, 11)}…` : datum.label}
            </SvgText>
            <Rect
              x={a}
              y={index * rowHeight + 3}
              width={Math.max(1, b - a)}
              height={rowHeight - 8}
              rx={4}
              fill={fillOf(datum, props.scheme)}
              stroke={strokeOf(datum, props.scheme)}
              strokeWidth={1}
            />
          </G>
        );
      })}
    </>
  );
}

function Donut(props: {
  readonly data: ReadonlyArray<ChartDatum>;
  readonly config: Parameters<typeof donutSlices>[1];
  readonly width: number;
  readonly scheme: "light" | "dark";
}) {
  const { slices, other } = donutSlices(props.data, props.config);
  const values = [...slices.map((slice) => slice.value ?? 0), ...(other === null ? [] : [other])];
  const angles = donutAngles(values);
  const radius = Math.min(props.width, HEIGHT) / 2 - 8;
  const cx = props.width / 2;
  const cy = HEIGHT / 2;
  const colors = palette(props.scheme);
  return (
    <>
      {angles.map((angle, index) => {
        const slice = slices[index];
        return (
          <Path
            key={slice?.id ?? "other"}
            d={arcPath(cx, cy, radius, radius * 0.6, angle.start, angle.end)}
            fill={slice === undefined ? colors.grid : fillOf(slice, props.scheme)}
            stroke={colors.surface}
            strokeWidth={2}
            fillRule="evenodd"
          />
        );
      })}
    </>
  );
}
