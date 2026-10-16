// Settings pages: ask before destructive form submits.
document.addEventListener("submit", (e) => {
  const msg = e.target.dataset.confirm || (e.submitter && e.submitter.dataset.confirmBtn);
  if (msg && !window.confirm(msg)) e.preventDefault();
});
