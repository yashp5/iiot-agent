import type { Severity } from "../shared/schemas";

const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARN: 1, CRITICAL: 2 };

interface GateState {
  streak: number;
  lastSeverity?: Severity;
  lastEmitTs?: number;
}

/**
 * Debounce plus cooldown, keyed per detector and sensor.
 *
 * Without it a two-minute overpressure emits 120 identical CRITICAL events — 120 HCS
 * transactions and 120 near-duplicate SLM inputs. A change in severity bypasses the
 * cooldown, so an escalation is never delayed by a recent WARN.
 */
export class EventGate {
  private readonly states = new Map<string, GateState>();

  constructor(
    private readonly debounceTicks: number,
    private readonly cooldownSec: number,
  ) {}

  /** True when this ongoing condition should be published now. */
  admit(key: string, severity: Severity, ts: number): boolean {
    const state = this.states.get(key) ?? { streak: 0 };
    state.streak += 1;
    this.states.set(key, state);

    if (state.streak < this.debounceTicks) return false;

    // Only an escalation may jump the cooldown. Treating any change as significant
    // lets a condition sitting on a threshold flap WARN/CRITICAL and emit every tick.
    const escalated =
      state.lastSeverity !== undefined &&
      SEVERITY_RANK[severity] > SEVERITY_RANK[state.lastSeverity];
    const cooledDown =
      state.lastEmitTs === undefined || ts - state.lastEmitTs >= this.cooldownSec * 1000;

    // Note the early return: a de-escalation inside the cooldown does not update
    // lastSeverity, so the higher severity stays latched until the cooldown lapses.
    if (!escalated && !cooledDown) return false;

    state.lastSeverity = severity;
    state.lastEmitTs = ts;
    return true;
  }

  /** The condition cleared: forget the streak so a fresh onset emits immediately. */
  clear(key: string): void {
    this.states.delete(key);
  }
}
