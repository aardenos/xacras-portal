
class StatusSensorAspect {

  constructor(opts = {}) {
    this.cfg = Object.assign({
      stallMs : 9000,
      tickMs  : 80,
    }, this._defaults(), opts);

    this.jobs   = {};  // key → { value, failed, lastValue, lastChange, sockets[] }
    this.keys   = [];
    this.ticker = null;
    this.active = false;
    this.dead   = false;
    this.outcome = null;  // 'pass' | 'mix' | 'fail' | null
    this.tStart  = null;
  }

  // ── subclass hook: return environment-specific config defaults ─────────────
  _defaults() { return {}; }

  // ── public api ─────────────────────────────────────────────────────────────

  invoke() {
    if (this.active) return this;
    this.active  = true;
    this.dead    = false;
    this.outcome = null;
    this.tStart  = Date.now();
    this._onstart();
    this._starttick();
    return this;
  }

  notify(key, value) {
    if (this.dead) return this;
    if (typeof key !== 'string' || !key.length) return this;
    const v = this._clamp(value);
    this.active || this.invoke();
    if (!this.jobs[key]) {
      this.jobs[key] = {
        value      : v,
        failed     : false,
        lastValue  : v,
        lastChange : Date.now(),
        sockets    : [],   // [{ socket, handlers: { init, step, done, fail } }]
      };
      this.keys.push(key);
    } else {
      const job = this.jobs[key];
      if (v !== job.value) { job.lastValue = job.value; job.lastChange = Date.now(); }
      job.value = v;
    }
    return this;
  }

  finish() {
    if (!this.active && !this.keys.length) return this;
    this.dead = true;
    this._stoptick();
    this.vacuum();
    this._conclude(true);
    return this;
  }

  remove() {
    this.dead = true;
    this._stoptick();
    this._onremove();
    this.vacuum();
    this._teardown();
    return this;
  }

  adjust(opts = {}) {
    Object.keys(opts).forEach(k => k in this.cfg && (this.cfg[k] = opts[k]));
    this._onadjust(opts);
    return this;
  }

  status(key) {
    if (!this.keys.length) return 0;
    if (!key || key === '*') return this._avg();
    return this.jobs[key]?.value ?? 0;
  }

  vacuum() {
    this.keys.forEach(key => this._detach(key));
    this.jobs = {}; this.keys = [];
    return this;
  }

  unhook(key) {
    if (!this.jobs[key]) return this;
    this._detach(key);
    delete this.jobs[key];
    this.keys = this.keys.filter(k => k !== key);
    return this;
  }

  /**
   * couple(key, socket)
   *
   * Binds a pre-shaped socket to a job. The socket must implement:
   *   .on(event, fn)
   *   .off(event, fn)
   * and optionally expose .value and .failed for already-settled detection.
   *
   * This is the driver primitive. Subclasses call this from attend() after
   * wrapping native objects into socket adapters.
   *
   * Custom usage:
   *   busy.couple('my-job', myCustomSocket);
   */
  couple(key, socket) {
    if (this.dead) return this;
    this.notify(key, 0);
    this._detach(key);

    const job = this.jobs[key];
    if (!job) return this;

    // already-settled check — socket may expose current state directly
    if (typeof socket.value === 'number' && socket.value >= 1) {
      job.value      = 1;
      job.failed     = socket.failed === true;
      job.lastChange = Date.now();
      return this;
    }
    if (socket.failed === true) {
      job.value      = 1;
      job.failed     = true;
      job.lastChange = Date.now();
      return this;
    }

    // wire the four driver events
    const handlers = {
      init : ()    => { const j = this.jobs[key]; if (j && j.value === 0) { j.value = 0.01; j.lastChange = Date.now(); } },
      step : (val) => { const j = this.jobs[key]; if (j) { j.value = this._clamp(val ?? j.value); j.lastChange = Date.now(); } },
      done : ()    => { const j = this.jobs[key]; if (j) { j.value = 1; j.lastChange = Date.now(); } },
      fail : ()    => { const j = this.jobs[key]; if (j) { j.failed = true; j.value = 1; j.lastChange = Date.now(); } },
    };

    try { socket.on('init', handlers.init); } catch (e) {}
    try { socket.on('step', handlers.step); } catch (e) {}
    try { socket.on('done', handlers.done); } catch (e) {}
    try { socket.on('fail', handlers.fail); } catch (e) {}

    job.sockets.push({ socket, handlers });
    return this;
  }

  /**
   * patrol(...args)
   * Environment-specific polling. Subclass must override.
   * Browser: watches DOM for selector matches.
   * Server:  watches filesystem for file presence.
   */
  patrol(...args) { return this; }

  // ── tick — the ONLY place operational logic lives ──────────────────────────

  _starttick() {
    this.ticker = setInterval(() => this._tick(), this.cfg.tickMs);
  }

  _stoptick() {
    this.ticker && (clearInterval(this.ticker), this.ticker = null);
  }

  _tick() {
    if (this.dead) return;

    const now     = Date.now();
    let   allDone = true;
    let   anyFail = false;

    this.keys.forEach(key => {
      const job = this.jobs[key];
      if (!job) return;

      // stall detection: no progress for stallMs → mark failed
      if (job.value < 1 && (now - job.lastChange) >= this.cfg.stallMs) {
        job.value  = 1;
        job.failed = true;
      }

      if (job.value < 1) allDone = false;
      if (job.failed)    anyFail = true;
    });

    // delegate render to subclass
    this._ontick(this._avg(), allDone, anyFail, now);

    // all jobs done — determine outcome and conclude
    if (allDone && this.keys.length > 0) {
      const allFail = this.keys.every(k => this.jobs[k]?.failed);
      this.outcome  = allFail ? 'fail' : anyFail ? 'mix' : 'pass';
      this._conclude(true);
    }
  }

  _conclude(show) {
    this._stoptick();
    this.dead = true;
    this._onconclude(show, this.outcome);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  _avg() {
    if (!this.keys.length) return 0;
    return this.keys.reduce((s, k) => s + (this.jobs[k]?.value ?? 0), 0) / this.keys.length;
  }

  _clamp(v) {
    return Math.min(1, Math.max(0, isNaN(+v) ? 0 : +v));
  }

  _detach(key) {
    const job = this.jobs[key];
    if (!job) return;
    job.sockets.forEach(({ socket, handlers }) => {
      try { socket.off('init', handlers.init); } catch (e) {}
      try { socket.off('step', handlers.step); } catch (e) {}
      try { socket.off('done', handlers.done); } catch (e) {}
      try { socket.off('fail', handlers.fail); } catch (e) {}
    });
    job.sockets = [];
  }

  // ── subclass lifecycle hooks (no-ops in base) ──────────────────────────────

  _onstart()                    {}
  _onremove()                   {}
  _onadjust(opts)               {}
  _ontick(avg, allDone, anyFail, now) {}
  _onconclude(show, outcome)    {}
  _teardown() { this.active = false; }

}


/**
 * @aarden/status-sensor — sensor.client.mjs
 * Browser client. Extends StatusSensorAspect.
 *
 * Themes: 'gear' (default) | 'slab'
 * Stat grid: opt-in via cfg.text = { show: true, layout: 'vertical' | 'horizontal' }
 *
 * attend(target, opts?) wraps browser objects into socket adapters:
 *   HTMLImageElement   → ImageSocket
 *   HTMLIFrameElement  → FrameSocket
 *   HTMLVideoElement   → MediaSocket
 *   HTMLAudioElement   → MediaSocket
 *   XMLHttpRequest     → XhrSocket
 *   Promise            → PromiseSocket
 *
 * Custom event maps:
 *   busy.attend(img, {
 *     events: { done: 'load', fail: 'error' }
 *   })
 *
 * Normaliser for step payloads:
 *   busy.attend(xhr, {
 *     events: { step: 'progress' },
 *     normalise: (e) => e.loaded / e.total
 *   })
 */

// driver inlined above

// ── Colours ───────────────────────────────────────────────────────────────────

const COL_PASS = '#2ec880';
const COL_MIX  = '#c87820';
const COL_FAIL = '#9b0e2e';

// ── SVG helpers ───────────────────────────────────────────────────────────────

const NS = 'http://www.w3.org/2000/svg';

function mksvg(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

// ── Stat grid ─────────────────────────────────────────────────────────────────

class StatGrid {
  /**
   * layout: 'vertical'   → top cell = active stream, bottom cell = done stream
   * layout: 'horizontal' → left cell = active stream, right cell = done stream
   */
  constructor(opts = {}) {
    this.layout   = opts.layout || 'vertical';
    this._maxLines = 6;
    this._lines = { active: [], done: [] };

    // Build the four cell divs
    this.cells = {};
    ['top', 'btm', 'lft', 'rgt'].forEach(name => {
      const d = document.createElement('div');
      Object.assign(d.style, {
        position   : 'absolute',
        overflow   : 'hidden',
        fontFamily : 'monospace',
        fontSize   : '0.55rem',
        lineHeight : '1.4',
        color      : '#a0a4ab',
        maxWidth   : '14rem',
        maxHeight  : '4.5rem',
        pointerEvents: 'none',
        whiteSpace : 'nowrap',
      });
      d.dataset.cell = name;
      this.cells[name] = d;
    });

    this.el = document.createElement('div');
    Object.assign(this.el.style, {
      position       : 'absolute',
      display        : 'flex',
      flexDirection  : this.layout === 'vertical' ? 'column' : 'row',
      alignItems     : 'center',
      gap            : '0.4rem',
      pointerEvents  : 'none',
    });

    if (this.layout === 'vertical') {
      this.el.appendChild(this.cells.top);
      this.el.appendChild(this.cells.btm);
      // lft/rgt unused in vertical
    } else {
      this.el.appendChild(this.cells.lft);
      this.el.appendChild(this.cells.rgt);
      // top/btm unused in horizontal
    }
  }

  push(key, value, failed) {
    const pct  = Math.round(value * 100);
    const tag  = failed ? 'FAIL' : value >= 1 ? 'DONE' : pct + '%';
    const line = key.slice(0, 14).padEnd(14) + ' ' + tag;
    const ls   = this._lines;

    if (value >= 1) {
      ls.done.unshift(line);
      if (ls.done.length > this._maxLines) ls.done.pop();
      ls.active = ls.active.filter(l => !l.startsWith(key.slice(0, 14)));
    } else {
      const idx = ls.active.findIndex(l => l.startsWith(key.slice(0, 14)));
      if (idx >= 0) ls.active[idx] = line;
      else { ls.active.unshift(line); if (ls.active.length > this._maxLines) ls.active.pop(); }
    }

    this._render();
  }

  _render() {
    const activeHTML = this._lines.active.map(l => `<div>${l}</div>`).join('');
    const doneHTML   = this._lines.done.map(l => `<div>${l}</div>`).join('');
    if (this.layout === 'vertical') {
      this.cells.top.innerHTML = activeHTML;
      this.cells.btm.innerHTML = doneHTML;
    } else {
      this.cells.lft.innerHTML = activeHTML;
      this.cells.rgt.innerHTML = doneHTML;
    }
  }

  tint(colour) {
    Object.values(this.cells).forEach(c => { c.style.color = colour; });
  }

  appendTo(pane) {
    pane.appendChild(this.el);
  }

  remove() {
    this.el.parentNode?.removeChild(this.el);
  }
}

// ── Socket adapters ───────────────────────────────────────────────────────────

/**
 * BaseSocket — wraps a DOM element into the driver socket contract.
 * All adapters extend this. Subclasses call this._emit(driverEvent, val).
 */
class BaseSocket {
  constructor() {
    this._handlers  = {};  // driverEvent → [fn, ...]
    this._listeners = [];  // [{ target, nativeEvent, fn }] for cleanup
    this.value      = undefined;
    this.failed     = undefined;
  }

  on(event, fn) {
    (this._handlers[event] ??= []).push(fn);
  }

  off(event, fn) {
    this._handlers[event] = (this._handlers[event] ?? []).filter(h => h !== fn);
    // clean up native listeners that are no longer needed
    this._listeners = this._listeners.filter(({ target, nativeEvent, fn: lFn, driverEvent }) => {
      if (driverEvent === event && this._handlers[event]?.length === 0) {
        try { target.removeEventListener(nativeEvent, lFn); } catch (e) {}
        return false;
      }
      return true;
    });
  }

  _emit(driverEvent, val) {
    (this._handlers[driverEvent] ?? []).forEach(fn => fn(val));
  }

  /**
   * Wire a native DOM event to a driver event.
   * opts.once: remove after first fire
   */
  _wire(target, nativeEvent, driverEvent, transform, opts = {}) {
    const fn = (e) => {
      const val = transform ? transform(e) : undefined;
      this._emit(driverEvent, val);
    };
    const options = opts.once ? { once: true } : false;
    target.addEventListener(nativeEvent, fn, options);
    this._listeners.push({ target, nativeEvent, fn, driverEvent });
  }

  /** Remove all wired native listeners */
  _cleanup() {
    this._listeners.forEach(({ target, nativeEvent, fn }) => {
      try { target.removeEventListener(nativeEvent, fn); } catch (e) {}
    });
    this._listeners = [];
  }
}

/** ImageSocket — wraps HTMLImageElement */
class ImageSocket extends BaseSocket {
  constructor(img, events = {}, normalise = null) {
    super();
    const map = Object.assign({ done: 'load', fail: 'error' }, events);

    // already settled
    if (img.complete) {
      this.value  = 1;
      this.failed = img.naturalWidth === 0 && img.naturalHeight === 0;
      return;
    }

    if (map.init) this._wire(img, map.init, 'init');
    if (map.step) this._wire(img, map.step, 'step', normalise ?? null);
    if (map.done) this._wire(img, map.done, 'done', null, { once: true });
    if (map.fail) this._wire(img, map.fail, 'fail', null, { once: true });
  }
}

/** FrameSocket — wraps HTMLIFrameElement */
class FrameSocket extends BaseSocket {
  constructor(frame, events = {}) {
    super();
    const map = Object.assign({ done: 'load', fail: 'error' }, events);

    const settled = () => {
      try { return !!frame.contentDocument?.body; } catch (e) { return false; }
    };

    if (settled()) {
      this.value = 1;
      return;
    }

    if (map.done) {
      this._wire(frame, map.done, 'done', () => {
        if (!settled()) { this._emit('fail'); } // cross-origin or bad domain
      }, { once: true });
    }
    if (map.fail) this._wire(frame, map.fail, 'fail', null, { once: true });
  }
}

/** MediaSocket — wraps HTMLVideoElement / HTMLAudioElement */
class MediaSocket extends BaseSocket {
  constructor(media, events = {}, normalise = null) {
    super();
    const map = Object.assign({
      init : 'loadstart',
      step : 'canplay',
      done : 'canplaythrough',
      fail : 'error',
    }, events);

    // already settled
    if (media.readyState >= 4) { this.value = 1; return; }
    if (media.error)           { this.value = 1; this.failed = true; return; }

    const progressMap = [
      [map.init, 'init',  () => 0.05],
      ['loadedmetadata',  'step', () => 0.3],
      [map.step, 'step',  () => 0.9],
      [map.done, 'done',  null],
      [map.fail, 'fail',  null],
    ];

    progressMap.forEach(([nativeEv, driverEv, transform]) => {
      if (nativeEv) this._wire(media, nativeEv, driverEv, transform, {});
    });
  }
}

/** XhrSocket — wraps XMLHttpRequest */
class XhrSocket extends BaseSocket {
  constructor(xhr, events = {}, normalise = null) {
    super();
    const map = Object.assign({
      init : 'loadstart',
      step : 'progress',
      done : 'load',
      fail : 'error',
    }, events);

    // already settled
    if (xhr.readyState === 4) {
      this.value  = 1;
      this.failed = xhr.status === 0 || xhr.status >= 400;
      return;
    }

    if (map.init) this._wire(xhr, map.init, 'init');
    if (map.step) this._wire(xhr, map.step, 'step',
      normalise ?? ((e) => e.lengthComputable ? e.loaded / e.total : undefined));
    if (map.done) this._wire(xhr, map.done, 'done', null, { once: true });
    if (map.fail) this._wire(xhr, map.fail, 'fail', null, { once: true });
    // abort also counts as fail
    this._wire(xhr, 'abort', 'fail', null, { once: true });
  }
}

/** PromiseSocket — wraps a Promise */
class PromiseSocket extends BaseSocket {
  constructor(promise) {
    super();
    this.value  = undefined;
    this.failed = undefined;
    // bump off zero immediately so stall timer starts from now
    setTimeout(() => this._emit('init'), 0);
    promise.then(
      ()  => { this.value = 1; this._emit('done'); },
      ()  => { this.value = 1; this.failed = true; this._emit('fail'); }
    );
  }
}

// ── Theme: Gear ───────────────────────────────────────────────────────────────

class GearTheme {
  constructor(cfg) {
    this.cfg  = cfg;
    this.segs = [];
    this.anim = null;
    this.el   = null;
  }

  build(colour) {
    const c  = colour;
    const sz = this.cfg.size;

    const svg = mksvg('svg', { viewBox: '0 0 100 100' });
    Object.assign(svg.style, { width: sz, height: sz, overflow: 'visible' });

    // outer ring — clockwise rotation
    const ring = mksvg('path', {
      fill: 'none', stroke: c, 'stroke-width': '0.8', 'stroke-opacity': '0.9',
      d: 'm 56.688,95.108 2.381,-8.894 5.198,-1.764 4.922,-2.428 7.971,4.607 5.082,-4.384 4.383,-5.081 -4.607,-7.973 2.427,-4.921 1.765,-5.198 8.894,-2.382 0.496,-6.689 -0.496,-6.69 -8.894,-2.381 -1.765,-5.199 -2.427,-4.923 4.607,-7.972 -4.383,-5.08 -5.082,-4.382 -7.971,4.607 -4.922,-2.428 -5.198,-1.765 -2.377,-8.8946 -6.693,-0.4935 -6.69,0.4935 -2.381,8.8946 -5.198,1.764 -4.923,2.428 -7.971,-4.606 -5.08,4.382 -4.382,5.08 4.606,7.972 -2.427,4.923 -1.765,5.199 -8.8944,2.381 -0.4936,6.69 0.4936,6.689 8.8944,2.382 1.765,5.198 2.427,4.921 -4.607,7.973 4.383,5.081 5.08,4.384 7.971,-4.607 4.923,2.428 5.198,1.764 2.381,8.894 6.69,0.492 z',
    });
    ring.appendChild(mksvg('animateTransform', {
      attributeName: 'transform', attributeType: 'XML', type: 'rotate',
      from: '0 50 50', to: '360 50 50', dur: '4s', repeatCount: 'indefinite',
    }));
    svg.appendChild(ring);

    // concentric circles
    svg.appendChild(mksvg('path', {
      fill: 'none', stroke: c, 'stroke-width': '0.8', 'stroke-opacity': '0.9',
      d: 'm 66.13,49.976 c 0,8.895 -7.211,16.105 -16.106,16.105 -8.894,0 -16.105,-7.21 -16.105,-16.105 0,-8.895 7.211,-16.106 16.105,-16.106 8.895,0 16.106,7.211 16.106,16.106 z m 11.519,0 c 0,15.257 -12.368,27.625 -27.625,27.625 -15.257,0 -27.624,-12.368 -27.624,-27.625 0,-15.258 12.367,-27.627 27.624,-27.627 15.257,0 27.625,12.369 27.625,27.627 z',
    }));

    // 10 segments — counter-clockwise spin while idle
    const grp = mksvg('g', {});
    const segPaths = [
      'm 46.275,26.382 2.999,3.799 c 3.117,-0.139 5.996,0.696 8.879,1.758 l -0.995,-4.744 c -3.575,-1.178 -7.19,-1.104 -10.883,-0.813 z',
      'm 60.805,28.694 0.213,4.844 c 2.603,1.727 4.442,4.103 6.154,6.665 l 1.959,-4.425 c -2.2,-3.066 -5.171,-5.142 -8.326,-7.084 z',
      'm 71.208,39.144 -2.671,4.04 c 1.096,2.931 1.196,5.941 1.079,9.026 L 73.8,49.79 c 0,-3.778 -1.178,-7.21 -2.592,-10.646 z',
      'm 73.511,53.741 -4.524,1.691 c -0.832,3.021 -2.512,5.511 -4.408,7.938 l 4.797,0.516 c 2.221,-3.053 3.268,-6.531 4.135,-10.145 z',
      'm 66.829,66.906 -4.647,-1.3 c -2.438,1.954 -5.257,2.977 -8.21,3.82 l 3.579,3.248 c 3.583,-1.155 6.466,-3.352 9.278,-5.768 z',
      'm 53.724,73.619 -2.999,-3.802 c -3.117,0.141 -5.996,-0.693 -8.879,-1.756 l 0.998,4.744 c 3.572,1.176 7.191,1.106 10.88,0.814 z',
      'm 39.194,71.305 -0.213,-4.843 c -2.592,-1.727 -4.434,-4.105 -6.144,-6.666 l -1.969,4.428 c 2.201,3.062 5.171,5.137 8.326,7.081 z',
      'm 28.792,60.854 2.67,-4.036 c -1.095,-2.934 -1.194,-5.945 -1.079,-9.029 l -4.183,2.42 c 0,3.777 1.176,7.21 2.592,10.645 z',
      'm 26.491,46.258 4.523,-1.688 c 0.83,-3.024 2.512,-5.515 4.409,-7.942 l -4.8,-0.516 c -2.22,3.053 -3.268,6.532 -4.132,10.146 z',
      'm 33.17,33.092 4.648,1.302 c 2.44,-1.953 5.256,-2.977 8.213,-3.82 l -3.583,-3.25 c -3.579,1.157 -6.466,3.353 -9.278,5.768 z',
    ];

    this.segs = segPaths.map(d => {
      const p = mksvg('path', {
        fill: c, 'fill-opacity': '0.15',
        stroke: c, 'stroke-width': '0.8', 'stroke-opacity': '0.9', d,
      });
      grp.appendChild(p);
      return p;
    });

    this.anim = mksvg('animateTransform', {
      attributeName: 'transform', attributeType: 'XML', type: 'rotate',
      from: '360 50 50', to: '0 50 50', dur: '4s', repeatCount: 'indefinite',
    });
    grp.appendChild(this.anim);
    svg.appendChild(grp);

    this.el = svg;
    return svg;
  }

  draw(avg) {
    const lit = Math.round(avg * 10);
    this.segs.forEach((s, i) => {
      s.setAttribute('fill-opacity', i < lit ? '0.9' : '0.15');
    });
  }

  stopspin() {
    this.anim?.parentNode?.removeChild(this.anim);
    this.anim = null;
  }

  resumespin() {
    if (this.anim || !this.el) return;
    const grp = this.el.querySelector('g');
    if (!grp) return;
    this.anim = mksvg('animateTransform', {
      attributeName: 'transform', attributeType: 'XML', type: 'rotate',
      from: '360 50 50', to: '0 50 50', dur: '4s', repeatCount: 'indefinite',
    });
    grp.appendChild(this.anim);
  }

  tint(colour) {
    this.el?.querySelectorAll('path').forEach(p => {
      if (p.getAttribute('fill')   !== 'none') p.setAttribute('fill',   colour);
      if (p.getAttribute('stroke') !== 'none') p.setAttribute('stroke', colour);
    });
  }

  destroy() {
    this.segs = []; this.anim = null; this.el = null;
  }
}

// ── Theme: Slab ───────────────────────────────────────────────────────────────

class SlabTheme {
  constructor(cfg) {
    this.cfg  = cfg;
    this.el   = null;
    this._rects = [];
    this._BAR_COUNT = 10;
  }

  build(colour) {
    const svg = mksvg('svg', { viewBox: '0 0 120 18' });
    Object.assign(svg.style, { width: '10rem', height: '1.5rem', overflow: 'visible' });

    // background track
    svg.appendChild(mksvg('rect', {
      x: '1', y: '1', width: '118', height: '16', rx: '4',
      fill: 'none', stroke: colour, 'stroke-width': '0.8', 'stroke-opacity': '0.5',
    }));

    // 10 fill bars
    const barW = 10, gap = 1.8, startX = 3;
    this._rects = [];
    for (let i = 0; i < this._BAR_COUNT; i++) {
      const x = startX + i * (barW + gap);
      const r = mksvg('rect', {
        x: String(x), y: '3', width: String(barW), height: '12', rx: '2',
        fill: colour, 'fill-opacity': '0.15',
      });
      svg.appendChild(r);
      this._rects.push(r);
    }

    this.el = svg;
    return svg;
  }

  draw(avg) {
    const lit = Math.round(avg * this._BAR_COUNT);
    this._rects.forEach((r, i) => {
      r.setAttribute('fill-opacity', i < lit ? '0.9' : '0.15');
    });
  }

  // slab pulses instead of spinning — nothing to stop/resume
  stopspin()  {}
  resumespin(){}

  tint(colour) {
    this.el?.querySelectorAll('rect, path').forEach(el => {
      if (el.getAttribute('fill')   !== 'none') el.setAttribute('fill',   colour);
      if (el.getAttribute('stroke') !== 'none') el.setAttribute('stroke', colour);
    });
  }

  destroy() {
    this._rects = []; this.el = null;
  }
}

// ── StatusSensorClient ────────────────────────────────────────────────────────

class StatusSensorClient extends StatusSensorAspect {

  static COL_PASS = COL_PASS;
  static COL_MIX  = COL_MIX;
  static COL_FAIL = COL_FAIL;

  _defaults() {
    return {
      target  : typeof document !== 'undefined' ? document.body : null,
      theme   : 'gear',           // 'gear' | 'slab'
      size    : '5rem',
      tintbg  : 'rgba(20,20,22,0.82)',
      tintfg  : '#a0a4ab',
      fadeIn  : 900,
      fadeOut : 200,
      stallMs : 9000,
      tickMs  : 80,
      text    : null,             // null = no stat grid; { show: true, layout: 'vertical' } to enable
    };
  }

  constructor(opts = {}) {
    super(opts);
    this.pane     = null;
    this.tFadeIn  = null;
    this.raf      = null;
    this.tKill    = null;
    this._theme   = null;
    this._grid    = null;
    this._spinning = true;
  }

  // ── attend — wraps browser objects into socket adapters ───────────────────

  attend(target, opts = {}) {
    if (!target) return this;
    const key    = this._keyfor(target);
    const events = opts.events    ?? {};
    const norm   = opts.normalise ?? null;
    let socket;

    const name = target?.constructor?.name ?? '';
    if      (name === 'HTMLImageElement')   socket = new ImageSocket(target, events, norm);
    else if (name === 'HTMLIFrameElement')   socket = new FrameSocket(target, events);
    else if (name === 'HTMLVideoElement' ||
             name === 'HTMLAudioElement')    socket = new MediaSocket(target, events, norm);
    else if (name === 'XMLHttpRequest')      socket = new XhrSocket(target, events, norm);
    else if (target instanceof Promise)      socket = new PromiseSocket(target);
    else return this;  // unknown type — ignore gracefully

    this.couple(key, socket);
    return this;
  }

  // ── patrol — DOM polling ──────────────────────────────────────────────────

  patrol(...args) {
    args.flat().forEach(arg => {
      const entries = typeof arg === 'string'
        ? { [arg]: arg }               // selector → same selector
        : Object.entries(arg);         // { key: selector } map

      (Array.isArray(entries) ? entries : Object.entries(arg)).forEach(([key, selector]) => {
        this.notify(key, 0);
        const id = setInterval(() => {
          if (this.dead) { clearInterval(id); return; }
          const job = this.jobs[key];
          if (!job) { clearInterval(id); return; }
          if (document.querySelectorAll(selector).length > 0) {
            job.value = 1; job.lastChange = Date.now();
            clearInterval(id);
          }
        }, 50);
      });
    });
    return this;
  }

  // ── lifecycle hooks ───────────────────────────────────────────────────────

  _onstart() {
    this._build();
  }

  _onremove() {
    this.tFadeIn && (clearTimeout(this.tFadeIn), this.tFadeIn = null);
  }

  _onadjust(opts) {
    if (!this.pane) return;
    if (opts.tintbg) this.pane.style.background = opts.tintbg;
    if (opts.tintfg) this._theme?.tint(opts.tintfg);
    if (opts.size && this._theme?.el) {
      Object.assign(this._theme.el.style, { width: opts.size, height: opts.size });
    }
    if (opts.text !== undefined) {
      this._grid?.remove();
      this._grid = opts.text?.show ? new StatGrid(opts.text) : null;
      if (this._grid) this._grid.appendTo(this.pane);
    }
  }

  _ontick(avg, allDone, anyFail, now) {
    if (!this.pane || this.dead) return;

    // draw theme
    this._theme?.draw(avg);

    // stat grid update
    if (this._grid) {
      this.keys.forEach(key => {
        const job = this.jobs[key];
        if (job) this._grid.push(key, job.value, job.failed);
      });
    }

    // spin control — stop spinning once progress is detected
    if (avg > 0 && this._spinning) {
      this._theme?.stopspin();
      this._spinning = false;
    } else if (avg === 0 && !this._spinning) {
      this._theme?.resumespin();
      this._spinning = true;
    }

    // 900ms gate — show overlay only if still busy after fadeIn ms
    const elapsed = now - this.tStart;
    if (!this.pane.style.opacity || this.pane.style.opacity === '0') {
      if (elapsed >= this.cfg.fadeIn) {
        if (allDone && !anyFail) {
          // finished cleanly before gate — silent teardown
          this._teardown();
          return;
        }
        this.pane.style.opacity = '1';
      }
    }
  }

  _onconclude(show, outcome) {
    if (!show || !this.pane) {
      this._teardown();
      return;
    }
    // if still within fadeIn gate — silent teardown
    if (!this.pane.style.opacity || this.pane.style.opacity === '0') {
      if (outcome === 'pass') { this._teardown(); return; }
      // failures always show — force visible
      this.pane.style.opacity = '1';
    }
    const colour = outcome === 'fail' ? COL_FAIL
                 : outcome === 'mix'  ? COL_MIX
                 :                      COL_PASS;
    this._theme?.tint(colour);
    this._grid?.tint(colour);
    this._fadeout();
  }

  _teardown() {
    this._cancelraf();
    this.tKill   && (clearTimeout(this.tKill),   this.tKill   = null);
    this.tFadeIn && (clearTimeout(this.tFadeIn), this.tFadeIn = null);
    this.pane?.parentNode?.removeChild(this.pane);
    this.pane     = null;
    this._theme?.destroy();
    this._theme   = null;
    this._grid?.remove();
    this._grid    = null;
    this._spinning = true;
    super._teardown();  // sets active = false
  }

  // ── DOM build ─────────────────────────────────────────────────────────────

  _build() {
    const host = this.cfg.target;
    if (!host) return;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    this.pane = document.createElement('div');
    Object.assign(this.pane.style, {
      position       : 'absolute',
      top            : '0', left: '0',
      width          : '100%', height: '100%',
      zIndex         : '99999999',
      background     : this.cfg.tintbg,
      display        : 'flex',
      alignItems     : 'center',
      justifyContent : 'center',
      flexDirection  : 'column',
      gap            : '0.6rem',
      opacity        : '0',
      transition     : 'none',
      pointerEvents  : 'all',
    });

    // build theme
    this._theme = this.cfg.theme === 'slab' ? new SlabTheme(this.cfg) : new GearTheme(this.cfg);
    const themeEl = this._theme.build(this.cfg.tintfg);
    this.pane.appendChild(themeEl);

    // stat grid (opt-in)
    if (this.cfg.text?.show) {
      this._grid = new StatGrid(this.cfg.text);
      this._grid.appendTo(this.pane);
    }

    host.appendChild(this.pane);
  }

  // ── Fade out ──────────────────────────────────────────────────────────────

  _fadeout() {
    if (!this.pane) return;
    this._cancelraf();
    const pane = this.pane;
    pane.style.transition = 'none';
    let o = parseFloat(getComputedStyle(pane).opacity);
    if (isNaN(o) || o <= 0) { this._teardown(); return; }
    const step = o / (this.cfg.fadeOut / 16);
    const tick = () => {
      o -= step;
      if (o <= 0 || !this.dead) { this._teardown(); return; }
      pane.style.opacity = o.toFixed(4);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf   = requestAnimationFrame(tick);
    this.tKill = setTimeout(() => this.dead && this._teardown(), this.cfg.fadeOut + 600);
  }

  _cancelraf() {
    this.raf && (cancelAnimationFrame(this.raf), this.raf = null);
  }

  // ── Key generation ────────────────────────────────────────────────────────

  _keyfor(target) {
    target._sensorKey || (target._sensorKey = 'j-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5));
    return target._sensorKey;
  }

}
