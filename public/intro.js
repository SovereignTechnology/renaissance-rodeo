// The black opening sequence. Loaded synchronously in <head> (no defer) so the first thing
// it does — putting .has-intro on <html> — lands before first paint and the page never flashes
// cream before the black. Everything else waits for DOMContentLoaded.
//
// Plays only when motion is allowed, once per browser session (sessionStorage 'rr-intro',
// set at start so a reload mid-sequence skips it) and never on a deep link (#signup from a
// mail or a share goes straight to the form). No JS, or any of those, and the overlay stays
// display:none. The frames are built from the page's own copy: every span[data-frame]
// inside an About paragraph is one frame (a paragraph without spans is one frame), then the
// partner marks, then the static closing card, which holds until the visitor acts.
// Skip, Esc, or a tap anywhere that is not a control moves things along.
(() => {
  const FADE_IN = 900;      // ms — mirrored by .intro-slide.is-on in style.css
  const FADE_OUT = 600;     // ms — .intro-slide
  const CUT = 250;          // ms — the quick cut to the closing card (.is-cut)
  const GAP = 300;          // ms of black between frames
  const HOLD_BASE = 800;    // ms every text frame holds…
  const HOLD_PER_WORD = 170;// …plus this per word
  const HOLD_MARKS = 3200;  // ms for the partner marks
  const LEAVE = 800;        // ms — .intro.is-leaving
  const KEY = 'rr-intro';

  const root = document.documentElement;
  let seen = false;
  try { seen = sessionStorage.getItem(KEY) === '1'; } catch { /* storage blocked: play, do not remember */ }
  if (seen || location.hash || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try { sessionStorage.setItem(KEY, '1'); } catch { /* same */ }
  root.classList.add('has-intro');
  const theme = document.querySelector('meta[name="theme-color"]');
  const themeWas = theme ? theme.content : '';
  if (theme) theme.content = '#000';

  const el = (tag, cls) => { const n = document.createElement(tag); n.className = cls; return n; };
  const words = (t) => t.trim().split(/\s+/).length;

  document.addEventListener('DOMContentLoaded', () => {
    const intro = document.querySelector('body > .intro');   // not '.intro': <html> carries has-intro, keep the names apart
    const stage = intro && intro.querySelector('.intro-stage');
    const cta = intro && intro.querySelector('.intro-cta');
    if (!intro || !stage || !cta) { root.classList.remove('has-intro'); if (theme) theme.content = themeWas; return; }

    const others = [...document.body.children].filter((n) => n !== intro);
    for (const n of others) n.inert = true;

    const frames = [];
    for (const p of document.querySelectorAll('.about p')) {
      const spans = p.querySelectorAll('span[data-frame]');
      const texts = spans.length ? [...spans].map((s) => s.textContent) : [p.textContent];
      for (const text of texts) {
        const slide = el('div', 'intro-slide');
        const copy = el('p', 'intro-text');
        copy.textContent = text.trim();
        slide.append(copy);
        frames.push({ slide, hold: HOLD_BASE + words(text) * HOLD_PER_WORD, enter: FADE_OUT + GAP });
      }
    }
    const marks = document.querySelectorAll('.partners img');
    if (marks.length) {
      const slide = el('div', 'intro-slide');
      const row = el('div', 'intro-marks');
      for (const m of marks) {
        const c = m.cloneNode(false);   // same src, width, height; decorative here
        c.alt = '';
        c.removeAttribute('loading');
        row.append(c);
      }
      slide.append(row);
      frames.push({ slide, hold: HOLD_MARKS, enter: FADE_OUT + GAP });
    }
    stage.append(...frames.map((f) => f.slide));
    cta.classList.add('is-cut');
    frames.push({ slide: cta, hold: Infinity, enter: CUT });

    let at = -1;
    let timer = 0;
    let ended = false;
    const show = (n) => {
      if (ended || n >= frames.length) return;
      clearTimeout(timer);
      if (at >= 0) frames[at].slide.classList.remove('is-on');
      at = n;
      const f = frames[at];
      const fadeIn = f.slide === cta ? CUT : FADE_IN;
      timer = setTimeout(() => {
        f.slide.classList.add('is-on');
        if (f.hold !== Infinity) timer = setTimeout(() => show(at + 1), fadeIn + f.hold);
      }, at === 0 ? 0 : f.enter);
    };

    const end = (after) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      intro.classList.add('is-leaving');
      root.classList.remove('has-intro');           // the page fades up underneath while the black lifts
      if (theme) theme.content = themeWas;
      if (after) after.scroll?.();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        for (const n of others) n.inert = false;
        intro.remove();
        if (after) after.focus?.();
      };
      intro.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, LEAVE + 100);          // no transition (motion off mid-way, hidden tab): still finish
    };

    intro.querySelector('.intro-skip')?.addEventListener('click', () => end());
    intro.querySelector('.intro-join')?.addEventListener('click', (e) => {
      e.preventDefault();
      const form = document.getElementById('signup');
      const email = document.getElementById('email');
      end({ scroll: () => form?.scrollIntoView(), focus: () => email?.focus({ preventScroll: true }) });
    });
    intro.querySelector('.intro-enter')?.addEventListener('click', (e) => {
      e.preventDefault();
      end({ focus: () => document.getElementById('main')?.focus({ preventScroll: true }) });
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ended) end(); });
    intro.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      if (at >= 0 && frames[at].slide !== cta) show(at + 1);
    });

    show(0);
  });
})();
