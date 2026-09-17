import { describe, expect, it } from 'vitest';
import {
  CronError, dueBetween, isValidCron, isValidTimeZone, matches, parseCron, wallClockIn,
} from './cron';

const at = (iso: string) => new Date(iso);
const hits = (expression: string, timeZone: string, iso: string) =>
  matches(parseCron(expression), timeZone, at(iso));

describe('parsing', () => {
  it('rejects anything that is not five fields', () => {
    expect(() => parseCron('0 0 *')).toThrow(CronError);
    expect(() => parseCron('0 0 * * * *')).toThrow(/five fields/);
  });

  it('rejects an out-of-range value rather than clamping it', () => {
    // Clamping would turn "run at 25:00" into a schedule that runs at 23:00,
    // which is worse than refusing: it silently does something else.
    expect(() => parseCron('0 25 * * *')).toThrow(/between 0 and 23/);
    expect(() => parseCron('60 * * * *')).toThrow(/between 0 and 59/);
  });

  it('rejects a step that is not a positive whole number', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/positive whole number/);
    expect(() => parseCron('*/-2 * * * *')).toThrow(CronError);
  });

  it('accepts month and weekday names', () => {
    expect(isValidCron('0 9 * jan mon')).toBe(true);
    expect(hits('0 9 * jan mon', 'UTC', '2026-01-05T09:00:00Z')).toBe(true);
  });

  it('treats 7 and 0 as the same Sunday', () => {
    expect(hits('0 0 * * 7', 'UTC', '2026-01-04T00:00:00Z')).toBe(true);
    expect(hits('0 0 * * 0', 'UTC', '2026-01-04T00:00:00Z')).toBe(true);
  });

  it('expands the shorthands', () => {
    expect(hits('@daily', 'UTC', '2026-03-05T00:00:00Z')).toBe(true);
    expect(hits('@daily', 'UTC', '2026-03-05T00:01:00Z')).toBe(false);
    expect(hits('@monthly', 'UTC', '2026-03-01T00:00:00Z')).toBe(true);
    expect(hits('@monthly', 'UTC', '2026-03-02T00:00:00Z')).toBe(false);
  });
});

describe('matching', () => {
  it('matches a plain daily time', () => {
    expect(hits('30 9 * * *', 'UTC', '2026-05-01T09:30:00Z')).toBe(true);
    expect(hits('30 9 * * *', 'UTC', '2026-05-01T09:31:00Z')).toBe(false);
  });

  it('honours a step', () => {
    const fields = parseCron('*/15 * * * *');
    for (const minute of [0, 15, 30, 45]) {
      expect(matches(fields, 'UTC', at(`2026-05-01T10:${String(minute).padStart(2, '0')}:00Z`)))
        .toBe(true);
    }
    expect(matches(fields, 'UTC', at('2026-05-01T10:14:00Z'))).toBe(false);
  });

  it('honours a list and a range', () => {
    expect(hits('0 9,17 * * *', 'UTC', '2026-05-01T17:00:00Z')).toBe(true);
    expect(hits('0 9-11 * * *', 'UTC', '2026-05-01T10:00:00Z')).toBe(true);
    expect(hits('0 9-11 * * *', 'UTC', '2026-05-01T12:00:00Z')).toBe(false);
  });

  it('wraps a range that crosses the end', () => {
    // People write fri-mon and mean it.
    const fields = parseCron('0 0 * * fri-mon');
    expect(matches(fields, 'UTC', at('2026-05-01T00:00:00Z'))).toBe(true);  // Friday
    expect(matches(fields, 'UTC', at('2026-05-04T00:00:00Z'))).toBe(true);  // Monday
    expect(matches(fields, 'UTC', at('2026-05-06T00:00:00Z'))).toBe(false); // Wednesday
  });
});

describe("cron's day-of-month / day-of-week rule", () => {
  it('ORs the two when both are restricted', () => {
    /*
     * The rule that catches everyone. `0 0 1 * MON` means the first of the
     * month OR any Monday — not the first of the month that happens to be a
     * Monday. ANDing them produces a schedule that fires a handful of times a
     * year and looks broken.
     */
    const fields = parseCron('0 0 1 * MON');

    // 1 June 2026 is a Monday — both.
    expect(matches(fields, 'UTC', at('2026-06-01T00:00:00Z'))).toBe(true);
    // 1 May 2026 is a Friday — day-of-month only.
    expect(matches(fields, 'UTC', at('2026-05-01T00:00:00Z'))).toBe(true);
    // 4 May 2026 is a Monday — day-of-week only.
    expect(matches(fields, 'UTC', at('2026-05-04T00:00:00Z'))).toBe(true);
    // 5 May 2026 is a Tuesday — neither.
    expect(matches(fields, 'UTC', at('2026-05-05T00:00:00Z'))).toBe(false);
  });

  it('ANDs nothing when only one is restricted', () => {
    // Day-of-month restricted, weekday open: the 15th, whatever day it is.
    expect(hits('0 0 15 * *', 'UTC', '2026-05-15T00:00:00Z')).toBe(true);
    expect(hits('0 0 15 * *', 'UTC', '2026-05-16T00:00:00Z')).toBe(false);

    // Weekday restricted, day-of-month open: every Monday.
    expect(hits('0 0 * * MON', 'UTC', '2026-05-04T00:00:00Z')).toBe(true);
    expect(hits('0 0 * * MON', 'UTC', '2026-05-05T00:00:00Z')).toBe(false);
  });

  it('treats */2 on a day field as a restriction', () => {
    // `*/2` is a restriction even though it starts with a star, so pairing it
    // with a weekday has to OR. A step counts from the range START, so `*/2` on
    // day-of-month is 1,3,5… — the ODD days, not the even ones.
    const fields = parseCron('0 0 */2 * MON');

    // 6 May 2026 is a Wednesday and an even day — neither field matches.
    expect(matches(fields, 'UTC', at('2026-05-06T00:00:00Z'))).toBe(false);
    // 5 May 2026 is a Tuesday, but an odd day — day-of-month alone is enough.
    expect(matches(fields, 'UTC', at('2026-05-05T00:00:00Z'))).toBe(true);
    // 4 May 2026 is a Monday and an even day — weekday alone is enough.
    expect(matches(fields, 'UTC', at('2026-05-04T00:00:00Z'))).toBe(true);
  });
});

describe('time zones', () => {
  it('matches local wall-clock time, not UTC', () => {
    // 09:00 in New York is 13:00 UTC in summer.
    expect(hits('0 9 * * *', 'America/New_York', '2026-07-01T13:00:00Z')).toBe(true);
    expect(hits('0 9 * * *', 'America/New_York', '2026-07-01T09:00:00Z')).toBe(false);
  });

  it('follows the zone across a DST change', () => {
    /*
     * The same wall-clock time is a different instant either side of the
     * change, which is the whole reason this is not offset arithmetic. New York
     * is UTC-5 in winter and UTC-4 in summer.
     */
    expect(hits('0 9 * * *', 'America/New_York', '2026-01-15T14:00:00Z')).toBe(true);
    expect(hits('0 9 * * *', 'America/New_York', '2026-07-15T13:00:00Z')).toBe(true);
    expect(hits('0 9 * * *', 'America/New_York', '2026-01-15T13:00:00Z')).toBe(false);
  });

  it('matches midnight', () => {
    // ICU reports midnight as 24 under some settings, which would make a
    // midnight schedule never fire.
    expect(wallClockIn('UTC', at('2026-05-01T00:00:00Z')).hour).toBe(0);
    expect(hits('0 0 * * *', 'UTC', '2026-05-01T00:00:00Z')).toBe(true);
    expect(hits('0 0 * * *', 'Asia/Tokyo', '2026-04-30T15:00:00Z')).toBe(true);
  });

  it('recognises a real zone and refuses an invented one', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Middle/Earth')).toBe(false);
  });
});

describe('finding what is due', () => {
  const daily = parseCron('0 9 * * *');

  it('returns nothing when nothing is due', () => {
    expect(dueBetween(daily, 'UTC', at('2026-05-01T09:00:00Z'), at('2026-05-01T10:00:00Z')))
      .toEqual([]);
  });

  it('finds a missed occurrence after a gap', () => {
    // The point of walking rather than only checking "now": a scheduler that
    // runs every five minutes must not miss a 09:00 job.
    const found = dueBetween(daily, 'UTC', at('2026-05-01T08:55:00Z'), at('2026-05-01T09:04:00Z'));
    expect(found).toHaveLength(1);
    expect(found[0]?.toISOString()).toBe('2026-05-01T09:00:00.000Z');
  });

  it('never returns the boundary minute it was told was already handled', () => {
    // Otherwise every sweep re-fires the last occurrence for ever.
    expect(dueBetween(daily, 'UTC', at('2026-05-01T09:00:00Z'), at('2026-05-01T09:00:00Z')))
      .toEqual([]);
  });

  it('caps a catch-up rather than firing a stampede', () => {
    /*
     * A per-minute schedule after a day of downtime is fourteen hundred runs
     * against somebody's budget, all at once. The cap makes recovery a
     * catch-up.
     */
    const everyMinute = parseCron('* * * * *');
    const found = dueBetween(
      everyMinute, 'UTC', at('2026-05-01T00:00:00Z'), at('2026-05-02T00:00:00Z'), 10,
    );
    expect(found).toHaveLength(10);
  });

  it('returns promptly for a schedule dormant for a year', () => {
    // The WALK is bounded, not just the result: without that this visits half a
    // million minutes to return ten.
    const started = Date.now();
    const found = dueBetween(daily, 'UTC', at('2025-05-01T00:00:00Z'), at('2026-05-01T12:00:00Z'));
    expect(found.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('is in order, earliest first', () => {
    const hourly = parseCron('0 * * * *');
    const found = dueBetween(hourly, 'UTC', at('2026-05-01T00:30:00Z'), at('2026-05-01T05:30:00Z'));
    const times = found.map((d) => d.toISOString());
    expect(times).toEqual([...times].sort());
    expect(times[0]).toBe('2026-05-01T01:00:00.000Z');
  });
});
