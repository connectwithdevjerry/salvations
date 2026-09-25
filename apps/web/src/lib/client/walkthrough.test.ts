import { describe, expect, it } from 'vitest';
import { placeCard, spotlightOf, stepsFor } from './walkthrough';

describe('stepsFor', () => {
  it('walks one assistant’s tabs when there is one', () => {
    const steps = stepsFor({ workspaceId: 'ws_1', agent: { id: 'agt_1', name: 'Bee' } });
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual([
      'welcome', 'assistants', 'chat', 'documents', 'routine', 'integrations', 'model', 'server',
      'models', 'approvals', 'activity', 'done',
    ]);
    const chat = steps.find((s) => s.id === 'chat');
    expect(chat?.path).toBe('/agents/agt_1');
    expect(chat?.activate).toBe(true);
    expect(chat?.body).toContain('Bee');
  });

  it('collapses the middle to "create one" when there is no assistant', () => {
    const steps = stepsFor({ workspaceId: 'ws_1' });
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual(['welcome', 'assistants', 'create', 'models', 'approvals', 'activity', 'done']);
    expect(steps.find((s) => s.id === 'assistants')?.path).toBe('/agents');
    expect(steps.find((s) => s.id === 'create')?.target).toBe('create-assistant');
  });

  it('shows the Admin page only to those who run the workspace', () => {
    const ids = (admin: boolean) => stepsFor({ workspaceId: 'ws_1', admin }).map((s) => s.id);
    expect(ids(true)).toContain('admin');
    expect(ids(false)).not.toContain('admin');
    expect(ids(true).indexOf('admin')).toBe(ids(true).length - 2);
    expect(stepsFor({ workspaceId: 'ws_1', admin: true }).find((s) => s.id === 'admin')?.target).toBe('nav-admin');
  });

  it('starts with a centred welcome and ends on the help button', () => {
    const steps = stepsFor({ workspaceId: 'ws_1' });
    expect(steps[0]?.target).toBeUndefined();
    expect(steps.at(-1)?.target).toBe('help');
  });
});

describe('placeCard', () => {
  const viewport = { width: 1200, height: 800 };
  const card = { width: 320, height: 160 };

  it('sits below the target when there is room', () => {
    const placement = placeCard({ top: 100, left: 500, width: 80, height: 30 }, card, viewport);
    expect(placement).toEqual({ mode: 'anchored', side: 'below', top: 100 + 30 + 6 + 12, left: 500 + 40 - 160 });
  });

  it('moves above when the bottom would not fit', () => {
    const placement = placeCard({ top: 700, left: 500, width: 80, height: 30 }, card, viewport);
    expect(placement.mode).toBe('anchored');
    if (placement.mode !== 'anchored') return;
    expect(placement.side).toBe('above');
    expect(placement.top).toBe(700 - 6 - 12 - 160);
  });

  it('never leaves the screen', () => {
    const placement = placeCard({ top: 10, left: 1180, width: 20, height: 20 }, card, viewport);
    expect(placement.mode).toBe('anchored');
    if (placement.mode !== 'anchored') return;
    expect(placement.left).toBe(1200 - 16 - 320);
    expect(placement.top).toBeGreaterThanOrEqual(16);
  });

  it('sits beside a target as tall as the screen', () => {
    const placement = placeCard({ top: 56, left: 0, width: 300, height: 744 }, card, viewport);
    expect(placement).toEqual({ mode: 'anchored', side: 'right', top: 56 - 6 + 756 / 2 - 80, left: 300 + 6 + 12 });
  });

  it('is centred with no target and a sheet on a phone', () => {
    expect(placeCard(undefined, card, viewport)).toEqual({ mode: 'centre' });
    expect(placeCard({ top: 0, left: 0, width: 10, height: 10 }, card, { width: 390, height: 800 })).toEqual({ mode: 'sheet' });
  });

  it('inflates the spotlight around the target', () => {
    expect(spotlightOf({ top: 10, left: 20, width: 30, height: 40 })).toEqual({ top: 4, left: 14, width: 42, height: 52 });
  });
});
