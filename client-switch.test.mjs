import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
const current = { id: 'openai-codex:alpha', providerId: 'openai-codex', account: { label: 'alpha', active: true, switchable: true } };
const target = { id: 'openai-codex:beta', providerId: 'openai-codex', account: { label: 'beta', active: false, switchable: true } };
const snapshot = { ok: true, providers: [current, target] };
function setup({ confirm = () => true, fetch = async () => ({ ok: true, json: async () => switched }) } = {}) {
  let client;
  let state = { data: snapshot, busy: false, error: null, switching: null, notice: null };
  const calls = [];
  const refs = [];
  let cursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [state, (update) => { state = typeof update === 'function' ? update(state) : update; }],
    useRef: (value) => refs[cursor++] ?? (refs[cursor - 1] = { current: value }),
    useCallback: (fn) => fn,
    useEffect() {},
  };
  vm.runInNewContext(source.replace('exports.apply = apply;', 'exports.QuotaSection = QuotaSection; exports.QuotaProviderCard = QuotaProviderCard; exports.apply = apply;'), {
    window: { confirm, __ModuleLoader__: { load: ({ factory }) => { client = factory(() => React); } } },
    fetch: async (...args) => { calls.push(args); return fetch(...args); }, Date,
  });
  return {
    get state() { return state; }, calls,
    card: (props) => client.QuotaProviderCard(props),
    render: () => { cursor = 0; return client.QuotaSection(); },
  };
}
const switched = { ok: true, providers: [{ ...current, account: { ...current.account, active: false } }, { ...target, account: { ...target.account, active: true } }] };
function nodes(tree, predicate) {
  if (tree == null || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((n) => nodes(n, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.children, predicate)];
}
function handler(app) { return nodes(app.render(), (n) => n.props?.p?.id === target.id)[0].props.onSwitch; }

test('inactive saved Codex cards expose switch action; current, fallback and GLM do not', () => {
  const app = setup();
  assert.equal(nodes(app.card({ p: target }), (n) => n.type === 'button').length, 1);
  for (const p of [current, { ...target, account: { ...target.account, switchable: false } }, { ...target, providerId: 'glm' }]) {
    assert.equal(nodes(app.card({ p }), (n) => n.type === 'button').length, 0);
  }
  const button = nodes(app.card({ p: target, switching: target.id, disabled: true }), (n) => n.type === 'button')[0];
  assert.equal(button.props.disabled, true);
  assert.match(button.children.join(''), /切换中/);
});

test('active or unsupported targets never prompt or send a write', async () => {
  let prompts = 0;
  const app = setup({ confirm: () => { prompts++; return true; } });
  const click = handler(app);
  for (const p of [current, { ...target, providerId: 'glm' }, { ...target, account: { ...target.account, switchable: false } }]) await click(p);
  assert.equal(prompts, 0);
  assert.equal(app.calls.length, 0);
});

test('cancelled global confirmation never sends a request', async () => {
  const prompts = [];
  const app = setup({ confirm: (message) => { prompts.push(message); return false; } });
  await handler(app)(target);
  assert.equal(app.calls.length, 0);
  assert.match(prompts[0], /从：alpha/);
  assert.match(prompts[0], /切换到：beta/);
  assert.match(prompts[0], /所有 GPT 会话/);
  assert.match(prompts[0], /后续自动执行/);
  assert.equal(app.state.switching, null);
});

test('confirmed switch sends exact guarded payload and uses server active identity', async () => {
  const app = setup();
  await handler(app)(target);
  assert.equal(app.calls.length, 1);
  const [url, options] = app.calls[0];
  assert.equal(url, '/usage-lite/accounts/switch');
  assert.equal(options.headers['x-usage-lite-action'], 'switch-account');
  assert.deepEqual(JSON.parse(options.body), { id: target.id, expectedActiveId: current.id, confirmed: true });
  assert.equal(app.state.data.providers.find((p) => p.account.active).id, target.id);
  assert.match(app.state.notice, /已全局切换到 beta/);
});

test('double clicks cannot dispatch concurrent switches or quota refreshes', async () => {
  let finish;
  const app = setup({ fetch: () => new Promise((resolve) => { finish = resolve; }) });
  const click = handler(app);
  const pending = click(target);
  await click(target);
  const query = nodes(app.render(), (n) => n.type === 'button')[0];
  assert.equal(query.props.disabled, true);
  query.props.onClick();
  assert.equal(app.calls.length, 1);
  finish({ ok: true, json: async () => switched });
  await pending;
  assert.equal(app.state.switching, null);
});

test('unknown write outcome reconciles by GET without retry or false success', async () => {
  const app = setup({ fetch: async (_url, options) => {
    if (options?.method === 'POST') throw new Error('connection lost');
    return { ok: true, json: async () => switched };
  } });
  await handler(app)(target);
  assert.equal(app.calls.filter(([, options]) => options?.method === 'POST').length, 1);
  assert.equal(app.calls.length, 2);
  assert.equal(app.state.notice, null);
  assert.match(app.state.error, /未自动重试/);
  assert.equal(app.state.data.providers.find((p) => p.account.active).id, target.id);
});

test('server rejection and mismatched active identity never claim success', async () => {
  for (const response of [{ ok: false, error: '当前账号已变化', providers: snapshot.providers }, snapshot]) {
    const app = setup({ fetch: async (_url, options) => ({ ok: options?.method !== 'POST' || response.ok, status: 409, json: async () => response }) });
    await handler(app)(target);
    assert.equal(app.state.notice, null);
    assert.ok(app.state.error);
    assert.equal(app.state.switching, null);
  }
});
