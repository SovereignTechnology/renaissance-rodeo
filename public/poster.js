// Poster viewer. Progressive enhancement over the a[data-poster] links, whose href is the
// JPEG itself: no JS, or no <dialog> support, and the browser simply opens the image.
// The <dialog> is modal (focus trapped, Esc closes natively); backdrop click closes because
// the dialog has no padding, so a click that lands on the element itself is outside the picture.
(() => {
  const dialog = document.getElementById('poster-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const close = dialog.querySelector('.lightbox-close');
  let opener = null;

  for (const link of document.querySelectorAll('a[data-poster]')) {
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; // new-tab intent: keep the link
      event.preventDefault();
      opener = link;
      dialog.showModal();
      close.focus();
    });
  }
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { if (opener) { opener.focus(); opener = null; } });
})();
