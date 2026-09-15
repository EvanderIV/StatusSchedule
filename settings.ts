/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { StatusScheduleSettings } from "./settingsComponents";
import { ALL_WEEKDAYS, ScheduleRule } from "./types";

export const MIN_CHECK_INTERVAL_SECONDS = 5;
export const DEFAULT_CHECK_INTERVAL_SECONDS = 30;

/**
 * Shipped disabled so installing the plugin never moves someone's status on its own -- they are
 * a working template to switch on, not a default schedule.
 */
const DEFAULT_RULES: ScheduleRule[] = [
    {
        id: "example-overnight",
        label: "Overnight",
        start: "23:00",
        end: "07:30",
        status: "invisible",
        days: ALL_WEEKDAYS,
        priority: 0,
        enabled: false
    },
    {
        id: "example-daytime",
        label: "Daytime",
        start: "07:30",
        end: "23:00",
        status: "online",
        days: ALL_WEEKDAYS,
        priority: 0,
        enabled: false
    }
];

export const settings = definePluginSettings({
    rulesEditor: {
        type: OptionType.COMPONENT,
        component: StatusScheduleSettings
    },
    rules: {
        type: OptionType.CUSTOM,
        default: DEFAULT_RULES
    },
    checkIntervalSeconds: {
        type: OptionType.NUMBER,
        description: "How often to check the schedule, in seconds",
        default: DEFAULT_CHECK_INTERVAL_SECONDS,
        isValid: (value: number) =>
            Number.isFinite(value) && value >= MIN_CHECK_INTERVAL_SECONDS
                ? true
                : `Must be at least ${MIN_CHECK_INTERVAL_SECONDS} seconds.`
    },
    respectManualOverride: {
        type: OptionType.BOOLEAN,
        description: "Hold a status you set by hand until the next scheduled transition, instead of overwriting it",
        default: true
    },
    restoreStatusAfterRule: {
        type: OptionType.BOOLEAN,
        description: "When a rule's window ends and no other rule takes over, go back to the status you had before it started",
        default: true
    },
    notifyOnScheduledChange: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when the schedule changes your status",
        default: true
    }
});
