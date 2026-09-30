/**
 * The configurable pill: which numbers it shows, where that choice lives, and
 * the two invariants the UI promises (fixed layout order, never empty).
 *
 * The dialog's five detail rows are NOT part of this — they stay complete, and
 * the shipped suites already pin them down.
 *
 *   node cost-meter-view.test.mjs                 # ../client.js, else the installed copy
 *   node cost-meter-view.test.mjs <package-dir>   # explicit package directory
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

// ── storage I own ───────────────────────────────────────────────────────────
const VIEW_KEY = 'dsh-cost-meter/view/v1';
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
  },
});

// ── a DOM just real enough for the placement code ───────────────────────────
const domNodes = new Map();
const boxOf = (className) => {
  if (!domNodes.has(className)) {
    domNodes.set(className, {
      rect: { left: 0, top: 0, width: 0, height: 0 },
      contains: () => false,
      getBoundingClientRect() {
        return {
          left: this.rect.left,
          top: this.rect.top,
          width: this.rect.width,
          height: this.rect.height,
          right: this.rect.left + this.rect.width,
          bottom: this.rect.top + this.rect.height,
        };
      },
    });
  }
  return domNodes.get(className);
};
const resizeCallbacks = [];
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe() { resizeCallbacks.push(this.callback); }
  disconnect() {
    const at = resizeCallbacks.indexOf(this.callback);
    if (at >= 0) resizeCallbacks.splice(at, 1);
  }
};
const fireResize = () => { for (const callback of [...resizeCallbacks]) callback(); };

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
  createElement: (type, props, ...children) => {
    const node = {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    };
    // React attaches refs at commit; the placement effect reads them right after.
    const ref = node.props.ref;
    if (ref !== null && ref !== undefined && typeof ref === 'object') {
      ref.current = boxOf(String(node.props.className ?? 'anonymous'));
    }
    return node;
  },
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

// ── one plugin instance = one "page load" ───────────────────────────────────
const usage = { uncachedInputTokens: 0, cacheReadTokens: 1000000, cacheWriteTokens: 0, outputTokens: 0 };
const route = { provider: 'deepseek-account', model: 'deepseek-flash' };
let runningState = false;

const load = () => {
  let registration = null;
  plugin.apply({
    slots: {
      inject(ownerKey, install) { registration = install(); },
      register(options, component) { return { options, component }; },
    },
    effect(callback) { callback(); },
    locale: undefined,
    remote: {
      $stream() { throw new Error('no account stream in this test'); },
      account: {
        async getBalance() {
          return {
            ok: true,
            value: {
              status: 'ready',
              value: [{ currency: 'CNY', balance: '43.19' }],
              bonusWallets: [{ currency: 'CNY', balance: '2.00' }],
            },
          };
        },
      },
    },
  });
  const injected = registration.options.inject();
  return {
    component: registration.component,
    wallets: injected.wallets,
    payments: injected.payments,
    viewPrefs: injected.viewPrefs,
  };
};

const draw = (instance) => {
  runtime.cursor = 0;
  const tree = instance.component({
    useProjection: (key) => (key === 'tokenUsage' ? usage : key === 'modelSelection' ? { lastUsed: route, next: null } : undefined),
    useSession: (selector) => selector({ running: runningState }),
    sessionId: 'session-1',
    wallets: instance.wallets,
    payments: instance.payments,
    viewPrefs: instance.viewPrefs,
  });
  flushEffects();
  return tree;
};
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
const pillText = (tree) => textOf(findButton(tree)?.children?.[1]);
const choiceOf = (panel, label) => (panel?.children?.[3]?.children?.[1]?.children ?? [])
  .find((choice) => choice?.children?.[1] === label);
const cellText = (tree, name) => {
  const flat = (findPanel(tree)?.children?.[2]?.children ?? []).flat(Infinity);
  const index = flat.findIndex((cell) => cell?.children?.[0] === name);
  return index < 0 ? null : flat[index + 1]?.children?.[0];
};
/** The picker is collapsed until its title is clicked; expand it and return it. */
const pickerOf = (page) => {
  const panel = findPanel(page.tree());
  const toggle = panel?.children?.[3]?.children?.[0];
  if (toggle === undefined) return null;
  if (toggle.props['aria-expanded'] === false) {
    toggle.props.onClick();
    page.redraw();
  }
  return findPanel(page.tree());
};

const mount = async () => {
  runtime.cells = [];               // a fresh component instance, as after a reload
  const instance = load();
  let tree = draw(instance);
  await settle();
  tree = draw(instance);
  tree = draw(instance);
  return { instance, tree: () => tree, redraw: () => { tree = draw(instance); return tree; } };
};
/** A fresh browser: no ledger, no stored choice, no usage, no running turn. */
const resetWorld = () => {
  storage.clear();
  usage.uncachedInputTokens = 0;
  usage.cacheReadTokens = 1000000;
  usage.cacheWriteTokens = 0;
  usage.outputTokens = 0;
  runningState = false;
};

// ═══ A. the default is what the pill always showed ══════════════════════════
resetWorld();
let page = await mount();
check('a fresh browser shows the balance and the session estimate',
  pillText(page.tree()) === '¥45.19·¥0.02', pillText(page.tree()));
check('nothing is written until the user chooses something',
  storage.get(VIEW_KEY) === undefined, String(storage.get(VIEW_KEY)));

// ═══ B. a stored choice is honoured, in the fixed layout order ══════════════
resetWorld();
storage.set(VIEW_KEY, JSON.stringify({ version: 1, items: ['turn', 'bonus', 'balance'] }));
page = await mount();
check('the stored choice is read back and re-ordered',
  pillText(page.tree()) === '¥45.19·¥2.00', pillText(page.tree()));
check('an item with nothing to show yet is left out, not printed as a dash',
  !pillText(page.tree()).includes('—'), pillText(page.tree()));
check('the aria label names what the pill shows',
  findButton(page.tree())?.props?.['aria-label'] === '账号钱包 余额合计 ¥45.19，赠送额度 ¥2.00',
  String(findButton(page.tree())?.props?.['aria-label']));

// ═══ C. a running turn joins the row once it has cost something ═════════════
resetWorld();
storage.set(VIEW_KEY, JSON.stringify({ version: 1, items: ['balance', 'turn'] }));
page = await mount();
check('a turn that has not spent anything stays out', pillText(page.tree()) === '¥45.19',
  pillText(page.tree()));
runningState = true;
page.redraw();                       // the running edge opens the turn bucket
usage.outputTokens = 2000;           // ¥0.008 off-peak
page.redraw();
page.redraw();
check('a spending turn appears with its running mark',
  pillText(page.tree()) === '¥45.19·¥0.008（进行中）', pillText(page.tree()));
check('a choice stored before the flag existed still marks the turn',
  JSON.parse(storage.get(VIEW_KEY))?.mark === undefined, String(storage.get(VIEW_KEY)));

// The flag only words the pill: the dialog's own row keeps saying a turn runs.
findButton(page.tree()).props.onClick();          // open the dialog
const collapsed = findPanel(page.redraw());
check('the picker is collapsed until asked for',
  collapsed?.children?.[3]?.children?.[0]?.props?.['aria-expanded'] === false
  && collapsed?.children?.[3]?.children?.[1] === undefined,
  JSON.stringify([collapsed?.children?.[3]?.children?.[0]?.props?.['aria-expanded'],
    collapsed?.children?.[3]?.children?.length]));
const panelC = pickerOf(page);
check('clicking the title expands the picker',
  panelC?.children?.[3]?.children?.[0]?.props?.['aria-expanded'] === true
  && choiceOf(panelC, '余额合计') !== undefined,
  JSON.stringify(panelC?.children?.[3]?.children?.[0]?.props?.['aria-expanded']));
const markChoice = choiceOf(panelC, '标注「进行中」');
check('the running mark has its own checkbox',
  markChoice?.children?.[0]?.props?.checked === true, JSON.stringify(markChoice?.children?.[1]));
check('the switch is live while the turn item is on',
  markChoice?.children?.[0]?.props?.disabled !== true && markChoice?.props?.title === undefined,
  JSON.stringify([markChoice?.children?.[0]?.props?.disabled, markChoice?.props?.title]));

markChoice.children[0].props.onChange();
page.redraw();
check('turning it off leaves the cost without the mark',
  pillText(page.tree()) === '¥45.19·¥0.008', pillText(page.tree()));
check('the dialog row is not affected by the flag',
  cellText(page.tree(), '本轮花费') === '≈¥0.008（进行中）', String(cellText(page.tree(), '本轮花费')));
check('the flag is persisted', JSON.parse(storage.get(VIEW_KEY)).mark === false,
  String(storage.get(VIEW_KEY)));

choiceOf(panelC, '标注「进行中」').children[0].props.onChange();
page.redraw();
check('turning it back on restores the mark',
  pillText(page.tree()) === '¥45.19·¥0.008（进行中）', pillText(page.tree()));

// ═══ C2. the spend switch: red, signed, and it twitches on a rise ═══════════
const turnNode = () => (findButton(page.tree())?.children?.[1]?.children ?? [])
  .find((child) => String(child?.props?.className ?? '').includes('dshcost_spend'));
const flashed = () => findButton(page.tree())?.children
  ?.some((child) => child?.props?.className === 'dshcost_hitFlash') === true;

check('no cue while the switch is off', flashed() === false);
const panelS = pickerOf(page);
check('the spend switch is off by default',
  choiceOf(panelS, '花费变红 + 扣血动效')?.children?.[0]?.props?.checked === false,
  JSON.stringify(choiceOf(panelS, '花费变红 + 扣血动效')?.children?.[0]?.props?.checked));

choiceOf(panelS, '花费变红 + 扣血动效').children[0].props.onChange();
page.redraw();
check('the turn cost is worn as a red deduction',
  pillText(page.tree()) === '¥45.19·-¥0.008（进行中）', pillText(page.tree()));
check('only the turn carries the deduction colour',
  String(turnNode()?.props?.className ?? '').includes('dshcost_spend')
  && turnNode()?.children?.[0] === '-¥0.008（进行中）',
  JSON.stringify([turnNode()?.props?.className, turnNode()?.children]));
check('turning it on does not fire a cue by itself', flashed() === false);
check('the switch is persisted', JSON.parse(storage.get(VIEW_KEY)).spend === true,
  String(storage.get(VIEW_KEY)));

usage.outputTokens = 4000;                        // +¥0.008 inside the same turn
page.redraw();                                    // the ledger prices the delta
page.redraw();                                    // the rise bumps the cue
page.redraw();                                    // the cue reaches the pill
check('a rise adds the hit animation', String(turnNode()?.props?.className ?? '').includes('dshcost_hit'),
  String(turnNode()?.props?.className));
check('a rise flashes the pill', flashed() === true);
check('the deduction keeps counting',
  pillText(page.tree()) === '¥45.19·-¥0.016（进行中）', pillText(page.tree()));

// ═══ D. the dialog picker toggles the pill and persists ═════════════════════
resetWorld();
page = await mount();
findButton(page.tree()).props.onClick();      // open
let panel = findPanel(page.redraw());
check('the dialog still shows its five rows',
  (panel?.children?.[2]?.children ?? []).flat(Infinity)
    .filter((cell) => cell.type === 'dt').map((cell) => cell.children[0]).join('|')
    === '充值余额|赠送额度|余额合计|本次会话|本轮花费');

panel = pickerOf(page);
const bonusChoice = choiceOf(panel, '赠送额度');
check('every pill item has a checkbox', choiceOf(panel, '充值余额') !== undefined
  && bonusChoice !== undefined && choiceOf(panel, '余额合计') !== undefined
  && choiceOf(panel, '本次会话') !== undefined && choiceOf(panel, '本轮花费') !== undefined);
check('the running-mark switch is gone while the turn item is off',
  choiceOf(panel, '标注「进行中」') === undefined,
  JSON.stringify(choiceOf(panel, '标注「进行中」')));
check('the spend switch is gone with it',
  choiceOf(panel, '花费变红 + 扣血动效') === undefined,
  JSON.stringify(choiceOf(panel, '花费变红 + 扣血动效')));
check('the picker reflects the current choice',
  choiceOf(panel, '余额合计')?.children?.[0]?.props?.checked === true
  && bonusChoice?.children?.[0]?.props?.checked === false);

bonusChoice.children[0].props.onChange();
page.redraw();
panel = pickerOf(page);
check('checking an item adds it to the pill', pillText(page.tree()) === '¥45.19·¥2.00·¥0.02',
  pillText(page.tree()));
check('the choice is persisted', storage.get(VIEW_KEY) === JSON.stringify({ version: 1, items: ['balance', 'bonus', 'session'], mark: true, spend: false }),
  String(storage.get(VIEW_KEY)));
check('the picker stays open across a toggle',
  panel?.children?.[3]?.children?.[0]?.props?.['aria-expanded'] === true,
  JSON.stringify(panel?.children?.[3]?.children?.[0]?.props?.['aria-expanded']));

choiceOf(panel, '赠送额度').children[0].props.onChange();
page.redraw();
check('unchecking it removes it again', pillText(page.tree()) === '¥45.19·¥0.02', pillText(page.tree()));

// The switch follows the turn item: it arrives with it and leaves with it.
const panelD = pickerOf(page);
check('an unrelated toggle leaves the switch absent',
  choiceOf(panelD, '标注「进行中」') === undefined);
choiceOf(panelD, '本轮花费').children[0].props.onChange();
page.redraw();
const withTurn = pickerOf(page);
check('checking the turn item brings the switch back',
  choiceOf(withTurn, '标注「进行中」')?.children?.[0]?.props?.checked === true,
  JSON.stringify(choiceOf(withTurn, '标注「进行中」')?.children?.[1]));

// ═══ E. and the pill can never be emptied ═══════════════════════════════════
resetWorld();
storage.set(VIEW_KEY, JSON.stringify({ version: 1, items: ['balance'] }));
page = await mount();
findButton(page.tree()).props.onClick();
page.redraw();
panel = pickerOf(page);
check('the only remaining item cannot be unchecked',
  choiceOf(panel, '余额合计')?.children?.[0]?.props?.checked === true
  && pillText(page.tree()) === '¥45.19', pillText(page.tree()));
choiceOf(panel, '余额合计').children[0].props.onChange();
page.redraw();
check('the pill survives the attempt', pillText(page.tree()) === '¥45.19'
  && JSON.parse(storage.get(VIEW_KEY)).items.join('|') === 'balance', pillText(page.tree()));

// ═══ F. junk in storage falls back to the default ═══════════════════════════
for (const junk of ['not json', '{}', '{"items":[]}', '{"items":["nope"]}', '["balance","nope","balance"]']) {
  resetWorld();
  storage.set(VIEW_KEY, junk);
  page = await mount();
  const expected = junk.startsWith('["balance"') ? '¥45.19' : '¥45.19·¥0.02';
  check(`junk falls back cleanly: ${junk}`, pillText(page.tree()) === expected, pillText(page.tree()));
}

// ═══ G. the dialog re-places itself when unfolding makes it taller ══════════
resetWorld();
window.innerWidth = 1280;
window.innerHeight = 800;
const anchorBox = boxOf('dshcost_root');
const panelBox = boxOf('dshcost_panel');
anchorBox.rect = { left: 500, top: 700, width: 140, height: 20 };
panelBox.rect = { left: 0, top: 0, width: 320, height: 180 };
page = await mount();
findButton(page.tree()).props.onClick();
page.redraw();                                  // the layout effect measures and places
const placed = findPanel(page.redraw())?.props?.style;
check('the dialog sits above its trigger',
  placed?.top === 700 - 180 - 8 && placed?.left === 500 + 70 - 160, JSON.stringify(placed));

// Unfolding the picker grows the box; the observer has to re-place it, or the
// lower rows end up past the bottom edge with no way to reach them.
panelBox.rect = { left: 0, top: 0, width: 320, height: 300 };
fireResize();
const grown = findPanel(page.redraw())?.props?.style;
check('growing the dialog moves it back up',
  grown?.top === 700 - 300 - 8, JSON.stringify(grown));
check('and keeps it inside the viewport',
  grown.top >= 12 && grown.top + 300 <= 800 - 12, JSON.stringify(grown));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
