/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getUserSettingLazy } from "@api/UserSettings";
import { Logger } from "@utils/Logger";

import { PresenceStatus } from "./types";

/*
 * ---------------------------------------------------------------------------------------------
 * This module is the plugin's only point of contact with Discord internals, and therefore the
 * only part expected to break when Discord ships a client update. Everything else is plain
 * TypeScript over the settings store.
 *
 * Presence lives in the user settings proto under the group "status", name "status" -- the same
 * value the built-in status picker writes. Vencord's UserSettingsAPI resolves that setting for
 * us, which is why this plugin lists "UserSettingsAPI" in its `dependencies`.
 *
 * If scheduled changes stop applying, check in this order:
 *   1. Is the UserSettingsAPI plugin still enabled and still finding the settings module?
 *      (Vencord DevTools -> Webpack -> search `"textAndImages","renderSpoilers"`, the anchor
 *      UserSettingsAPI uses to locate it.)
 *   2. Has the group/name pair below been renamed? Reproduce by picking a status by hand and
 *      watching which setting updates.
 * Fixing either one should mean touching only this file.
 * ---------------------------------------------------------------------------------------------
 */
const StatusSetting = getUserSettingLazy<PresenceStatus>("status", "status")!;

const logger = new Logger("StatusSchedule");

/** The status the client is currently set to, or null if it could not be read. */
export function getCurrentStatus(): PresenceStatus | null {
    try {
        return StatusSetting.getSetting() ?? null;
    } catch (err) {
        logger.error("Failed to read the current status", err);
        return null;
    }
}

/** Applies a status exactly as the built-in picker would. Resolves to whether it took effect. */
export async function applyStatus(status: PresenceStatus): Promise<boolean> {
    try {
        await StatusSetting.updateSetting(status);
        return true;
    } catch (err) {
        logger.error(`Failed to set status to ${status}`, err);
        return false;
    }
}
