import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionReminder, orientationText, groundingText } from '../lib/reminders.mjs';

const effect = { kind: 'inject_reminder', message: orientationText, severity: 'info', audience: 'model' };
const context = state => ({ snapshot: { sessionId: 'session-a' }, signal: new AbortController().signal, state });

test('reminder state errors pass and version contention has a bounded reread', async () => {
  for (const phase of ['get', 'set']) {
    const ctx = context({ get: async () => ({ version: 0 }), set: async () => ({ ok: true }) });
    ctx.state[phase] = async () => { throw new Error('State unavailable.'); };
    assert.deepEqual(await sessionReminder(ctx, 'notient.orientation.v1', effect), {});
  }
  let reads = 0; let writes = 0;
  const ctx = context({ get: async () => { reads++; return { version: reads }; }, set: async (key, value, options) => { writes++; assert.equal(options.ifVersion, reads); return { ok: false }; } });
  assert.deepEqual(await sessionReminder(ctx, 'notient.orientation.v1', effect), {});
  assert.equal(reads, 2); assert.equal(writes, 2);
});

test('aborted and timed-out reminder work emits no effect and stops before setting an unsent flag', async () => {
  let writes = 0; let release;
  const pending = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const ctx = context({ get: async () => pending, set: async () => { writes++; return { ok: true }; } }); ctx.signal = controller.signal;
  const result = sessionReminder(ctx, 'notient.orientation.v1', effect);
  controller.abort(); release({ version: 0 });
  assert.deepEqual(await result, {}); assert.equal(writes, 0);
  assert.deepEqual(await sessionReminder(ctx, 'notient.orientation.v1', effect), {});
});

test('reminder abort after the successful stamp preserves at-most-once emission and bad text never stamps', async () => {
  let writes = 0; const controller = new AbortController();
  const ctx = context({ get: async () => ({ version: 0 }), set: async () => { writes++; controller.abort(); return { ok: true }; } }); ctx.signal = controller.signal;
  assert.deepEqual(await sessionReminder(ctx, 'notient.orientation.v1', effect), {}); assert.equal(writes, 1);
  const normal = context({ get: async () => { throw new Error('Invalid text must not read state.'); } });
  assert.deepEqual(await sessionReminder(normal, 'notient.orientation.v1', { ...effect, message: 'x'.repeat(601) }), {});
  assert.deepEqual(await sessionReminder(normal, 'notient.orientation.v1', { ...effect, message: '' }), {});
  assert.equal(orientationText.length, 475); assert.equal(groundingText.length, 397);
});
