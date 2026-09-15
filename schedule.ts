/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ALL_WEEKDAYS, PRESENCE_STATUSES, PresenceStatus, ScheduleRule, Weekday, WEEKDAY_LABELS } from "./types";

/*
 * Pure scheduling logic. Deliberately free of Vencord/webpack/Discord imports so it can be
 * unit tested against fixed Date values without a client runtime -- see schedule.test.ts.
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parses "HH:MM" into minutes since local midnight, or null if malformed. */
export function parseTime(time: string): number | null {
    const match = TIME_RE.exec(time);
    if (match == null) return null;

    return Number(match[1]) * 60 + Number(match[2]);
}

export function isValidTime(time: string): boolean {
    return parseTime(time) !== null;
}

/** Minutes since local midnight for the given moment. */
export function minutesOfDay(date: Date): number {
    return date.getHours() * 60 + date.getMinutes();
}

/**
 * Whether a rule covers the given moment.
 *
 * Note on wrapping rules: `days` is matched against the day the clock currently reads, not
 * against the day the window started on. A 23:00->07:30 rule enabled only on Monday therefore
 * covers Mon 00:00-07:30 and Mon 23:00-24:00, not Tue 00:00-07:30.
 */
export function isRuleActiveAt(rule: ScheduleRule, date: Date): boolean {
    if (!rule.enabled) return false;
    if (!rule.days.includes(date.getDay() as Weekday)) return false;

    const start = parseTime(rule.start);
    const end = parseTime(rule.end);
    // A malformed rule never matches rather than matching at a surprising time
    if (start === null || end === null) return false;

    const now = minutesOfDay(date);

    if (start === end) return true; // documented edge case: treated as a 24 hour rule
    if (start < end) return now >= start && now < end;

    return now >= start || now < end; // wraps past midnight
}

/**
 * The rule that should be in force at `date`, or null if none match.
 *
 * Highest priority wins; ties go to whichever rule appears first in the array. There is no
 * implicit fallback -- callers must leave presence untouched when this returns null.
 */
export function resolveActiveRule(rules: readonly ScheduleRule[], date: Date): ScheduleRule | null {
    let best: ScheduleRule | null = null;

    for (const rule of rules) {
        if (!isRuleActiveAt(rule, date)) continue;
        if (best === null || rule.priority > best.priority) best = rule;
    }

    return best;
}

/** Remembers which rule was in force when the user took manual control. */
export interface ManualOverride {
    /** The rule the plugin was enforcing when the change happened, or null if it was enforcing none. */
    ruleId: string | null;
    /** The status it had applied at that point. */
    status: PresenceStatus | null;
}

export interface ScheduleState {
    /** The status the plugin itself last set -- what we expect to still find in place. */
    lastAppliedStatus: PresenceStatus | null;
    /** The rule that produced `lastAppliedStatus`, so a later manual change can be scoped to it. */
    lastAppliedRuleId: string | null;
    manualOverride: ManualOverride | null;
    /**
     * The status that was in force before any rule took over, restored once the rules stop
     * covering the current moment. Captured on the no-rule -> rule edge only, so a chain of
     * back-to-back rules still unwinds to what was there before the first of them.
     */
    restorePoint: PresenceStatus | null;
}

export interface ScheduleInput {
    rules: readonly ScheduleRule[];
    now: Date;
    /** The client's actual status, or null if it could not be read. */
    currentStatus: PresenceStatus | null;
    respectManualOverride: boolean;
    restoreStatusAfterRule: boolean;
}

export type ScheduleDecision =
    | { type: "hold"; reason: "no-matching-rule" | "manual-override" | "already-applied"; }
    | { type: "apply"; rule: ScheduleRule; }
    | { type: "restore"; status: PresenceStatus; };

export const INITIAL_STATE: ScheduleState = {
    lastAppliedStatus: null,
    lastAppliedRuleId: null,
    manualOverride: null,
    restorePoint: null
};

/**
 * The whole scheduling decision, as a pure function of the previous state and the world.
 *
 * Kept separate from the plugin lifecycle so the manual-override behaviour -- the fiddliest part
 * of this plugin -- can be tested without a Discord client. The caller performs the status write
 * and reverts `lastAppliedStatus` if it fails.
 *
 * `lastAppliedStatus` is advanced to the target *before* the caller awaits its write, so a tick
 * landing mid-write cannot mistake the plugin's own change for a manual one.
 */
export function decideNextAction(state: ScheduleState, input: ScheduleInput): { decision: ScheduleDecision; state: ScheduleState; } {
    const { rules, now, currentStatus, respectManualOverride, restoreStatusAfterRule } = input;

    const active = resolveActiveRule(rules, now);
    const { lastAppliedStatus } = state;
    let { manualOverride, restorePoint } = state;

    if (!restoreStatusAfterRule) restorePoint = null;

    if (!respectManualOverride) {
        // Naive mode: the matching rule is enforced on every tick
        manualOverride = null;
    } else {
        const changedElsewhere = lastAppliedStatus !== null
            && currentStatus !== null
            && currentStatus !== lastAppliedStatus;

        if (manualOverride === null && changedElsewhere) {
            // Scoped to the rule the plugin was actually enforcing, not to whatever happens to be
            // due now: a status picked while nothing was scheduled must not veto the next rule.
            manualOverride = { ruleId: state.lastAppliedRuleId, status: lastAppliedStatus };
            // The user has just made a newer, explicit choice than the one we were holding, so
            // restoring the older status when the rule lapses would undo what they asked for
            restorePoint = null;
        }

        if (manualOverride !== null) {
            const sameRuleStillInForce = manualOverride.ruleId !== null
                && manualOverride.ruleId === (active?.id ?? null)
                && manualOverride.status === (active?.status ?? null);

            // Hold until the rule in force actually changes, then resume automatic control
            if (sameRuleStillInForce) {
                return {
                    decision: { type: "hold", reason: "manual-override" },
                    state: { ...state, manualOverride, restorePoint }
                };
            }

            manualOverride = null;
        }
    }

    if (active === null) {
        // The rules have stopped covering this moment. Put back whatever was in force before they
        // started, rather than leaving the last rule's status stranded.
        if (restorePoint !== null) {
            const status = restorePoint;

            return {
                decision: currentStatus === status
                    ? { type: "hold", reason: "already-applied" }
                    : { type: "restore", status },
                state: { lastAppliedStatus: status, lastAppliedRuleId: null, manualOverride, restorePoint: null }
            };
        }

        return {
            decision: { type: "hold", reason: "no-matching-rule" },
            // Nothing is being enforced, so the plugin deliberately forgets what it last set.
            // Otherwise a status the user picks now still reads as a difference later, and would
            // register as an override against whichever rule next falls due.
            state: { lastAppliedStatus: null, lastAppliedRuleId: null, manualOverride, restorePoint: null }
        };
    }

    // Crossing from uncovered time into a rule: remember what we are displacing. Only on that
    // edge, so A -> B -> uncovered still unwinds to what preceded A rather than to A's status.
    if (restoreStatusAfterRule && restorePoint === null && currentStatus !== null) {
        restorePoint = currentStatus;
    }

    const next: ScheduleState = {
        lastAppliedStatus: active.status,
        lastAppliedRuleId: active.id,
        manualOverride,
        restorePoint
    };

    if (currentStatus === active.status) {
        // Already correct, possibly because the user got there first. Recording it keeps override
        // detection honest on the next tick without a redundant write.
        return { decision: { type: "hold", reason: "already-applied" }, state: next };
    }

    return { decision: { type: "apply", rule: active }, state: next };
}

/** Human readable day summary, e.g. "Every day", "Weekdays", "Mon, Wed, Fri" */
export function describeDays(days: readonly Weekday[]): string {
    const unique = [...new Set(days)].sort((a, b) => a - b);

    if (unique.length === 0) return "Never";
    if (unique.length === 7) return "Every day";
    if (unique.length === 5 && unique.every(day => day >= 1 && day <= 5)) return "Weekdays";
    if (unique.length === 2 && unique[0] === 0 && unique[1] === 6) return "Weekends";

    return unique.map(day => WEEKDAY_LABELS[day]).join(", ");
}

export function formatTimeRange(rule: ScheduleRule): string {
    if (rule.start === rule.end) return "All day";

    const wraps = (parseTime(rule.start) ?? 0) > (parseTime(rule.end) ?? 0);
    return `${rule.start} – ${rule.end}${wraps ? " (next day)" : ""}`;
}

/** Field level validation for the rule editor. Returns a message per invalid field. */
export function validateRule(rule: ScheduleRule): Partial<Record<"label" | "start" | "end" | "days" | "priority", string>> {
    const errors: Partial<Record<"label" | "start" | "end" | "days" | "priority", string>> = {};

    if (rule.label.trim() === "") errors.label = "Give the rule a name.";
    if (!isValidTime(rule.start)) errors.start = "Must be a 24h time, e.g. 23:00.";
    if (!isValidTime(rule.end)) errors.end = "Must be a 24h time, e.g. 07:30.";
    if (rule.days.length === 0) errors.days = "Pick at least one day.";
    if (!Number.isInteger(rule.priority)) errors.priority = "Priority must be a whole number.";

    return errors;
}

export function isRuleValid(rule: ScheduleRule): boolean {
    return Object.keys(validateRule(rule)).length === 0;
}

function describeRuleProblem(rule: any, index: number): string | null {
    const where = `Rule ${index + 1}`;

    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return `${where} is not an object.`;
    if (typeof rule.label !== "string") return `${where} is missing a string "label".`;
    if (typeof rule.start !== "string" || !isValidTime(rule.start)) return `${where} has an invalid "start" (expected "HH:MM").`;
    if (typeof rule.end !== "string" || !isValidTime(rule.end)) return `${where} has an invalid "end" (expected "HH:MM").`;
    if (!PRESENCE_STATUSES.includes(rule.status)) return `${where} has an invalid "status" (expected one of ${PRESENCE_STATUSES.join(", ")}).`;
    if (!Array.isArray(rule.days) || rule.days.some((day: unknown) => !ALL_WEEKDAYS.includes(day as Weekday))) return `${where} has an invalid "days" (expected an array of 0-6).`;
    if (rule.priority != null && !Number.isInteger(rule.priority)) return `${where} has a non-integer "priority".`;
    if (rule.enabled != null && typeof rule.enabled !== "boolean") return `${where} has a non-boolean "enabled".`;

    return null;
}

/**
 * Parses the raw JSON escape hatch (§8.4) into rules, filling in optional fields and minting
 * ids for entries that lack one. Returns an error message instead of throwing so the settings
 * UI can render it inline.
 */
export function parseRulesJson(text: string, makeId: () => string): { rules: ScheduleRule[]; } | { error: string; } {
    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch (err) {
        return { error: `Not valid JSON: ${(err as Error).message}` };
    }

    if (!Array.isArray(parsed)) return { error: "Expected an array of rules." };

    const rules: ScheduleRule[] = [];
    const seenIds = new Set<string>();

    for (const [index, rule] of parsed.entries()) {
        const problem = describeRuleProblem(rule, index);
        if (problem !== null) return { error: problem };

        // Ids only have to be unique within the array; anything duplicated or absent is reminted
        const id = typeof rule.id === "string" && rule.id !== "" && !seenIds.has(rule.id) ? rule.id : makeId();
        seenIds.add(id);

        rules.push({
            id,
            label: rule.label,
            start: rule.start,
            end: rule.end,
            status: rule.status as PresenceStatus,
            days: [...new Set(rule.days as Weekday[])].sort((a, b) => a - b),
            priority: rule.priority ?? 0,
            enabled: rule.enabled ?? false
        });
    }

    return { rules };
}
