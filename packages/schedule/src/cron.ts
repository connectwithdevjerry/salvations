/**
 * Five-field cron, evaluated in a named time zone.
 *
 * Written rather than depended on, for once with a real reason beyond size: the
 * behaviour that matters here is what happens across a DST boundary and how
 * day-of-month interacts with day-of-week, and both differ between libraries.
 * Owning it means the answer is in one file with tests next to it.
 *
 * The evaluator answers "does this minute match", never "when is the next run".
 * Computing a next-run time means date arithmetic across DST, which is where
 * schedulers go wrong; asking about a minute that has already happened is a
 * pure comparison of wall-clock fields, and the caller walks the minutes it has
 * not yet considered.
 */

export interface CronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  /**
   * Whether either day field was restricted.
   *
   * Cron's oddest rule: when BOTH day-of-month and day-of-week are restricted,
   * a day matches if EITHER does — not both. `0 0 1 * MON` is the first of the
   * month AND every Monday. Getting this backwards silently produces a schedule
   * that almost never fires.
   */
  readonly restrictsDayOfMonth: boolean;
  readonly restrictsDayOfWeek: boolean;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

interface Bound { readonly min: number; readonly max: number; readonly names?: Readonly<Record<string, number>> }

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAYS: Readonly<Record<string, number>> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const BOUNDS: readonly Bound[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS },
  { min: 0, max: 7, names: DAYS },
];

/** Shorthands people actually type. */
const ALIASES: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

function parseField(raw: string, bound: Bound): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;

  for (const piece of raw.split(',')) {
    const [range, stepText] = piece.split('/');
    if (range === undefined || range === '') throw new CronError(`"${raw}" is not a valid field.`);

    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new CronError(`"${piece}" has a step that is not a positive whole number.`);
    }

    let from: number;
    let to: number;
    if (range === '*') {
      from = bound.min;
      to = bound.max;
      // `*/15` IS a restriction; a bare `*` is not.
      if (stepText !== undefined) restricted = true;
    } else {
      restricted = true;
      const [startText, endText] = range.split('-');
      from = resolve(startText ?? '', bound);
      to = endText === undefined ? from : resolve(endText, bound);
      // `fri-mon` is a wrap, not an error: people write it and mean it.
      if (from > to) {
        for (let v = from; v <= bound.max; v += 1) values.add(v);
        for (let v = bound.min; v <= to; v += 1) values.add(v);
        continue;
      }
    }

    for (let v = from; v <= to; v += step) values.add(v);
  }

  if (values.size === 0) throw new CronError(`"${raw}" matches nothing.`);
  return { values, restricted };
}

function resolve(text: string, bound: Bound): number {
  const trimmed = text.trim().toLowerCase();
  const named = bound.names?.[trimmed.slice(0, 3)];
  const value = named ?? Number(trimmed);
  if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
    throw new CronError(`"${text}" is not between ${bound.min} and ${bound.max}.`);
  }
  return value;
}

export function parseCron(expression: string): CronFields {
  const normalised = (ALIASES[expression.trim().toLowerCase()] ?? expression).trim();
  const fields = normalised.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      `A cron expression has five fields (minute hour day month weekday); "${expression}" has ${fields.length}.`,
    );
  }

  const parsed = fields.map((field, index) => parseField(field, BOUNDS[index] as Bound));
  const dayOfWeek = parsed[4] as { values: Set<number>; restricted: boolean };

  // Both 0 and 7 mean Sunday, and people use both.
  if (dayOfWeek.values.has(7)) dayOfWeek.values.add(0);
  dayOfWeek.values.delete(7);

  return {
    minute: (parsed[0] as { values: Set<number> }).values,
    hour: (parsed[1] as { values: Set<number> }).values,
    dayOfMonth: (parsed[2] as { values: Set<number> }).values,
    month: (parsed[3] as { values: Set<number> }).values,
    dayOfWeek: dayOfWeek.values,
    restrictsDayOfMonth: (parsed[2] as { restricted: boolean }).restricted,
    restrictsDayOfWeek: dayOfWeek.restricted,
  };
}

export const isValidCron = (expression: string): boolean => {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
};

interface WallClock {
  readonly minute: number;
  readonly hour: number;
  readonly dayOfMonth: number;
  readonly month: number;
  readonly dayOfWeek: number;
}

const WEEKDAY: Readonly<Record<string, number>> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * The wall-clock fields in a named zone.
 *
 * Via Intl rather than by offset arithmetic, because that is the only way to
 * get DST right without shipping a copy of the tz database. `hourCycle: 'h23'`
 * matters: with `hour12: false` some ICU builds report midnight as 24, and a
 * schedule set for midnight would then never match.
 */
export function wallClockIn(timeZone: string, at: Date): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(at);

  const read = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  return {
    minute: Number(read('minute')),
    hour: Number(read('hour')),
    dayOfMonth: Number(read('day')),
    month: Number(read('month')),
    dayOfWeek: WEEKDAY[read('weekday')] ?? 0,
  };
}

export function matches(fields: CronFields, timeZone: string, at: Date): boolean {
  const now = wallClockIn(timeZone, at);

  if (!fields.minute.has(now.minute)) return false;
  if (!fields.hour.has(now.hour)) return false;
  if (!fields.month.has(now.month)) return false;

  const byDayOfMonth = fields.dayOfMonth.has(now.dayOfMonth);
  const byDayOfWeek = fields.dayOfWeek.has(now.dayOfWeek);

  // The OR rule. When both day fields are restricted either one is enough;
  // otherwise whichever is restricted decides, and if neither is, any day.
  if (fields.restrictsDayOfMonth && fields.restrictsDayOfWeek) return byDayOfMonth || byDayOfWeek;
  if (fields.restrictsDayOfMonth) return byDayOfMonth;
  if (fields.restrictsDayOfWeek) return byDayOfWeek;
  return true;
}

const MINUTE_MS = 60_000;

/**
 * Every minute in `(after, until]` that the expression matches.
 *
 * Walked minute by minute rather than computed, so DST needs no special case:
 * a spring-forward hour simply has no minutes to visit, and a fall-back hour's
 * repeated minutes are distinct instants that the caller's own de-duplication
 * handles.
 *
 * `cap` is not an optimisation. Without it, a scheduler that has been down for
 * a day comes back and fires a daily schedule once — but a per-minute schedule
 * fourteen hundred times, all at once, against a workspace's budget. The cap
 * turns a recovery into a catch-up rather than a stampede.
 */
export function dueBetween(
  fields: CronFields,
  timeZone: string,
  after: Date,
  until: Date,
  cap = 10,
): readonly Date[] {
  const found: Date[] = [];

  // Start at the minute after `after`, aligned, so a minute already fired for
  // is never revisited.
  let cursor = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const end = Math.floor(until.getTime() / MINUTE_MS) * MINUTE_MS;

  // Bound the WALK as well as the result. A schedule dormant for a year would
  // otherwise visit half a million minutes to return ten.
  const earliest = end - cap * 24 * 60 * MINUTE_MS;
  if (cursor < earliest) cursor = Math.floor(earliest / MINUTE_MS) * MINUTE_MS;

  for (; cursor <= end; cursor += MINUTE_MS) {
    const at = new Date(cursor);
    if (matches(fields, timeZone, at)) {
      found.push(at);
      if (found.length >= cap) break;
    }
  }

  return found;
}

/** Whether a zone name is one this runtime actually knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
