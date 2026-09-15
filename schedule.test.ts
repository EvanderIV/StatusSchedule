/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideNextAction, describeDays, formatTimeRange, INITIAL_STATE, isRuleActiveAt, parseRulesJson, parseTime, resolveActiveRule, ScheduleState, validateRule } from "./schedule";
import { ALL_WEEKDAYS, PresenceStatus, ScheduleRule, Weekday } from "./types";

/*
 * Run with: npx tsx --test src/userplugins/statusSchedule/schedule.test.ts
 *
 * schedule.ts has no Discord or Vencord imports precisely so these can run outside the client.
 */

/** 2026-09-13 is a Sunday, so this week's dates line up with weekday numbers. */
function at(weekday: Weekday, hours: number, minutes = 0): Date {
    return new Date(2026, 8, 13 + weekday, hours, minutes);
}

function rule(overrides: Partial<ScheduleRule> = {}): ScheduleRule {
    return {
        id: "test",
        label: "Test",
        start: "09:00",
        end: "17:00",
        status: "online",
        days: ALL_WEEKDAYS,
        priority: 0,
        enabled: true,
        ...overrides
    };
}

describe("parseTime", () => {
    it("parses valid 24h times", () => {
        assert.equal(parseTime("00:00"), 0);
        assert.equal(parseTime("07:30"), 450);
        assert.equal(parseTime("23:59"), 1439);
    });

    it("rejects malformed times", () => {
        for (const bad of ["", "7:30", "24:00", "23:60", "12:5", "noon", "12:30:00"]) {
            assert.equal(parseTime(bad), null, `expected "${bad}" to be rejected`);
        }
    });
});

describe("isRuleActiveAt", () => {
    it("matches a same-day window on its start but not its end", () => {
        const daytime = rule({ start: "09:00", end: "17:00" });

        assert.equal(isRuleActiveAt(daytime, at(1, 9, 0)), true);
        assert.equal(isRuleActiveAt(daytime, at(1, 12, 0)), true);
        assert.equal(isRuleActiveAt(daytime, at(1, 16, 59)), true);
        assert.equal(isRuleActiveAt(daytime, at(1, 17, 0)), false);
        assert.equal(isRuleActiveAt(daytime, at(1, 8, 59)), false);
    });

    it("matches a rule spanning midnight on both sides of it", () => {
        const overnight = rule({ start: "23:00", end: "07:30" });

        assert.equal(isRuleActiveAt(overnight, at(1, 23, 0)), true, "at the start");
        assert.equal(isRuleActiveAt(overnight, at(1, 23, 59)), true, "before midnight");
        assert.equal(isRuleActiveAt(overnight, at(1, 3, 0)), true, "after midnight");
        assert.equal(isRuleActiveAt(overnight, at(1, 7, 29)), true, "just before the end");
        assert.equal(isRuleActiveAt(overnight, at(1, 7, 30)), false, "at the end");
        assert.equal(isRuleActiveAt(overnight, at(1, 13, 0)), false, "during the day");
    });

    it("treats an equal start and end as a 24 hour rule", () => {
        const allDay = rule({ start: "00:00", end: "00:00" });

        assert.equal(isRuleActiveAt(allDay, at(3, 0, 0)), true);
        assert.equal(isRuleActiveAt(allDay, at(3, 13, 45)), true);
        assert.equal(isRuleActiveAt(allDay, at(3, 23, 59)), true);
    });

    it("ignores disabled rules without forgetting them", () => {
        const disabled = rule({ enabled: false });

        assert.equal(isRuleActiveAt(disabled, at(1, 12, 0)), false);
        assert.equal(isRuleActiveAt({ ...disabled, enabled: true }, at(1, 12, 0)), true);
    });

    it("only matches on selected days", () => {
        const weekdaysOnly = rule({ days: [1, 2, 3, 4, 5] });

        assert.equal(isRuleActiveAt(weekdaysOnly, at(1, 12, 0)), true, "Monday");
        assert.equal(isRuleActiveAt(weekdaysOnly, at(0, 12, 0)), false, "Sunday");
        assert.equal(isRuleActiveAt(weekdaysOnly, at(6, 12, 0)), false, "Saturday");
    });

    it("matches a wrapping rule against the day the clock reads, not the day it started", () => {
        // Documented semantics: a Monday-only 23:00->07:30 rule covers Mon 00:00-07:30 and
        // Mon 23:00-24:00, and does not bleed into Tuesday morning.
        const mondayOvernight = rule({ start: "23:00", end: "07:30", days: [1] });

        assert.equal(isRuleActiveAt(mondayOvernight, at(1, 2, 0)), true, "Monday 02:00");
        assert.equal(isRuleActiveAt(mondayOvernight, at(1, 23, 30)), true, "Monday 23:30");
        assert.equal(isRuleActiveAt(mondayOvernight, at(2, 2, 0)), false, "Tuesday 02:00");
    });

    it("never matches a rule with a malformed time", () => {
        assert.equal(isRuleActiveAt(rule({ start: "9:00" }), at(1, 12, 0)), false);
        assert.equal(isRuleActiveAt(rule({ end: "25:00" }), at(1, 12, 0)), false);
    });
});

describe("resolveActiveRule", () => {
    it("returns null when nothing matches, rather than a default", () => {
        const rules = [rule({ start: "09:00", end: "17:00" })];

        assert.equal(resolveActiveRule(rules, at(1, 20, 0)), null);
    });

    it("lets the higher priority rule win an overlap", () => {
        const daytime = rule({ id: "daytime", status: "online", start: "07:30", end: "23:00", priority: 0 });
        const focus = rule({ id: "focus", status: "dnd", start: "09:00", end: "11:00", priority: 10, days: [1, 2, 3, 4, 5] });

        assert.equal(resolveActiveRule([daytime, focus], at(1, 10, 0))?.id, "focus");
        assert.equal(resolveActiveRule([focus, daytime], at(1, 10, 0))?.id, "focus", "order must not matter");
        assert.equal(resolveActiveRule([daytime, focus], at(1, 12, 0))?.id, "daytime", "outside the focus block");
        assert.equal(resolveActiveRule([daytime, focus], at(0, 10, 0))?.id, "daytime", "focus block is weekdays only");
    });

    it("breaks ties by array order", () => {
        const first = rule({ id: "first", priority: 5 });
        const second = rule({ id: "second", priority: 5 });

        assert.equal(resolveActiveRule([first, second], at(1, 12, 0))?.id, "first");
        assert.equal(resolveActiveRule([second, first], at(1, 12, 0))?.id, "second");
    });

    it("skips disabled rules when picking a winner", () => {
        const daytime = rule({ id: "daytime", priority: 0 });
        const focus = rule({ id: "focus", priority: 10, enabled: false });

        assert.equal(resolveActiveRule([daytime, focus], at(1, 12, 0))?.id, "daytime");
    });

    it("finds a full-day fallback when the specific rules have lapsed", () => {
        const fallback = rule({ id: "fallback", start: "00:00", end: "00:00", priority: -1, status: "idle" });
        const daytime = rule({ id: "daytime", start: "09:00", end: "17:00", priority: 0 });

        assert.equal(resolveActiveRule([fallback, daytime], at(1, 12, 0))?.id, "daytime");
        assert.equal(resolveActiveRule([fallback, daytime], at(1, 20, 0))?.id, "fallback");
    });
});

describe("decideNextAction", () => {
    const daytime = rule({ id: "daytime", label: "Daytime", status: "online", start: "07:30", end: "23:00" });
    const overnight = rule({ id: "overnight", label: "Overnight", status: "invisible", start: "23:00", end: "07:30" });
    const rules = [daytime, overnight];

    /** Runs a tick the way index.tsx does, threading state through and reporting what happened. */
    function tick(state: ScheduleState, now: Date, currentStatus: PresenceStatus | null, respectManualOverride = true) {
        return decideNextAction(state, { rules, now, currentStatus, respectManualOverride });
    }

    it("applies the matching rule on the first tick, whatever the status happens to be", () => {
        const { decision, state } = tick(INITIAL_STATE, at(1, 2, 0), "online");

        assert.deepEqual(decision, { type: "apply", rule: overnight });
        assert.equal(state.lastAppliedStatus, "invisible");
    });

    it("does not rewrite a status that is already correct", () => {
        const { decision, state } = tick(INITIAL_STATE, at(1, 12, 0), "online");

        assert.deepEqual(decision, { type: "hold", reason: "already-applied" });
        assert.equal(state.lastAppliedStatus, "online", "still recorded, so an override can be spotted next tick");
    });

    it("holds nothing when no rule matches", () => {
        const { decision } = decideNextAction(INITIAL_STATE, {
            rules: [rule({ start: "09:00", end: "17:00" })],
            now: at(1, 20, 0),
            currentStatus: "dnd",
            respectManualOverride: true
        });

        assert.deepEqual(decision, { type: "hold", reason: "no-matching-rule" });
    });

    describe("with respectManualOverride on", () => {
        it("stops enforcing a rule once the user changes status by hand", () => {
            // 12:00, the Daytime rule applies and the plugin sets Online
            let { state } = tick(INITIAL_STATE, at(1, 12, 0), "idle");
            assert.equal(state.lastAppliedStatus, "online");

            // The user switches to DND for a meeting
            let result = tick(state, at(1, 12, 1), "dnd");
            assert.deepEqual(result.decision, { type: "hold", reason: "manual-override" });
            state = result.state;

            // ...and it is still respected several ticks later, inside the same rule
            result = tick(state, at(1, 16, 0), "dnd");
            assert.deepEqual(result.decision, { type: "hold", reason: "manual-override" });
            assert.notEqual(result.state.manualOverride, null);
        });

        it("resumes control at the next rule transition", () => {
            let { state } = tick(INITIAL_STATE, at(1, 12, 0), "idle");
            state = tick(state, at(1, 12, 1), "dnd").state;

            // 23:00: Overnight takes over, so the override lapses and the schedule applies again
            const result = tick(state, at(1, 23, 0), "dnd");

            assert.deepEqual(result.decision, { type: "apply", rule: overnight });
            assert.equal(result.state.manualOverride, null);
            assert.equal(result.state.lastAppliedStatus, "invisible");
        });

        it("treats a status change during an uncovered stretch as an override too", () => {
            const onlyDaytime = [daytime];
            let { state } = decideNextAction(INITIAL_STATE, { rules: onlyDaytime, now: at(1, 12, 0), currentStatus: "idle", respectManualOverride: true });

            // User goes invisible after the Daytime window has closed
            state = decideNextAction(state, { rules: onlyDaytime, now: at(1, 23, 30), currentStatus: "invisible", respectManualOverride: true }).state;
            assert.deepEqual(state.manualOverride, { ruleId: null, status: null });

            // Next morning the Daytime rule comes back around and takes over again
            const result = decideNextAction(state, { rules: onlyDaytime, now: at(2, 8, 0), currentStatus: "invisible", respectManualOverride: true });
            assert.deepEqual(result.decision, { type: "apply", rule: daytime });
        });

        it("does not treat the plugin's own change as an override", () => {
            const { state } = tick(INITIAL_STATE, at(1, 2, 0), "online");
            assert.equal(state.lastAppliedStatus, "invisible");

            // The next tick sees the status the plugin just set
            const result = tick(state, at(1, 2, 30), "invisible");

            assert.deepEqual(result.decision, { type: "hold", reason: "already-applied" });
            assert.equal(result.state.manualOverride, null);
        });

        it("ignores a status it cannot read rather than guessing an override", () => {
            const { state } = tick(INITIAL_STATE, at(1, 12, 0), "idle");
            const result = tick(state, at(1, 12, 1), null);

            assert.equal(result.state.manualOverride, null);
        });
    });

    describe("with respectManualOverride off", () => {
        it("re-applies the matching rule after a manual change", () => {
            const { state } = tick(INITIAL_STATE, at(1, 12, 0), "idle", false);
            const result = tick(state, at(1, 12, 1), "dnd", false);

            assert.deepEqual(result.decision, { type: "apply", rule: daytime });
        });

        it("drops an override that was being held when the setting is turned off", () => {
            let { state } = tick(INITIAL_STATE, at(1, 12, 0), "idle");
            state = tick(state, at(1, 12, 1), "dnd").state;
            assert.notEqual(state.manualOverride, null);

            const result = tick(state, at(1, 12, 2), "dnd", false);

            assert.deepEqual(result.decision, { type: "apply", rule: daytime });
            assert.equal(result.state.manualOverride, null);
        });
    });
});

describe("validateRule", () => {
    it("accepts a well-formed rule", () => {
        assert.deepEqual(validateRule(rule()), {});
    });

    it("reports each invalid field", () => {
        const errors = validateRule(rule({ label: "  ", start: "9:00", end: "", days: [], priority: 1.5 }));

        assert.deepEqual(Object.keys(errors).sort(), ["days", "end", "label", "priority", "start"]);
    });
});

describe("parseRulesJson", () => {
    const makeId = () => "generated";

    it("round-trips rules through JSON unchanged", () => {
        const rules = [rule({ id: "a" }), rule({ id: "b", status: "dnd", days: [1, 3, 5] })];
        const result = parseRulesJson(JSON.stringify(rules), makeId);

        assert.ok("rules" in result);
        assert.deepEqual(result.rules, rules);
    });

    it("fills in optional fields", () => {
        const result = parseRulesJson('[{ "id": "x", "label": "L", "start": "01:00", "end": "02:00", "status": "idle", "days": [0] }]', makeId);

        assert.ok("rules" in result);
        assert.equal(result.rules[0].priority, 0);
        assert.equal(result.rules[0].enabled, false);
    });

    it("mints ids that are missing or duplicated", () => {
        const result = parseRulesJson(`[
            { "label": "A", "start": "01:00", "end": "02:00", "status": "idle", "days": [0] },
            { "id": "dup", "label": "B", "start": "01:00", "end": "02:00", "status": "idle", "days": [0] },
            { "id": "dup", "label": "C", "start": "01:00", "end": "02:00", "status": "idle", "days": [0] }
        ]`, makeId);

        assert.ok("rules" in result);
        assert.deepEqual(result.rules.map(r => r.id), ["generated", "dup", "generated"]);
    });

    it("explains what is wrong instead of throwing", () => {
        const cases: [string, RegExp][] = [
            ["not json", /Not valid JSON/],
            ['{ "rules": [] }', /Expected an array/],
            ['[{ "label": "A", "start": "1:00", "end": "02:00", "status": "idle", "days": [0] }]', /invalid "start"/],
            ['[{ "label": "A", "start": "01:00", "end": "02:00", "status": "away", "days": [0] }]', /invalid "status"/],
            ['[{ "label": "A", "start": "01:00", "end": "02:00", "status": "idle", "days": [9] }]', /invalid "days"/],
            ['[{ "start": "01:00", "end": "02:00", "status": "idle", "days": [0] }]', /missing a string "label"/]
        ];

        for (const [input, expected] of cases) {
            const result = parseRulesJson(input, makeId);
            assert.ok("error" in result, `expected "${input}" to be rejected`);
            assert.match(result.error, expected);
        }
    });
});

describe("formatting", () => {
    it("summarises days", () => {
        assert.equal(describeDays(ALL_WEEKDAYS), "Every day");
        assert.equal(describeDays([1, 2, 3, 4, 5]), "Weekdays");
        assert.equal(describeDays([0, 6]), "Weekends");
        assert.equal(describeDays([1, 3, 5]), "Mon, Wed, Fri");
        assert.equal(describeDays([]), "Never");
    });

    it("flags a range that runs into the next day", () => {
        assert.equal(formatTimeRange(rule({ start: "09:00", end: "17:00" })), "09:00 – 17:00");
        assert.equal(formatTimeRange(rule({ start: "23:00", end: "07:30" })), "23:00 – 07:30 (next day)");
        assert.equal(formatTimeRange(rule({ start: "00:00", end: "00:00" })), "All day");
    });
});
