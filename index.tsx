/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

import { applyStatus, getCurrentStatus } from "./applyStatus";
import { decideNextAction, INITIAL_STATE, ScheduleState } from "./schedule";
import { DEFAULT_CHECK_INTERVAL_SECONDS, MIN_CHECK_INTERVAL_SECONDS, settings } from "./settings";
import { STATUS_META } from "./types";

const logger = new Logger("StatusSchedule");

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let running = false;

/** All the scheduler's memory between ticks. The decision itself lives in schedule.ts. */
let state: ScheduleState = INITIAL_STATE;

function logOverrideChange(previous: ScheduleState, next: ScheduleState, currentStatus: string | null) {
    // Deliberately not toasts: respecting an override is the quiet, expected case
    if (previous.manualOverride === null && next.manualOverride !== null) {
        logger.debug(`Status changed to "${currentStatus}" outside the plugin; holding until the next transition`);
    } else if (previous.manualOverride !== null && next.manualOverride === null) {
        logger.debug("Reached a rule transition; resuming automatic control");
    }
}

export async function evaluateSchedule() {
    const previous = state;
    const currentStatus = getCurrentStatus();

    const { decision, state: next } = decideNextAction(previous, {
        rules: settings.store.rules,
        now: new Date(),
        currentStatus,
        respectManualOverride: settings.store.respectManualOverride,
        restoreStatusAfterRule: settings.store.restoreStatusAfterRule
    });

    state = next;
    logOverrideChange(previous, next, currentStatus);

    if (decision.type === "hold") return;

    const status = decision.type === "apply" ? decision.rule.status : decision.status;
    const because = decision.type === "apply"
        ? `(${decision.rule.label})`
        : "(schedule ended)";

    if (await applyStatus(status)) {
        logger.info(`Set status to "${status}" ${because}`);

        if (settings.store.notifyOnScheduledChange) {
            const message = decision.type === "apply"
                ? `Status set to ${STATUS_META[status].label} (${decision.rule.label})`
                : `Status restored to ${STATUS_META[status].label}`;

            showToast(message, Toasts.Type.SUCCESS);
        }
    } else {
        // The write never landed, so don't claim it as ours
        state = { ...state, lastAppliedStatus: previous.lastAppliedStatus };
        showToast(`StatusSchedule could not set your status to ${STATUS_META[status].label}. See the console.`, Toasts.Type.FAILURE);
    }
}

/*
 * A self-rescheduling timeout rather than setInterval: the delay is re-read from settings every
 * tick, so changing the check interval takes effect without restarting anything.
 */
function scheduleNextTick() {
    const configured = settings.store.checkIntervalSeconds;
    const seconds = Number.isFinite(configured)
        ? Math.max(MIN_CHECK_INTERVAL_SECONDS, configured)
        : DEFAULT_CHECK_INTERVAL_SECONDS;

    timeoutId = setTimeout(tick, seconds * 1000);
}

async function tick() {
    timeoutId = null;

    try {
        await evaluateSchedule();
    } catch (err) {
        logger.error("Schedule evaluation failed", err);
    } finally {
        if (running) scheduleNextTick();
    }
}

export default definePlugin({
    name: "StatusSchedule",
    description: "Automatically sets your Discord status from time-of-day rules, so you stop looking online at 3am",
    tags: ["Activity", "Privacy", "Utility"],
    authors: [{ name: "Evan Minich", id: 628373174001860628n }],
    dependencies: ["UserSettingsAPI"],
    settings,

    start() {
        running = true;
        // A fresh start makes no assumptions about who set the current status
        state = INITIAL_STATE;

        tick();
    },

    stop() {
        running = false;

        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }

        // Presence is deliberately left as-is: reverting on disable would be surprising
    }
});
