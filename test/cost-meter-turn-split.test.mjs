/**
 * Regression test for the cost-meter turn split.
 *
 * A page reload during a running turn must adopt the turn bucket restored from
 * the ledger. The shipped client.js only guards the FIRST render (`sawMount`),
 * but the turn-edge effect also re-runs when `ready` flips false→true — which is
 * exactly what a page load does, because the pill mounts before the first wallet
 * read lands. The running turn is then closed as a phantom "previous turn" and
 * "本轮花费" restarts from zero.
 *
 * Run it against any copy of the bundle:
 *   node cost-meter-turn-split.test.mjs                 # ../client.js, else the installed copy
 *   node cost-meter-turn-split.test.mjs <package-dir>   # explicit package directory
 * Drop it into test/ next to simulate_cost_meter.mjs and it resolves ../client.js.
 *
 * The test is self-contained: mini React with real effect flushing + a deferred
 * account read, so the tracker is deliberately still unread when the pill mounts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTALLED = 'C:\\Users\\Lenovo\\.dsh\\profiles\\desktop\\node_modules\\@local\\dsh-cost-meter';
const DEFAULT_DIR = fs.existsSync(path.join(import.meta.dirname, '..', 'client.js'))
  ? path.resolve(import.meta.dirname, '..')
  : INSTALLED;
const dir = process.argv[2] ?? DEFAULT_DIR;

// ── fake timers ─────────────────────────────────────────────────────────────
const timers = new Map();
let timerSeq = 0;
globalThis.setTimeout = (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; };
globalThis.setInterval = (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.clearInterval = (id) => { timers.delete(id); };

// ── clock + storage ─────────────────────────────────────────────────────────
let fakeNow = Date.parse('2026-09-30T12:00:00+08:00'); // Beijing noon → off-peak
Date.now = () => fakeNow;
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
  },
});

// ── mini React with real effect flushing ────────────────────────────────────
const runtime = { cells: [], cursor: 0, pending: [] };
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
  innerWidth: 1280, innerHeight: 800,
  addEventListener() {}, removeEventListener() {},
};
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
globalThis.document = {
  visibilityState: 'visible', body: { nodeType: 1 },
  addEventListener() {}, removeEventListener() {},
};

await import(pathToFileURL(path.join(dir, 'client.js')).href);
const plugin = loaded.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react-dom') return { createPortal: (node) => node };
  throw new Error('unexpected require: ' + specifier);
});

// ── deferred account Remote: the read lands only when the test says so ──────
let pendingRead = null;
let walletTotal = 98.08;
const makeInstance = () => {
  let registration = null;
  const ctx = {
    slots: {
      inject(ownerKey, install) { registration = install(); },
      register(options, component) { return { options, component }; },
    },
    effect(callback) { callback(); },
    remote: {
      $stream() { throw new Error('no account stream in this test'); },
      account: {
        getBalance() {
          return new Promise((resolve) => {
            pendingRead = () => resolve({
              ok: true,
              value: {
                status: 'ready',
                value: [{ currency: 'CNY', balance: walletTotal.toFixed(2) }],
                bonusWallets: [],
              },
            });
          });
        },
      },
    },
  };
  plugin.apply(ctx);
  const injected = registration.options.inject();
  return { component: registration.component, wallets: injected.wallets, payments: injected.payments };
};

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
};
const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const usage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
const route = { provider: 'deepseek-account', model: 'deepseek-flash' };
let runningState = true; // the turn is already running when the page loads

const draw = (instance) => {
  runtime.cursor = 0;
  const tree = instance.component({
    useProjection: (key) => (key === 'tokenUsage' ? usage : key === 'modelSelection' ? { lastUsed: route, next: null } : undefined),
    useSession: (selector) => selector({ running: runningState }),
    sessionId: 'session-1',
    wallets: instance.wallets,
    payments: instance.payments,
  });
  flushEffects();
  return tree;
};

// ── instance 1: the page is open, a turn starts and spends money ────────────
const first = makeInstance();
draw(first);
await settle();
await pendingRead();          // the first balance read lands
await settle();
draw(first);                  // ready, still idle

runningState = false;
draw(first);
runningState = true;
draw(first);                  // the running edge opens the turn bucket
usage.outputTokens = 2000;    // ¥0.008 inside this turn
draw(first);
draw(first);

const before = first.payments.get('session-1');
check('the running turn has cost before the reload', before.turns.length === 0 && before.current.cost > 0,
  `turns=${before.turns.length} cost=${before.current.cost.toFixed(4)}`);

// ── instance 2: F5 in the middle of that same running turn ──────────────────
runtime.cells = [];           // fresh component instance, as after a reload
const second = makeInstance(); // ledger is restored from localStorage
draw(second);                 // mounted BEFORE the first balance read lands
await settle();
await pendingRead();          // the read lands mid-turn → ready flips false → true
await settle();
draw(second);

const after = second.payments.get('session-1');
check('a reload mid-turn does not close the running turn',
  after.turns.length === before.turns.length,
  `turns ${before.turns.length} -> ${after.turns.length}`);
check('a reload mid-turn keeps the running turn cost',
  after.current.cost === before.current.cost,
  `${before.current.cost.toFixed(4)} -> ${after.current.cost.toFixed(4)}`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
