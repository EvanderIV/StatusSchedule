# StatusSchedule

A [Vencord](https://vencord.dev) userplugin that sets your Discord status from time-of-day rules,
so you stop appearing online at 3am because a client was left running.

Discord has no native presence scheduling. StatusSchedule adds it: define windows of local time,
pick a status for each, and the plugin keeps your presence matching your actual availability.

## Install

This is a userplugin, so it needs a [Vencord dev install](https://docs.vencord.dev/installing/):

```sh
git clone https://github.com/EvanderIV/StatusSchedule src/userplugins/statusSchedule
pnpm build
pnpm inject
```

Then enable **StatusSchedule** in Vencord's plugin settings. It depends on Vencord's built-in
`UserSettingsAPI` plugin, which is enabled automatically.

Nothing happens until you enable a rule: the two rules shipped by default ("Overnight" and
"Daytime") are switched off, and exist as a template to edit.

## How rules work

A rule is a window of local time, a status, and the weekdays it applies on.

- **Windows that cross midnight** are supported. `23:00 → 07:30` matches from 23:00 up to 07:30
  the next morning. A window is inclusive of its start and exclusive of its end, so back-to-back
  rules (`07:30 → 23:00` and `23:00 → 07:30`) never overlap.
- **A start equal to its end** means "all day" — useful as a full-coverage fallback rule you
  toggle on and off by hand.
- **Overlapping rules** are resolved by priority, highest first. That is how a DND focus block at
  09:00–11:00 (priority 10) beats a broad "Online during the day" rule (priority 0). Rules with
  equal priority are resolved by whichever comes first in the list.
- **When a window ends with no rule to take over,** your previous status comes back — whatever you
  were on before the rule started. So a one-off "DND 09:00–11:00" returns you to Online at 11:00
  without needing a second rule covering the rest of the day. Turn off **Restore status after a
  rule ends** if you would rather the last rule's status simply stay put.
- **A chain of back-to-back rules unwinds to what preceded the first of them.** If Online → Focus
  (DND) → Midday (Idle) → nothing, you end up Online, not DND.
- **No rule has ever matched, and none does now?** Nothing happens. There is no implicit default
  status. For guaranteed coverage, add a rule with every day selected, an identical start and end,
  and the lowest priority.
- **Days are matched against the day the clock currently reads.** A `23:00 → 07:30` rule enabled
  only on Monday covers Monday 00:00–07:30 and Monday 23:00–24:00 — it does not run into Tuesday
  morning. Select both days if you want a full Monday night.

## Manual changes are respected

If you set your status by hand — DND for a meeting, say — the plugin notices on its next check
and stops enforcing the rule that would otherwise apply. It stays out of the way until the next
scheduled transition (when a different rule, or a different status, becomes due), at which point
automatic control resumes.

Turn off **Respect manual status changes** if you would rather the schedule always win; the
current rule is then re-applied on every check.

A status you pick while *no* rule is running is simply yours — the plugin isn't enforcing anything
at that point, so it takes no notice and the next rule still falls due normally. Picking a status
during a rule's window also cancels the restore described above, since your choice is the more
recent one.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Schedule | two disabled examples | The rule list, plus an "edit as JSON" escape hatch |
| How often to check the schedule | 30 seconds | Clamped to a 5 second minimum |
| Hold a status you set by hand | on | The manual-override behaviour above |
| Restore status after a rule ends | on | Go back to the status you had before the rule started |
| Show a toast when the schedule changes your status | on | Confirms changes actually happened |

Failures always toast, regardless of that last setting, so a broken plugin never fails silently.

### JSON format

The "Advanced: edit as JSON" section edits the same array the list above does, so changes made
either way round-trip cleanly. `priority` defaults to `0`, `enabled` to `false`, and missing or
duplicated `id`s are regenerated on apply.

```json
[
  {
    "id": "8f0e...",
    "label": "Overnight",
    "start": "23:00",
    "end": "07:30",
    "status": "invisible",
    "days": [0, 1, 2, 3, 4, 5, 6],
    "priority": 0,
    "enabled": true
  }
]
```

`status` is one of `online`, `idle`, `dnd`, `invisible`. `days` uses `0` for Sunday through `6`
for Saturday.

## Known limitations

- **No timezone awareness.** Rules are evaluated against the system clock, so they travel with
  you. Pinning a rule to a fixed timezone ("always UTC 03:00") is not supported.
- **No per-server status.** Discord has no per-guild presence; this is a platform limitation.
- **Depends on a Discord internal.** Setting presence goes through the user settings proto, which
  is not a public API and can change in a client update. That is confined to
  [`applyStatus.ts`](applyStatus.ts), which documents what to check if it ever breaks.
- **Disabling the plugin does not revert your status.** It stops making changes and leaves your
  presence where it was.

## Development

The scheduling logic in [`schedule.ts`](schedule.ts) has no Vencord, webpack, or Discord imports,
so it runs and is tested outside the client:

```sh
npx tsx --test src/userplugins/statusSchedule/schedule.test.ts
```

From the Vencord root, `npx tsc --noEmit` typechecks and `npx eslint src/userplugins/statusSchedule`
lints against Vencord's own configuration.

| File | Role |
| --- | --- |
| `index.tsx` | Plugin definition, lifecycle, check loop, and the status write itself |
| `types.ts` | Rule and status types, weekday and status metadata |
| `schedule.ts` | Pure time-matching, the manual-override decision, validation, JSON parsing |
| `applyStatus.ts` | The only Discord-internals surface |
| `settings.ts` | Persisted settings and defaults |
| `settingsComponents.tsx` | Rule list, rule editor, JSON escape hatch |

## Licence

GPL-3.0-or-later, matching Vencord.
