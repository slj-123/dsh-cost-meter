// Offline checks for the cost-meter bundle: manifest, locale, module shape,
// slot registration, wallet math, the official-rate ledger, poll policy, and
// the click-open dialog.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.resolve(import.meta.dirname, '..');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
};
const close = (a, b, epsilon = 1e-9) => Math.abs(a - b) < epsilon;

// ── manifest ────────────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
check('manifest name', pkg.name === '@local/dsh-cost-meter', pkg.name);
check('manifest bundle patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml');
check('manifest exports the patch', pkg.exports?.['./cordis.patch.yml'] === './cordis.patch.yml');
check('manifest client platform', pkg.dsh?.client?.platform === 'web');
check('manifest exports client', pkg.exports?.['./client'] === './client.js');

for (const lang of ['en', 'zh']) {
  const loc = JSON.parse(fs.readFileSync(path.join(dir, 'locale', `${lang}.json`), 'utf8'));
  check(`locale ${lang} meta`, typeof loc.meta?.title === 'string' && typeof loc.meta?.description === 'string');
}

const patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
check('patch inserts one row', /-\s*insert:/.test(patch) && patch.includes('id: cost-meter') && patch.includes(`name: "${pkg.name}"`));

// ── browser stand-ins ───────────────────────────────────────────────────────
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
  },
});

const hooks = { slots: [], cursor: 0, overrides: {} };
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }),
  memo: (component) => component,
  useState(initial) {
    const index = hooks.cursor;
    hooks.cursor += 1;
    if (!(index in hooks.slots)) {
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    }
    if (index in hooks.overrides) hooks.slots[index] = hooks.overrides[index];
    const set = (next) => {
      hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next;
    };
    return [hooks.slots[index], set];
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
};
const beginRender = (overrides = {}) => {
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.overrides = overrides;
};

let loaded = null;
globalThis.window = { __ModuleLoader__: { load(definition) { loaded = definition; } } };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
await import(pathToFileURL(path.join(dir, 'client.js')).href);
check('module loader received a definition', loaded !== null);

const plugin = loaded.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react-dom') return { createPortal: (node) => node };
  throw new Error('unexpected require: ' + specifier);
});
check('client plugin injects the account remote',
  plugin.inject?.includes('slots') && plugin.inject?.includes('remote.account'),
  JSON.stringify(plugin.inject));

// ── fake account remote ─────────────────────────────────────────────────────
const WALLETS = {
  status: 'ready',
  value: [{ currency: 'CNY', balance: '43.19' }, { currency: 'USD', balance: '1.00' }],
  bonusWallets: [{ currency: 'CNY', balance: '2.00' }],
};
const WALLETS_LOW = { status: 'ready', value: [{ currency: 'CNY', balance: '44.84' }], bonusWallets: [] };

let mode = 'ready';
let reads = 0;
let lastMetadata = null;
const streamWaits = [];
let streamDisposed = 0;
const streamDisposers = [];
const pushAccountFrame = (value) => {
  const resolve = streamWaits.shift();
  if (resolve === undefined) throw new Error('no stream reader waiting');
  resolve({ done: false, value });
};
const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

const makePlugin = () => {
  let registration = null;
  plugin.apply({
    slots: {
      inject(ownerKey, install) {
        if (ownerKey !== 'conversation.composer.dock') throw new Error('wrong slot: ' + ownerKey);
        registration = install();
      },
      register(options, component) { return { options, component }; },
    },
    effect(callback) { streamDisposers.push(callback()); },
    remote: {
      $stream({ name }) {
        if (name !== 'account') throw new Error('unexpected stream: ' + name);
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise((resolve) => { streamWaits.push(resolve); }),
              return: () => Promise.resolve({ done: true }),
            };
          },
          dispose: () => { streamDisposed += 1; },
        };
      },
      account: {
        async getBalance(metadata) {
          reads += 1;
          lastMetadata = metadata;
          if (mode === 'throw') throw new Error('network');
          if (mode === 'hang') return new Promise(() => {});
          if (mode === 'null') return { ok: true, value: null };
          if (mode === 'failed') return { ok: true, value: { status: 'failed' } };
          if (mode === 'low') return { ok: true, value: WALLETS_LOW };
          if (mode === 'nok') return { ok: false, reason: 'unauthorized' };
          return { ok: true, value: WALLETS };
        },
      },
    },
  });
  const injected = registration.options.inject();
  return { registration, tracker: injected.wallets, payments: injected.payments };
};

const { registration, tracker, payments } = makePlugin();
check('registers into conversation.composer.dock', registration?.options?.name === 'conversation.composer.dock');
check('entry id is own id', registration?.options?.id === 'cost-meter', registration?.options?.id);
check('entry shares the dock row with the shipped pills', registration?.options?.order > 0, String(registration?.options?.order));
check('entry injects the wallet tracker and the ledger',
  tracker !== undefined && typeof tracker.refresh === 'function'
  && payments !== undefined && typeof payments.observe === 'function');

// ── wallet tracker ──────────────────────────────────────────────────────────
await tracker.refresh();
check('first read publishes a ready snapshot', tracker.get().status === 'ready', tracker.get().status);
check('wallet total sums top-up and bonus in CNY', tracker.get().total === 45.19, String(tracker.get().total));
check('top-up and bonus are split out', tracker.get().topUp === 43.19 && tracker.get().bonus === 2,
  JSON.stringify([tracker.get().topUp, tracker.get().bonus]));
check('account metadata carries version/locale/zone',
  lastMetadata?.version === '0.2.0-rc.2' && lastMetadata?.locale === 'zh-CN'
  && typeof lastMetadata?.timezoneOffsetSeconds === 'number',
  JSON.stringify(lastMetadata));

const readsAfterFirst = reads;
await tracker.refresh();
check('a throttled refresh skips the Platform', reads === readsAfterFirst, String(reads));
await tracker.refresh({ force: true });
check('a forced refresh calls again', reads === readsAfterFirst + 1, String(reads));

mode = 'throw';
await tracker.refresh({ force: true });
check('a failed read after a good one keeps the numbers',
  tracker.get().status === 'ready' && tracker.get().error === 'failed' && tracker.get().total === 45.19,
  JSON.stringify([tracker.get().status, tracker.get().error, tracker.get().total]));
mode = 'ready';
await tracker.refresh({ force: true });
check('a later success clears the stale mark', tracker.get().error === undefined && tracker.get().total === 45.19);

// ── push: one account-stream frame reads the wallet immediately ─────────────
await settle();
const readsBeforeFrame = reads;
pushAccountFrame({ status: 'credential-stored', attempt: null });
await settle();
check('an account-stream frame triggers an immediate read', reads === readsBeforeFrame + 1,
  `${readsBeforeFrame} -> ${reads}`);
check('the stream lifetime is registered as an effect', streamDisposers.length === 1, String(streamDisposers.length));
streamDisposers[0]();
check('disposing the plugin releases the stream', streamDisposed === 1, String(streamDisposed));

// ── poll policy (fake timers) ───────────────────────────────────────────────
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const scheduled = [];
let cleared = 0;
globalThis.setInterval = (fn, ms) => { scheduled.push(ms); return { fake: true, fn }; };
globalThis.clearInterval = () => { cleared += 1; };

const polled = makePlugin();
const release = polled.tracker.retain();
check('retain() polls immediately', reads > 0);
check('an idle session starts at the base poll', scheduled.at(-1) === 5000, String(scheduled.at(-1)));
polled.tracker.setRunning(true);
check('a running session keeps the fast poll', scheduled.at(-1) === 5000, String(scheduled.at(-1)));
polled.tracker.setRunning(false);
check('going idle stays at the base poll', scheduled.at(-1) === 5000, String(scheduled.at(-1)));
const clearsBeforeRelease = cleared;
polled.tracker.retain();
release();
check('one of two holders releasing keeps polling', cleared === clearsBeforeRelease, String(cleared));
const secondRelease = polled.tracker.retain();
secondRelease();
release();
check('the last holder releasing stops polling', cleared > clearsBeforeRelease, String(cleared));

// Adaptive idle: each quiet minute doubles the period, movement snaps it back,
// and watching the dialog holds the fast period regardless.
const adaptive = makePlugin();
mode = 'ready';
const adaptiveClockStart = Date.now();
let adaptiveClock = adaptiveClockStart;
const realDateNowForPoll = Date.now;
Date.now = () => adaptiveClock;
const releaseAdaptive = adaptive.tracker.retain();
await settle();
check('idle polling starts at the base period', adaptive.tracker.period() === 5000, String(adaptive.tracker.period()));
adaptiveClock += 61000;
await adaptive.tracker.refresh({ force: true });
check('one quiet minute doubles the idle period', adaptive.tracker.period() === 10000, String(adaptive.tracker.period()));
adaptiveClock += 61000;
await adaptive.tracker.refresh({ force: true });
check('two quiet minutes double it again', adaptive.tracker.period() === 20000, String(adaptive.tracker.period()));
adaptiveClock += 120000;
await adaptive.tracker.refresh({ force: true });
check('the backoff stops at its ceiling', adaptive.tracker.period() === 40000, String(adaptive.tracker.period()));
adaptive.tracker.setWatching(true);
check('watching the dialog holds the fast period', adaptive.tracker.period() === 5000, String(adaptive.tracker.period()));
adaptive.tracker.setWatching(false);
check('closing the dialog restarts the quiet clock', adaptive.tracker.period() === 5000, String(adaptive.tracker.period()));
mode = 'low';
await adaptive.tracker.refresh({ force: true });
check('any movement resets the backoff', adaptive.tracker.period() === 5000, String(adaptive.tracker.period()));
adaptive.tracker.setRunning(true);
check('a running session polls at the fast period', adaptive.tracker.period() === 5000, String(adaptive.tracker.period()));
Date.now = realDateNowForPoll;
releaseAdaptive();
mode = 'ready';

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;

// ── a hung read cannot freeze the loop (watchdog) ───────────────────────────
const realDateNow = Date.now;
let clock = realDateNow();
Date.now = () => clock;
const hung = makePlugin();
mode = 'hang';
void hung.tracker.refresh({ force: true });
const readsWhileHung = reads;
mode = 'ready';
void hung.tracker.refresh({ force: true });
check('a second refresh while hung does not stack reads', reads === readsWhileHung, String(reads));
clock += 50000;
await hung.tracker.refresh({ force: true }).catch(() => {});
await settle();
check('after the timeout the hung read is abandoned and retried', reads === readsWhileHung + 1, String(reads));
check('the retry heals the snapshot', hung.tracker.get().status === 'ready' && hung.tracker.get().successes === 1,
  JSON.stringify([hung.tracker.get().status, hung.tracker.get().successes]));
Date.now = realDateNow;

// ── official-rate ledger ────────────────────────────────────────────────────
const ROUTE_FLASH = { provider: 'deepseek-account', model: 'deepseek-flash' };
const READ_1M = { uncached: 0, cacheRead: 1000000, cacheWrite: 0, output: 0 };
const at = (iso) => Date.parse(iso);
/** The flash share of a ledger entry (cost buckets are accumulated per model). */
const flashShare = (entry) => entry.models['deepseek-flash'] ?? { base: 0, cost: 0 };
/** Price a whole 1M cache-read basket at one instant: ¥0.04 peak, ¥0.02 off. */
const priceAt = (iso) => flashShare(payments.observe('band-' + iso, READ_1M, ROUTE_FLASH, 100, at(iso))).base;

check('weekday 10:00 Beijing is peak', close(priceAt('2026-09-30T02:00:00Z'), 0.04), String(priceAt('2026-09-30T02:00:00Z')));
check('weekday 13:00 Beijing is off-peak', close(priceAt('2026-09-30T05:00:00Z'), 0.02), String(priceAt('2026-09-30T05:00:00Z')));
check('weekday 08:30 Beijing is off-peak', close(priceAt('2026-09-30T00:30:00Z'), 0.02), String(priceAt('2026-09-30T00:30:00Z')));
check('weekday 17:30 Beijing is peak', close(priceAt('2026-09-30T09:30:00Z'), 0.04), String(priceAt('2026-09-30T09:30:00Z')));
check('weekday 18:30 Beijing is off-peak', close(priceAt('2026-09-30T10:30:00Z'), 0.02), String(priceAt('2026-09-30T10:30:00Z')));
check('Saturday is off-peak even at 10:00', close(priceAt('2026-09-26T02:00:00Z'), 0.02), String(priceAt('2026-09-26T02:00:00Z')));
check('a public holiday is off-peak even at 10:00', close(priceAt('2026-10-01T02:00:00Z'), 0.02), String(priceAt('2026-10-01T02:00:00Z')));

const deltaSession = 'delta-session';
const first = payments.observe(deltaSession, READ_1M, ROUTE_FLASH, 100, at('2026-09-30T02:00:00Z'));
check('the first observation prices the whole session total',
  close(flashShare(first).base, 0.04) && flashShare(first).cost === 0,
  JSON.stringify(flashShare(first)));
check('the first observation remembers the wallet it started from', first.walletStart === 100, String(first.walletStart));
const grown = payments.observe(deltaSession, { ...READ_1M, output: 1000 }, ROUTE_FLASH, 99.9, at('2026-09-30T02:00:05Z'));
check('later deltas are priced at the peak rate', close(flashShare(grown).cost, 0.008), String(flashShare(grown).cost));
const later = payments.observe(deltaSession, { ...READ_1M, output: 2000 }, ROUTE_FLASH, 99.8, at('2026-09-30T05:00:00Z'));
check('a delta observed off-peak uses the half rate', close(flashShare(later).cost, 0.012), String(flashShare(later).cost));
check('the base is not double counted', close(flashShare(later).base + flashShare(later).cost, 0.052),
  String(flashShare(later).base + flashShare(later).cost));

const unpriced = payments.observe('unpriced-session', READ_1M, { provider: 'x', model: 'mystery-model' }, 10, at('2026-09-30T02:00:00Z'));
check('an unpriced model adds nothing', Object.keys(unpriced.models).length === 0, JSON.stringify(unpriced.models));

// Two models in one session keep separate shares, so one model's learned factor
// can never be applied to the other's usage.
const mixed = 'mixed-session';
payments.observe(mixed, READ_1M, ROUTE_FLASH, 100, at('2026-09-30T02:00:00Z'));
payments.observe(mixed, { ...READ_1M, output: 1000 }, ROUTE_FLASH, 99.99, at('2026-09-30T02:00:05Z'));
const switched = payments.observe(mixed, { ...READ_1M, output: 1000, uncached: 1000000 },
  { provider: 'deepseek-account', model: 'deepseek-v4-pro' }, 99.9, at('2026-09-30T02:00:10Z'));
check('a model switch keeps the shares apart',
  Object.keys(switched.models).sort().join(',') === 'deepseek-flash,deepseek-v4-pro',
  JSON.stringify(Object.keys(switched.models)));
check('each share carries its own delta',
  close(switched.models['deepseek-flash'].cost, 0.008) && close(switched.models['deepseek-v4-pro'].cost, 9),
  JSON.stringify([switched.models['deepseek-flash'].cost, switched.models['deepseek-v4-pro'].cost]));

// Per-turn buckets: a running edge opens the bucket, the next edge closes it.
const turnSession = 'turn-session';
payments.observe(turnSession, READ_1M, ROUTE_FLASH, 100, at('2026-09-30T02:00:00Z'));
payments.beginTurn(turnSession, at('2026-09-30T02:00:02Z'));
payments.observe(turnSession, { ...READ_1M, output: 1000 }, ROUTE_FLASH, 99.99, at('2026-09-30T02:00:05Z'));
const afterFirstTurn = payments.beginTurn(turnSession, at('2026-09-30T02:00:30Z'));
check('a running edge closes the turn',
  close(afterFirstTurn.turns[0]?.cost ?? 0, 0.008) && afterFirstTurn.current.cost === 0,
  JSON.stringify([afterFirstTurn.turns[0]?.cost, afterFirstTurn.current.cost]));
payments.observe(turnSession, { ...READ_1M, output: 2000 }, ROUTE_FLASH, 99.98, at('2026-09-30T02:00:35Z'));
const inSecondTurn = payments.get(turnSession);
check('the next turn accumulates on its own', close(inSecondTurn.current.cost, 0.008),
  String(inSecondTurn.current.cost));

// A foreign-only window (no usage of ours, wallet still moved) is still evidence.
const samplesBefore = payments.calibration('deepseek-flash')?.samples ?? 0;
const foreignSession = 'foreign-session';
payments.observe(foreignSession, READ_1M, ROUTE_FLASH, 100, at('2026-09-30T02:00:00Z'));
let foreignWallet = 100;
for (let i = 1; i <= 5; i += 1) {
  const ours = i <= 3; // two windows where only the other machine spends
  const paid = ours ? 0.04 * i : 0.02;
  foreignWallet -= paid;
  payments.observe(foreignSession,
    ours ? { ...READ_1M, cacheRead: 1000000 * (1 + i) } : READ_1M,
    ROUTE_FLASH, foreignWallet, at('2026-09-30T02:00:00Z') + i * 10000);
}
const samplesAfter = payments.calibration('deepseek-flash')?.samples ?? 0;
check('foreign-only windows count as samples', samplesAfter - samplesBefore === 5,
  `${samplesBefore} -> ${samplesAfter}`);

const reloaded = makePlugin();
const resumed = reloaded.payments.get(deltaSession);
check('the ledger survives a reload', resumed !== null && close(flashShare(resumed).cost, 0.012),
  JSON.stringify(resumed?.models));

// ── rendering ───────────────────────────────────────────────────────────────
// A clean stage: its own plugin instance and cleared storage, so the pooled
// price-change detector starts from zero evidence.
storage.clear();
const stage = makePlugin();
const stageTracker = stage.tracker;
const stagePayments = stage.payments;
const PEAK_ISO = '2026-09-30T02:00:00Z';
mode = 'ready';
await stageTracker.refresh();
const renderPill = ({
  sessionId = 'session-3', open = false, running = false, wallet = stageTracker, payments = stagePayments,
} = {}) => {
  beginRender(open ? { 1: true } : {});
  return stage.registration.component({
    useProjection: (key) => (key === 'tokenUsage'
      ? { uncachedInputTokens: 1000, cacheReadTokens: 2000000, cacheWriteTokens: 0, outputTokens: 500 }
      : key === 'modelSelection'
        ? { lastUsed: ROUTE_FLASH, next: null }
        : undefined),
    useSession: (selector) => selector({ running }),
    sessionId,
    wallets: wallet,
    payments,
  });
};
const findRoot = (tree) => tree?.children?.find((child) => child?.props?.['data-cost-meter'] === true);
const findButton = (tree) => findRoot(tree)?.children?.find((child) => child?.props?.className === 'dshcost_pill');
const findLabel = (tree) => findButton(tree)?.children?.find((child) => child?.props?.className === 'dshcost_label');
const findPanel = (tree) => tree?.children?.find((child) => child?.props?.className === 'dshcost_panel');
const cellText = (tree, name) => {
  const flat = (findPanel(tree)?.children?.[2]?.children ?? []).flat(Infinity);
  const index = flat.findIndex((cell) => cell?.children?.[0] === name);
  return index < 0 ? null : flat[index + 1]?.children?.[0];
};

// session-3: 1000 miss + 2M cache-read + 500 output at peak = (2000 + 80000 + 4000)/1e6
stagePayments.observe('session-3', { uncached: 1000, cacheRead: 2000000, cacheWrite: 0, output: 500 },
  ROUTE_FLASH, 45.19, at(PEAK_ISO));
const closed = renderPill();
check('pill renders the real balance', JSON.stringify(findLabel(closed)?.children).includes('¥45.19'),
  JSON.stringify(findLabel(closed)?.children));
check('pill renders the official-price estimate',
  JSON.stringify(findLabel(closed)?.children).includes('¥0.086'), JSON.stringify(findLabel(closed)?.children));
check('pill is a dialog trigger', findButton(closed)?.props?.['aria-haspopup'] === 'dialog'
  && findButton(closed)?.props?.['aria-expanded'] === false);
check('closed pill renders no panel', findPanel(closed) === undefined);

const iconElement = findButton(closed)?.children?.[0];
const iconSvg = typeof iconElement?.type === 'function' ? iconElement.type({}) : null;
check('the wallet icon replaced the yen circle',
  iconSvg?.type === 'svg' && JSON.stringify(iconSvg.children.map((child) => child.type)) === '["rect","path","circle"]',
  JSON.stringify(iconSvg?.children?.map((child) => child.type)));

const opened = renderPill({ open: true });
const panel = findPanel(opened);
check('open pill renders the dialog', panel !== undefined);
check('dialog is a portaled labelled dialog', panel?.props?.role === 'dialog' && panel?.props?.['aria-label'] === '账号钱包');
check('dialog starts unplaced so it can be measured', panel?.props?.style?.visibility === 'hidden');
const panelTitle = panel?.children?.[0];
check('dialog title carries the icon and the total',
  panelTitle?.props?.className === 'dshcost_title'
  && JSON.stringify(panelTitle.children).includes('账号钱包') && JSON.stringify(panelTitle.children).includes('¥45.19'),
  JSON.stringify(panelTitle?.children?.[1]));
check('dialog has the host title rule', panel?.children?.[1]?.props?.className === 'dshcost_titleRule');
check('dialog body is a definition list',
  panel?.children?.[2]?.type === 'dl' && panel?.children?.[2]?.props?.className === 'dshcost_details');

check('dialog lists the wallet rows',
  cellText(opened, '充值余额') === '¥43.19' && cellText(opened, '赠送额度') === '¥2.00'
  && cellText(opened, '余额合计') === '¥45.19',
  JSON.stringify([cellText(opened, '充值余额'), cellText(opened, '赠送额度')]));
check('dialog states the session estimate', cellText(opened, '本次会话') === '≈¥0.086',
  String(cellText(opened, '本次会话')));
check('dialog prices the turn row', cellText(opened, '本轮花费') === '—', String(cellText(opened, '本轮花费')));
const panelRows = (panel?.children?.[2]?.children ?? []).flat(Infinity);
check('the dialog shows exactly the five requested rows',
  panelRows.length === 10 && panelRows.filter((cell) => cell.type === 'dt').map((cell) => cell.children[0]).join('|')
    === '充值余额|赠送额度|余额合计|本次会话|本轮花费',
  JSON.stringify(panelRows.filter((cell) => cell.type === 'dt').map((cell) => cell.children[0])));

// A turn in progress shows its own cost, marked as still running. It runs on its
// own plugin instance so its calibration samples never reach the rate cases.
const turnStage = 'turn-stage';

mode = 'throw';
await stageTracker.refresh({ force: true });
const stale = renderPill({ sessionId: 'session-3', open: true });
check('a failed read keeps the last numbers on screen',
  findPanel(stale) !== undefined && cellText(stale, '余额合计') === '¥45.19'
  && cellText(stale, '本次会话') === '≈¥0.086',
  JSON.stringify([cellText(stale, '余额合计'), cellText(stale, '本次会话')]));
mode = 'ready';
await stageTracker.refresh({ force: true });

// ── the price-change detector ───────────────────────────────────────────────
// Case 1: the published price doubled. Sample costs vary (1M..5M cache-read at
// ¥0.04 per M), and each window charged exactly twice the table price.
const CAL_READ = { uncached: 0, cacheRead: 1000000, cacheWrite: 0, output: 0 }; // ¥0.04 at peak
let calWallet = 50;
let cumulative = 1000000;
stagePayments.observe('cal-session', { ...CAL_READ, cacheRead: cumulative }, ROUTE_FLASH, calWallet, at(PEAK_ISO));
for (let i = 1; i <= 5; i += 1) {
  const predicted = 0.04 * i;      // delta cost of this window
  cumulative += 1000000 * i;
  calWallet -= predicted * 2;      // reality: double the table price
  stagePayments.observe('cal-session', { ...CAL_READ, cacheRead: cumulative }, ROUTE_FLASH, calWallet,
    at(PEAK_ISO) + i * 10000);
}
const verdict = stagePayments.calibration('deepseek-flash');
check('the detector pools the observed windows', verdict?.samples === 5, String(verdict?.samples));
check('a proportional change is read as a price factor',
  verdict?.applied === true && close(verdict?.factor ?? 0, 2), JSON.stringify([verdict?.applied, verdict?.factor]));
check('a clean doubling leaves no foreign rate', close(verdict?.foreignRate ?? 1, 0), String(verdict?.foreignRate));
const flagged = renderPill({ sessionId: 'cal-session', open: true });
check('the corrected estimate carries its factor in the one row',
  cellText(flagged, '本次会话') === '≈¥1.28（实测 ×2.00）',
  String(cellText(flagged, '本次会话')));
const correctedPill = renderPill({ sessionId: 'cal-session' });
check('the pill shows the corrected estimate',
  JSON.stringify(findLabel(correctedPill)?.children).includes('¥1.28'),
  JSON.stringify(findLabel(correctedPill)?.children));

// Case 2: the table is right, but a second computer draws from the same wallet at
// a steady rate. Time and usage vary independently, so the fit can separate them:
// the factor must stay at 1 and the drain must be reported instead of corrected.
const PRO_READ = { uncached: 0, cacheRead: 1000000, cacheWrite: 0, output: 0 }; // ¥0.30 at peak
const ROUTE_PRO = { provider: 'deepseek-account', model: 'deepseek-v4-pro' };
const WINDOW_SECONDS = [5, 20, 5, 20, 5];
const FOREIGN_PER_SECOND = 0.001;
let proWallet = 40;
let proCumulative = 1000000;
let proClock = at(PEAK_ISO);
stagePayments.observe('pro-session', { ...PRO_READ, cacheRead: proCumulative }, ROUTE_PRO, proWallet, proClock);
for (let i = 1; i <= 5; i += 1) {
  proWallet -= 0.3 * i + FOREIGN_PER_SECOND * WINDOW_SECONDS[i - 1];
  proCumulative += 1000000 * i;
  proClock += WINDOW_SECONDS[i - 1] * 1000;
  stagePayments.observe('pro-session', { ...PRO_READ, cacheRead: proCumulative }, ROUTE_PRO, proWallet, proClock);
}
const shared = stagePayments.calibration('deepseek-v4-pro');
check('a steady foreign drain does not become a price factor',
  shared?.applied === false && close(shared?.factor ?? 0, 1, 0.02),
  JSON.stringify([shared?.applied, shared?.factor]));
check('the foreign drain is measured instead',
  close(shared?.foreignRate ?? 0, FOREIGN_PER_SECOND, 1e-6), String(shared?.foreignRate));
const sharedPanel = renderPill({ sessionId: 'pro-session', open: true });
check('a foreign drain adds no correction to the row',
  cellText(sharedPanel, '本次会话') === '≈¥4.80',
  String(cellText(sharedPanel, '本次会话')));

// Case 3: without spread in the sample costs a slope cannot be identified at all.
localStorage.setItem('dsh-cost-meter/calibration/v2', JSON.stringify({ version: 'other', models: {} }));
const degenerateWallet = 10;
const degenerate = makePlugin();
let degCumulative = 1000000;
degenerate.payments.observe('deg-session', { ...CAL_READ, cacheRead: degCumulative }, ROUTE_FLASH, degenerateWallet, at(PEAK_ISO));
for (let i = 1; i <= 5; i += 1) {
  degCumulative += 1000000; // every window prices exactly the same
  degenerate.payments.observe('deg-session', { ...CAL_READ, cacheRead: degCumulative }, ROUTE_FLASH,
    degenerateWallet, at(PEAK_ISO) + i * 10000);
}
const degenerateVerdict = degenerate.payments.calibration('deepseek-flash');
check('identical sample costs cannot identify a factor',
  degenerateVerdict?.insufficientSpread === true && degenerateVerdict?.applied === false,
  JSON.stringify([degenerateVerdict?.insufficientSpread, degenerateVerdict?.applied]));
const degeneratePanel = renderPill({ sessionId: 'deg-session', open: true, payments: degenerate.payments });
check('an unidentified factor leaves the row uncorrected',
  cellText(degeneratePanel, '本次会话') === '≈¥0.24',
  String(cellText(degeneratePanel, '本次会话')));

// ── per-model accounting still separates the shares ─────────────────────────
// A clean stage again, so these samples never reach the detector cases above.
storage.clear();
const late = makePlugin();
mode = 'ready';
await late.tracker.refresh();
const renderLate = (sessionId, running = false) => renderPill({
  sessionId, open: true, running, wallet: late.tracker, payments: late.payments,
});

const multiStage = 'multi-stage';
late.payments.observe(multiStage, READ_1M, ROUTE_FLASH, 45.19, at(PEAK_ISO));
const lateSwitched = late.payments.observe(multiStage, { ...READ_1M, uncached: 1000000 }, ROUTE_PRO, 45.1, at(PEAK_ISO) + 5000);
check('a model switch keeps the shares apart',
  Object.keys(lateSwitched.models).sort().join(',') === 'deepseek-flash,deepseek-v4-pro',
  JSON.stringify(Object.keys(lateSwitched.models)));
check('each share carries its own delta',
  close(lateSwitched.models['deepseek-flash'].cost, 0) && close(lateSwitched.models['deepseek-v4-pro'].cost, 9),
  JSON.stringify([lateSwitched.models['deepseek-flash'].cost, lateSwitched.models['deepseek-v4-pro'].cost]));
const multiPanel = renderLate(multiStage);
check('the session row adds both shares up',
  cellText(multiPanel, '本次会话') === '≈¥9.04', String(cellText(multiPanel, '本次会话')));

// The turn row on its own instance, so its samples never reach the rate cases.
late.payments.observe(turnStage, READ_1M, ROUTE_FLASH, 45.19, at(PEAK_ISO));
late.payments.beginTurn(turnStage, at(PEAK_ISO) + 2000);
late.payments.observe(turnStage, { ...READ_1M, output: 2000 }, ROUTE_FLASH, 45.18, at(PEAK_ISO) + 5000);
const liveTurn = renderLate(turnStage, true);
check('a running turn shows its cost and the running mark',
  String(cellText(liveTurn, '本轮花费')).includes('¥0.016') && String(cellText(liveTurn, '本轮花费')).includes('进行中'),
  String(cellText(liveTurn, '本轮花费')));
const idleTurn = renderPill({ sessionId: turnStage, open: true, wallet: late.tracker, payments: late.payments });
check('a settled turn keeps its cost without the running mark',
  String(cellText(idleTurn, '本轮花费')).includes('¥0.016')
  && !String(cellText(idleTurn, '本轮花费')).includes('进行中'),
  String(cellText(idleTurn, '本轮花费')));

// A new published table discards everything learned against the old one.
localStorage.setItem('dsh-cost-meter/calibration/v2',
  JSON.stringify({ version: 'old-table-2026-01-01', models: { 'deepseek-flash': { pairs: [[0.04, 0.08, 5]] } } }));
const fresh = makePlugin();
check('a new rate-table version discards learned corrections',
  fresh.payments.calibration('deepseek-flash') === null,
  JSON.stringify(fresh.payments.calibration('deepseek-flash')));

// Sub-cent formatting through a synthetic ready snapshot.
const formatVia = (total) => {
  const snapshot = { status: 'ready', at: Date.now(), currency: 'CNY', symbol: '¥', total, topUp: total, bonus: 0 };
  const stub = {
    subscribe: () => () => {},
    get: () => snapshot,
    refresh: () => Promise.resolve(),
    retain: () => () => {},
    setRunning: () => {},
    setWatching: () => {},
    period: () => 5000,
  };
  const tree = renderPill({ sessionId: 'unpriced-session', wallet: stub });
  return findLabel(tree)?.children?.[0];
};
check('sub-cent totals format as <¥0.01', formatVia(0.004) === '<¥0.01', String(formatVia(0.004)));
check('ordinary totals keep two decimals', formatVia(0.4) === '¥0.40', String(formatVia(0.4)));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
