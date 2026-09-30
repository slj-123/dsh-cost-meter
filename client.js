/**
 * Client half of the cost-meter bundle — v5.
 *
 * Renders one pill in `conversation.composer.dock` (the row below the composer
 * card that already carries 轮/步 · tok/s and `84K tok · 缓存命中`).
 *
 * Two independent numbers, shown together so they check each other:
 *
 *   1. the **real wallet**, read through the account Remote shipped plugins use
 *      (`ctx.remote.account.getBalance` → paid + bonus wallets, CNY/USD);
 *   2. a **cost estimate from DeepSeek's published rates**, applied to the
 *      session's own token buckets (`tokenUsage` projection) with the model from
 *      `modelSelection` and the peak/off-peak band of the moment each delta was
 *      observed. Peak is weekdays 09:00–12:00 and 14:00–18:00 Beijing time,
 *      excluding Chinese public holidays; everything else bills at half.
 *
 * v1 estimated with invented rates (¥0.5 per 1M cache-hit tokens) and was ~4x
 * high; the published cache-hit rate is ¥0.02–0.04 per 1M, and there is a
 * peak/off-peak factor the first version did not model at all.
 * Rates source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *
 * No Harness Client package is imported; the icon and the panel are local.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-cost-meter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let createPortal = null;
    try {
      createPortal = require('react-dom').createPortal;
    } catch {
      createPortal = null;
    }

    /** Client build version carried by account calls; follows the app build. */
    const CLIENT_VERSION = '0.2.0-rc.2';
    /** Wallet poll while a turn is running or the dialog is open. */
    const RUNNING_INTERVAL_MS = 5000;
    /** Wallet poll while the session is idle and nothing has moved. */
    const IDLE_INTERVAL_MS = 5000;
    /** Idle polling doubles once per quiet minute, up to this ceiling. */
    const IDLE_MAX_INTERVAL_MS = 40000;
    const QUIET_STEP_MS = 60000;
    /** Smallest gap between two Platform reads. */
    const MIN_INTERVAL_MS = 4000;
    /** A read older than this is abandoned so one hang cannot freeze polling. */
    const READ_TIMEOUT_MS = 45000;
    /** Placement constants copied from the shipped stat dialog. */
    const PANEL_MARGIN = 12;
    const PANEL_GAP = 8;
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

    /**
     * DeepSeek published rates, CNY per 1,000,000 tokens. Peak is exactly twice
     * off-peak. Cache writes have no published line of their own, so they are
     * priced as cache-miss input — the reconciliation row in the dialog is what
     * confirms or refutes that reading.
     */
    const RATES = {
      'deepseek-flash': {
        off: { miss: 1, hit: 0.02, write: 1, out: 4 },
        peak: { miss: 2, hit: 0.04, write: 2, out: 8 },
      },
      'deepseek-v4-pro': {
        off: { miss: 4.5, hit: 0.15, write: 4.5, out: 13.5 },
        peak: { miss: 9, hit: 0.3, write: 9, out: 27 },
      },
    };

    /**
     * Chinese public holidays (Beijing dates) from 国办发明电〔2025〕7号. The
     * published rule is "weekdays except public holidays", so these days bill at
     * the off-peak rate all day; make-up weekend workdays stay weekends. Update
     * this list when the next year's notice lands.
     */
    const HOLIDAYS = new Set([
      '2026-01-01', '2026-01-02', '2026-01-03',
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
      '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
      '2026-04-04', '2026-04-05', '2026-04-06',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
      '2026-10-06', '2026-10-07',
    ]);

    /**
     * The newest year the table covers. Derived from the data rather than kept
     * by hand, so pasting next year's notice into HOLIDAYS is the only edit
     * needed to clear the staleness notice.
     */
    const HOLIDAY_YEAR = HOLIDAYS.size === 0
      ? 0
      : Math.max(...[...HOLIDAYS].map((date) => Number(date.slice(0, 4))));

    /** Per-session estimate cache, so a page reload resumes instead of restarting. */
    const LEDGER_KEY = 'dsh-cost-meter/ledger/v2';
    const LEDGER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const LEDGER_MAX_SESSIONS = 40;
    /** Completed turns kept per session for the per-turn rows. */
    const TURN_HISTORY = 8;

    /** Which numbers the pill shows, persisted per browser. */
    const VIEW_KEY = 'dsh-cost-meter/view/v1';
    /**
     * Every number the pill can show, in the order the pill lays them out. The
     * ids are the persisted vocabulary, so they never change; each one is named
     * by the dialog row of the same value.
     */
    const VIEW_ITEMS = ['balance', 'topUp', 'bonus', 'session', 'turn'];
    /** The dialog row that names each pill item. */
    const VIEW_LABELS = {
      balance: 'row.total',
      topUp: 'row.topUp',
      bonus: 'row.bonus',
      session: 'row.session',
      turn: 'row.turn',
    };
    /** What the pill showed before it was configurable. */
    const DEFAULT_VIEW = ['balance', 'session'];
    /** A turn's cost must rise by this much before the pill reacts to it. */
    const SPEND_HIT_MIN_DELTA = 0.0002;
    /** Two reactions never land closer together than this, however fast the steps come. */
    const SPEND_HIT_INTERVAL_MS = 600;

    /** The pricing page revision the table above was copied from. */
    const RATES_VERSION = '2026-09-10';
    /** Wallet-vs-estimate samples needed before the correction claims anything. */
    const CALIBRATION_MIN_SAMPLES = 5;
    /** Beyond this relative gap the table is worth re-checking. */
    const CALIBRATION_TOLERANCE = 0.15;
    /** Only the most recent pairs count, so a price change is not diluted by old ones. */
    const CALIBRATION_WINDOW = 24;
    /** The learned factor is clamped to this range. */
    const CALIBRATION_MIN_FACTOR = 0.25;
    const CALIBRATION_MAX_FACTOR = 4;
    /** Relative spread of the sample costs below which the slope is unidentifiable. */
    const CALIBRATION_MIN_SPREAD = 0.05;
    /** Residual RMS (relative to mean charge) above which the fit is not trusted. */
    const CALIBRATION_MAX_RESIDUAL = 0.6;
    /** Apply the learned factor to the shown estimate (false = report only). */
    const AUTO_CALIBRATE = true;
    /** Observed pairs live here; they are what makes a price change visible. */
    const CALIBRATION_KEY = 'dsh-cost-meter/calibration/v2';

    const CSS = [
      // pill — copied from the shipped StatsPills row
      '.dshcost_root{box-sizing:border-box;min-width:0;max-width:100%;',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'justify-content:center;gap:12px;display:flex}',
      '.dshcost_pill{box-sizing:border-box;max-width:100%;',
      'color:var(--dsw-alias-label-tertiary);font:inherit;',
      'font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;',
      'background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;',
      'padding:1px 8px;display:inline-flex;cursor:pointer;position:relative}',
      '.dshcost_pill:hover,.dshcost_pill[aria-expanded="true"]{',
      'background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-secondary)}',
      '.dshcost_pill svg{flex:none;width:14px;height:14px}',
      '.dshcost_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.dshcost_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
      // dialog — copied from the shipped stat-dialog module
      '.dshcost_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);',
      'background:var(--dsw-specific-menu);width:max-content;',
      'min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);',
      'backdrop-filter:var(--dsw-menu-backdrop-filter);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
      'box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);',
      'cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}',
      '.dshcost_title{color:var(--dsw-alias-label-primary);justify-content:space-between;',
      'gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
      '.dshcost_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
      '.dshcost_titleValue{font-variant-numeric:tabular-nums}',
      '.dshcost_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}',
      '.dshcost_titleLabel svg{flex:none;width:14px;height:14px}',
      '.dshcost_details{color:var(--dsw-alias-label-tertiary);',
      'grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}',
      '.dshcost_details dt,.dshcost_details dd{min-width:0;margin:0}',
      '.dshcost_details dd{color:var(--dsw-alias-label-secondary);',
      'font-variant-numeric:tabular-nums;text-align:right}',
      '.dshcost_notice{color:var(--dsw-alias-state-warn-primary);',
      'margin-top:8px;font-size:11px;line-height:16px}',
      // display-item picker, below the dialog body
      '.dshcost_display{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:12px;padding-top:10px}',
      '.dshcost_disclosure{color:var(--dsw-alias-label-tertiary);font:inherit;',
      'background:0 0;border:0;border-radius:6px;box-sizing:border-box;',
      'width:calc(100% + 12px);margin:0 -6px;padding:2px 6px;gap:6px;',
      'align-items:center;text-align:left;display:flex;cursor:pointer}',
      '.dshcost_disclosure:hover{color:var(--dsw-alias-label-secondary);',
      'background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshcost_chevron{flex:none;width:12px;height:12px;transition:transform .15s ease}',
      '.dshcost_chevron[data-open="true"]{transform:rotate(90deg)}',
      '.dshcost_choices{grid-template-columns:1fr 1fr;gap:4px 12px;display:grid;margin-top:8px}',
      '.dshcost_choice{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;display:flex;cursor:pointer}',
      '.dshcost_choice:hover{color:var(--dsw-alias-label-primary)}',
      '.dshcost_choiceWide{grid-column:1/-1}',
      '.dshcost_choice input{margin:0;cursor:pointer}',
      // opportunity cost, worn on the sleeve — only when the reader asked for it
      '.dshcost_spend{color:var(--dsw-alias-state-error-primary)}',
      '.dshcost_hit{display:inline-block;animation:dshcost-hit .45s ease-out}',
      '.dshcost_hitFlash{position:absolute;inset:0;border-radius:999px;',
      'background:var(--dsw-alias-state-error-primary);opacity:.14;',
      'pointer-events:none;animation:dshcost-flash .5s ease-out forwards}',
      '@keyframes dshcost-hit{0%{transform:translateY(-1px) scale(1.08)}',
      '40%{transform:translateY(1px) scale(1)}100%{transform:none}}',
      '@keyframes dshcost-flash{0%{opacity:.2}100%{opacity:0}}',
      '@media (prefers-reduced-motion:reduce){.dshcost_hit,.dshcost_hitFlash{animation:none}',
      '.dshcost_chevron{transition:none}}',
    ].join('');

    const SYMBOL = { CNY: '¥', USD: '$' };

    /** This package's locale namespace; the pill and the panel own this copy. */
    const NS = 'cost-meter';
    /**
     * Visible copy, in the shape `ctx.locale.register` takes. Simplified Chinese
     * is the key-set source of truth and the English dictionary carries the same
     * keys. The framework-injected `t` seat resolves these against the active
     * locale; `fallbackTranslate` keeps the component readable in a composition
     * that installs no locale face, and in the offline tests.
     */
    const ZH = {
      'panel.title': '账号钱包',
      'row.topUp': '充值余额',
      'row.bonus': '赠送额度',
      'row.total': '余额合计',
      'row.session': '本次会话',
      'row.turn': '本轮花费',
      'turn.running': '（进行中）',
      'estimate.corrected': '（实测 ×{factor}）',
      'panel.display': '显示项',
      'panel.runningMark': '标注「进行中」',
      'panel.spendEffect': '花费变红 + 扣血动效',
      'panel.holidayStale': '节假日表只到 {year}，假期当天可能按高峰计价',
      'pill.aria': '账号钱包 {list}',
      'pill.aria.join': '，',
    };
    const EN = {
      'panel.title': 'Account wallet',
      'row.topUp': 'Top-up balance',
      'row.bonus': 'Bonus credit',
      'row.total': 'Total balance',
      'row.session': 'This session',
      'row.turn': 'This turn',
      'turn.running': '(running)',
      'estimate.corrected': '(measured ×{factor})',
      'panel.display': 'Shown in the pill',
      'panel.runningMark': 'Mark the running turn',
      'panel.spendEffect': 'Red spend with a hit effect',
      'panel.holidayStale': 'Holiday table ends at {year}: holidays may bill at the peak rate',
      'pill.aria': 'Account wallet {list}',
      'pill.aria.join': ', ',
    };

    /** Stand-in translator for a composition that installs no locale face. */
    function fallbackTranslate(key, params) {
      const template = ZH[key] ?? key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (
        params[name] === undefined ? match : String(params[name])
      ));
    }

    /** Two decimals with Platform Web's sub-cent rule; the sign is kept. */
    function formatMoney(amount, symbol) {
      const value = Math.abs(amount);
      const sign = amount < 0 ? '-' : '';
      if (value > 0 && value < 0.01) return sign + '<' + symbol + '0.01';
      return sign + symbol + value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }

    /**
     * Costs need finer resolution than balances: one turn can be well under a
     * cent, and rounding that to 0.00 would hide the number being measured.
     */
    function formatCost(amount, symbol) {
      const value = Math.abs(amount);
      if (!(value > 0)) return symbol + '0.00';
      if (value < 0.001) return '<' + symbol + '0.001';
      if (value >= 1) {
        return symbol + value.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      }
      const text = value.toFixed(3).replace(/0+$/, '');
      const decimals = text.includes('.') ? text.split('.')[1].length : 0;
      return symbol + (decimals >= 2 ? text : text + '0'.repeat(2 - decimals));
    }

    /** The wallet group in the currency that carries the balance. */
    function pickWallets(balance) {
      const groups = [balance.value ?? [], balance.bonusWallets ?? []];
      const currencies = [];
      for (const group of groups) {
        for (const wallet of group) {
          if (typeof wallet?.balance === 'string' && !currencies.includes(wallet.currency)) {
            currencies.push(wallet.currency);
          }
        }
      }
      const currency = currencies.includes('CNY') ? 'CNY' : currencies[0];
      if (currency === undefined) return null;
      const sum = (group) => group.reduce((total, wallet) => (
        wallet?.currency === currency && typeof wallet.balance === 'string'
          ? total + Number(wallet.balance)
          : total
      ), 0);
      const topUp = sum(groups[0]);
      const bonus = sum(groups[1]);
      const total = topUp + bonus;
      if (!Number.isFinite(total)) return null;
      return { currency, symbol: SYMBOL[currency] ?? currency + ' ', total, topUp, bonus };
    }

    /** The four billed buckets of one usage projection value. */
    function bucketsOf(usage) {
      const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
      return {
        uncached: number(usage.uncachedInputTokens),
        cacheRead: number(usage.cacheReadTokens),
        cacheWrite: number(usage.cacheWriteTokens),
        output: number(usage.outputTokens),
      };
    }

    function bucketDelta(current, previous) {
      const diff = (next, before) => Math.max(0, (next ?? 0) - (before ?? 0));
      return {
        uncached: diff(current.uncached, previous?.uncached),
        cacheRead: diff(current.cacheRead, previous?.cacheRead),
        cacheWrite: diff(current.cacheWrite, previous?.cacheWrite),
        output: diff(current.output, previous?.output),
      };
    }

    /** Beijing wall-clock parts for one instant, whatever the local zone is. */
    function beijingAt(ms) {
      const shifted = new Date(ms + 8 * 60 * 60 * 1000);
      return {
        weekday: shifted.getUTCDay(),
        date: shifted.toISOString().slice(0, 10),
        minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
      };
    }

    /** 'peak' on Beijing weekdays 09:00–12:00 and 14:00–18:00 outside holidays. */
    function bandAt(ms) {
      const { weekday, date, minutes } = beijingAt(ms);
      if (weekday === 0 || weekday === 6) return 'off';
      if (HOLIDAYS.has(date)) return 'off';
      return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080) ? 'peak' : 'off';
    }

    /**
     * True once the clock has left the years the holiday table knows about. The
     * State Council publishes next year's arrangement each autumn, so there is a
     * window every winter where a public holiday is silently priced as a peak
     * weekday; this is what lets the UI say so instead.
     */
    function holidayTableStale(ms) {
      return Number(beijingAt(ms).date.slice(0, 4)) > HOLIDAY_YEAR;
    }

    /** The rate row for one route, accepting a "provider/model" key too. */
    function ratesFor(model, provider) {
      if (typeof model !== 'string' || model === '') return null;
      if (typeof provider === 'string' && RATES[provider + '/' + model] !== undefined) {
        return RATES[provider + '/' + model];
      }
      return RATES[model] ?? null;
    }

    /** Published-price cost of one bucket delta; null when the route is unpriced. */
    function costOfBuckets(buckets, rates, band) {
      if (rates === null) return null;
      const rate = rates[band];
      return (buckets.uncached * rate.miss
        + buckets.cacheRead * rate.hit
        + buckets.cacheWrite * rate.write
        + buckets.output * rate.out) / 1e6;
    }

    /**
     * Learned correction between the published table and this account's real
     * charges, per model, over a recent window of observations.
     *
     * The model is a two-term regression over each observation window:
     *
     *     charge ≈ rate · seconds + factor · tablePrice
     *
     * The `factor` term is the price multiplier the table needs; the `rate` term
     * is a steady drain that is *not* ours — another machine signed into the same
     * account, spending continuously. Those two have different shapes, and that
     * is the whole point: a pooled ratio cannot tell them apart (both inflate it),
     * while a regression separates a proportional change (slope) from an additive
     * one (time-rate). With two computers on one wallet, that distinction is the
     * difference between "the price doubled" and "the laptop is also running".
     *
     * Guards: recent window only, enough samples, enough spread in the sample
     * costs to identify a slope at all, residual RMS within tolerance, clamped
     * factor, and AUTO_CALIBRATE to switch the correction off entirely.
     */
    function createCalibration(storage) {
      const empty = () => ({ version: RATES_VERSION, models: {} });
      const read = () => {
        try {
          const raw = storage.getItem(CALIBRATION_KEY);
          if (raw === null || raw === '') return empty();
          const parsed = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object') return empty();
          // A new published table invalidates everything learned against the old one.
          if (parsed.version !== RATES_VERSION) return empty();
          return { version: RATES_VERSION, models: parsed.models ?? {} };
        } catch {
          return empty();
        }
      };
      let state = read();
      const save = () => {
        try { storage.setItem(CALIBRATION_KEY, JSON.stringify(state)); } catch { /* quota */ }
      };
      const pairsOf = (model) => {
        const key = typeof model === 'string' && model !== '' ? model : 'unknown';
        return state.models[key]?.pairs ?? [];
      };
      /** Least squares over [estimated, charged, seconds] samples. */
      const summarise = (pairs) => {
        const samples = pairs.length;
        if (samples < CALIBRATION_MIN_SAMPLES) return null;
        let ss = 0; let se = 0; let ee = 0; let sp = 0; let ep = 0; let sumPaid = 0; let sumEstimated = 0;
        for (const [estimated, paid, seconds] of pairs) {
          ss += seconds * seconds;
          se += seconds * estimated;
          ee += estimated * estimated;
          sp += seconds * paid;
          ep += estimated * paid;
          sumPaid += paid;
          sumEstimated += estimated;
        }
        const meanEstimated = sumEstimated / samples;
        let variance = 0;
        for (const [estimated] of pairs) variance += (estimated - meanEstimated) ** 2;
        const spread = meanEstimated > 0 ? Math.sqrt(variance / samples) / meanEstimated : 0;
        const determinant = ss * ee - se * se;
        const base = {
          samples,
          factor: 1,
          foreignRate: 0,
          residualShare: 1,
          consistent: false,
          insufficientSpread: false,
          applied: false,
        };
        if (!(determinant > 1e-12) || spread < CALIBRATION_MIN_SPREAD) {
          return { ...base, insufficientSpread: true };
        }
        const rawFactor = (ep * ss - sp * se) / determinant;
        const rawRate = (sp * ee - ep * se) / determinant;
        let sumSquares = 0;
        for (const [estimated, paid, seconds] of pairs) {
          const fitted = rawRate * seconds + rawFactor * estimated;
          sumSquares += (paid - fitted) ** 2;
        }
        const meanPaid = sumPaid / samples;
        const residualShare = meanPaid > 0 ? Math.sqrt(sumSquares / samples) / meanPaid : 1;
        const factor = Math.min(CALIBRATION_MAX_FACTOR, Math.max(CALIBRATION_MIN_FACTOR, rawFactor));
        const consistent = residualShare <= CALIBRATION_MAX_RESIDUAL;
        return {
          samples,
          factor,
          foreignRate: Math.max(0, rawRate),
          residualShare,
          consistent,
          insufficientSpread: false,
          applied: AUTO_CALIBRATE && consistent && Math.abs(factor - 1) > CALIBRATION_TOLERANCE,
        };
      };
      return {
        record(model, estimated, paid, seconds) {
          // A zero-cost window is a valid sample: it is the clearest evidence that
          // the money leaving the wallet was not ours.
          if (!(estimated >= 0) || !(paid >= 0) || !(seconds > 0)) return;
          const key = typeof model === 'string' && model !== '' ? model : 'unknown';
          const bucket = state.models[key] ?? { pairs: [] };
          bucket.pairs = [...(bucket.pairs ?? []), [estimated, paid, seconds]].slice(-CALIBRATION_WINDOW);
          state.models[key] = bucket;
          save();
        },
        /** The verdict for one model, or null while there is too little evidence. */
        summary: (model) => summarise(pairsOf(model)),
        reset() { state = empty(); save(); },
      };
    }

    /** localStorage when it works, an in-memory stand-in when it does not. */
    function createStorage() {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.getItem(LEDGER_KEY);
          return localStorage;
        }
      } catch { /* blocked or private storage */ }
      const memory = new Map();
      return {
        getItem: (key) => (memory.has(key) ? memory.get(key) : null),
        setItem: (key, value) => { memory.set(key, value); },
      };
    }

    /**
     * Which numbers the pill shows. Stored per browser rather than in the
     * profile: the choice is about this screen's composer row, and localStorage
     * keeps it instant — a checkbox has to repaint the pill on the same click.
     *
     * The stored order is ignored: items always render in VIEW_ITEMS order so a
     * later toggle cannot shuffle the row the user just got used to.
     */
    function createViewPreferences(storage) {
      const read = () => {
        try {
          const raw = storage.getItem(VIEW_KEY);
          if (raw === null || raw === '') return null;
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return { items: parsed };
          return parsed !== null && typeof parsed === 'object' ? parsed : null;
        } catch {
          return null;
        }
      };
      const stored = read();
      const listed = stored?.items;
      const chosen = Array.isArray(listed) ? VIEW_ITEMS.filter((id) => listed.includes(id)) : [];
      let items = chosen.length === 0 ? [...DEFAULT_VIEW] : chosen;
      // A record written before the flag existed has no opinion, and the
      // behaviour it was written against marked the running turn.
      let mark = typeof stored?.mark === 'boolean' ? stored.mark : true;
      // This one arrived later and stays off until asked for: a red number that
      // twitches on every step is a taste, not a default.
      let spend = stored?.spend === true;
      const save = () => {
        try {
          storage.setItem(VIEW_KEY, JSON.stringify({ version: 1, items, mark, spend }));
        } catch { /* quota or blocked storage */ }
      };
      return {
        get: () => items,
        /** Whether the pill marks a turn that is still running. */
        mark: () => mark,
        /** Whether the turn's cost is worn as a red deduction with a hit cue. */
        spend: () => spend,
        /**
         * Flip one item and persist. Removing the last remaining item is a
         * no-op: a pill with nothing in it cannot be clicked back open.
         */
        toggle(id) {
          if (!VIEW_ITEMS.includes(id)) return items;
          const next = items.includes(id)
            ? items.filter((each) => each !== id)
            : VIEW_ITEMS.filter((each) => each === id || items.includes(each));
          if (next.length === 0) return items;
          items = next;
          save();
          return items;
        },
        toggleMark() {
          mark = !mark;
          save();
          return mark;
        },
        toggleSpend() {
          spend = !spend;
          save();
          return spend;
        },
      };
    }

    /** The store a render gets when nothing was injected (the offline tests). */
    let looseViewPrefs = null;
    function viewPrefsFor(injected) {
      if (injected !== undefined && injected !== null) return injected;
      looseViewPrefs = looseViewPrefs ?? createViewPreferences(createStorage());
      return looseViewPrefs;
    }

    /**
     * Per-session estimate, persisted so a reload resumes rather than restarts.
     *
     * Costs are accumulated per model, and per turn inside that, so each model's
     * learned factor applies to its own share and a model switch mid-session does
     * not smear one factor over another model's usage.
     *
     * The first observation prices the session's whole total at that moment's
     * band — usage from before this page opened cannot be split by time — and
     * every later observation prices only its own delta at its own band. The
     * wallet total at that first observation is kept so the dialog can compare
     * the estimate against real money over exactly the same window.
     */
    function createLedger(storage) {
      const calibration = createCalibration(storage);
      const read = () => {
        try {
          const raw = storage.getItem(LEDGER_KEY);
          if (raw === null || raw === '') return {};
          const parsed = JSON.parse(raw);
          return parsed !== null && typeof parsed === 'object' && parsed.sessions !== undefined
            ? parsed.sessions
            : {};
        } catch {
          return {};
        }
      };
      let entries = read();
      const save = () => {
        try {
          storage.setItem(LEDGER_KEY, JSON.stringify({ version: 2, sessions: entries }));
        } catch { /* quota or blocked storage */ }
      };
      const bucketOf = (entry, model) => {
        const key = typeof model === 'string' && model !== '' ? model : 'unknown';
        entry.models[key] = entry.models[key] ?? { base: 0, cost: 0 };
        return entry.models[key];
      };
      const prune = (at) => {
        // A entry without a usable `startedAt` is corrupt, not eternal: treating
        // it as 0 makes both the TTL and the recency sort drop it.
        const startedAt = (value) => (Number.isFinite(value?.startedAt) ? value.startedAt : 0);
        const stale = Object.entries(entries).filter(([, value]) => at - startedAt(value) > LEDGER_TTL_MS);
        for (const [key] of stale) delete entries[key];
        const kept = Object.entries(entries).sort((a, b) => startedAt(b[1]) - startedAt(a[1]));
        for (const [key] of kept.slice(LEDGER_MAX_SESSIONS)) delete entries[key];
      };
      const keep = (sessionId, entry) => {
        entries[sessionId] = entry;
        save();
        return entry;
      };
      return {
        /** Price one observation and return the entry the dialog renders. */
        observe(sessionId, buckets, route, walletTotal, at) {
          const model = route === null || route === undefined ? null : route.model;
          const provider = route === null || route === undefined ? null : route.provider;
          const rates = ratesFor(model, provider);
          const band = bandAt(at);
          let entry = entries[sessionId];
          if (entry === undefined) {
            entry = {
              startedAt: at,
              observations: 1,
              models: {},
              turns: [],
              current: { at, cost: 0, edged: false },
              last: buckets,
              lastModel: model,
              walletStart: walletTotal,
              lastWallet: walletTotal,
              lastAt: at,
            };
            const base = costOfBuckets(buckets, rates, band);
            if (base !== null) bucketOf(entry, model).base = base;
            prune(at);
            return keep(sessionId, entry);
          }
          const cost = costOfBuckets(bucketDelta(buckets, entry.last), rates, band);
          const seconds = Math.max(1, (at - (entry.lastAt ?? at)) / 1000);
          if (entry.lastWallet !== null && entry.lastWallet !== undefined && walletTotal !== null) {
            const walletDelta = entry.lastWallet - walletTotal;
            // Two kinds of sample: a window where we spent, and a window where we
            // did not but the wallet still moved — the cleanest evidence of a
            // second machine. Unpriced windows teach nothing and are skipped.
            if (cost !== null && walletDelta >= 0 && (cost > 0.0005 || walletDelta > 0.0005)) {
              calibration.record(model ?? entry.lastModel ?? null, cost, walletDelta, seconds);
            }
          }
          entry = {
            ...entry,
            observations: entry.observations + 1,
            last: buckets,
            lastModel: model ?? entry.lastModel ?? null,
            lastWallet: walletTotal,
            lastAt: at,
          };
          if (cost !== null) {
            const bucket = bucketOf(entry, model);
            bucket.cost += cost;
            entry.current = { ...entry.current, cost: entry.current.cost + cost };
          }
          if (entry.walletStart === null && walletTotal !== null) entry.walletStart = walletTotal;
          prune(at);
          return keep(sessionId, entry);
        },
        /** Close the running turn and open a new one; called on the running edge. */
        beginTurn(sessionId, at) {
          const entry = entries[sessionId];
          if (entry === undefined) return null;
          const current = entry.current ?? { at, cost: 0, edged: false };
          // Only a bucket opened by an edge is a turn; usage seen before the first
          // edge belongs to the session total, not to a made-up "previous turn".
          const turns = current.edged === true && current.cost > 0
            ? [...(entry.turns ?? []), { at: current.at, cost: current.cost }].slice(-TURN_HISTORY)
            : (entry.turns ?? []);
          return keep(sessionId, { ...entry, turns, current: { at, cost: 0, edged: true } });
        },
        get: (sessionId) => entries[sessionId] ?? null,
        /** Wallet-vs-table verdict for one model, or null with too little evidence. */
        calibration: (model) => calibration.summary(model),
        /** Exposed for tests and for a future "reset estimate" action. */
        reset() { entries = {}; save(); calibration.reset(); },
      };
    }

    /**
     * Page-level wallet state: one snapshot, one in-flight read, one baseline per
     * session, and one poll loop shared by every pill instance.
     *
     * The loop is an interval, not a self-rescheduling timeout: a read that never
     * settles (or a callback that throws) must not be able to kill polling for
     * the rest of the page's life. A read older than READ_TIMEOUT_MS is abandoned
     * and retried, and a superseded read can no longer publish.
     */
    function createWalletTracker(read) {
      let snapshot = { status: 'idle' };
      let lastReadMs = 0;
      let inflight = null;
      let timer = null;
      let retains = 0;
      let running = false;
      let watching = false;
      let lastChangeMs = Date.now();
      let period = IDLE_INTERVAL_MS;
      let token = 0;
      let successes = 0;
      let failures = 0;
      const listeners = new Set();

      const publish = (next) => {
        snapshot = next;
        for (const listener of [...listeners]) listener();
      };
      const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

      /** Keep the last good numbers when a read fails; only then blank the pill. */
      const fail = (status) => {
        failures += 1;
        if (snapshot.status === 'ready') publish({ ...snapshot, error: status, failures });
        else publish({ status, at: lastReadMs, failures });
      };

      const start = (forced) => {
        if (!forced && Date.now() - lastReadMs < MIN_INTERVAL_MS) return Promise.resolve();
        const mine = (token += 1);
        const entry = { at: Date.now(), promise: null };
        inflight = entry;
        entry.promise = (async () => {
          try {
            const value = await read();
            if (mine !== token) return;
            lastReadMs = Date.now();
            const previousTotal = snapshot.status === 'ready' ? snapshot.total : null;
            const wallets = value?.status === 'ready' ? pickWallets(value) : null;
            if (wallets === null) fail('unavailable');
            else {
              successes += 1;
              if (previousTotal === null || wallets.total !== previousTotal) lastChangeMs = Date.now();
              publish({ status: 'ready', at: lastReadMs, successes, failures, ...wallets });
            }
            syncTimer();
          } catch {
            if (mine !== token) return;
            lastReadMs = Date.now();
            fail('failed');
          } finally {
            if (inflight === entry) inflight = null;
          }
        })();
        return entry.promise;
      };

      const refresh = (options) => {
        const forced = options !== undefined && options.force === true;
        if (inflight !== null) {
          // A read that outlives its timeout is abandoned rather than trusted:
          // otherwise one hung request freezes every later refresh.
          if (Date.now() - inflight.at < READ_TIMEOUT_MS) return inflight.promise;
          inflight = null;
          token += 1;
          fail('timeout');
        }
        return start(forced);
      };

      const stopTimer = () => {
        if (timer === null) return;
        clearInterval(timer);
        timer = null;
      };
      /**
       * Idle polling is adaptive and time-based: every quiet minute doubles the
       * period, up to IDLE_MAX_INTERVAL_MS. Any movement — ours or another
       * machine's — resets it, and so does watching the dialog, because that is
       * exactly when the number has to be current. Nothing here changes how often
       * a running turn is polled: that stays at the fast period throughout.
       */
      const periodFor = () => {
        if (running || watching) return RUNNING_INTERVAL_MS;
        const steps = Math.floor(Math.max(0, Date.now() - lastChangeMs) / QUIET_STEP_MS);
        return Math.min(IDLE_MAX_INTERVAL_MS, IDLE_INTERVAL_MS * 2 ** steps);
      };
      const startTimer = () => {
        if (timer !== null || retains === 0) return;
        period = periodFor();
        timer = setInterval(tick, period);
      };
      const syncTimer = () => {
        if (timer === null || periodFor() === period) return;
        stopTimer();
        startTimer();
      };
      const tick = () => {
        if (!visible()) return;
        void refresh({ force: true });
      };
      const onVisibility = () => {
        if (!visible()) return;
        lastChangeMs = Date.now();
        syncTimer();
        void refresh({ force: true });
      };
      /** Coming back to the window is as good a reason to read as opening it. */
      const onFocus = () => {
        lastChangeMs = Date.now();
        syncTimer();
        void refresh({ force: true });
      };

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        get: () => snapshot,
        refresh,
        /** Start the shared poll loop; the returned function releases it. */
        retain() {
          retains += 1;
          if (retains === 1) {
            if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
            if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
              window.addEventListener('focus', onFocus);
            }
            lastChangeMs = Date.now();
            void refresh({ force: true });
            startTimer();
          }
          return () => {
            retains = Math.max(0, retains - 1);
            if (retains > 0) return;
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
              window.removeEventListener('focus', onFocus);
            }
            stopTimer();
          };
        },
        /** A running session polls fast; an idle one backs off while nothing moves. */
        setRunning(value) {
          const next = value === true;
          if (next === running) return;
          running = next;
          lastChangeMs = Date.now();
          syncTimer();
        },
        /** While the dialog is open the number must stay current. */
        setWatching(value) {
          const next = value === true;
          if (next === watching) return;
          watching = next;
          lastChangeMs = Date.now();
          syncTimer();
        },
        /** The period the loop is actually using right now, in milliseconds. */
        period: () => period,
      };
    }

    function accountMetadata() {
      return {
        version: CLIENT_VERSION,
        locale: typeof navigator === 'undefined' ? 'en' : (navigator.language || 'en'),
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      };
    }

    /** Outline wallet on the 24-grid, stroked in currentColor like host icons. */
    function WalletIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        'aria-hidden': true,
        focusable: 'false',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      h('rect', { x: 2.75, y: 5.25, width: 18.5, height: 13.5, rx: 3.25 }),
      h('path', { d: 'M15.6 10.7h4v2.6h-4a1.3 1.3 0 0 1 0-2.6z' }),
      h('circle', { cx: 18.2, cy: 12, r: 0.85, fill: 'currentColor', stroke: 'none' }));
    }

    /** Subscribe a component to the shared tracker snapshot. */
    function useWallet(tracker) {
      const [snapshot, setSnapshot] = React.useState(tracker.get());
      React.useEffect(() => tracker.subscribe(() => setSnapshot(tracker.get())), [tracker]);
      return snapshot;
    }

    /** Place the panel above its trigger, clamped to the viewport. */
    function useAnchoredPanel(open, anchorRef, panelRef) {
      const [pos, setPos] = React.useState(null);
      React.useLayoutEffect(() => {
        if (!open) {
          setPos(null);
          return undefined;
        }
        const place = () => {
          const anchor = anchorRef.current;
          const panel = panelRef.current;
          if (anchor === null || panel === null) return;
          const a = anchor.getBoundingClientRect();
          const p = panel.getBoundingClientRect();
          const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - p.width - PANEL_MARGIN);
          const left = Math.min(Math.max(PANEL_MARGIN, a.left + a.width / 2 - p.width / 2), maxLeft);
          let top = a.top - p.height - PANEL_GAP;
          if (top < PANEL_MARGIN) {
            top = Math.min(a.bottom + PANEL_GAP, Math.max(PANEL_MARGIN, window.innerHeight - p.height - PANEL_MARGIN));
          }
          const next = { left: Math.round(left), top: Math.round(top) };
          setPos((current) => (current !== null && current.left === next.left && current.top === next.top
            ? current
            : next));
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        // The panel changes height while it is open: the copy grows, the picker
        // unfolds. A position computed for the old height pushes the lower rows
        // past the viewport edge, so re-place whenever the box changes size.
        let observer = null;
        if (typeof ResizeObserver === 'function' && panelRef.current !== null) {
          observer = new ResizeObserver(() => place());
          observer.observe(panelRef.current);
        }
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
          if (observer !== null) observer.disconnect();
        };
      }, [open, anchorRef, panelRef]);
      return pos;
    }

    /** Close on an outside pointer press and on Escape, like the host dialog. */
    function useDismiss(open, setOpen, rootRef, panelRef) {
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (rootRef.current !== null && rootRef.current.contains(target)) return;
          if (panelRef.current !== null && panelRef.current.contains(target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open, setOpen, rootRef, panelRef]);
    }

    function row(label, value, key) {
      return [h('dt', { key: key + '-t' }, label), h('dd', { key: key + '-d' }, value)];
    }

    /**
     * The click-opened panel, markup-compatible with the shipped stat dialog.
     *
     * Five rows on purpose: the wallet split, the session estimate, and what the
     * turn in progress has cost so far. Everything the plugin computes beyond
     * that — reconciliation, calibration, price-table revision — still runs, it
     * is just not shown here.
     */
    function WalletPanel({
      panelRef,
      pos,
      snapshot,
      estimate,
      correction,
      turnCosts,
      running,
      t,
      view,
      onToggleView,
      mark,
      onToggleMark,
      spend,
      onToggleSpend,
      turnShown,
      pickerOpen,
      onTogglePicker,
      holidayStale,
    }) {
      const symbol = snapshot.symbol;
      const factor = correction === null ? 1 : correction.factor;
      const current = turnCosts === null ? null : turnCosts.current;
      const estimateValue = estimate === null
        ? '—'
        : '≈' + formatCost(estimate.corrected, symbol)
          + (correction === null ? '' : t('estimate.corrected', { factor: correction.factor.toFixed(2) }));
      const turnValue = current === null || !(current.cost > 0)
        ? '—'
        : '≈' + formatCost(current.cost * factor, symbol) + (running ? t('turn.running') : '');
      const rows = [
        row(t('row.topUp'), formatMoney(snapshot.topUp, symbol), 'topup'),
        row(t('row.bonus'), formatMoney(snapshot.bonus, symbol), 'bonus'),
        row(t('row.total'), formatMoney(snapshot.total, symbol), 'total'),
        row(t('row.session'), estimateValue, 'estimate'),
        row(t('row.turn'), turnValue, 'turn'),
      ];
      return h('div', {
        ref: panelRef,
        className: 'dshcost_panel',
        role: 'dialog',
        'aria-label': t('panel.title'),
        style: pos ?? MEASURE_STYLE,
      },
      h('div', { className: 'dshcost_title' },
        h('span', { className: 'dshcost_titleLabel' }, h(WalletIcon), t('panel.title')),
        h('span', { className: 'dshcost_titleValue' }, formatMoney(snapshot.total, symbol))),
      h('div', { className: 'dshcost_titleRule', 'aria-hidden': true }),
      h('dl', { className: 'dshcost_details' }, rows),
      // The table only knows the years it lists, and the published notice for
      // the next one lands each autumn. Until then a holiday can be priced as a
      // peak weekday, so the row that reads the estimate says so.
      holidayStale && h('div', { className: 'dshcost_notice', role: 'status' },
        t('panel.holidayStale', { year: HOLIDAY_YEAR })),
      // The five rows above stay complete: the pill is the glance, this list is
      // the detail. The picker only chooses what the pill repeats.
      h('div', { className: 'dshcost_display' },
        h('button', {
          type: 'button',
          className: 'dshcost_disclosure',
          'aria-expanded': pickerOpen,
          onClick: () => onTogglePicker(),
        },
        h('svg', {
          className: 'dshcost_chevron',
          viewBox: '0 0 24 24',
          'aria-hidden': true,
          focusable: 'false',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'data-open': pickerOpen ? 'true' : 'false',
        }, h('path', { d: 'M9 5l7 7-7 7' })),
        t('panel.display')),
        pickerOpen && h('div', { className: 'dshcost_choices' },
          VIEW_ITEMS.map((id) => h('label', {
            key: id,
            className: 'dshcost_choice',
          },
          h('input', {
            type: 'checkbox',
            checked: view.includes(id),
            onChange: () => onToggleView(id),
          }),
          t(VIEW_LABELS[id]))),
          // Not a number, so it spans both columns. It only words the turn item
          // above, and the dialog's own row always says a turn is still running,
          // so the switch is simply not there while that item is off.
          turnShown && h('label', {
            key: 'running-mark',
            className: 'dshcost_choice dshcost_choiceWide',
          },
          h('input', {
            type: 'checkbox',
            checked: mark,
            onChange: () => onToggleMark(),
          }),
          t('panel.runningMark')),
          // Same rule: this one only dresses the turn item.
          turnShown && h('label', {
            key: 'spend-effect',
            className: 'dshcost_choice dshcost_choiceWide',
          },
          h('input', {
            type: 'checkbox',
            checked: spend,
            onChange: () => onToggleSpend(),
          }),
          t('panel.spendEffect')))));
    }

    /**
     * The pill and its dialog. Every hook runs before the early return, so the
     * hook order stays stable across renders.
     */
    function WalletPill({ useProjection, useSession, sessionId, wallets, payments, viewPrefs, t }) {
      // The slot hands over `t` once the entry declares its locale namespace; the
      // local dictionary keeps the component readable without that seat.
      const tr = typeof t === 'function' ? t : fallbackTranslate;
      // Same arrangement for the pill's chosen numbers.
      const prefs = viewPrefsFor(viewPrefs);
      const usage = useProjection('tokenUsage');
      const selection = useProjection('modelSelection');
      const running = useSession((snapshot) => snapshot !== undefined && snapshot.running === true) === true;
      const snapshot = useWallet(wallets);
      const [open, setOpen] = React.useState(false);
      const [fed, setFed] = React.useState(null);
      const [view, setView] = React.useState(prefs.get());
      const [mark, setMark] = React.useState(prefs.mark());
      const [spend, setSpend] = React.useState(prefs.spend());
      const [hit, setHit] = React.useState(0);
      const [pickerOpen, setPickerOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const pos = useAnchoredPanel(open, rootRef, panelRef);
      useDismiss(open, setOpen, rootRef, panelRef);

      const usageKey = usage === undefined || usage === null
        ? ''
        : [usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens].join(':');
      const ready = snapshot.status === 'ready';
      const route = selection === undefined || selection === null
        ? null
        : selection.lastUsed ?? selection.next ?? null;

      // Own the shared poll loop for as long as this pill is mounted.
      React.useEffect(() => wallets.retain(), [wallets]);
      React.useEffect(() => { wallets.setRunning(running); }, [wallets, running]);
      // A settled turn changes the projection; that is the moment money moved.
      React.useEffect(() => { wallets.refresh(); }, [wallets, usageKey]);
      // Opening the dialog asks for fresh numbers, and holds the fast poll while
      // it is open: the number has to be current exactly when someone is reading it.
      React.useEffect(() => {
        wallets.setWatching(open);
        if (open) wallets.refresh({ force: true });
      }, [open, wallets]);
      // A rising running edge opens a new turn bucket — and only a rising edge.
      // This effect also re-runs when the wallet becomes readable mid-turn (a
      // page load during a turn starts with `ready === false`), so keying the
      // call on `running && ready` reopened the bucket on that transition and
      // split the running turn — exactly the split the mount guard prevents.
      // `open` tracks the running *episode* instead of the current render.
      const sawMount = React.useRef(false);
      const turnOpen = React.useRef(false);
      React.useEffect(() => {
        if (!sawMount.current) {
          sawMount.current = true;
          // A turn already running at mount is adopted from the restored ledger,
          // not opened.
          turnOpen.current = running;
          return;
        }
        if (!running) {
          turnOpen.current = false;
          return;
        }
        if (!ready || turnOpen.current) return;
        turnOpen.current = true;
        payments.beginTurn(sessionId, Date.now());
      }, [payments, sessionId, running, ready]);
      // Price each observed delta and remember the wallet this session started from.
      React.useEffect(() => {
        if (!ready || usage === undefined || usage === null) return;
        setFed({
          id: sessionId,
          entry: payments.observe(sessionId, bucketsOf(usage), route, snapshot.total, Date.now()),
        });
      }, [payments, sessionId, usageKey, ready, ready ? snapshot.total : null]);

      // The hit cue fires on a rise, never on the first paint, and never closer
      // than SPEND_HIT_INTERVAL_MS: one turn produces dozens of deltas, and a cue
      // per delta would leave the composer row twitching for the whole turn.
      const lastTurnCost = React.useRef(null);
      const lastHitAt = React.useRef(0);
      const turnCostRaw = ready && fed !== null && fed.id === sessionId
        ? (fed.entry?.current?.cost ?? 0)
        : 0;
      React.useEffect(() => {
        const previous = lastTurnCost.current;
        lastTurnCost.current = turnCostRaw;
        if (spend !== true || !view.includes('turn')) return;
        if (previous === null || turnCostRaw - previous < SPEND_HIT_MIN_DELTA) return;
        if (Date.now() - lastHitAt.current < SPEND_HIT_INTERVAL_MS) return;
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        lastHitAt.current = Date.now();
        setHit((count) => count + 1);
      }, [turnCostRaw, spend, view]);

      if (!ready) return null;

      const entry = fed !== null && fed.id === sessionId ? fed.entry : payments.get(sessionId);
      const balanceText = formatMoney(snapshot.total, snapshot.symbol);

      // Per-model totals, each corrected by its own learned factor.
      const shares = [];
      let officialTotal = 0;
      let correctedTotal = 0;
      let observedTotal = 0;
      for (const [name, bucket] of Object.entries((entry ?? {}).models ?? {})) {
        const official = (bucket.base ?? 0) + (bucket.cost ?? 0);
        const verdict = payments.calibration(name === 'unknown' ? null : name);
        const corrected = official * (verdict !== null && verdict.applied ? verdict.factor : 1);
        shares.push({ name, official, corrected, verdict });
        officialTotal += official;
        correctedTotal += corrected;
        observedTotal += bucket.cost ?? 0;
      }
      const estimate = shares.length === 0
        ? null
        : { shares, official: officialTotal, corrected: correctedTotal, observed: observedTotal };
      // One row carries the correction, so it speaks for the largest share.
      const dominant = shares.length === 0
        ? null
        : shares.reduce((best, share) => (share.official > best.official ? share : best));
      const calibration = dominant === null ? null : dominant.verdict;
      const correction = calibration !== null && calibration.applied ? calibration : null;
      // The pill states its numbers plainly. The ≈ and the measured factor belong
      // to the dialog, which is where the estimate's provenance is spelled out.
      const estimateText = estimate === null ? null : formatCost(estimate.corrected, snapshot.symbol);
      const turnCosts = entry === undefined || entry === null ? null : { current: entry.current ?? null };

      // One pill item per chosen number. `null` means there is nothing to show
      // yet — an unpriced route, or a turn that has not spent anything — and the
      // item is left out rather than printed as a placeholder.
      const viewOf = (id) => {
        switch (id) {
          case 'balance': return { text: balanceText, label: 'row.total' };
          case 'topUp': return { text: formatMoney(snapshot.topUp, snapshot.symbol), label: 'row.topUp' };
          case 'bonus': return { text: formatMoney(snapshot.bonus, snapshot.symbol), label: 'row.bonus' };
          case 'session': return estimateText === null ? null : { text: estimateText, label: 'row.session' };
          case 'turn': {
            const factor = correction === null ? 1 : correction.factor;
            const cost = turnCosts === null || turnCosts.current === null
              ? 0
              : turnCosts.current.cost * factor;
            return cost > 0
              ? {
                text: (spend ? '-' : '') + formatCost(cost, snapshot.symbol)
                  + (running && mark ? tr('turn.running') : ''),
                label: 'row.turn',
                tone: spend ? 'dshcost_spend' : null,
              }
              : null;
          }
          default: return null;
        }
      };
      const shown = view.map((id) => ({ id, item: viewOf(id) })).filter((each) => each.item !== null);

      const ariaParts = shown.map(({ item }) => tr(item.label) + ' ' + item.text);
      if (correction !== null) ariaParts.push(tr('estimate.corrected', { factor: correction.factor.toFixed(2) }));
      const label = tr('pill.aria', { list: ariaParts.join(tr('pill.aria.join')) });

      // The pill stays quiet about it and keeps the caveat in its tooltip; the
      // dialog is where the reader is already looking at provenance.
      const holidayStale = holidayTableStale(Date.now());
      const staleNotice = holidayStale ? tr('panel.holidayStale', { year: HOLIDAY_YEAR }) : null;

      const panel = open
        ? WalletPanel({
          panelRef,
          pos,
          snapshot,
          estimate,
          correction,
          turnCosts,
          running,
          t: tr,
          view,
          onToggleView: (id) => setView(prefs.toggle(id)),
          mark,
          onToggleMark: () => setMark(prefs.toggleMark()),
          spend,
          onToggleSpend: () => setSpend(prefs.toggleSpend()),
          turnShown: view.includes('turn'),
          pickerOpen,
          onTogglePicker: () => setPickerOpen((was) => !was),
          holidayStale,
        })
        : null;

      const labelNodes = [];
      for (const { id, item } of shown) {
        if (labelNodes.length > 0) {
          labelNodes.push(h('span', {
            key: 'sep-' + id,
            className: 'dshcost_sep',
            'aria-hidden': true,
          }, '·'));
        }
        if (item.tone === null || item.tone === undefined) {
          labelNodes.push(item.text);
          continue;
        }
        // Re-keying on every cue remounts the node, which is what replays the
        // CSS animation; a class alone would only play it once.
        const struck = id === 'turn' && hit > 0;
        labelNodes.push(h('span', {
          key: 'v-' + id + (struck ? '-' + hit : ''),
          className: item.tone + (struck ? ' dshcost_hit' : ''),
        }, item.text));
      }

      return h(React.Fragment, null,
        h('style', { key: 'cost-meter-css' }, CSS),
        h('div', {
          key: 'cost-meter',
          className: 'dshcost_root',
          'data-composer-stats': true,
          'data-cost-meter': true,
          ref: rootRef,
        }, h('button', {
          type: 'button',
          className: 'dshcost_pill',
          'aria-label': label,
          title: staleNotice ?? undefined,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
        h(WalletIcon, { key: 'icon' }),
        h('span', { className: 'dshcost_label' }, labelNodes),
        hit > 0 && spend && h('span', {
          key: 'hit-flash-' + hit,
          className: 'dshcost_hitFlash',
          'aria-hidden': true,
        }))),
        panel !== null && createPortal !== null && typeof document !== 'undefined'
          ? createPortal(panel, document.body)
          : panel);
    }

    return {
      inject: ['slots', 'remote', 'remote.account', 'locale'],
      apply(ctx) {
        const tracker = createWalletTracker(async () => {
          const result = await ctx.remote.account.getBalance(accountMetadata());
          if (result === undefined || result.ok !== true) throw new Error('account balance failed');
          return result.value;
        });
        const storage = createStorage();
        const ledger = createLedger(storage);
        const viewPrefs = createViewPreferences(storage);
        // The pill and the panel read their copy from this namespace. The slot
        // entry below declares it, and that declaration is what hands the
        // component its `t` seat.
        if (ctx.locale !== undefined) {
          ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'cost-meter: dictionaries');
        }

        // Genuine push: `account.watch` is a Remote stream, so it rides the
        // browser's WebSocket to the Host (`/api/remote.mux`) and delivers
        // sign-in, sign-out and credential-expiry frames as they happen. The
        // wallet value itself has no push source — the Platform only answers
        // `GET /api/v0/users/get_user_summary` — so a frame means "read now".
        try {
          const stream = ctx.remote.$stream({
            name: 'account',
            open: (signal) => ctx.remote.account.watch(signal),
            // A generation that ends is terminal here: the poll loop below keeps
            // the wallet fresh either way, so `accepted` only sharpens the message.
            ended: (accepted) => new Error(accepted
              ? 'account stream ended'
              : 'account stream closed before its opening value'),
          });
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => () => { void stream.dispose(); }, 'cost-meter: account stream');
          }
          void (async () => {
            try {
              for await (const item of stream) {
                // `$stream` hands every item a per-generation `accept()`, and that
                // call is what resets the wrapper's reconnect budget: without it
                // the second carrier loss ends the stream for the rest of the
                // page's life, leaving polling as the only source of updates.
                item?.accept?.();
                if (item !== undefined) void tracker.refresh({ force: true });
              }
            } catch {
              // The stream ended; the poll loop still covers later refreshes.
            }
          })();
        } catch {
          // No account stream in this composition; polling still applies.
        }

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'cost-meter',
          order: 10,
          locale: NS,
          inject: () => ({ wallets: tracker, payments: ledger, viewPrefs }),
        }, WalletPill));
      },
    };
  },
});
