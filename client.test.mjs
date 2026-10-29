import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
let client;
const React = { createElement: (type, props, ...children) => ({ type, props, children }) };
vm.runInNewContext(source.replace('exports.apply = apply;', 'exports.QuotaProviderCard = QuotaProviderCard; exports.humanizeReset = humanizeReset; exports.apply = apply;'), {
  window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(() => React); } } },
  Date,
});
function text(tree) {
  if (tree == null || tree === false) return '';
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  if (typeof tree !== 'object') return String(tree);
  return text(tree.children);
}
test('account identity and active badge render without hiding quota windows', () => {
  const p = { id: 'openai-codex:second', label: 'OpenAI Codex (ChatGPT)', account: { email: 'second@example.test', label: 'second', active: true },  plan: 'prolite', status: 'ok', windows: [] };
  const rendered = text(client.QuotaProviderCard({ p }));
  assert.doesNotMatch(rendered, /second@example\.test/);
  assert.match(rendered, /second/);
  assert.match(rendered, /DSH 当前使用/);
  assert.match(rendered, /prolite/);
  assert.doesNotMatch(text(client.QuotaProviderCard({ p: { ...p, account: { ...p.account, active: false } } })), /DSH 当前使用/);
});
test('GLM cards remain compatible without account fields', () => {
  assert.match(text(client.QuotaProviderCard({ p: { id: 'glm', label: 'GLM', status: 'error', error: 'offline' } })), /offline/);
});
test('cached reset uses absolute reset time instead of stale remaining seconds', () => {
  assert.equal(client.humanizeReset(604800, Date.now() + 3600000), '1.0 小时后重置');
});
