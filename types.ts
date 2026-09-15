/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** 0 = Sunday ... 6 = Saturday, matching `Date#getDay` */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type PresenceStatus = "online" | "idle" | "dnd" | "invisible";

export interface ScheduleRule {
    /** Stable uuid, generated client side. Also used as the React key. */
    id: string;
    /** User facing name, e.g. "Overnight" */
    label: string;
    /** "HH:MM", 24h, local time */
    start: string;
    /** "HH:MM", 24h, local time. May be earlier than `start`, which wraps past midnight. */
    end: string;
    status: PresenceStatus;
    days: Weekday[];
    /** Higher wins. Ties are broken by whichever rule comes first in the array. */
    priority: number;
    /** Lets a rule be parked without deleting it */
    enabled: boolean;
}

export const ALL_WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const STATUS_META: Record<PresenceStatus, { label: string; color: string; }> = {
    online: { label: "Online", color: "var(--status-online, #23a55a)" },
    idle: { label: "Idle", color: "var(--status-idle, #f0b232)" },
    dnd: { label: "Do Not Disturb", color: "var(--status-dnd, #f23f43)" },
    invisible: { label: "Invisible", color: "var(--status-offline, #80848e)" }
};

export const PRESENCE_STATUSES = Object.keys(STATUS_META) as PresenceStatus[];
