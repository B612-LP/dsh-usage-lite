import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('./client.js', import.meta.url), 'utf8'))
  .replace('exports.apply = apply;', 'exports.QuotaSection = QuotaSection; exports.apply = apply;');
const current = { id: 'openai-codex:alpha', providerId: 'openai-codex', status: 'ok', account: { label: 'alpha', active: true } };
const target = { id: 'openai-codex:beta', providerId: 'openai-codex', status: 'ok', account: { label: 'beta', active: false, switchable: true } };
const snapshot = { ok: true, queriedAt: Date.now(), canRenew: true, activeAccountTag: 'opaque-alpha-tag', providers: [current, target] };
const quotas = '/usage-lite/quotas';
const refresh = `${quotas}/refresh`;
const renew = `${quotas}/renew`;
const status = `${quotas}/renewal-status`;
const response = (data = snapshot, status = 200) => ({ ok: status < 400, status, json: async () => data });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup({ data = snapshot, fetch = async () => response(), confirm = () => true } = {}) {
  let client;
  let state = { data, busy: false, renewing: false, error: null, switching: null, notice: null };
  let nextTimer = 0;
  let cursor = 0;
  let effect;
  let cleanup;
  let updates = 0;
  const timers = new Map();
  const refs = [];
  const calls = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [state, (update) => { updates++; state = typeof update === 'function' ? update(state) : update; }],
    useRef: (value) => refs[cursor++] ?? (refs[cursor - 1] = { current: value }),
    useEffect: (callback) => { effect = callback; },
    useCallback: (fn) => fn,
  };
  vm.runInNewContext(source, {
    window: { confirm, __ModuleLoader__: { load: ({ factory }) => { client = factory(() => React); } } },
    fetch: async (url, options) => { calls.push({ url, options }); return fetch(url, options); },
    Date, AbortController,
    setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
  });
  const render = () => { cursor = 0; return client.QuotaSection(); };
  return {
    render, calls, timers,
    mount: () => { render(); cleanup = effect(); },
    unmount: () => { assert.equal(typeof cleanup, 'function'); cleanup(); },
    get state() { return state; },
    get updates() { return updates; },
    async tick() {
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, 400);
      timers.delete(id);
      await timer.callback();
    },
  };
}

function nodes(tree, predicate) {
  if (tree == null || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((item) => nodes(item, predicate));
  if (typeof tree.type === 'function') return nodes(tree.type(tree.props), predicate);
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.children, predicate)];
}
function text(tree) {
  if (tree == null || typeof tree === 'boolean') return '';
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  if (typeof tree !== 'object') return String(tree);
  return typeof tree.type === 'function' ? text(tree.type(tree.props)) : text(tree.children);
}
const query = (app) => nodes(app.render(), (n) => n.type === 'button')[0];
const paths = ({ calls }) => calls.map(({ url }) => url.split('?')[0]);
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('mount never renews; only an old snapshot triggers the read-only refresh', async () => {
  for (const old of [false, true]) {
    const data = { ...snapshot, queriedAt: Date.now() - (old ? 11 * 60_000 : 0) };
    const app = setup({ data: null, fetch: async () => response(data) });
    app.mount();
    await flush();
    assert.deepEqual(paths(app), old ? [quotas, refresh] : [quotas]);
    if (old) {
      assert.equal(app.calls[1].options.method, 'POST');
      assert.equal(app.calls[1].options.headers['x-usage-lite-action'], undefined);
    }
    assert.equal(app.timers.size, 0);
    app.unmount();
  }
});

test('manual query sends exactly one guarded write only for an allowed and identified active Codex account', async () => {
  const app = setup({ fetch: async () => response({ ...snapshot, message: '当前账号续期成功。' }) });
  assert.equal(text(query(app)), '查询额度');
  await query(app).props.onClick();
  assert.deepEqual(paths(app), [renew]);
  const { options } = app.calls[0];
  assert.equal(options.method, 'POST');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.redirect, 'error');
  assert.deepEqual({ ...options.headers }, { accept: 'application/json', 'content-type': 'application/json', 'x-usage-lite-action': 'renew-codex' });
  assert.deepEqual(JSON.parse(options.body), { expectedActiveId: current.id, expectedActiveAccountTag: snapshot.activeAccountTag });
  assert.match(text(app.render()), /当前账号续期成功/);
  assert.equal(app.timers.size, 0);

  for (const data of [
    null,
    { ...snapshot, canRenew: undefined },
    { ...snapshot, canRenew: false },
    { ...snapshot, canRenew: 'true' },
    { ...snapshot, activeAccountTag: undefined },
    { ...snapshot, providers: [target] },
    { ...snapshot, providers: [{ ...current, providerId: 'glm' }] },
  ]) {
    const other = setup({ data });
    await query(other).props.onClick();
    assert.deepEqual(paths(other), [refresh]);
    assert.equal(other.calls[0].options.headers['x-usage-lite-action'], undefined);
    assert.equal(other.state.notice, null);
    assert.equal(other.timers.size, 0);
  }
});

test('server-driven progress is read-only, never overlaps polls, and stops on completion', async () => {
  const pending = deferred();
  const pendingStatus = deferred();
  let statusCount = 0;
  const app = setup({ fetch: async (url) => {
    if (url === renew) return pending.promise;
    if (url === status) return ++statusCount === 1 ? pendingStatus.promise : response({ renewing: false });
    throw new Error('unexpected dispatch');
  } });
  const click = query(app).props.onClick;
  const operation = click();
  await click();
  assert.deepEqual(paths(app), [renew]);
  assert.equal(query(app).props.disabled, true);
  assert.equal(nodes(app.render(), (n) => n.props?.['aria-label'] === '切换使用 beta')[0].props.disabled, true);
  assert.doesNotMatch(text(app.render()), /正在续期当前账号/);

  const poll = app.tick();
  assert.equal(app.timers.size, 0); // no overlapping request while status is unresolved
  const { options } = app.calls[1];
  assert.equal(options.method ?? 'GET', 'GET');
  assert.equal(options.body, undefined);
  pendingStatus.resolve(response({ renewing: true }));
  await poll;
  assert.match(text(app.render()), /正在续期当前账号…/);
  await app.tick();
  assert.doesNotMatch(text(app.render()), /正在续期当前账号/);

  pending.resolve(response());
  await operation;
  assert.deepEqual(paths(app), [renew, status, status]);
  assert.equal(options.signal.aborted, true);
  assert.equal(app.timers.size, 0);
  assert.equal(app.state.notice, null);
  assert.equal(query(app).props.disabled, false);
});

test('progress polling has a finite request cap even if the manual request never settles', async () => {
  const pending = deferred();
  const app = setup({ fetch: async (url) => url === renew ? pending.promise : response({ renewing: true }) });
  const operation = query(app).props.onClick();
  for (let i = 0; i < 75; i++) await app.tick();
  assert.equal(app.timers.size, 0);
  assert.equal(app.calls.filter(({ url }) => url === status).length, 75);
  pending.resolve(response());
  await operation;
});

test('unmount cancels a scheduled poll, aborts an in-flight one, fences old results and never triggers reconciliation', async () => {
  for (const inFlight of [false, true]) {
    const pending = deferred();
    const pendingStatus = deferred();
    const app = setup({ fetch: async (url) => {
      if (url === renew) return pending.promise;
      if (url === status) return pendingStatus.promise;
      return response();
    } });
    app.mount();
    await flush();
    const operation = query(app).props.onClick();
    const poll = inFlight ? app.tick() : null;
    const updates = app.updates;
    app.unmount();
    assert.equal(app.timers.size, 0);
    if (inFlight) assert.equal(app.calls[2].options.signal.aborted, true);
    pendingStatus.resolve(response({ renewing: true }));
    pending.resolve(response({ private: 'secret' }, 502));
    await Promise.all([operation, poll]);
    assert.equal(app.updates, updates);
    assert.equal(app.timers.size, 0);
    assert.deepEqual(paths(app), inFlight ? [quotas, renew, status] : [quotas, renew]);
  }
});

test('a late mount GET cannot replace manual data or trigger its automatic refresh', async () => {
  const first = deferred();
  const newer = { ...snapshot, queriedAt: Date.now() + 1 };
  const app = setup({ fetch: async (url) => url === renew ? response(newer) : first.promise });
  app.mount();
  await query(app).props.onClick();
  first.resolve(response({ ...snapshot, queriedAt: 0, canRenew: false }));
  await flush();
  assert.deepEqual(paths(app), [quotas, renew]);
  assert.equal(app.state.data, newer);
  assert.equal(app.state.busy, false);
});

test('authorization failures ignore the body, and authorized 409 reconciles without retry', async () => {
  for (const code of [401, 403]) {
    let reads = 0;
    const app = setup({ fetch: async () => ({ ...response(null, code), json: async () => { reads++; return { error: 'SECRET' }; } }) });
    await query(app).props.onClick();
    assert.deepEqual(paths(app), [renew]);
    assert.equal(reads, 0);
    assert.match(text(app.render()), /未获授权/);
    assert.doesNotMatch(text(app.render()), /SECRET/);
    assert.equal(app.timers.size, 0);
  }
  const changed = { ...snapshot, activeAccountTag: 'opaque-beta-tag', providers: [{ ...target, account: { ...target.account, active: true } }] };
  for (const included of [false, true]) {
    const app = setup({ fetch: async (url) => url === renew
      ? response({ ...(included ? changed : {}), ok: false, error: 'SECRET' }, 409)
      : response(changed) });
    await query(app).props.onClick();
    assert.deepEqual(paths(app), included ? [renew] : [renew, quotas]);
    assert.equal(app.state.data.providers[0].id, target.id);
    assert.match(text(app.render()), /未自动重试续期/);
    assert.doesNotMatch(text(app.render()), /SECRET/);
    assert.equal(app.state.notice, null);
  }
});

test('unknown or mismatched renewal outcome reconciles by GET only, with safe copy', async () => {
  for (const error of [
    new Error('SECRET bearer token'),
    response({ ok: true, providers: [target], message: 'SECRET' }),
    response({ ...snapshot, activeAccountTag: 'other-account', message: 'SECRET' }),
    response({ ...snapshot, activeAccountTag: undefined, message: 'SECRET' }),
    response({ ...snapshot, activeAccountTag: null, message: 'SECRET' }),
    response({ error: 'SECRET' }, 502),
  ]) {
    const updated = { ...snapshot, canRenew: false };
    const app = setup({ fetch: async (url) => {
      if (url !== renew) return response(updated);
      if (error instanceof Error) throw error;
      return error;
    } });
    await query(app).props.onClick();
    assert.deepEqual(paths(app), [renew, quotas]);
    assert.equal(app.state.data, updated);
    assert.equal(app.state.notice, null);
    assert.match(text(app.render()), /未自动重试续期/);
    assert.doesNotMatch(text(app.render()), /SECRET/);
    assert.equal(app.timers.size, 0);
  }
});

test('the stale card preserves windows and last success time; canSwitch false hides and guards switch', async () => {
  let prompts = 0;
  const data = {
    ...snapshot, canSwitch: false,
    providers: [{ ...current, status: 'stale', staleAt: 1_700_000_000_000, error: '更新额度失败', windows: [{ label: '5 小时', usedPercent: 20 }] }, target],
  };
  const app = setup({ data, confirm: () => { prompts++; return true; } });
  const tree = app.render();
  assert.match(text(tree), /更新额度失败/);
  assert.match(text(tree), /上次成功于/);
  assert.match(text(tree), /5 小时.*已用 20%/);
  assert.equal(nodes(tree, (n) => n.props?.['aria-label'] === '切换使用 beta').length, 0);
  const card = tree.children.at(-1).children[0].find((item) => item.props.p.id === target.id);
  await card.props.onSwitch(target);
  assert.equal(prompts, 0);
  assert.deepEqual(paths(app), []);
});
