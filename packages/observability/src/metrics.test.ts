import { describe, expect, it } from 'vitest';
import { ExecutionMetricsRecorder } from './execution-metrics';
import { InMemoryMetrics, NO_METRICS } from './metrics';

describe('aggregation', () => {
  it('counts and aggregates rather than retaining samples', () => {
    // A long-lived worker retaining every sample grows a list forever, and a
    // metric that causes an outage is not worth having.
    const metrics = new InMemoryMetrics();
    for (const value of [10, 20, 60]) metrics.observe('run.step', value);

    expect(metrics.observations()['run.step'])
      .toEqual({ count: 3, mean: 30, min: 10, max: 60 });
  });

  it('keeps tagged series apart', () => {
    const metrics = new InMemoryMetrics();
    metrics.count('run.finished', 1, { status: 'succeeded' });
    metrics.count('run.finished', 1, { status: 'failed' });
    metrics.count('run.finished', 1, { status: 'succeeded' });

    expect(metrics.counts()).toEqual({
      'run.finished{status=succeeded}': 2,
      'run.finished{status=failed}': 1,
    });
  });

  it('orders tags, so one series does not split across two keys', () => {
    const metrics = new InMemoryMetrics();
    metrics.count('run.step', 1, { a: '1', b: '2' });
    metrics.count('run.step', 1, { b: '2', a: '1' });
    expect(Object.keys(metrics.counts())).toEqual(['run.step{a=1,b=2}']);
  });

  it('discards everything when metrics are switched off', () => {
    // So nothing downstream has to guard on undefined.
    expect(() => {
      NO_METRICS.count('run.finished');
      NO_METRICS.observe('run.step', 5);
    }).not.toThrow();
  });
});

describe('the headline number', () => {
  it('reports yields per completed run, which is how slice sizing is judged', () => {
    // Near zero means slices comfortably fit a run; above one means every run
    // is paying re-claims and cold starts.
    const metrics = new InMemoryMetrics();
    const recorder = new ExecutionMetricsRecorder(metrics);

    recorder.sliceYielded('run_1', 4);
    recorder.sliceYielded('run_1', 3);
    recorder.runFinished('run_1', 'succeeded', 7);

    expect(metrics.yieldRate()).toBe(2);
  });

  it('is zero before anything has finished, rather than dividing by zero', () => {
    expect(new InMemoryMetrics().yieldRate()).toBe(0);
  });

  it('sums a metric across its tags, not only its bare name', () => {
    // Finishes are tagged by status. A rate that read the bare key would
    // report zero forever and look healthy while it did.
    const metrics = new InMemoryMetrics();
    const recorder = new ExecutionMetricsRecorder(metrics);
    recorder.runFinished('run_1', 'succeeded', 1);
    recorder.runFinished('run_2', 'failed', 1);

    expect(metrics.total('run.finished')).toBe(2);
  });

  it('records how much each slice achieved, not only that it yielded', () => {
    // A yield after zero steps means the reserve is misconfigured, and that
    // looks identical to a busy slice in a bare count.
    const metrics = new InMemoryMetrics();
    new ExecutionMetricsRecorder(metrics).sliceYielded('run_1', 0);
    expect(metrics.observations()['run.slice.yielded']?.max).toBe(0);
  });
});

describe('the executor recorder', () => {
  it('tags a finish with its status and a step with what it did', () => {
    const metrics = new InMemoryMetrics();
    const recorder = new ExecutionMetricsRecorder(metrics);

    recorder.runFinished('run_1', 'failed', 2);
    recorder.runSuspended('run_1', 'approval');
    recorder.stepCompleted('run_1', 'tool_phase', 1_200);
    recorder.leaseLost('run_1');
    recorder.idleWake();

    expect(metrics.counts()).toMatchObject({
      'run.finished{status=failed}': 1,
      'run.suspended{reason=approval}': 1,
      'run.step{did=tool_phase}': 1,
      'run.lease_lost': 1,
      'executor.idle_wake': 1,
    });
    expect(metrics.observations()['run.step{did=tool_phase}']?.mean).toBe(1_200);
  });

  it('resets cleanly, so a test or a scrape window starts empty', () => {
    const metrics = new InMemoryMetrics();
    metrics.count('run.finished');
    metrics.reset();
    expect(metrics.counts()).toEqual({});
    expect(metrics.observations()).toEqual({});
  });
});
