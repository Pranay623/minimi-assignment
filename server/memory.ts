import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import type { MemoryReference, Turn } from '../shared/types.js';
import type { Store } from './db.js';

export interface DateWindow {
  start: string;
  end: string;
  label: string;
}
export interface TimeContext {
  now: string;
  timezone: string;
  localDate: string;
  window: DateWindow | null;
  note: string | null;
}
export interface MemoryContext {
  time: TimeContext;
  turns: Turn[];
  references: MemoryReference[];
  truncated: boolean;
  dateMatches: number;
}

/** Calendar arithmetic happens in the user's zone, not in the server's zone. */
export function resolveTime(text: string, now: Date, timezone: string): TimeContext {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) throw new Error('Invalid timezone');
  const context: TimeContext = {
    now: now.toISOString(),
    timezone,
    localDate: local.toISODate()!,
    window: null,
    note: null,
  };
  const window = (start: DateTime, days = 1): TimeContext => ({
    ...context,
    window: {
      start: start.startOf('day').toUTC().toISO()!,
      end: start.startOf('day').plus({ days }).toUTC().toISO()!,
      label:
        days === 1
          ? start.toFormat('d LLLL yyyy')
          : `${start.toFormat('d LLL')}–${start.plus({ days: days - 1 }).toFormat('d LLL yyyy')}`,
    },
  });

  // "Today" in "is it still true today?" is the comparison endpoint, not the memory anchor.
  const anchorText = text
    .replace(/\b(?:as of|correct|true|valid|changed|different)\s+today\b/gi, '')
    .replace(/\bstill\s+\w+\s+today\b/gi, '');
  const isoDates = [...anchorText.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)];
  if (isoDates.some((match) => !DateTime.fromISO(match[0], { zone: timezone }).isValid))
    return { ...context, note: 'The requested calendar date is invalid.' };
  if (
    /\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b/i.test(anchorText)
  )
    return {
      ...context,
      note: 'A future date cannot identify an earlier conversation. Clarify the historical baseline.',
    };
  if (
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(anchorText.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ''))
  )
    return {
      ...context,
      note: 'Numeric dates can be ambiguous. Ask for the month in words or an ISO date.',
    };
  if (/\blast week\b/i.test(anchorText))
    return window(local.startOf('week').minus({ weeks: 1 }), 7);

  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const days = [
    ...anchorText
      .toLowerCase()
      .matchAll(
        /\b(?:(last|this|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g,
      ),
  ];
  if (days.length === 1) {
    const match = days[0]!;
    const target = weekdays.indexOf(match[2]!) + 1;
    let diff = (local.weekday - target + 7) % 7;
    if (diff === 0 && match[1] === 'last') diff = 7;
    return {
      ...window(local.minus({ days: diff })),
      note: 'Weekdays refer to their most recent occurrence; “last” excludes today.',
    };
  }
  // A UTC-shaped reference prevents chrono from using the host machine's timezone.
  const reference = new Date(Date.UTC(local.year, local.month - 1, local.day, 12));
  const parsed = chrono.casual
    .parse(anchorText, { instant: reference, timezone: 0 }, { forwardDate: false })
    .filter((p) => p.start.isCertain('day') || p.start.isCertain('weekday'));
  const historical = parsed.filter((p) => !/^today$/i.test(p.text));
  const anchors = historical.length ? historical : parsed;
  if (anchors.length > 1 || days.length > 1)
    return {
      ...context,
      note: 'Multiple possible dates were mentioned. Clarify which conversation is the baseline.',
    };
  if (!anchors.length) return context;
  const result = anchors[0]!;
  let date = DateTime.fromObject(
    {
      year: result.start.get('year')!,
      month: result.start.get('month')!,
      day: result.start.get('day')!,
    },
    { zone: timezone },
  );
  if (!result.start.isCertain('year') && date.startOf('day') > local.startOf('day'))
    date = date.minus({ years: 1 });
  if (!date.isValid) return { ...context, note: 'The requested calendar date is invalid.' };
  if (result.end)
    return {
      ...context,
      note: 'A date range was mentioned. Clarify the baseline date if the matching history is ambiguous.',
    };
  return {
    ...window(date),
    note: result.start.isCertain('year')
      ? null
      : 'Dates without a year resolve to their most recent occurrence.',
  };
}

const stopWords = new Set(
  'a an the i me my we our you your it its them they that this those these any some all what which who did do does is are was were be been has have had on in at to for from of and or but with about since then today yesterday last still changed change ask asked tell said can could would should please now pricing price monday tuesday wednesday thursday friday saturday sunday november october'.split(
    ' ',
  ),
);

export function lexicalQuery(text: string): string | undefined {
  const tokens = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? [])]
    .filter((token) => !stopWords.has(token))
    .slice(0, 14);
  return tokens.length
    ? tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ')
    : undefined;
}

export function retrieveMemory(
  store: Store,
  owner: string,
  conversationId: string,
  question: string,
  now: Date,
  timezone: string,
  demo = false,
): MemoryContext {
  const time = resolveTime(question, now, timezone);
  const selected = new Map<string, { turn: Turn; reason: MemoryReference['reason'] }>();
  const add = (turns: Turn[], reason: MemoryReference['reason']) => {
    for (const turn of turns) if (!selected.has(turn.id)) selected.set(turn.id, { turn, reason });
  };
  const dated = time.window ? store.recall(owner, { ...time.window, limit: 41, demo }) : [];
  add(dated, 'date');
  // Keep exact originals; use adjacent turns to resolve references such as "those five".
  add(store.recall(owner, { conversationId, limit: 6, demo }), 'recent');
  const query = lexicalQuery(question);
  if (query) add(store.recall(owner, { query, limit: 12, demo }), 'lexical');
  add(store.recall(owner, { limit: 4, demo }), 'recent');
  let size = 0;
  const chosen: { turn: Turn; reason: MemoryReference['reason'] }[] = [];
  for (const candidate of selected.values()) {
    const chars = candidate.turn.question.length + candidate.turn.answer.length;
    if (chosen.length >= 16 || size + chars > 60_000) continue;
    chosen.push(candidate);
    size += chars;
  }
  return {
    time,
    turns: chosen.map((c) => c.turn),
    dateMatches: dated.length,
    truncated: chosen.length < selected.size || dated.length === 41,
    references: chosen.map(({ turn, reason }) => ({
      turnId: turn.id,
      conversationId: turn.conversationId,
      question: turn.question,
      createdAt: turn.createdAt,
      reason,
    })),
  };
}
