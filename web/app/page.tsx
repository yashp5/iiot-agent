"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnalysisMessage, Decision, ReportRef, TelemetryFrame } from "@shared/schemas";
import { tSat } from "@shared/steam";
import { CombinationPlot, SensorChart, type SensorSeriesPoint } from "./components/charts";
import { DecisionBar } from "./components/decide";
import { SeverityBadge, UrgencyBadge } from "./components/severity";

/*
 * Everything on this page is read from Hedera. The dashboard has no connection to the
 * simulator or the analysis worker — it polls the same topics they publish to, so what is
 * rendered is exactly what the chain can prove.
 */

const POLL_MS = 2000;
const LIMITS = { t: { min: 165, max: 195 }, p: { min: 8, max: 11 }, o2: { min: 2, max: 6 }, mawp: 12 };

interface TopicRecord<T> {
  sequenceNumber: number;
  consensusTimestamp: string;
  payload: T;
}

function useTopic<T>(name: string, intervalMs = POLL_MS) {
  const [records, setRecords] = useState<Array<TopicRecord<T>>>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/topic/${name}`);
        const body = (await response.json()) as { records?: Array<TopicRecord<T>>; error?: string };
        if (cancelled) return;
        if (body.error) setError(body.error);
        else {
          setError(undefined);
          setRecords(body.records ?? []);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "fetch failed");
      }
    };
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [name, intervalMs]);

  return { records, error };
}

/** 24-hour, so a timestamp fits one line in the narrow feed column and on a tick. */
function clockLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function consensusClock(ts: string): string {
  return clockLabel(Number(ts.split(".")[0]) * 1000);
}

export default function Dashboard() {
  const telemetry = useTopic<TelemetryFrame>("telemetry");
  const analysis = useTopic<AnalysisMessage>("analysis");
  const reports = useTopic<ReportRef>("reports");
  const decisions = useTopic<Decision>("decisions");

  // A report is settled once an operator has published a decision against it.
  const decisionByReport = useMemo(() => {
    const map = new Map<string, Decision>();
    for (const record of decisions.records) map.set(record.payload.reportId, record.payload);
    return map;
  }, [decisions.records]);

  const frames = useMemo(() => {
    const byBoiler = new Map<string, TelemetryFrame[]>();
    for (const record of telemetry.records) {
      byBoiler.set(record.payload.b, [...(byBoiler.get(record.payload.b) ?? []), record.payload]);
    }
    // The busiest boiler on the topic is the one worth showing by default.
    const [, best] = [...byBoiler.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    return (best ?? []).slice(-120);
  }, [telemetry.records]);

  const latest = frames.at(-1);
  const residual = latest ? +(latest.t - tSat(latest.p)).toFixed(2) : undefined;

  const series = (key: "t" | "p" | "o2"): SensorSeriesPoint[] =>
    frames.map((f) => ({ ts: f.ts, value: f[key], label: clockLabel(f.ts) }));

  const events = analysis.records
    .filter(
      (r): r is TopicRecord<Exclude<AnalysisMessage, { kind: "classification" }>> =>
        r.payload.kind !== "classification",
    )
    .reverse();
  const classifications = analysis.records
    .filter(
      (r): r is TopicRecord<Extract<AnalysisMessage, { kind: "classification" }>> =>
        r.payload.kind === "classification",
    )
    .reverse();
  const lastClassification = classifications[0]?.payload;

  return (
    <div className="wrap">
      <header className="page">
        <div>
          <h1>Boiler Guardian</h1>
          <p className="sub">
            Live from Hedera Consensus Service · {frames.length} frames
            {latest ? ` · boiler ${latest.b}` : ""}
          </p>
        </div>
        <div className="sub">
          {lastClassification ? (
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <strong>{lastClassification.state.replace(/_/g, " ")}</strong>
              <UrgencyBadge urgency={lastClassification.urgency} />
            </span>
          ) : (
            "awaiting classification"
          )}
        </div>
      </header>

      {telemetry.error && <div className="card empty">mirror node error: {telemetry.error}</div>}

      <div className="grid-tiles">
        <div className="card tile">
          <div className="label">Temperature</div>
          <div className="value">
            {latest?.t ?? "—"}
            <span className="unit">°C</span>
          </div>
          <div className="foot">saturation {latest ? tSat(latest.p).toFixed(1) : "—"} °C</div>
        </div>
        <div className="card tile">
          <div className="label">Pressure</div>
          <div className="value">
            {latest?.p ?? "—"}
            <span className="unit">bar</span>
          </div>
          <div className="foot">MAWP {LIMITS.mawp} bar</div>
        </div>
        <div className="card tile">
          <div className="label">Flue-gas O₂</div>
          <div className="value">
            {latest?.o2 ?? "—"}
            <span className="unit">%</span>
          </div>
          <div className="foot">target {LIMITS.o2.min}–{LIMITS.o2.max} %</div>
        </div>
        <div className="card tile">
          <div className="label">Physics residual</div>
          <div className="value" style={{ color: residual !== undefined && Math.abs(residual) >= 15 ? "var(--status-critical)" : undefined }}>
            {residual !== undefined ? `${residual > 0 ? "+" : ""}${residual}` : "—"}
            <span className="unit">°C</span>
          </div>
          <div className="foot">t − tSat(p)</div>
        </div>
      </div>

      <div className="grid-charts">
        <SensorChart title="Drum temperature" unit=" °C" data={series("t")} min={LIMITS.t.min} max={LIMITS.t.max} />
        <SensorChart
          title="Drum pressure"
          unit=" bar"
          data={series("p")}
          min={LIMITS.p.min}
          max={LIMITS.p.max}
          criticalAt={{ value: LIMITS.mawp, label: "MAWP" }}
        />
        <SensorChart title="Flue-gas oxygen" unit=" %" data={series("o2")} min={LIMITS.o2.min} max={LIMITS.o2.max} />
      </div>

      <div className="grid-lower">
        <CombinationPlot frames={frames} />

        <div className="card">
          <h2>Detector events</h2>
          <p className="note">Published to the analysis topic, newest first.</p>
          {events.length === 0 ? (
            <p className="empty">No events on the topic yet.</p>
          ) : (
            <ul className="feed">
              {events.slice(0, 40).map((record) => {
                const e = record.payload;
                return (
                  <li key={record.sequenceNumber}>
                    <span className="when">{consensusClock(record.consensusTimestamp)}</span>
                    <SeverityBadge severity={e.severity} />
                    <span className="what">
                      {e.kind === "outlier" ? (
                        <>
                          <strong>{e.method}</strong> on {e.sensors.join("+")} · score {e.score}
                        </>
                      ) : (
                        <>
                          <strong>{e.pattern}</strong> · {e.detail}
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Incident reports</h2>
        <p className="note">
          Written when a classification reaches urgency {3} or above. Body and hash are carried on
          chain; nothing here is generated in the browser. A decision is signed with an operator
          key the analysis worker does not hold, and the worker reads it back off the chain.
        </p>
        {reports.records.length === 0 ? (
          <p className="empty">No reports on the topic yet.</p>
        ) : (
          [...reports.records].reverse().map((record) => {
            const r = record.payload;
            return (
              <div className="report" key={r.id}>
                <h3>
                  <span>{r.state.replace(/_/g, " ")}</span>
                  <UrgencyBadge urgency={r.urgency} />
                  <span className="hash">
                    seq {r.ref.from}–{r.ref.to} · sha256 {r.sha256.slice(0, 12)}…
                  </span>
                </h3>
                <p className="summary">{r.summary}</p>
                <details>
                  <summary>Full report</summary>
                  <pre>{r.body}</pre>
                </details>
                <DecisionBar reportId={r.id} boiler={r.b} decided={decisionByReport.get(r.id)} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
