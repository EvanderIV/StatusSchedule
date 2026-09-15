/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Evan Minich and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { Switch } from "@components/Switch";
import { classNameFactory } from "@utils/css";
import { Select, TextArea, TextInput, useState } from "@webpack/common";

import { describeDays, formatTimeRange, parseRulesJson, resolveActiveRule, validateRule } from "./schedule";
import { settings } from "./settings";
import { ALL_WEEKDAYS, PRESENCE_STATUSES, PresenceStatus, ScheduleRule, STATUS_META, Weekday, WEEKDAY_LABELS } from "./types";

const cl = classNameFactory("vc-statusSchedule-");

function makeRule(): ScheduleRule {
    return {
        id: crypto.randomUUID(),
        label: "New rule",
        start: "09:00",
        end: "17:00",
        status: "online",
        days: [...ALL_WEEKDAYS],
        priority: 0,
        enabled: false
    };
}

function StatusDot({ status }: { status: PresenceStatus; }) {
    return <span className={cl("dot")} style={{ background: STATUS_META[status].color }} />;
}

function StatusLabel({ status }: { status: PresenceStatus; }) {
    return (
        <span className={cl("status-label")}>
            <StatusDot status={status} />
            {STATUS_META[status].label}
        </span>
    );
}

/** Text field that only writes back on blur, so typing doesn't churn the settings store. */
function DeferredInput({ initialValue, onCommit, ...props }: {
    initialValue: string;
    onCommit(value: string): void;
    type?: string;
    placeholder?: string;
    error?: string;
}) {
    const [value, setValue] = useState(initialValue);

    return (
        <TextInput
            {...props}
            value={value}
            onChange={setValue}
            spellCheck={false}
            onBlur={() => value !== initialValue && setTimeout(() => onCommit(value), 0)}
        />
    );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode; }) {
    return (
        <>
            <Span weight="medium" size="md">{label}</Span>
            <div>
                {children}
                {error != null && <Span className={cl("error")}>{error}</Span>}
            </div>
        </>
    );
}

function StatusSelect({ value, onChange }: { value: PresenceStatus; onChange(status: PresenceStatus): void; }) {
    return (
        <Select
            options={PRESENCE_STATUSES.map(status => ({ value: status, label: STATUS_META[status].label }))}
            isSelected={status => status === value}
            select={onChange}
            serialize={String}
            closeOnSelect
            renderOptionLabel={option => <StatusLabel status={option.value} />}
            renderOptionValue={options => options[0] == null ? null : <StatusLabel status={options[0].value} />}
        />
    );
}

function WeekdayPicker({ days, onChange }: { days: Weekday[]; onChange(days: Weekday[]): void; }) {
    return (
        <div className={cl("days")}>
            {WEEKDAY_LABELS.map((label, index) => {
                const day = index as Weekday;
                const active = days.includes(day);

                return (
                    <Button
                        key={label}
                        size="xs"
                        variant={active ? "primary" : "secondary"}
                        aria-pressed={active}
                        onClick={() => onChange(
                            active
                                ? days.filter(other => other !== day)
                                : [...days, day].sort((a, b) => a - b)
                        )}
                    >
                        {label}
                    </Button>
                );
            })}
        </div>
    );
}

function RuleEditor({ rule }: { rule: ScheduleRule; }) {
    const errors = validateRule(rule);

    return (
        <div className={cl("editor")}>
            <Field label="Name" error={errors.label}>
                <DeferredInput
                    initialValue={rule.label}
                    placeholder="Overnight"
                    onCommit={value => rule.label = value}
                />
            </Field>

            <Field label="Start" error={errors.start}>
                <DeferredInput type="time" initialValue={rule.start} onCommit={value => rule.start = value} />
            </Field>

            <Field label="End" error={errors.end}>
                <DeferredInput type="time" initialValue={rule.end} onCommit={value => rule.end = value} />
            </Field>

            <Field label="Status">
                <StatusSelect value={rule.status} onChange={status => rule.status = status} />
            </Field>

            <Field label="Days" error={errors.days}>
                <WeekdayPicker days={rule.days} onChange={days => rule.days = days} />
            </Field>

            <Field label="Priority" error={errors.priority}>
                <DeferredInput
                    type="number"
                    initialValue={String(rule.priority)}
                    onCommit={value => rule.priority = Number.parseInt(value, 10) || 0}
                />
            </Field>
        </div>
    );
}

function RuleRow({ rule, expanded, onToggleExpanded, onDelete }: {
    rule: ScheduleRule;
    expanded: boolean;
    onToggleExpanded(): void;
    onDelete(): void;
}) {
    const invalid = Object.keys(validateRule(rule)).length > 0;

    return (
        <Card className={cl("rule")}>
            <div className={cl("summary")}>
                <div className={cl("summary-main")}>
                    <StatusDot status={rule.status} />
                    <Span weight="semibold" size="md" className={cl("summary-name")}>{rule.label || "Untitled rule"}</Span>
                    {invalid && <Span className={cl("error")}>needs attention</Span>}
                </div>

                <Span className={cl("summary-meta")}>{formatTimeRange(rule)}</Span>
                <Span className={cl("summary-meta")}>{describeDays(rule.days)}</Span>
                <Span className={cl("summary-meta")}>P{rule.priority}</Span>

                <Switch checked={rule.enabled} onChange={enabled => rule.enabled = enabled} />

                <Button size="small" variant="secondary" onClick={onToggleExpanded}>
                    {expanded ? "Done" : "Edit"}
                </Button>
                <Button size="small" variant="dangerSecondary" onClick={onDelete}>Delete</Button>
            </div>

            {expanded && <RuleEditor rule={rule} />}
        </Card>
    );
}

function JsonEditor({ rules }: { rules: ScheduleRule[]; }) {
    const [open, setOpen] = useState(false);
    // null means "mirror the live rules"; a string means the user has unapplied edits
    const [draft, setDraft] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    if (!open) {
        return (
            <Button size="small" variant="secondary" onClick={() => setOpen(true)}>
                Advanced: edit as JSON
            </Button>
        );
    }

    const value = draft ?? JSON.stringify(rules, null, 2);

    function apply() {
        const result = parseRulesJson(value, () => crypto.randomUUID());

        if ("error" in result) {
            setError(result.error);
            return;
        }

        settings.store.rules = result.rules;
        setDraft(null);
        setError(null);
    }

    return (
        <div className={cl("json")}>
            <Paragraph>
                The same rules, as raw JSON. This edits the exact array the list above does, so
                changes round-trip either way.
            </Paragraph>

            <TextArea
                value={value}
                onChange={setDraft}
                rows={12}
                spellCheck={false}
                className={cl("json-input")}
            />

            {error != null && <Span className={cl("error")}>{error}</Span>}

            <div className={cl("json-actions")}>
                <Button size="small" onClick={apply} disabled={draft === null}>Apply</Button>
                <Button
                    size="small"
                    variant="secondary"
                    onClick={() => { setDraft(null); setError(null); }}
                    disabled={draft === null}
                >
                    Discard changes
                </Button>
                <Button
                    size="small"
                    variant="secondary"
                    onClick={() => { setOpen(false); setDraft(null); setError(null); }}
                >
                    Close
                </Button>
            </div>
        </div>
    );
}

function ActiveRuleSummary({ rules }: { rules: ScheduleRule[]; }) {
    const active = resolveActiveRule(rules, new Date());

    if (active === null) {
        return (
            <Paragraph>
                No rule covers right now, so your status is left alone. To guarantee full coverage,
                add a rule with every day selected, the same start and end time, and the lowest priority.
            </Paragraph>
        );
    }

    return (
        <Paragraph>
            Right now: <strong>{active.label}</strong> — <StatusLabel status={active.status} />
        </Paragraph>
    );
}

export function StatusScheduleSettings() {
    const { rules } = settings.use(["rules"]);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    return (
        <div className={cl("settings")}>
            <HeadingSecondary>Schedule</HeadingSecondary>
            <Paragraph>
                Rules are checked against your local clock. When several rules overlap, the highest
                priority wins.
            </Paragraph>

            <ActiveRuleSummary rules={rules} />

            <div className={cl("rules")}>
                {rules.length === 0 && <Paragraph>No rules yet.</Paragraph>}

                {rules.map((rule, index) => (
                    <RuleRow
                        key={rule.id}
                        rule={rule}
                        expanded={expandedId === rule.id}
                        onToggleExpanded={() => setExpandedId(current => current === rule.id ? null : rule.id)}
                        onDelete={() => {
                            rules.splice(index, 1);
                            setExpandedId(null);
                        }}
                    />
                ))}
            </div>

            <div className={cl("actions")}>
                <Button
                    size="small"
                    onClick={() => {
                        const rule = makeRule();
                        rules.push(rule);
                        setExpandedId(rule.id);
                    }}
                >
                    Add rule
                </Button>

                <JsonEditor rules={rules} />
            </div>
        </div>
    );
}
