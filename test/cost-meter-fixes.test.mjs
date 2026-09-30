/**
 * Targeted checks for the two fixes that the shipped suites cannot see:
 *
 *   1. the locale seat — the existing tests render the pill without a `t` prop,
 *      so they exercise `fallbackTranslate` only. This file renders it WITH a
 *      `t` seat and asserts the copy actually goes through it, and checks the
 *      two dictionaries against each other (same keys, same placeholders).
 *   2. the account stream — the wrapper's per-item `accept()` is what resets its
 *      reconnect budget, so this file feeds items that carry an `accept` spy.
 *
 * Run it against any copy of the bundle:
 *   node cost-meter-fixes.test.mjs                 # ../client.js, else the installed copy
 *   node cost-meter-fixes.test.mjs <package-dir>   # explicit package directory
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTALLED = 'C:\\Users\\Lenovo\\.dsh\\profiles\\desktop\\node_modules\\@local\\dsh-cost-meter';
const DEFAULT_DIR = fs.existsSync(path.join(import.meta.dirname, '..', 'client.js'))
  ? path.resolve(import.meta.dirname, '..')
  : INSTALLED;
const dir = process.argv[2] ?? DEFAULT_DIR;

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
};
const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

// ── fake timers ─────────────────────────────────────────────────────────────
const timers = new Map();
let timerSeq = 0;
globalThis.setTimeout = (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; };
globalThis.setInterval = (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.clearInterval = (id) => { timers.delete(id); };
Date.now = () => Date.parse('2026-09-30T12:00:00+08:00'); // Beijing noon → off-peak

// ── storage ─────────────────────────────────────────────────────────────────
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
  innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {},
};
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
globalThis.document = {
  visibilityState: 'visible', body: { nodeType: 1 }, addEventListener() {}, removeEventListener() {},
};

await import(pathToFileURL(path.join(dir, 'client.js')).href);
const plugin = loaded.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react-dom') return { createPortal: (node) => node };
  throw new Error('unexpected require: ' + specifier);
});

check('the plugin requires the locale service',
  Array.isArray(plugin.inject) && plugin.inject.includes('locale'),
  JSON.stringify(plugin.inject));

// ═══ 1. the dictionaries and the register call ══════════════════════════════
const registrations = [];
const streamItems = [];
let accepts = 0;
let reads = 0;
let registration = null;

const stream = {
  [Symbol.asyncIterator]() {
    return {
      next: () => new Promise((resolve) => { streamItems.push(resolve); }),
      return: () => Promise.resolve({ done: true }),
    };
  },
  dispose: () => {},
};
const pushFrame = () => {
  const resolve = streamItems.shift();
  if (resolve === undefined) throw new Error('no stream reader waiting');
  resolve({ done: false, value: { generation: 1, value: { status: 'ready' }, accept: () => { accepts += 1; } } });
};

plugin.apply({
  slots: {
    inject(ownerKey, install) { registration = install(); },
    register(options, component) { return { options, component }; },
  },
  effect(callback) { callback(); },
  locale: {
    register(ns, dicts) { registrations.push({ ns, dicts }); return () => {}; },
    bind: () => (key) => key,
  },
  remote: {
    $stream({ name }) {
      if (name !== 'account') throw new Error('unexpected stream: ' + name);
      return stream;
    },
    account: {
      async getBalance() {
        reads += 1;
        return { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '45.19' }], bonusWallets: [] } };
      },
    },
  },
});

check('apply registers exactly one namespace', registrations.length === 1, String(registrations.length));
const { ns, dicts } = registrations[0] ?? {};
check('the namespace is stable', ns === 'cost-meter', String(ns));
check('both shipped locales are registered',
  dicts !== undefined && typeof dicts.zh === 'object' && typeof dicts.en === 'object',
  dicts === undefined ? 'none' : Object.keys(dicts).join(','));

const zhKeys = Object.keys(dicts?.zh ?? {}).sort();
const enKeys = Object.keys(dicts?.en ?? {}).sort();
check('the dictionaries carry the same keys',
  zhKeys.length > 0 && zhKeys.join('|') === enKeys.join('|'),
  `${zhKeys.length} zh vs ${enKeys.length} en`);
const placeholders = (text) => (String(text).match(/\{\w+\}/g) ?? []).sort().join(',');
const mismatched = zhKeys.filter((key) => placeholders(dicts.zh[key]) !== placeholders(dicts.en[key]));
check('every placeholder survives translation', mismatched.length === 0, mismatched.join(','));

check('the slot entry declares that namespace', registration?.options?.locale === 'cost-meter',
  String(registration?.options?.locale));

// ═══ 2. the component actually reads through the injected `t` ═══════════════
const injected = registration.options.inject();
const usage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
const route = { provider: 'deepseek-account', model: 'deepseek-flash' };
const marked = (key) => '«' + key + '»';

const draw = () => {
  runtime.cursor = 0;
  const tree = registration.component({
    useProjection: (key) => (key === 'tokenUsage' ? usage : key === 'modelSelection' ? { lastUsed: route, next: null } : undefined),
    useSession: (selector) => selector({ running: false }),
    sessionId: 'session-1',
    wallets: injected.wallets,
    payments: injected.payments,
    t: marked,
  });
  flushEffects();
  return tree;
};
const findButton = (tree) => tree?.children
  ?.find((child) => child?.props?.['data-cost-meter'] === true)
  ?.children?.find((child) => child?.props?.className === 'dshcost_pill');
const findPanel = (tree) => tree?.children?.find((child) => child?.props?.className === 'dshcost_panel');

let tree = draw();
await settle();
tree = draw();
tree = draw();
check('the pill label goes through the seat',
  String(findButton(tree)?.props?.['aria-label']).startsWith('«pill.aria'),
  String(findButton(tree)?.props?.['aria-label']));

findButton(tree).props.onClick();
tree = draw();
const panel = findPanel(tree);
check('the panel goes through the seat',
  panel?.props?.['aria-label'] === '«panel.title»',
  String(panel?.props?.['aria-label']));
const labels = (panel?.children?.[2]?.children ?? []).flat(Infinity)
  .filter((cell) => cell.type === 'dt').map((cell) => cell.children[0]);
check('every row label goes through the seat',
  labels.join('|') === '«row.topUp»|«row.bonus»|«row.total»|«row.session»|«row.turn»',
  JSON.stringify(labels));

// ═══ 3. stream frames are accepted, not just counted ═══════════════════════
const readsBeforeFrames = reads;
await settle(); // let the for-await loop reach its first next()
pushFrame();
await settle(); // deliver the frame, then let the loop ask for the next one
pushFrame();
await settle();
check('each stream frame is accepted', accepts === 2, String(accepts));
check('each stream frame still asks for a fresh read',
  reads > readsBeforeFrames, `${readsBeforeFrames} -> ${reads}`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
