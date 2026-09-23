"use strict";

// =====================================================================
// Core math (pure functions, no DOM)
// =====================================================================

// Returns { percent, needed, canSkip } for `attended` out of `total` classes
// against a `target` percentage (1–100). Uses integer math to avoid float errors.
function analyze(attended, total, target) {
  const percent = total > 0 ? (attended / total) * 100 : 0;
  let needed = 0;
  let canSkip = 0;

  if (attended * 100 < target * total) {
    // Smallest x with (attended + x) / (total + x) >= target / 100
    needed = target >= 100 ? Infinity : Math.ceil((target * total - 100 * attended) / (100 - target));
  } else {
    // Largest y with attended / (total + y) >= target / 100
    canSkip = Math.floor((100 * attended - target * total) / target);
  }

  return { percent, needed, canSkip };
}

// Percentage after attending `attendNext` and missing `missNext` more classes.
function project(attended, total, attendNext, missNext) {
  const newTotal = total + attendNext + missNext;
  return {
    attended: attended + attendNext,
    total: newTotal,
    percent: newTotal > 0 ? ((attended + attendNext) / newTotal) * 100 : 0,
  };
}

// Classifies a result: "good" (safe), "warn" (on target but can't skip), "bad" (below), "new" (no classes).
function statusOf(result, target, total) {
  if (total === 0) return { key: "new", label: "No classes yet" };
  if (result.percent < target) return { key: "bad", label: "Below target" };
  if (result.canSkip === 0) return { key: "warn", label: "On the edge" };
  return { key: "good", label: "Safe" };
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Human-readable advice. Returns HTML (only numbers are interpolated).
function adviceHtml(result, target, total) {
  if (total === 0) return "Mark your first class to get started.";
  if (result.needed === Infinity) return `You can't reach ${target}% any more, because you've already missed a class.`;
  if (result.needed > 0) return `Attend the next <strong>${plural(result.needed, "class", "classes")}</strong> in a row to reach ${target}%.`;
  if (result.canSkip > 0) return `You can skip <strong>${plural(result.canSkip, "class", "classes")}</strong> and stay at or above ${target}%.`;
  return `You're exactly on target. Don't skip the next class.`;
}

const stripTags = (html) => html.replace(/<[^>]+>/g, "");
const fmt = (n) => `${Math.round(n * 100) / 100}%`;

// =====================================================================
// Helpers
// =====================================================================

const $ = (id) => document.getElementById(id);

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Parses an input's value. Returns null when empty, NaN when invalid.
function readInt(el) {
  const raw = el.value.trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}

const isValidTarget = (n) => Number.isFinite(n) && n >= 1 && n <= 100;

function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return "Earlier";
  const d = new Date(iso + "T00:00:00");
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// SVG progress ring with a small notch marking the target.
function ringHtml(percent, statusKey, target, label) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  const angle = ((target / 100) * 360 - 90) * (Math.PI / 180);
  const x1 = 50 + (r - 6) * Math.cos(angle), y1 = 50 + (r - 6) * Math.sin(angle);
  const x2 = 50 + (r + 6) * Math.cos(angle), y2 = 50 + (r + 6) * Math.sin(angle);
  return `
    <svg class="ring ring-${statusKey}" viewBox="0 0 100 100" aria-hidden="true">
      <circle class="ring-track" cx="50" cy="50" r="${r}" />
      <circle class="ring-value" cx="50" cy="50" r="${r}" stroke-dasharray="${c}"
        stroke-dashoffset="${c * (1 - p / 100)}" transform="rotate(-90 50 50)" />
      <line class="ring-target" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
    </svg>
    <span class="ring-label">${label}</span>`;
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// =====================================================================
// State & persistence
// =====================================================================

const STORAGE_KEY = "attendance-app-v2";
const LEGACY_KEY = "attendance-subjects"; // version 1 stored a bare array here
const THEMES = ["system", "light", "dark"];

const defaultState = () => ({ version: 2, settings: { target: 75, theme: "system" }, subjects: [] });

function toCount(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Cleans saved or imported data into a valid state. Throws if it isn't recognisable.
function normalize(raw) {
  const list = Array.isArray(raw) ? raw : raw && raw.subjects;
  if (!Array.isArray(list)) throw new Error("This file doesn't look like an attendance backup.");

  const state = defaultState();
  const settings = (raw && raw.settings) || {};
  if (isValidTarget(Number(settings.target))) state.settings.target = Math.round(Number(settings.target));
  if (THEMES.includes(settings.theme)) state.settings.theme = settings.theme;

  state.subjects = list
    .filter((s) => s && typeof s === "object")
    .map((s) => {
      const total = toCount(s.total);
      const target = s.target == null || s.target === "" ? null : Number(s.target);
      let log = [];
      if (Array.isArray(s.log)) {
        log = s.log
          .filter((e) => e && (e.t === "p" || e.t === "a"))
          .map((e) => ({ t: e.t, d: typeof e.d === "string" ? e.d.slice(0, 10) : "" }));
      } else if (Array.isArray(s.history)) {
        log = s.history.filter((t) => t === "p" || t === "a").map((t) => ({ t, d: "" })); // v1 format
      }
      return {
        id: typeof s.id === "string" && s.id ? s.id : uid(),
        name: String(s.name ?? "").trim().slice(0, 40) || "Untitled",
        attended: Math.min(toCount(s.attended), total),
        total,
        target: isValidTarget(target) ? Math.round(target) : null,
        log,
      };
    });
  return state;
}

function load() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalize(JSON.parse(saved));
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) return normalize(JSON.parse(legacy));
  } catch {
    // Corrupt or unavailable storage: start fresh.
  }
  return defaultState();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable (e.g. private mode): keep working in memory.
  }
}

let state = load();

const targetFor = (subject) => subject.target ?? state.settings.target;
const findSubject = (id) => state.subjects.find((s) => s.id === id);

// =====================================================================
// Toast
// =====================================================================

let toastTimer;
function toast(message, actionLabel, onAction) {
  const el = $("toast");
  const action = $("toast-action");
  $("toast-msg").textContent = message;
  action.hidden = !actionLabel;
  action.textContent = actionLabel || "";
  action.onclick = () => {
    el.hidden = true;
    onAction();
  };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), actionLabel ? 6000 : 3000);
}

// =====================================================================
// Theme
// =====================================================================

const THEME_ICONS = { system: "◐", light: "☀", dark: "☾" };

function applyTheme() {
  const theme = state.settings.theme;
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $("theme-icon").textContent = THEME_ICONS[theme];
  $("theme-label").textContent = theme[0].toUpperCase() + theme.slice(1);
}

$("theme-btn").addEventListener("click", () => {
  const i = THEMES.indexOf(state.settings.theme);
  state.settings.theme = THEMES[(i + 1) % THEMES.length];
  save();
  applyTheme();
  toast(`Theme: ${$("theme-label").textContent}`);
});

// =====================================================================
// Overview
// =====================================================================

function renderOverview() {
  const target = state.settings.target;
  const attended = state.subjects.reduce((sum, s) => sum + s.attended, 0);
  const total = state.subjects.reduce((sum, s) => sum + s.total, 0);
  const counts = { good: 0, warn: 0, bad: 0 };

  state.subjects.forEach((s) => {
    const key = statusOf(analyze(s.attended, s.total, targetFor(s)), targetFor(s), s.total).key;
    if (key in counts) counts[key]++;
  });

  const r = analyze(attended, total, target);
  const st = statusOf(r, target, total);
  $("overall-ring").innerHTML = ringHtml(r.percent, st.key, target, total ? fmt(r.percent) : "—");

  let headline;
  if (!state.subjects.length) headline = "Add subjects below to see your overall attendance.";
  else if (!total) headline = "Mark your first class to see your overall attendance.";
  else if (counts.bad) headline = `${plural(counts.bad, "subject is", "subjects are")} below target. Check the red cards first.`;
  else if (counts.warn) headline = `All subjects are at or above target, but ${counts.warn === 1 ? "one is" : counts.warn + " are"} on the edge.`;
  else headline = `You're above ${target}% in every subject. Nice work.`;
  $("overall-headline").textContent = headline;

  $("stat-classes").textContent = `${attended} / ${total}`;
  $("stat-subjects").textContent = state.subjects.length;
  $("stat-safe").textContent = counts.good;
  $("stat-edge").textContent = counts.warn;
  $("stat-below").textContent = counts.bad;
}

// =====================================================================
// Quick check
// =====================================================================

const quick = { attended: $("attended"), total: $("total"), target: $("target") };

// Returns { attended, total, target } or { error } for the quick-check inputs.
function readQuick() {
  const a = readInt(quick.attended);
  const t = readInt(quick.total);
  const p = Number(quick.target.value);
  Object.values(quick).forEach((el) => el.removeAttribute("aria-invalid"));

  if (a === null || t === null) return { empty: true };
  if (Number.isNaN(a) || a < 0) return { error: "Attended must be a whole number, 0 or more.", el: quick.attended };
  if (Number.isNaN(t) || t < 1) return { error: "Total must be a whole number, at least 1.", el: quick.total };
  if (a > t) return { error: "Attended classes can't be more than total classes.", el: quick.attended };
  if (!isValidTarget(p)) return { error: "Target must be between 1 and 100.", el: quick.target };
  return { attended: a, total: t, target: p };
}

function renderQuick() {
  const box = $("calc-result");
  const q = readQuick();
  box.className = "result";

  if (q.empty) {
    box.innerHTML = `<div class="result-text"><span>Enter attended and total classes to see your percentage.</span></div>`;
    return;
  }
  if (q.error) {
    q.el.setAttribute("aria-invalid", "true");
    box.classList.add("bad");
    box.innerHTML = `<div class="result-text"><span>${esc(q.error)}</span></div>`;
    return;
  }

  const r = analyze(q.attended, q.total, q.target);
  const st = statusOf(r, q.target, q.total);
  box.classList.add(st.key);
  box.innerHTML = `
    <div class="ring-wrap medium">${ringHtml(r.percent, st.key, q.target, fmt(r.percent))}</div>
    <div class="result-text">
      <span class="result-title">${st.label}</span>
      <span>${adviceHtml(r, q.target, q.total)}</span>
    </div>`;
}

Object.values(quick).forEach((el) =>
  el.addEventListener("input", () => {
    renderQuick();
    renderWhatIf();
  })
);

// =====================================================================
// What-if planner
// =====================================================================

const whatif = { source: $("whatif-source"), attend: $("whatif-attend"), miss: $("whatif-miss") };

function renderWhatIfSources() {
  const current = whatif.source.value;
  whatif.source.innerHTML =
    `<option value="quick">Quick check numbers</option>` +
    (state.subjects.length ? `<option value="overall">All subjects combined</option>` : "") +
    state.subjects.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  const stillExists = [...whatif.source.options].some((o) => o.value === current);
  whatif.source.value = stillExists ? current : "quick";
}

// Returns the { attended, total, target } the planner should start from.
function whatIfBase() {
  const src = whatif.source.value;
  if (src === "quick") {
    const q = readQuick();
    return q.empty || q.error ? null : q;
  }
  if (src === "overall") {
    return {
      attended: state.subjects.reduce((sum, s) => sum + s.attended, 0),
      total: state.subjects.reduce((sum, s) => sum + s.total, 0),
      target: state.settings.target,
    };
  }
  const s = findSubject(src);
  return s ? { attended: s.attended, total: s.total, target: targetFor(s) } : null;
}

function renderWhatIf() {
  const box = $("whatif-result");
  box.className = "result";
  const base = whatIfBase();

  if (!base) {
    box.innerHTML = `<div class="result-text"><span>Fill in Quick check, or choose a subject in “Based on”.</span></div>`;
    return;
  }

  const attendNext = readInt(whatif.attend) ?? 0;
  const missNext = readInt(whatif.miss) ?? 0;
  if (Number.isNaN(attendNext) || Number.isNaN(missNext) || attendNext < 0 || missNext < 0) {
    box.classList.add("bad");
    box.innerHTML = `<div class="result-text"><span>Use whole numbers, 0 or more.</span></div>`;
    return;
  }

  const now = base.total ? fmt((base.attended / base.total) * 100) : "—";
  const p = project(base.attended, base.total, attendNext, missNext);
  if (p.total === 0) {
    box.innerHTML = `<div class="result-text"><span>No classes yet. Enter how many you'll attend or miss.</span></div>`;
    return;
  }

  const st = statusOf(analyze(p.attended, p.total, base.target), base.target, p.total);
  box.classList.add(st.key);
  box.innerHTML = `
    <div class="result-text">
      <span class="projection">${now}<span class="arrow">→</span>${fmt(p.percent)}</span>
      <span><strong>${st.label}</strong> against ${base.target}%. That's ${p.attended} of ${p.total} classes.</span>
    </div>`;
}

Object.values(whatif).forEach((el) => el.addEventListener("input", renderWhatIf));

// =====================================================================
// Subjects
// =====================================================================

const ICONS = {
  edit: `<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>`,
};

const openHistory = new Set(); // ids whose history panel is expanded

function subjectCard(s) {
  const target = targetFor(s);
  const r = analyze(s.attended, s.total, target);
  const st = statusOf(r, target, s.total);
  const id = esc(s.id);
  const recent = s.log.slice(-20).reverse();
  const targetNote = s.target == null ? `target ${target}%` : `custom target ${target}%`;

  return `
    <article class="subject status-${st.key}" data-id="${id}">
      <div class="subject-top">
        <div class="ring-wrap small">${ringHtml(r.percent, st.key, target, s.total ? `${Math.round(r.percent)}%` : "—")}</div>
        <div class="subject-info">
          <h3 class="subject-name">${esc(s.name)}</h3>
          <span class="badge badge-${st.key}">${st.label}</span>
          <p class="subject-meta">${s.attended} / ${s.total} attended · ${targetNote}</p>
        </div>
        <div class="icon-actions">
          <button class="icon-btn" data-action="edit" aria-label="Edit ${esc(s.name)}" title="Edit">${ICONS.edit}</button>
          <button class="icon-btn danger" data-action="delete" aria-label="Delete ${esc(s.name)}" title="Delete">${ICONS.trash}</button>
        </div>
      </div>
      <div class="bar" role="img" aria-label="${fmt(r.percent)} attended, target ${target}%">
        <span class="bar-fill" style="width:${Math.min(100, r.percent)}%"></span>
        <span class="bar-target" style="left:calc(${target}% - 1px)"></span>
      </div>
      <p class="advice">${adviceHtml(r, target, s.total)}</p>
      <div class="subject-actions">
        <button class="btn btn-present" data-action="present">✓ Present</button>
        <button class="btn btn-absent" data-action="absent">✕ Absent</button>
        <button class="btn" data-action="undo" ${s.log.length ? "" : "disabled"} title="Undo last mark">Undo</button>
      </div>
      ${
        s.log.length
          ? `<details class="history" ${openHistory.has(s.id) ? "open" : ""}>
              <summary>History · last ${Math.min(20, s.log.length)} of ${s.log.length} marks</summary>
              <div class="streak" aria-hidden="true">${s.log.slice(-30).map((e) => `<span class="dot dot-${e.t}"></span>`).join("")}</div>
              <ol>${recent
                .map((e) => `<li><span class="dot dot-${e.t}"></span>${e.t === "p" ? "Present" : "Absent"}<span class="history-date">${formatDate(e.d)}</span></li>`)
                .join("")}</ol>
            </details>`
          : ""
      }
    </article>`;
}

function visibleSubjects() {
  const q = $("search").value.trim().toLowerCase();
  const list = state.subjects.filter((s) => s.name.toLowerCase().includes(q));
  const pct = (s) => (s.total ? s.attended / s.total : -1);
  switch ($("sort").value) {
    case "name": return list.sort((a, b) => a.name.localeCompare(b.name));
    case "pct-asc": return list.sort((a, b) => pct(a) - pct(b));
    case "pct-desc": return list.sort((a, b) => pct(b) - pct(a));
    default: return list;
  }
}

function renderSubjects() {
  const list = visibleSubjects();
  $("subject-list").innerHTML = list.map(subjectCard).join("");
  $("empty-state").hidden = state.subjects.length > 0;
  $("no-match").hidden = !(state.subjects.length > 0 && list.length === 0);
}

function renderAll() {
  renderOverview();
  renderQuick();
  renderWhatIfSources();
  renderWhatIf();
  renderSubjects();
}

// Saves, re-renders and returns — used after every change to state.
function commit() {
  save();
  renderAll();
}

// ----- Add subject -----
$("subject-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const nameEl = $("subject-name");
  const name = nameEl.value.trim();
  const attended = readInt($("subject-attended")) ?? 0;
  const total = readInt($("subject-total")) ?? 0;
  const target = readInt($("subject-target"));

  let error = "";
  if (!name) error = "Enter a subject name.";
  else if (state.subjects.some((s) => s.name.toLowerCase() === name.toLowerCase())) error = `“${name}” already exists.`;
  else if (Number.isNaN(attended) || Number.isNaN(total) || attended < 0 || total < 0) error = "Counts must be whole numbers, 0 or more.";
  else if (attended > total) error = "Attended can't be more than total.";
  else if (target !== null && !isValidTarget(target)) error = "Target must be between 1 and 100, or left blank.";

  $("subject-error").textContent = error;
  if (error) return;

  state.subjects.push({ id: uid(), name, attended, total, target, log: [] });
  e.target.reset();
  nameEl.focus();
  commit();
  toast(`Added “${name}”`);
});

// ----- Card actions -----
$("subject-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const card = btn.closest(".subject");
  const s = findSubject(card.dataset.id);
  if (!s) return;

  switch (btn.dataset.action) {
    case "present":
      s.attended++;
      s.total++;
      s.log.push({ t: "p", d: todayISO() });
      break;
    case "absent":
      s.total++;
      s.log.push({ t: "a", d: todayISO() });
      break;
    case "undo": {
      const last = s.log.pop();
      if (!last) return;
      if (last.t === "p" && s.attended > 0) s.attended--;
      if (s.total > s.attended) s.total--;
      break;
    }
    case "edit":
      openEditDialog(s);
      return;
    case "delete": {
      const index = state.subjects.indexOf(s);
      state.subjects.splice(index, 1);
      openHistory.delete(s.id);
      commit();
      toast(`Deleted “${s.name}”`, "Undo", () => {
        state.subjects.splice(Math.min(index, state.subjects.length), 0, s);
        commit();
      });
      return;
    }
  }
  commit();
});

// `toggle` doesn't bubble, so listen in the capture phase to remember open panels.
$("subject-list").addEventListener(
  "toggle",
  (e) => {
    if (!e.target.matches("details.history")) return;
    const id = e.target.closest(".subject").dataset.id;
    e.target.open ? openHistory.add(id) : openHistory.delete(id);
  },
  true
);

$("search").addEventListener("input", renderSubjects);
$("sort").addEventListener("change", renderSubjects);

// ----- Edit dialog -----
const dialog = $("edit-dialog");
let editingId = null;

function openEditDialog(s) {
  editingId = s.id;
  $("edit-name").value = s.name;
  $("edit-attended").value = s.attended;
  $("edit-total").value = s.total;
  $("edit-target").value = s.target ?? "";
  $("edit-target").placeholder = `Default (${state.settings.target})`;
  $("edit-error").textContent = "";
  dialog.showModal();
}

$("edit-cancel").addEventListener("click", () => dialog.close());

$("edit-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const s = findSubject(editingId);
  if (!s) return dialog.close();

  const name = $("edit-name").value.trim();
  const attended = readInt($("edit-attended")) ?? 0;
  const total = readInt($("edit-total")) ?? 0;
  const target = readInt($("edit-target"));

  let error = "";
  if (!name) error = "Enter a subject name.";
  else if (state.subjects.some((o) => o !== s && o.name.toLowerCase() === name.toLowerCase())) error = `“${name}” already exists.`;
  else if (Number.isNaN(attended) || Number.isNaN(total) || attended < 0 || total < 0) error = "Counts must be whole numbers, 0 or more.";
  else if (attended > total) error = "Attended can't be more than total.";
  else if (target !== null && !isValidTarget(target)) error = "Target must be between 1 and 100, or left blank.";

  $("edit-error").textContent = error;
  if (error) return;

  Object.assign(s, { name, attended, total, target });
  dialog.close();
  commit();
  toast("Changes saved");
});

// =====================================================================
// Settings & data
// =====================================================================

const defaultTargetEl = $("default-target");

defaultTargetEl.addEventListener("input", () => {
  const n = readInt(defaultTargetEl);
  const ok = n !== null && isValidTarget(n);
  if (!ok) return defaultTargetEl.setAttribute("aria-invalid", "true");
  defaultTargetEl.removeAttribute("aria-invalid");
  state.settings.target = n;
  quick.target.value = n;
  commit();
});

$("export-json").addEventListener("click", () => {
  download(`attendance-backup-${todayISO()}.json`, JSON.stringify(state, null, 2), "application/json");
  toast("Backup downloaded");
});

$("import-json").addEventListener("click", () => $("import-file").click());

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // allow picking the same file again later
  if (!file) return;
  try {
    const imported = normalize(JSON.parse(await file.text()));
    const n = imported.subjects.length;
    if (!confirm(`Replace your current data with ${n} subject${n === 1 ? "" : "s"} from “${file.name}”?`)) return;
    const previous = state;
    state = imported;
    syncSettingsInputs();
    applyTheme();
    commit();
    toast(`Imported ${n} subject${n === 1 ? "" : "s"}`, "Undo", () => {
      state = previous;
      syncSettingsInputs();
      applyTheme();
      commit();
    });
  } catch (err) {
    toast(err instanceof SyntaxError ? "That file isn't valid JSON." : err.message);
  }
});

// Quotes a CSV cell and neutralises spreadsheet formulas (=, +, -, @).
function csvCell(value) {
  let v = String(value);
  if (/^[=+\-@]/.test(v)) v = "'" + v;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

$("export-csv").addEventListener("click", () => {
  if (!state.subjects.length) return toast("Add a subject first");
  const rows = [["Subject", "Attended", "Total", "Percentage", "Target %", "Status", "Advice"]];
  state.subjects.forEach((s) => {
    const target = targetFor(s);
    const r = analyze(s.attended, s.total, target);
    rows.push([
      s.name,
      s.attended,
      s.total,
      s.total ? (Math.round(r.percent * 100) / 100).toFixed(2) : "",
      target,
      statusOf(r, target, s.total).label,
      stripTags(adviceHtml(r, target, s.total)),
    ]);
  });
  download(`attendance-${todayISO()}.csv`, rows.map((row) => row.map(csvCell).join(",")).join("\n"), "text/csv");
  toast("Spreadsheet downloaded");
});

$("print-report").addEventListener("click", () => {
  $("report-date").textContent = `Attendance report · ${formatDate(todayISO())}`;
  window.print();
});

$("reset-all").addEventListener("click", () => {
  if (!state.subjects.length) return toast("Nothing to reset");
  if (!confirm("Delete all subjects and their history? You can undo this right after.")) return;
  const previous = state;
  state = { ...defaultState(), settings: { ...state.settings } };
  commit();
  toast("Everything was reset", "Undo", () => {
    state = previous;
    commit();
  });
});

function syncSettingsInputs() {
  defaultTargetEl.value = state.settings.target;
  defaultTargetEl.removeAttribute("aria-invalid");
  quick.target.value = state.settings.target;
}

// =====================================================================
// Start
// =====================================================================

syncSettingsInputs();
applyTheme();
renderAll();
