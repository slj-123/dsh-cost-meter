// End-to-end simulation of the pill's live-update path: a mini React runtime
// that really runs effects, fake timers, and a clock I control — so I can watch
// usage growth, a poll tick, a hung read and the turn split reach the rendered
// dialog text.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.resolve(import.meta.dirname, '..');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
};

// ── fake timers (intervals repeat, timeouts do not) ─────────────────────────
const timers = new Map();
let timerSeq = 0;
const addTimer = (fn, ms, repeat) => { const id = ++timerSeq; timers.set(id, { fn, ms, repeat }); return id; };
globalThis.setTimeout = (fn, ms) => addTimer(fn, ms, false);
globalThis.setInterval = (fn, ms) => addTimer(fn, ms, true);
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.clearInterval = (id) => { timers.delete(id); };
const fireByDelay = (ms) => {
  const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms);
  if (entry === undefined) throw new Error(`no ${ms}ms timer scheduled`);
  if (!entry[1].repeat) timers.delete(entry[0]);
  entry[1].fn();
};
const hasDelay = (ms) => [...timers.values()].some((timer) => timer.ms === ms);

// ── clock and storage I control ─────────────────────────────────────────────
let fakeNow = Date.parse('2026-09-30T12:00:00+08:00'); // Beijing noon → off-peak
const realDateNow = Date.now;
Date.now = () => fakeNow;
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
  },
});

// ── mini React: hooks + effect flushing ─────────────────────────────────────
const runtime = { cells: [], cursor: 0, pending: [], renders: 0 };
const cellAt = (kind) => {
  const index = runtime.cursor;
  runtime.cursor += 1;
  if (runtime.cells[index] === undefined) runtime.cells[index] = { kind, init: false };
  if (runtime.cells[index].kind !== kind) throw new Error(`hook order changed at ${index}`);
  return runtime.cells[index];
};
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }),
  memo: (component) => component,
  useState(initial) {
    const cell = cellAt('state');
    if (!cell.init) { cell.value = typeof initial === 'function' ? initial() : initial; cell.init = true; }
    return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
  },
  useEffect(fn, deps) {
    const cell = cellAt('effect');
    const previous = cell.deps;
    const changed = previous === undefined || deps === undefined
      || deps.length !== previous.length || deps.some((dep, i) => !Object.is(dep, previous[i]));
    if (changed) { cell.deps = deps; cell.fn = fn; runtime.pending.push(cell); }
  },
  useLayoutEffect(fn, deps) { React.useEffect(fn, deps); },
  useMemo: (factory) => factory(),
  useRef(initial) {
    const cell = cellAt('ref');
    if (!cell.init) { cell.value = { current: initial }; cell.init = true; }
    return cell.value;
  },
};
const flushEffects = () => {
  const pending = runtime.pending;
  runtime.pending = [];
  for (const cell of pending) {
    if (typeof cell.cleanup === 'function') cell.cleanup();
    cell.cleanup = cell.fn();
  }
};

let loaded = null;
globalThis.window = {
  __ModuleLoader__: { load(definition) { loaded = definition; } },
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
};
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
globalThis.document = {
  visibilityState: 'visible',
  body: { nodeType: 1 },
  addEventListener() {},
  removeEventListener() {},
};

await import(pathToFileURL(path.join(dir, 'client.js')).href);
const plugin = loaded.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react-dom') return { createPortal: (node) => node };
  throw new Error('unexpected require: ' + specifier);
});

// ── fake account remote ─────────────────────────────────────────────────────
let walletTotal = 98.08;
let mode = 'ready';
let reads = 0;
let registration = null;
plugin.apply({
  slots: {
    inject(ownerKey, install) { registration = install(); },
    register(options, component) { return { options, component }; },
  },
  effect(callback) { callback(); },
  remote: {
    $stream() { throw new Error('no account stream in this simulation'); },
    account: {
      async getBalance() {
        reads += 1;
        if (mode === 'hang') return new Promise(() => {});
        fakeNow += 5000; // five seconds pass per read, like a real poll
        return {
          ok: true,
          value: {
            status: 'ready',
            value: [{ currency: 'CNY', balance: walletTotal.toFixed(2) }],
            bonusWallets: [],
          },
        };
      },
    },
  },
});

const injected = registration.options.inject();
const tracker = injected.wallets;
const payments = injected.payments;
const usage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
const route = { provider: 'deepseek-account', model: 'deepseek-flash' };
let runningState = false;

const render = () => {
  runtime.cursor = 0;
  runtime.renders += 1;
  const tree = registration.component({
    useProjection: (key) => (key === 'tokenUsage' ? usage : key === 'modelSelection' ? { lastUsed: route, next: null } : undefined),
    useSession: (selector) => selector({ running: runningState }),
    sessionId: 'session-1',
    wallets: tracker,
    payments,
  });
  flushEffects();
  return tree;
};
const settle = async () => { for (let i = 0; i < 14; i += 1) await Promise.resolve(); };
const findButton = (tree) => tree?.children
  ?.find((child) => child?.props?.['data-cost-meter'] === true)
  ?.children?.find((child) => child?.props?.className === 'dshcost_pill');
const findPanel = (tree) => tree?.children?.find((child) => child?.props?.className === 'dshcost_panel');
const textOf = (node) => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object' && node.children !== undefined) return textOf(node.children);
  return '';
};
const labelText = (tree) => textOf(findButton(tree)?.children?.[1]);
const cellText = (tree, name) => {
  const flat = (findPanel(tree)?.children?.[2]?.children ?? []).flat(Infinity);
  const index = flat.findIndex((cell) => cell?.children?.[0] === name);
  return index < 0 ? null : flat[index + 1]?.children?.[0];
};
const rowLabels = (tree) => (findPanel(tree)?.children?.[2]?.children ?? [])
  .flat(Infinity).filter((cell) => cell.type === 'dt').map((cell) => cell.children[0]);

// 1. mount
let tree = render();
await settle();
check('mount reads the wallet once', reads === 1, String(reads));
check('mount starts an interval, not a one-shot chain', hasDelay(5000), JSON.stringify([...timers.values()].map((t) => t.ms)));

// 2. open the dialog
tree = render();
findButton(tree).props.onClick();
tree = render();
check('click opens the dialog', findPanel(tree) !== undefined);
check('the dialog is the five requested rows',
  rowLabels(tree).join('|') === '充值余额|赠送额度|余额合计|本次会话 · 官网价|本轮花费', JSON.stringify(rowLabels(tree)));
check('a fresh session starts at zero', String(cellText(tree, '本次会话 · 官网价')) === '≈¥0.00',
  String(cellText(tree, '本次会话 · 官网价')));
check('no turn cost before a turn runs', String(cellText(tree, '本轮花费')) === '—',
  String(cellText(tree, '本轮花费')));

// 3. usage arrives: the pill prices it at the official off-peak rate
usage.cacheReadTokens = 1000000; // ¥0.02 per 1M off-peak
tree = render(); // effect feeds the ledger
tree = render(); // re-render shows the fed estimate
check('the pill shows the session estimate', labelText(tree).includes('≈¥0.02'), labelText(tree));
check('the dialog shows the same estimate', String(cellText(tree, '本次会话 · 官网价')) === '≈¥0.02',
  String(cellText(tree, '本次会话 · 官网价')));

// 4. more usage: only the delta is priced
usage.outputTokens = 1000; // ¥4 per 1M off-peak → +0.004
tree = render();
tree = render();
check('deltas accumulate at the official rates', String(cellText(tree, '本次会话 · 官网价')) === '≈¥0.024',
  String(cellText(tree, '本次会话 · 官网价')));

// 5. the platform actually charges: the wallet drops and the poll reports it
await settle(); // let the usage-triggered read finish before charging again
walletTotal = 98.06;
fireByDelay(5000);
await settle();
tree = render();
check('the poll picks up the new balance', labelText(tree).includes('¥98.06'), labelText(tree));
check('the dialog agrees on the balance', String(cellText(tree, '余额合计')) === '¥98.06',
  String(cellText(tree, '余额合计')));

// 6. a hung read must not stack, and the watchdog must recover
mode = 'hang';
fireByDelay(5000);
await settle();
const readsWhileHung = reads;
check('the hung read is issued once', readsWhileHung > 0, String(reads));
fireByDelay(5000);
await settle();
check('a later tick does not stack a second hung read', reads === readsWhileHung, String(reads));
fakeNow += 50000; // past READ_TIMEOUT_MS
mode = 'ready';
walletTotal = 98.04;
fireByDelay(5000);
await settle();
tree = render();
check('the watchdog abandons the hung read and retries', reads === readsWhileHung + 1, String(reads));
check('the retry refreshes the balance', labelText(tree).includes('¥98.04'), labelText(tree));

// 7. per-turn cost: a rising running edge opens a turn bucket
runningState = true;
tree = render(); // the running effect opens turn 1
usage.outputTokens = 2000; // +0.004 in this turn
tree = render();
tree = render();
check('the running turn is priced', String(cellText(tree, '本轮花费')) === '≈¥0.004（进行中）',
  String(cellText(tree, '本轮花费')));

runningState = false;
tree = render();
check('a settled turn keeps its cost without the mark', String(cellText(tree, '本轮花费')) === '≈¥0.004',
  String(cellText(tree, '本轮花费')));

runningState = true;
tree = render(); // the next edge opens turn 2
usage.outputTokens = 4000; // +0.008
tree = render();
tree = render();
check('the next turn starts from zero', String(cellText(tree, '本轮花费')) === '≈¥0.008（进行中）',
  String(cellText(tree, '本轮花费')));
check('the session total still covers every turn', String(cellText(tree, '本次会话 · 官网价')) === '≈¥0.036',
  String(cellText(tree, '本次会话 · 官网价')));

// 8. a page reload mid-turn must adopt the running turn, not split it in two.
const before = payments.get('session-1');
const turnsBefore = before.turns.length;
const costBefore = before.current.cost;
runtime.cells = []; // a fresh component instance, as after a reload
let registration2 = null;
plugin.apply({
  slots: {
    inject(ownerKey, install) { registration2 = install(); },
    register(options, component) { return { options, component }; },
  },
  effect(callback) { callback(); },
  remote: {
    $stream() { throw new Error('no account stream in this simulation'); },
    account: { async getBalance() { return { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: walletTotal.toFixed(2) }], bonusWallets: [] } }; } },
  },
});
const payments2 = registration2.options.inject().payments;
const wallets2 = registration2.options.inject().wallets;
await wallets2.refresh();
await settle();
const renderReloaded = () => {
  runtime.cursor = 0;
  const tree2 = registration2.component({
    useProjection: (key) => (key === 'tokenUsage' ? usage : key === 'modelSelection' ? { lastUsed: route, next: null } : undefined),
    useSession: (selector) => selector({ running: true }), // the turn is still running
    sessionId: 'session-1',
    wallets: wallets2,
    payments: payments2,
  });
  flushEffects();
  return tree2;
};
let reloadedTree = renderReloaded();
findButton(reloadedTree).props.onClick();
reloadedTree = renderReloaded();
const after = payments2.get('session-1');
check('a reload mid-turn does not close the running turn', after.turns.length === turnsBefore,
  `${turnsBefore} -> ${after.turns.length}`);
check('a reload mid-turn keeps the running turn cost', after.current.cost === costBefore,
  `${costBefore} -> ${after.current.cost}`);
check('the reloaded pill shows the same turn cost',
  String(cellText(reloadedTree, '本轮花费')) === '≈¥0.008（进行中）', String(cellText(reloadedTree, '本轮花费')));

Date.now = realDateNow;
console.log(`\nrenders=${runtime.renders} reads=${reads} ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
