# StatusSchedule — Design Spec

**Target:** Vencord plugin (TypeScript/TSX), runs inside Vesktop/Vencord client
**Audience:** Implementing agent — this doc should be sufficient to build the plugin without
further clarification. Where a judgment call was made, the reasoning is included so it can be
revisited.

---

## 1. Purpose

Discord has no native way to schedule presence (Online / Idle / Do Not Disturb / Invisible)
changes. Users who leave their client open on phone/PC overnight or across long stretches
appear "Online" at times that don't reflect their actual availability, which causes social
friction (e.g., people assuming a late-night reply is imminent).

StatusSchedule lets the user define a set of time-based rules that automatically set their
Discord presence, so their visible status matches their real-world availability without manual
toggling.

## 2. Goals

- Automatically apply one of `online | idle | dnd | invisible` based on time-of-day and
  day-of-week rules.
- Support schedules that cross midnight (e.g., 23:00 → 07:30).
- Support multiple non-contiguous rules per day (e.g., "focus mode" DND block at midday).
- Provide a settings UI usable without hand-editing JSON, while still allowing power users to
  paste/export JSON directly.
- Be resilient to Discord client updates changing internal module/action names — isolate that
  risk to one small, clearly-marked function.
- Never fight the user: manual status changes should be respected until the next rule boundary,
  not instantly overwritten.

## 3. Non-goals

- Not a full presence-automation suite (no "set idle when muted," no per-voice-channel status,
  no activity/Rich Presence management — those are separate plugins if wanted later).
- Not timezone-aware across multiple timezones — schedule is evaluated against the local system
  clock only. (Documented as a known limitation, see §9.)
- No network calls beyond what the Discord client already makes. No external services, no
  telemetry, no analytics.
- No server-side / bot component. Purely a local client plugin acting on the user's own account
  presence, exactly as if they'd clicked the status picker themselves.

## 4. User stories

1. As a user, I want to appear Invisible from 11pm–7:30am every day, without remembering to
   toggle it, so people don't message me expecting a fast reply overnight.
2. As a user, I want to appear Online during normal waking hours by default.
3. As a user, I want to define a DND block during a daily focus period (e.g., 9am–11am weekdays)
   that takes priority over the general "Online" daytime rule.
4. As a user, if I manually set myself to DND in the middle of an "Online" window because I'm in
   a meeting, I don't want the plugin to silently flip me back to Online 30 seconds later — it
   should hold my manual choice until the next scheduled transition.
5. As a user, I want to see confirmation (however minor) that a scheduled change actually
   happened, so I can trust the plugin is working without staring at my own status dot.

## 5. Data model

### 5.1 Rule shape

```ts
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday ... 6 = Saturday

type PresenceStatus = "online" | "idle" | "dnd" | "invisible";

interface ScheduleRule {
    id: string;              // stable uuid, generated client-side, used as React key
    label: string;           // user-facing name, e.g. "Overnight", "Focus block"
    start: string;           // "HH:MM", 24h, local time
    end: string;             // "HH:MM", 24h, local time; may be < start (wraps past midnight)
    status: PresenceStatus;
    days: Weekday[];         // which weekdays this rule is active on
    priority: number;        // higher number = evaluated first; see §6.2
    enabled: boolean;        // allows disabling a rule without deleting it
}
```

### 5.2 Persisted settings

```ts
interface StatusScheduleSettings {
    rules: ScheduleRule[];
    checkIntervalSeconds: number;      // default 30
    respectManualOverride: boolean;    // default true, see §6.3
    notifyOnScheduledChange: boolean;  // default true, see §7
}
```

Stored via Vencord's `definePluginSettings`. The raw array is kept as the single source of
truth; the settings UI (§8) is a structured editor over this array, not a separate JSON blob the
user edits directly — but a "raw edit" escape hatch is provided (§8.4) for power users, since
that was the interim approach in the prototype and some users will prefer it.

## 6. Core scheduling algorithm

### 6.1 Evaluation loop

- On plugin `start()`, run `evaluateSchedule()` immediately, then on an interval of
  `checkIntervalSeconds` (default 30s; configurable, minimum clamped to 5s to avoid hammering
  the dispatch call).
- On plugin `stop()`, clear the interval. Do not revert status on stop — leave the user's
  presence as last set (reverting on disable would be surprising and is out of scope).

### 6.2 Rule resolution

Given the current local time and weekday:

1. Filter to `enabled` rules whose `days` include today.
2. Filter to rules where current time falls within `[start, end)`, handling midnight wrap:
   - If `start < end`: in-range when `start <= now < end`.
   - If `start > end` (wraps past midnight): in-range when `now >= start OR now < end`.
   - If `start === end`: treat as a 24-hour rule (always in range) — documented edge case,
     useful for a permanent override a user toggles `enabled` on/off manually.
3. Among matching rules, pick the one with the **highest `priority`** (ties broken by whichever
   rule appears first in the array). This is how "focus block DND" can override a broader
   "daytime online" rule that also matches the same window.
4. If no rule matches, do not change presence — leave it as-is. (Do not assume a default; an
   explicit "default/fallback" rule with `days: [0..6]`, full-day range, and lowest priority is
   the documented way to guarantee full coverage, rather than baking in an implicit fallback.)

### 6.3 Manual override handling

This is the most important UX decision in the spec — get this right:

- Track `lastAppliedStatus` (what the plugin itself last set) and compare it against the
  client's actual current status (read from the relevant presence store, not just plugin state)
  on each tick.
- If the current status differs from `lastAppliedStatus` **and** `lastAppliedStatus` was
  previously set successfully, treat this as a manual override: the user (or another plugin)
  changed it since the plugin last acted.
- While in "manually overridden" state, **do not** re-apply the rule that would otherwise match,
  even if it still matches — hold off until the *next rule transition* (i.e., the moment the
  matching rule changes to a different rule/status than the one active when the override
  happened). At that point, resume normal automatic control.
- This behavior is gated by `respectManualOverride` (default `true`). If the user disables it,
  the plugin reverts to naive "always enforce the current matching rule" behavior instead.
- Rationale: without this, any manual status change gets stomped within `checkIntervalSeconds`,
  which is confusing and makes the plugin feel like it's fighting the user (see user story 4).

### 6.4 Status application

- Setting presence is done via the same internal action the built-in status picker uses —
  currently a Flux dispatch of shape `{ type: "STATUS_UPDATE", status: <PresenceStatus> }`.
- **Isolate this in a single function** (e.g., `applyStatus(status: PresenceStatus)`), since this
  is the piece most likely to need updating after a Discord client update. Include a code comment
  pointing future maintainers to Vencord DevTools → Webpack search for `STATUS_UPDATE` if it
  stops working.
- Skip the dispatch if `status === lastAppliedStatus` (avoid redundant no-op dispatches).
- Wrap the dispatch call in try/catch; on failure, log via Vencord's `Logger` and surface a toast
  (see §7) so silent failure isn't the failure mode.

## 7. Feedback / notifications

- On every **automatic** status change (not on user manual changes), show a toast:
  `Status set to {status} ({rule.label})`. Gated by `notifyOnScheduledChange` (default `true`,
  since silent background changes are exactly the kind of thing users lose track of and stop
  trusting — user story 5).
- On dispatch failure, show a distinct failure toast so the user knows to check the plugin/logs
  rather than assuming it's working.
- No toast on manual overrides being "respected" (§6.3) — that would be noisy; log at debug level
  instead.

## 8. Settings UI

### 8.1 Rule list

- Primary settings panel shows the rule list as rows: label, time range, status (with a colored
  dot matching Discord's own status colors), days (compact weekday abbreviations, active ones
  highlighted), priority, enabled toggle, delete button.
- "Add rule" button opens a rule editor (inline expansion or modal — implementer's choice based
  on what Vencord's settings component library makes easiest).
- Rule editor fields: label (text), start time (time input), end time (time input), status
  (select: Online/Idle/DND/Invisible, mirroring Discord's own iconography/colors where the
  component library supports it), days (multi-select weekday picker), priority (number input),
  enabled (toggle).
- Validate on save: `start`/`end` must be valid `HH:MM`; at least one day selected; priority is
  an integer. Show inline validation errors rather than silently rejecting.

### 8.2 Global settings

- `checkIntervalSeconds` (number input, min 5)
- `respectManualOverride` (toggle, default on)
- `notifyOnScheduledChange` (toggle, default on)

### 8.3 Defaults on first install

Ship with two example rules pre-populated (disabled by default, so nothing changes the user's
status until they opt in) to serve as a working template:

```json
[
  { "id": "...", "label": "Overnight", "start": "23:00", "end": "07:30",
    "status": "invisible", "days": [0,1,2,3,4,5,6], "priority": 0, "enabled": false },
  { "id": "...", "label": "Daytime", "start": "07:30", "end": "23:00",
    "status": "online", "days": [0,1,2,3,4,5,6], "priority": 0, "enabled": false }
]
```

### 8.4 Raw JSON escape hatch

Provide a collapsible "Advanced: edit as JSON" section that shows/accepts the same `ScheduleRule[]`
shape directly, for users who'd rather script/paste their schedule. Changes made here should
round-trip cleanly with the structured editor (same underlying settings array, not a shadow copy).

## 9. Known limitations (document, don't silently paper over)

- **No timezone awareness.** Schedule uses the system's local time as reported by `Date()`. If
  the user travels across timezones, rules shift with them (arguably correct) but are not
  timezone-pinned (e.g., "always match UTC 03:00" is not supported).
- **No per-guild schedules.** All rules apply globally to the account's presence; Discord does
  not support per-server presence, so this is a platform limitation, not a plugin gap.
- **Internal action name risk.** §6.4's `STATUS_UPDATE` dispatch depends on Discord's internal
  Flux action naming, which is not a public API and can change without notice on client updates.

## 10. Non-functional requirements

- No external network calls.
- No persisted data beyond Vencord's own settings store (no separate storage/telemetry).
- Interval timer must be cleared on `stop()` — no leaked intervals across plugin
  disable/enable cycles.
- Should not noticeably impact client performance: evaluation logic is O(number of rules) every
  tick, which is trivially cheap for realistic rule-list sizes (tens of rules, not thousands).

## 11. File/module structure

```
StatusSchedule/
  index.tsx          — definePlugin export, start/stop lifecycle, interval wiring
  types.ts            — ScheduleRule, PresenceStatus, Weekday types
  schedule.ts         — pure logic: parseTime, isRuleActive, resolveActiveRule (unit-testable,
                         no Discord/webpack imports so it can be tested in isolation)
  applyStatus.ts       — isolated Flux dispatch wrapper (§6.4), the "likely to break" surface
  settingsComponents.tsx — rule list UI, rule editor UI, JSON escape hatch
```

Keeping `schedule.ts` free of Vencord/webpack imports is deliberate: it lets the core
time-matching logic be unit tested with plain Jest/vitest against fixed `Date` values, independent
of the Discord client runtime.

## 12. Acceptance criteria

- [ ] A rule spanning midnight (e.g., 23:00–07:30) correctly matches both before and after
      midnight, and does not match during the day.
- [ ] Two overlapping rules with different priorities: the higher-priority rule's status wins.
- [ ] With `respectManualOverride: true`, manually changing status away from what the plugin set
      is not reverted before the next rule transition; after that transition, automatic control
      resumes.
- [ ] With `respectManualOverride: false`, the matching rule's status is (re)applied on every
      tick regardless of manual changes.
- [ ] Disabling a rule (`enabled: false`) removes it from consideration without deleting it.
- [ ] No rule matching the current time leaves presence unchanged (no implicit fallback status).
- [ ] Toast is shown on automatic status changes when `notifyOnScheduledChange` is on, and
      suppressed when off.
- [ ] Plugin `stop()` clears the interval; no further status changes occur after disable.
- [ ] Settings persist and reload correctly across client restarts.
- [ ] JSON escape hatch and structured UI edit the same underlying data with no drift.

## 13. Possible future enhancements (explicitly out of scope for v1)

- Per-rule custom status text (not just presence), if/when combined with a separate
  status-text plugin.
- "Snooze" button to temporarily suspend automatic control for N minutes without fully disabling
  `respectManualOverride`.
- Import/export schedule as a shareable preset.
