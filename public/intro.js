// The black opening sequence. It never plays on arrival — the page always opens on the cream
// site. The "View intro" button in the footer is the only way in, and it plays motion
// preference or not (an explicit ask). Deferred, so it costs the first paint nothing; the
// overlay is display:none until start() puts .has-intro on <html>.
//
// The frames are static markup in each page (section.intro): the text slides, then the
// partner marks (cloned from the partner row), then the closing card, which holds until the
// visitor acts. Skip or Esc ends it; a tap, a horizontal swipe or the arrow keys step through
// the frames, forward and back.
(() => {
  const FADE_IN = 900;      // ms — mirrored by .intro-slide.is-on in style.css
  const FADE_OUT = 600;     // ms — .intro-slide
  const CUT = 250;          // ms — the quick cut to the closing card (.is-cut)
  const GAP = 300;          // ms of black between frames
  const HOLD_BASE = 1200;   // ms every text frame holds…
  const HOLD_PER_WORD = 210;// …plus this per word
  const HOLD_MARKS = 4000;  // ms for the partner marks
  const LEAVE = 800;        // ms — .intro.is-leaving

  const root = document.documentElement;
  const theme = document.querySelector('meta[name="theme-color"]');
  const themeWas = theme ? theme.content : '';

  document.addEventListener('DOMContentLoaded', setup);

  function setup() {
    const intro = document.querySelector('body > .intro');   // not '.intro': <html> carries has-intro, keep the names apart
    const stage = intro && intro.querySelector('.intro-stage');
    const cta = intro && intro.querySelector('.intro-cta');
    const replay = document.querySelector('.intro-replay');
    if (!intro || !stage || !cta) return;

    const el = (tag, cls) => { const n = document.createElement(tag); n.className = cls; return n; };
    // textContent, not innerText: the slides are visibility:hidden here and innerText reads as "".
    const words = (n) => { const c = n.cloneNode(true); for (const br of c.querySelectorAll('br')) br.replaceWith(' '); return c.textContent.trim().split(/\s+/).length; };

    // Text frames from the markup, then the partner marks, then the closing card.
    const frames = [...stage.querySelectorAll('.intro-slide')].map((slide) => ({ slide, hold: HOLD_BASE + words(slide) * HOLD_PER_WORD, enter: FADE_OUT + GAP }));
    const marks = document.querySelectorAll('.partners img');
    if (marks.length) {
      const slide = el('div', 'intro-slide');
      const row = el('div', 'intro-marks');
      for (const m of marks) {
        const c = m.cloneNode(false);   // same src, width, height; decorative here
        c.alt = '';
        c.draggable = false;
        c.removeAttribute('loading');
        row.append(c);
      }
      slide.append(row);
      stage.append(slide);
      frames.push({ slide, hold: HOLD_MARKS, enter: FADE_OUT + GAP });
    }
    cta.classList.add('is-cut');
    frames.push({ slide: cta, hold: Infinity, enter: CUT });

    const others = [...document.body.children].filter((n) => n !== intro);
    let playing = false;
    let at = -1;
    let timer = 0;
    let opener = null;      // the element to hand focus back to when a replay ends

    const show = (n) => {
      if (!playing || n >= frames.length) return;
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

    const start = (from) => {
      if (playing) return;
      playing = true;
      opener = from || null;
      at = -1;
      for (const f of frames) f.slide.classList.remove('is-on');
      intro.classList.remove('is-leaving');
      root.classList.add('has-intro');
      if (theme) theme.content = '#000';
      for (const n of others) n.inert = true;
      show(0);
    };

    const end = (after) => {
      if (!playing) return;
      playing = false;
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
        intro.classList.remove('is-leaving');       // and now display:none again, ready for a replay
        if (at >= 0) frames[at].slide.classList.remove('is-on');
        if (after?.focus) after.focus(); else opener?.focus();
        opener = null;
      };
      intro.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, LEAVE + 100);          // no transition (motion off, hidden tab): still finish
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
    // Step forward or back through the frames; the closing card is the end of the line.
    const step = (d) => { if (at >= 0 && at + d >= 0 && at + d < frames.length) show(at + d); };
    document.addEventListener('keydown', (e) => {
      if (!playing) return;
      if (e.key === 'Escape') end();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    });
    // Swipe: a mostly horizontal pointer travel of 40px+ (touch-action:none keeps the browser
    // from cancelling it). A tap anywhere that is not a control steps forward.
    let x0 = null, y0 = 0, swiped = false;
    intro.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; swiped = false; });
    intro.addEventListener('pointerup', (e) => {
      if (x0 === null) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      x0 = null;
      if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) { swiped = true; step(dx < 0 ? 1 : -1); }
    });
    intro.addEventListener('click', (e) => {
      if (swiped || e.target.closest('a, button')) return;
      step(1);
    });
    if (replay) {
      replay.hidden = false;                    // it only works with JS, so it only shows with JS
      replay.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'instant' }); start(replay); });
    }
  }
})();
