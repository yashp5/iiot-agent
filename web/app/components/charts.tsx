"use client";

import {
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { tSat } from "@shared/steam";
import type { TelemetryFrame } from "@shared/schemas";

/*
 * One measure per chart. Temperature, pressure and oxygen share a time axis but not a
 * scale, and overlaying them on twin y-axes would invent a correlation the data does not
 * contain — so they are small multiples instead.
 */

const AXIS = { fontSize: 11, fill: "var(--text-muted)" } as const;

export interface SensorSeriesPoint {
  ts: number;
  value: number;
  label: string;
}

function TimeTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ payload: SensorSeriesPoint }>;
  unit: string;
}) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div className="tooltip">
      <div>
        <strong>
          {point.value}
          {unit}
        </strong>
      </div>
      <div className="k">{point.label}</div>
    </div>
  );
}

export function SensorChart({
  title,
  unit,
  data,
  min,
  max,
  criticalAt,
}: {
  title: string;
  unit: string;
  data: SensorSeriesPoint[];
  min: number;
  max: number;
  criticalAt?: { value: number; label: string };
}) {
  const values = data.map((d) => d.value);
  const latest = values.at(-1);
  // Keep the limit lines in frame so "how close are we" is always answerable, and pad so
  // the trace never rides the edge of the plot.
  const lo = Math.min(min, ...values, criticalAt?.value ?? Infinity);
  const hi = Math.max(max, ...values, criticalAt?.value ?? -Infinity);
  const pad = (hi - lo) * 0.12 || 1;

  return (
    <div className="card">
      <h2>{title}</h2>
      <p className="note">
        {latest === undefined ? "no data" : `now ${latest}${unit}`} · limits {min}–{max}
        {unit}
      </p>
      <ResponsiveContainer width="100%" height={168}>
        <LineChart data={data} margin={{ top: 4, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: "var(--axis)" }}
            minTickGap={44}
          />
          <YAxis
            domain={[lo - pad, hi + pad]}
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={46}
            tickFormatter={(v: number) => v.toFixed(1)}
          />
          <Tooltip content={<TimeTooltip unit={unit} />} cursor={{ stroke: "var(--axis)" }} />
          <ReferenceLine y={min} stroke="var(--axis)" strokeWidth={1} />
          <ReferenceLine y={max} stroke="var(--axis)" strokeWidth={1} />
          {criticalAt && (
            <ReferenceLine
              y={criticalAt.value}
              stroke="var(--status-critical)"
              strokeWidth={1}
              label={{ value: criticalAt.label, position: "insideTopRight", fontSize: 10, fill: "var(--status-critical)" }}
            />
          )}
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--series-1)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * The combination plot: temperature against pressure, with the steam-table saturation
 * curve drawn through it. A healthy boiler sits on the curve. Distance from it is the
 * physics residual — the signal that catches low water and a frozen sensor while every
 * individual reading is still inside its limits.
 */
export function CombinationPlot({ frames }: { frames: TelemetryFrame[] }) {
  const points = frames.map((f) => ({ p: f.p, t: f.t, seq: f.seq, residual: +(f.t - tSat(f.p)).toFixed(1) }));
  const latest = points.at(-1);

  // Scale to the readings, not to a fixed window: drum pressure varies by tenths of a bar,
  // so a forced wide domain squeezes every point into one narrow band.
  const pressures = points.map((d) => d.p);
  const span = pressures.length ? Math.max(...pressures) - Math.min(...pressures) : 0;
  const pad = Math.max(span * 0.15, 0.05);
  const lo = pressures.length ? Math.min(...pressures) - pad : 9.5;
  const hi = pressures.length ? Math.max(...pressures) + pad : 10.5;
  const curve = Array.from({ length: 40 }, (_, i) => {
    const p = lo + ((hi - lo) * i) / 39;
    return { p, saturation: +tSat(p).toFixed(2) };
  });

  // The y-domain must span the readings AND the saturation curve. Deriving it from the
  // scatter alone drops the curve off-scale exactly when it matters most — a low-water
  // boiler reads 30 °C above saturation — and recharts then places its points at NaN.
  const temperatures = [...points.map((d) => d.t), ...curve.map((c) => c.saturation)];
  const yLo = temperatures.length ? Math.min(...temperatures) - 3 : 175;
  const yHi = temperatures.length ? Math.max(...temperatures) + 3 : 195;

  return (
    <div className="card">
      <h2>Temperature vs pressure</h2>
      <p className="note">
        Readings against the saturation curve. Vertical distance from the line is the
        residual{latest ? ` — now ${latest.residual > 0 ? "+" : ""}${latest.residual} °C` : ""}.
      </p>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart margin={{ top: 8, right: 16, bottom: 16, left: -8 }}>
          <CartesianGrid stroke="var(--grid)" />
          <XAxis
            type="number"
            dataKey="p"
            domain={[lo, hi]}
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: "var(--axis)" }}
            tickFormatter={(v: number) => v.toFixed(2)}
            label={{ value: "pressure (bar)", position: "insideBottom", offset: -8, fontSize: 11, fill: "var(--text-muted)" }}
          />
          <YAxis
            type="number"
            dataKey="t"
            domain={[yLo, yHi]}
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={46}
            tickFormatter={(v: number) => v.toFixed(0)}
          />
          <Tooltip
            content={({ active, payload }) => {
              const d = active ? (payload?.[0]?.payload as (typeof points)[number] | undefined) : undefined;
              if (!d || d.seq === undefined) return null;
              return (
                <div className="tooltip">
                  <div>
                    <strong>
                      {d.t} °C at {d.p} bar
                    </strong>
                  </div>
                  <div className="k">
                    residual {d.residual > 0 ? "+" : ""}
                    {d.residual} °C · seq {d.seq}
                  </div>
                </div>
              );
            }}
          />
          {/* The reference curve is chrome, not a second series: muted, unlabelled in the legend. */}
          <Line
            data={curve}
            dataKey="saturation"
            stroke="var(--text-muted)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            legendType="none"
            label={({ index, x, y }: { index?: number; x?: number; y?: number }) =>
              index === curve.length - 1 && Number.isFinite(x) && Number.isFinite(y) ? (
                <text x={x! - 6} y={y! - 8} textAnchor="end" fontSize={10} fill="var(--text-muted)">
                  saturation
                </text>
              ) : (
                <g />
              )
            }
          />
          <Scatter data={points} fill="var(--series-1)" fillOpacity={0.55} shape="circle" isAnimationActive={false} />
          {latest && (
            <Scatter
              data={[latest]}
              fill="var(--series-1)"
              stroke="var(--surface-1)"
              strokeWidth={2}
              shape="circle"
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      <p className="note" style={{ margin: "8px 0 0" }}>
        Saturation curve — a drum on the line is healthy; drift above it means temperature
        has decoupled from pressure.
      </p>
    </div>
  );
}
