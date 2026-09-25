import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOP_THRESHOLD, LoopDetector, NEVER_STOPPED } from './loop-detection';

const call = (name: string, args: unknown = {}) => ({ canonicalName: name, args });

describe('exact repeats', () => {
  it('allows a call the model has not made before', () => {
    expect(new LoopDetector().inspect(call('a__x')).looping).toBe(false);
  });

  it('stops the call that would be the Nth identical one', () => {
    const detector = new LoopDetector({ threshold: 3 });
    detector.record(call('a__x', { q: 1 }));
    detector.record(call('a__x', { q: 1 }));
    expect(detector.inspect(call('a__x', { q: 1 }))).toMatchObject({
      looping: true, repeats: 3, canonicalName: 'a__x',
    });
  });

  it('tells the model what to do instead of just refusing', () => {
    // A bare refusal is something a model retries.
    const detector = LoopDetector.from([call('a__x'), call('a__x')], { threshold: 3 });
    expect(detector.inspect(call('a__x')).message)
      .toMatch(/change the arguments, use a different tool, or answer with what you have/);
  });

  it('ignores argument key order, so a reserialised call still counts', () => {
    const detector = new LoopDetector({ threshold: 2 });
    detector.record(call('a__x', { b: 2, a: 1 }));
    expect(detector.inspect(call('a__x', { a: 1, b: 2 })).looping).toBe(true);
  });

  it('treats a different argument as a different call', () => {
    // This is the behaviour we WANT from a model: retry with a correction.
    const detector = LoopDetector.from(
      [call('a__x', { q: 1 }), call('a__x', { q: 1 })], { threshold: 3 },
    );
    expect(detector.inspect(call('a__x', { q: 2 })).looping).toBe(false);
  });

  it('treats a different tool as a different call', () => {
    const detector = LoopDetector.from([call('a__x'), call('a__x')], { threshold: 3 });
    expect(detector.inspect(call('b__x')).looping).toBe(false);
  });

  it('defaults to stopping the third identical call', () => {
    const detector = LoopDetector.from([call('a__x'), call('a__x')]);
    expect(DEFAULT_LOOP_THRESHOLD).toBe(3);
    expect(detector.inspect(call('a__x')).looping).toBe(true);
  });
});

describe('resumption and windowing', () => {
  it('rebuilds from persisted history, so a loop survives a slice boundary', () => {
    // An in-memory counter resets exactly when the loop gets expensive.
    const detector = LoopDetector.from(
      [call('a__x'), call('b__y'), call('a__x')], { threshold: 3 },
    );
    expect(detector.inspect(call('a__x')).looping).toBe(true);
  });

  it('forgets beyond the window, so a long run does not grow it forever', () => {
    const detector = new LoopDetector({ threshold: 2, window: 2 });
    detector.record(call('a__x'));
    detector.record(call('b__y'));
    detector.record(call('c__z'));
    expect(detector.inspect(call('a__x')).looping).toBe(false);
  });
});

describe('a parallel phase', () => {
  it('catches a duplicate emitted twice within one batch', () => {
    // A model can emit the same call twice in a single parallel batch.
    const detector = LoopDetector.from([call('a__x')], { threshold: 3 });
    expect(detector.inspectPhase([call('a__x'), call('b__y'), call('a__x')]).looping).toBe(true);
  });

  it('admits a batch of distinct calls', () => {
    const detector = LoopDetector.from([call('a__x'), call('a__x')], { threshold: 3 });
    expect(detector.inspectPhase([call('b__y'), call('c__z')]).looping).toBe(false);
  });

  it('does not record the phase it merely inspected', () => {
    // Inspection must be free of side effects, or a rejected phase would still
    // push the run closer to the threshold.
    const detector = LoopDetector.from([call('a__x')], { threshold: 3 });
    detector.inspectPhase([call('a__x')]);
    expect(detector.inspect(call('a__x')).looping).toBe(false);
  });
});

describe('the kill switch', () => {
  it('defaults to never stopping, so composition must opt in to a real one', async () => {
    expect(await NEVER_STOPPED.isStopped('ws_1', 'agt_1')).toBeUndefined();
  });
});
