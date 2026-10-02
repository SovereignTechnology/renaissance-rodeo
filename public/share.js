// Share bar. Progressive enhancement over section.share, whose five links (WhatsApp, X,
// Facebook, Telegram, email) already work without JS. This only unhides the two buttons the
// browser can run: "Copy link" (Clipboard API) and the system share sheet (Web Share, mostly
// phones). URL, title and the "copied" string come from the section's data-* attributes, so
// the script carries no per-language text.
(() => {
  const box = document.querySelector('section.share');
  if (!box) return;
  const { url, title, copied } = box.dataset;
  const status = box.querySelector('.share-status');
  const copy = box.querySelector('.share-copy');
  const native = box.querySelector('.share-native');
  let clear = 0;

  if (copy && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    copy.hidden = false;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
      } catch (_) {
        return; // permission refused: the share links still work, so stay quiet
      }
      if (!status) return;
      status.textContent = copied || '';
      clearTimeout(clear);
      clear = setTimeout(() => { status.textContent = ''; }, 3000);
    });
  }

  if (native && typeof navigator.share === 'function') {
    native.hidden = false;
    native.addEventListener('click', () => {
      // Rejects with AbortError when the visitor closes the sheet; nothing to report.
      navigator.share({ title, url }).catch(() => {});
    });
  }
})();
