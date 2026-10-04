// First-run walkthrough: dims the page, spotlights one element at a time, and explains it.
// Steps: { title, body, target?: () => Element | null, before?: () => void | Promise }.
// Seen-state is a per-device convenience in localStorage; the ? button replays it anytime.

const KEY = role => `nno-tour-${role}-v1`;

export function seenTour(role) {
  try { return localStorage.getItem(KEY(role)) === "done"; } catch { return false; }
}
function markSeen(role) {
  try { localStorage.setItem(KEY(role), "done"); } catch { /* storage blocked: shows again next visit */ }
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function runTour(role, steps, { onEnd } = {}) {
  document.getElementById("tour")?.remove();
  const root = document.createElement("div");
  root.id = "tour";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "tour-title");
  root.innerHTML = `<div class="tour-hole"></div><div class="tour-card" tabindex="-1"></div>`;
  document.body.appendChild(root);
  const hole = root.querySelector(".tour-hole");
  const card = root.querySelector(".tour-card");
  let i = 0;
  let current = null;

  function place() {
    const el = current;
    const r = el?.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight, pad = 6;
    if (r && r.width && r.height) {
      Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`, opacity: 1 });
    } else {
      Object.assign(hole.style, { left: `${vw / 2}px`, top: `${vh / 2}px`, width: "0px", height: "0px", opacity: 1 });
    }
    const cw = Math.min(360, vw - 24);
    card.style.width = `${cw}px`;
    const ch = card.offsetHeight;
    let left, top;
    if (!r || !r.width) {
      left = (vw - cw) / 2; top = (vh - ch) / 2;
    } else if (vw < 640) {
      // Phones: dock the card at whichever end the spotlight isn't.
      left = (vw - cw) / 2;
      top = r.top + r.height / 2 > vh / 2 ? 12 : vh - ch - 12;
    } else if (r.right + 16 + cw < vw && r.height > vh * 0.5) {
      left = r.right + 16; top = Math.min(Math.max(12, r.top), vh - ch - 12);
    } else if (r.bottom + 16 + ch < vh) {
      left = r.left + r.width / 2 - cw / 2; top = r.bottom + 16;
    } else {
      left = r.left + r.width / 2 - cw / 2; top = r.top - ch - 16;
    }
    card.style.left = `${Math.min(Math.max(12, left), vw - cw - 12)}px`;
    card.style.top = `${Math.min(Math.max(12, top), vh - ch - 12)}px`;
  }

  async function show(n) {
    i = n;
    const step = steps[i];
    card.classList.add("leaving");
    await step.before?.();
    await wait(step.before ? 380 : 120); // let panels slide and the map settle
    current = step.target?.() || null;
    current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const last = i === steps.length - 1;
    card.innerHTML = `
      <div class="tour-step">${i + 1} of ${steps.length}</div>
      <h2 id="tour-title" class="tour-title">${esc(step.title)}</h2>
      <div class="tour-body">${step.body}</div>
      <div class="tour-actions">
        <button class="tour-skip" data-act="skip">${last ? "" : "Skip tour"}</button>
        <span class="flex gap-2">
          ${i ? `<button class="tour-back" data-act="back">Back</button>` : ""}
          <button class="tour-next" data-act="next">${last ? "Got it" : "Next"}</button>
        </span>
      </div>`;
    place();
    card.classList.remove("leaving");
    card.querySelector(".tour-next").focus({ preventScroll: true });
  }

  function end() {
    markSeen(role);
    removeEventListener("resize", place);
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    onEnd?.();
  }
  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); end(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); i < steps.length - 1 ? show(i + 1) : end(); }
    else if (e.key === "ArrowLeft" && i) { e.preventDefault(); show(i - 1); }
  }

  card.addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "skip") end();
    else if (act === "back") show(i - 1);
    else if (act === "next") (i < steps.length - 1 ? show(i + 1) : end());
  });
  addEventListener("resize", place);
  document.addEventListener("keydown", onKey, true);
  show(0);
}
