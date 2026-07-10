'use strict';

// --- DOM refs ---------------------------------------------------------------
const dropzone = document.getElementById('dropzone');
const dropzoneEmpty = document.getElementById('dropzone-empty');
const thumbs = document.getElementById('thumbs');
const note = document.getElementById('note');
const analyzeBtn = document.getElementById('analyze-btn');
const btnLabel = analyzeBtn.querySelector('.btn-label');
const clearBtn = document.getElementById('clear-btn');
const leftStatus = document.getElementById('left-status');
const progressEl = document.getElementById('progress');
const progressBar = document.getElementById('progress-bar');
const progressMetaEl = document.getElementById('progress-meta');
const progressEtaEl = document.getElementById('progress-eta');
const progressPercentEl = document.getElementById('progress-percent');

const editorModal = document.getElementById('editor-modal');
const editorImg = document.getElementById('editor-img');
const editorOverlay = document.getElementById('editor-overlay');
const editorClear = document.getElementById('editor-clear');
const editorDone = document.getElementById('editor-done');

const resultEl = document.getElementById('result');
const resultEmpty = document.getElementById('result-empty');
const activityEl = document.getElementById('activity');
const activityHeadEl = document.getElementById('activity-head');
const activityStepsEl = document.getElementById('activity-steps');
const activityStatusEl = document.getElementById('activity-status');

const questionModal = document.getElementById('question-modal');
const questionText = document.getElementById('question-text');
const questionInput = document.getElementById('question-input');
const questionSend = document.getElementById('question-send');
const questionSkip = document.getElementById('question-skip');
const usageEl = document.getElementById('usage');
const modelBadge = document.getElementById('model-badge');

const chatEl = document.getElementById('chat');
const chatLog = document.getElementById('chat-log');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');

const historyBtn = document.getElementById('history-btn');
const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const historyClose = document.getElementById('history-close');

const homeRecentList = document.getElementById('home-recent-list');
const homeSeeAllBtn = document.getElementById('home-see-all');

const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const apiKeyInput = document.getElementById('api-key');
const modelInput = document.getElementById('model-select');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');
const reasoningInput = document.getElementById('reasoning-input');
const baseUrlInput = document.getElementById('base-url');
const presetHf = document.getElementById('preset-hf');
const presetOllama = document.getElementById('preset-ollama');
const webSearchInput = document.getElementById('web-search');

const mapWrap = document.getElementById('map-wrap');
const mapBackdrop = document.getElementById('map-backdrop');
const mapLabel = document.getElementById('map-label');
const mapLink = document.getElementById('map-link');
const mapRecenterBtn = document.getElementById('map-recenter');
const mapExpandBtn = document.getElementById('map-expand');
const candidatesEl = document.getElementById('candidates');

// --- State ------------------------------------------------------------------
let images = []; // [{ mediaType, data, name }]
const MAX_IMAGES = 8;
let busy = false;
let chatBusy = false;
let currentSessionId = null; // set when an analysis completes or a chat is opened
let chatTurnIndex = 0; // mirrors sess.chat's length on the main side, for revert

// --- Map (Leaflet, bundled locally) -----------------------------------------
let map = null;
let markerLayer = null; // L.layerGroup holding the current candidate pins
let markerRefs = []; // parallel to the rendered candidates, for list ↔ map sync
let lastCandidates = []; // the candidates currently shown, for recenter/expand

// Tell Leaflet where its bundled marker images live.
if (window.L) {
  L.Icon.Default.imagePath = 'vendor/leaflet/images/';
}

function ensureMap() {
  if (map) return map;
  map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: true,
    worldCopyJump: true,
  });
  // CARTO dark basemap (free, no key) to match the app's dark theme; @2x tiles
  // stay crisp on high-DPI screens. If it can't load (offline/blocked), fall
  // back to standard OpenStreetMap tiles so the map always renders.
  const carto = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    detectRetina: true,
    subdomains: 'abcd',
    attribution: '© OpenStreetMap contributors © CARTO',
  });
  let swapped = false;
  carto.on('tileerror', () => {
    if (swapped) return;
    swapped = true;
    map.removeLayer(carto);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
  });
  carto.addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  return map;
}

function hideMap() {
  mapWrap.classList.add('hidden');
  if (mapWrap.classList.contains('expanded')) toggleMapExpanded(false);
}

// Fit the map's view to a set of candidate points — used both when pins first
// drop and by the "recenter" button after the user has panned/zoomed around.
function fitMapToCandidates(cands) {
  if (!map || !cands || !cands.length) return;
  const pts = cands.map((c) => [c.lat, c.lng]);
  const primary = cands[0];
  if (pts.length === 1) {
    map.setView(pts[0], primary.source === 'osm' ? 14 : 5);
  } else {
    map.fitBounds(pts, { padding: [42, 42], maxZoom: 14 });
  }
}

// Toggle a distraction-free, much larger view of the map (a lightbox-style
// overlay) — closes on Escape or clicking the backdrop.
function toggleMapExpanded(force) {
  const expand = typeof force === 'boolean' ? force : !mapWrap.classList.contains('expanded');
  mapWrap.classList.toggle('expanded', expand);
  mapBackdrop.classList.toggle('hidden', !expand);
  mapExpandBtn.textContent = expand ? '⤡' : '⤢';
  mapExpandBtn.title = expand ? 'Collapse map' : 'Expand map';
  // The container just resized (CSS transition) — Leaflet must recompute size.
  setTimeout(() => {
    if (map) map.invalidateSize();
  }, 220);
}

mapExpandBtn.addEventListener('click', () => toggleMapExpanded());
mapBackdrop.addEventListener('click', () => toggleMapExpanded(false));
mapRecenterBtn.addEventListener('click', () => fitMapToCandidates(lastCandidates));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mapWrap.classList.contains('expanded')) toggleMapExpanded(false);
});

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A clean numbered map marker: a circular badge with a small pointer tail. The
// primary (best) guess is larger and accented; alternatives are dimmer. Pins
// drop in with a staggered animation.
function pinIcon(cand, idx) {
  const cls = 'geo-pin' + (cand.primary ? ' geo-pin-primary' : ' geo-pin-alt');
  const html =
    `<div class="${cls}" style="animation-delay:${idx * 0.1}s">` +
    `<span class="geo-pin-num">${escapeHtml(String(idx + 1))}</span>` +
    '<span class="geo-pin-tail"></span></div>';
  const big = Boolean(cand.primary);
  return L.divIcon({
    className: 'geo-pin-wrap',
    html,
    iconSize: big ? [38, 48] : [30, 40],
    iconAnchor: big ? [19, 46] : [15, 38],
    popupAnchor: [0, big ? -44 : -36],
  });
}

// Drop one pin per candidate, fit the map to all of them, and render the
// candidate list beneath. `candidates` is best-first; [0] is the primary.
function showLocations(candidates) {
  const cands = (candidates || []).filter(
    (c) => c && Number.isFinite(c.lat) && Number.isFinite(c.lng)
  );
  if (!cands.length) {
    hideMap();
    return;
  }

  mapWrap.classList.remove('hidden');
  const m = ensureMap();
  // The container was hidden when created, so Leaflet must recompute its size.
  setTimeout(() => m.invalidateSize(), 0);

  if (markerLayer) markerLayer.remove();
  markerLayer = L.layerGroup().addTo(m);
  markerRefs = [];

  let primaryMarker = null;
  cands.forEach((cand, i) => {
    const mk = L.marker([cand.lat, cand.lng], {
      icon: pinIcon(cand, i),
      zIndexOffset: cand.primary ? 1000 : 0,
    }).addTo(markerLayer);

    const title = escapeHtml(cand.label || cand.place || `Candidate ${i + 1}`);
    const tag = cand.primary
      ? '<span class="popup-tag">★ Best guess</span>'
      : `<span class="popup-tag alt">Alternative ${i + 1}</span>`;
    const reason = cand.reason ? `<div class="popup-reason">${escapeHtml(cand.reason)}</div>` : '';
    mk.bindPopup(`<div class="map-popup">${tag}<div class="popup-title">${title}</div>${reason}</div>`);

    markerRefs.push(mk);
    if (cand.primary || i === 0) primaryMarker = mk;
  });

  const primary = cands[0];
  lastCandidates = cands;
  fitMapToCandidates(cands);
  if (primaryMarker) primaryMarker.openPopup();

  mapLabel.textContent =
    `📍 ${primary.lat.toFixed(4)}, ${primary.lng.toFixed(4)}` +
    (cands.length > 1 ? ` · ${cands.length} candidates` : '');
  const q = `${primary.lat},${primary.lng}`;
  mapLink.dataset.url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

  renderCandidateList(cands);
}

// The candidate list under the map: best guess first; click a row to fly to it.
function renderCandidateList(cands) {
  if (!candidatesEl) return;
  candidatesEl.innerHTML = '';
  if (!cands.length) {
    candidatesEl.classList.add('hidden');
    return;
  }
  candidatesEl.classList.remove('hidden');

  const head = document.createElement('div');
  head.className = 'candidates-head';
  head.textContent = cands.length > 1 ? `Best guess + ${cands.length - 1} alternatives` : 'Best guess';
  candidatesEl.appendChild(head);

  cands.forEach((cand, i) => {
    const row = document.createElement('div');
    row.className = 'cand-row' + (cand.primary ? ' primary' : '');
    row.style.animationDelay = `${i * 0.07}s`;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'cand-main';
    main.innerHTML =
      `<span class="cand-dot">${i + 1}</span>` +
      `<span class="cand-body">` +
      `<span class="cand-label">${escapeHtml(cand.label || cand.place || `Candidate ${i + 1}`)}</span>` +
      (cand.reason ? `<span class="cand-reason">${escapeHtml(cand.reason)}</span>` : '') +
      `</span>` +
      (cand.primary ? '<span class="cand-tag">★ best</span>' : '');
    main.addEventListener('click', () => {
      flyToCandidate(cand);
      const mk = markerRefs[i];
      if (mk) mk.openPopup();
    });

    // Per-candidate "open in Google Maps" so every option is reachable, not just
    // the best guess.
    const maps = document.createElement('button');
    maps.type = 'button';
    maps.className = 'cand-maps';
    maps.title = 'Open this option in Google Maps';
    maps.innerHTML = '<span aria-hidden="true">↗</span>';
    maps.addEventListener('click', (e) => {
      e.stopPropagation();
      const q = `${cand.lat},${cand.lng}`;
      window.api.openExternal(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`);
    });

    row.appendChild(main);
    row.appendChild(maps);
    candidatesEl.appendChild(row);
  });
}

// Smoothly recenter the map on a candidate when its list row is clicked.
function flyToCandidate(cand) {
  if (!map) return;
  const z = Math.max(map.getZoom() || 0, cand.source === 'osm' ? 14 : 6);
  if (typeof map.flyTo === 'function') map.flyTo([cand.lat, cand.lng], z, { duration: 0.6 });
  else map.setView([cand.lat, cand.lng], z);
}

// --- Estimated-time progress bar ---------------------------------------------
// The bar's fill blends two signals: which discrete step we're on (so it always
// visibly advances at each step boundary) and elapsed-time vs. an estimate (so
// it also creeps forward smoothly between boundaries, like a real progress bar
// instead of jumping in big steps). Per-step durations are learned from past
// runs (localStorage), so the ETA gets more accurate the more you use the app.
const ETA_STORAGE_KEY = 'geolink.stepDurations.v1';

function loadStepDurations() {
  try {
    const v = JSON.parse(localStorage.getItem(ETA_STORAGE_KEY));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
let stepDurations = loadStepDurations();

// Fallback estimates (seconds) before any history exists, indexed by total-step
// count: [examine, closer look, (search clues), reason, (verify), final].
const DEFAULT_STEP_SECONDS = {
  4: [11, 9, 9, 13],
  6: [11, 9, 6, 9, 6, 13],
};

function estimateStepSeconds(pass, total) {
  const rec = stepDurations[`${total}|${pass}`];
  if (rec && rec.avg) return rec.avg;
  const arr = DEFAULT_STEP_SECONDS[total] || DEFAULT_STEP_SECONDS[6];
  return arr[pass - 1] || 10;
}

function estimateTotalSeconds(total) {
  let sum = 0;
  for (let p = 1; p <= total; p++) sum += estimateStepSeconds(p, total);
  return sum;
}

// Exponential moving average so estimates adapt to this machine/model's real
// speed over repeated uses without being thrown off by one slow/fast outlier.
function recordStepSeconds(pass, total, seconds) {
  const key = `${total}|${pass}`;
  const rec = stepDurations[key];
  stepDurations[key] = rec ? { avg: rec.avg * 0.7 + seconds * 0.3, n: rec.n + 1 } : { avg: seconds, n: 1 };
  try {
    localStorage.setItem(ETA_STORAGE_KEY, JSON.stringify(stepDurations));
  } catch {
    /* private mode / quota — the ETA just won't persist across runs */
  }
}

// --- Activity timeline ------------------------------------------------------
// A live "Analysing" panel: one row per pipeline step (spinner → check), each
// with an expandable body that streams the step's text or its web-search cards.
let currentStep = null; // the step element being filled right now

function resetActivity() {
  activityStepsEl.innerHTML = '';
  currentStep = null;
  activityStatusEl.textContent = '';
  activityStatusEl.className = 'activity-status';
  activityEl.classList.remove('hidden', 'done', 'collapsed');
}

// Let the user collapse/expand the timeline.
activityHeadEl.addEventListener('click', () => activityEl.classList.toggle('collapsed'));

// Mark the active step finished, then start a new one. Returns the step element.
function startStep(info) {
  if (currentStep) finishStep(currentStep);

  const li = document.createElement('li');
  li.className = 'step running';
  if (info.kind) li.dataset.kind = info.kind;

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'step-head';
  head.innerHTML =
    '<span class="step-icon"><span class="step-spinner"></span></span>' +
    `<span class="step-title">${escapeHtml(info.label || 'Working…')}</span>` +
    (info.sub ? `<span class="step-sub">${escapeHtml(info.sub)}</span>` : '<span class="step-sub"></span>') +
    '<span class="step-chevron">⌄</span>';

  const body = document.createElement('div');
  body.className = 'step-body';

  head.addEventListener('click', () => li.classList.toggle('collapsed'));

  li.appendChild(head);
  li.appendChild(body);
  activityStepsEl.appendChild(li);
  activityEl.scrollTop = activityEl.scrollHeight;

  currentStep = li;
  currentStep._body = body;
  return li;
}

function finishStep(li) {
  if (!li) return;
  li.classList.remove('running');
  li.classList.add('done', 'collapsed');
  const icon = li.querySelector('.step-icon');
  if (icon) icon.innerHTML = '✓';
}

// Append streamed text to the current step's body (used for the model steps).
function stepAppendText(text) {
  if (!currentStep) return;
  let pre = currentStep._body.querySelector('.step-stream');
  if (!pre) {
    pre = document.createElement('div');
    pre.className = 'step-stream';
    currentStep._body.appendChild(pre);
  }
  pre.textContent += text;
  activityEl.scrollTop = activityEl.scrollHeight;
}

// Render/update a single web-search result card inside `container` — shared by
// the analysis timeline's search steps and the follow-up chat's "thinking"
// block, so both look and behave identically.
function renderSearchCard(container, info) {
  if (info.empty) {
    const e = document.createElement('div');
    e.className = 'search-empty';
    e.textContent = 'No specific search terms were found — skipping web search.';
    container.appendChild(e);
    return;
  }

  // A "pending" event creates the card with a spinner; the result event fills it.
  let card = container.querySelector(`[data-q="${cssEscape(info.query)}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'search-card';
    card.dataset.q = info.query;
    card.innerHTML =
      `<div class="search-q"><span class="search-ico">🔍</span><span>${escapeHtml(info.query)}</span>` +
      '<span class="search-spin"></span></div><div class="search-results"></div>';
    container.appendChild(card);
  }
  if (info.pending) return;

  card.classList.add('resolved');
  const results = card.querySelector('.search-results');
  results.innerHTML = '';
  const places = info.places || [];
  const web = info.web || [];
  if (!places.length && !web.length) {
    results.innerHTML = '<div class="search-none">no results</div>';
    return;
  }
  for (const pl of places) {
    const row = document.createElement('div');
    row.className = 'search-hit place';
    row.innerHTML =
      `<span class="hit-ico">📍</span><span class="hit-text">${escapeHtml(pl.name)}</span>`;
    results.appendChild(row);
  }
  for (const w of web) {
    const row = document.createElement('div');
    row.className = 'search-hit web';
    row.innerHTML = `<span class="hit-ico">🔗</span><span class="hit-text">${escapeHtml(w)}</span>`;
    results.appendChild(row);
  }
}

// Render a web-search result card into the current activity step.
function stepAddSearch(info) {
  if (!currentStep) return;
  renderSearchCard(currentStep._body, info);
  activityEl.scrollTop = activityEl.scrollHeight;
}

// Minimal CSS attribute-selector escaper for the query string.
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

// The model asked the user a clarifying question. The main process is BLOCKED
// awaiting the reply, so we show a modal the user must act on — Answer or Skip
// (deny) — before the analysis continues. A note is also logged in the timeline.
let pendingQuestionId = null;

function showQuestion(info) {
  pendingQuestionId = info.id;
  questionText.textContent = info.question;
  questionInput.value = '';
  questionModal.classList.remove('hidden');
  setTimeout(() => questionInput.focus(), 80);

  // Leave a breadcrumb in the activity timeline too.
  if (currentStep) {
    const n = document.createElement('div');
    n.className = 'step-note';
    n.textContent = `Asked you: ${info.question}`;
    currentStep._body.appendChild(n);
  }
}

function answerQuestion(value) {
  if (pendingQuestionId == null) return;
  const id = pendingQuestionId;
  pendingQuestionId = null;
  questionModal.classList.add('hidden');
  window.api.answerQuestion(id, value || '');
  activityStatusEl.textContent = value ? 'Thanks — continuing…' : 'Skipped — continuing…';
  activityStatusEl.className = 'activity-status';
}

questionSend.addEventListener('click', () => answerQuestion(questionInput.value.trim()));
questionSkip.addEventListener('click', () => answerQuestion(''));
questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    answerQuestion(questionInput.value.trim());
  } else if (e.key === 'Escape') {
    e.preventDefault();
    answerQuestion('');
  }
});

mapLink.addEventListener('click', (e) => {
  e.preventDefault();
  const url = mapLink.dataset.url;
  if (url) window.api.openExternal(url);
});

// Parse the machine-readable "GEO: lat, lng" line the model is asked to emit,
// with a light fallback to the first decimal lat/lng pair in the text.
function parseCoords(text) {
  const geo = text.match(/^\s*GEO:\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/im);
  if (geo) {
    return validatePair(parseFloat(geo[1]), parseFloat(geo[2]));
  }
  if (/^\s*GEO:\s*none\s*$/im.test(text)) return null;

  // Fallback: a "lat, lng" decimal pair anywhere in the text.
  const pair = text.match(/(-?\d{1,2}(?:\.\d+)?)\s*[,/]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (pair) return validatePair(parseFloat(pair[1]), parseFloat(pair[2]));
  return null;
}

function validatePair(lat, lng) {
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  ) {
    return { lat, lng };
  }
  return null;
}

// Remove the machine-readable trailer so it isn't shown: an optional
// "Machine-readable…/map candidates" heading, the CANDIDATES block, the legacy
// GEO/PLACE lines, and any stray code fence around them. Everything from that
// trailer to the end is the final output, so we cut to end-of-string. Stripping
// mid-stream also hides the raw pipe rows as they arrive.
function stripGeoLine(text) {
  return text
    .replace(/^\s*#{0,6}\s*(machine-readable[^\n]*|map candidates)\s*$[\s\S]*$/im, '')
    .replace(/^[ \t]*`{3,}\s*$\s*CANDIDATES:[\s\S]*$/im, '')
    .replace(/^[ \t]*CANDIDATES:[\s\S]*$/im, '')
    .replace(/^\s*(GEO|PLACE):.*$/gim, '')
    .replace(/\n?\s*`{3,}\s*$/g, '')
    .trimEnd();
}

// Reasoning models (e.g. GLM-5.2) may emit a <think>...</think> chain of
// thought. Hide it from the displayed answer, including a not-yet-closed block
// that's still streaming.
function stripThink(text) {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = t.search(/<think>/i);
  if (open !== -1) t = t.slice(0, open);
  return t;
}

function cleanForDisplay(text) {
  return stripThink(stripGeoLine(text));
}

// Pull the "Best guess" line for the map popup, if present.
function bestGuessLine(text) {
  const m = text.match(/##\s*Best guess\s*\n+([^\n]+)/i);
  return m ? m[1].replace(/\*\*/g, '').trim() : '';
}

// --- Settings ---------------------------------------------------------------
function shortModelName(id) {
  // "zai-org/GLM-4.5V" -> "GLM-4.5V"
  return String(id).split('/').pop().replace(/:.*$/, '');
}

async function refreshSettingsBadge() {
  const s = await window.api.getSettings();
  // A configured endpoint is "ready" if it's local (no token needed) or has a token.
  const ready = s.local || s.hasApiKey;
  const label = s.local ? `${shortModelName(s.model)} · local` : shortModelName(s.model);
  modelBadge.textContent = ready ? label : 'no token';
  modelBadge.title = `${s.model}  @  ${s.baseUrl}`;
  modelBadge.style.color = ready ? '' : 'var(--warn)';
  return s;
}

async function openSettings() {
  const s = await window.api.getSettings();
  apiKeyInput.value = '';
  apiKeyInput.placeholder = s.hasApiKey
    ? '•••••••• saved — leave blank to keep it'
    : s.local
      ? '(not needed for local Ollama)'
      : 'hf_...';
  baseUrlInput.value = s.baseUrl || 'https://router.huggingface.co/v1';
  modelInput.value = s.model || 'zai-org/GLM-4.5V';
  reasoningInput.value = s.reasoningModel || 'zai-org/GLM-5.2';
  webSearchInput.checked = s.webSearch !== false;
  settingsModal.classList.remove('hidden');
  apiKeyInput.focus();
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsCancel.addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

// Preset buttons fill the endpoint + sensible model defaults for each provider.
presetHf.addEventListener('click', () => {
  baseUrlInput.value = 'https://router.huggingface.co/v1';
  if (!modelInput.value || /localhost|llama|llava|qwen|gemma|minicpm/i.test(modelInput.value)) {
    modelInput.value = 'zai-org/GLM-4.5V';
    reasoningInput.value = 'zai-org/GLM-5.2';
  }
});
presetOllama.addEventListener('click', () => {
  baseUrlInput.value = 'http://localhost:11434/v1';
  if (!modelInput.value || /\//.test(modelInput.value)) {
    modelInput.value = 'qwen2.5vl';
    reasoningInput.value = 'qwen2.5';
  }
});

settingsSave.addEventListener('click', async () => {
  await window.api.saveSettings({
    apiKey: apiKeyInput.value, // blank is ignored by main; keeps existing key
    baseUrl: baseUrlInput.value,
    model: modelInput.value,
    reasoningModel: reasoningInput.value,
    webSearch: webSearchInput.checked,
  });
  closeSettings();
  await refreshSettingsBadge();
});

// --- Image handling ---------------------------------------------------------
function renderThumbs() {
  thumbs.innerHTML = '';
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const cell = document.createElement('div');
    cell.className = 'thumb';
    cell.dataset.index = String(i);
    cell.title = 'Click to highlight clues';

    const el = document.createElement('img');
    el.src = `data:${img.mediaType};base64,${img.data}`;
    el.alt = img.name || `photo ${i + 1}`;
    cell.appendChild(el);

    const rm = document.createElement('button');
    rm.className = 'thumb-remove';
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.dataset.remove = String(i);
    cell.appendChild(rm);

    const n = (img.highlights || []).length;
    if (n) {
      const badge = document.createElement('span');
      badge.className = 'thumb-badge';
      badge.textContent = `${n} ✦`;
      cell.appendChild(badge);
    }

    thumbs.appendChild(cell);
  }

  // "Add more" tile
  if (images.length > 0 && images.length < MAX_IMAGES) {
    const add = document.createElement('div');
    add.className = 'thumb-add';
    add.dataset.add = '1';
    add.textContent = '+';
    add.title = 'Add more photos';
    thumbs.appendChild(add);
  }

  const has = images.length > 0;
  thumbs.classList.toggle('hidden', !has);
  dropzoneEmpty.classList.toggle('hidden', has);
  if (has && !busy) {
    leftStatus.style.color = '';
    leftStatus.textContent = `${images.length} photo${images.length === 1 ? '' : 's'} · click one to highlight clues`;
  } else if (!has) {
    leftStatus.textContent = '';
  }
  updateButtons();
}

function clearImages() {
  images = [];
  renderThumbs();
}

function updateButtons() {
  const none = images.length === 0;
  analyzeBtn.disabled = busy || none;
  clearBtn.disabled = busy || none;
  analyzeBtn.classList.toggle('loading', busy);
  if (btnLabel) btnLabel.textContent = busy ? 'Analyzing…' : 'Locate';
}

const SUPPORTED = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
  'image/gif': true,
};

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    if (!SUPPORTED[file.type]) {
      reject(new Error('Unsupported image type. Use JPEG, PNG, WebP, or GIF.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1];
      resolve({ name: file.name, mediaType: file.type, data: base64 });
    };
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.readAsDataURL(file);
  });
}

// Add one or more images (from files or the native picker), respecting the cap.
function addImages(newOnes) {
  let added = 0;
  let capped = false;
  for (const img of newOnes) {
    if (images.length >= MAX_IMAGES) {
      capped = true;
      break;
    }
    images.push(img);
    added += 1;
  }
  renderThumbs();
  if (capped) {
    leftStatus.style.color = 'var(--warn)';
    leftStatus.textContent = `Added ${added}. Limit is ${MAX_IMAGES} photos.`;
  }
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && f.type.startsWith('image/'));
  if (files.length === 0) return;
  const results = [];
  for (const f of files) {
    try {
      results.push(await fileToImage(f));
    } catch (err) {
      leftStatus.style.color = 'var(--warn)';
      leftStatus.textContent = err.message;
    }
  }
  if (results.length) addImages(results);
}

// Routing: × removes · a thumbnail opens the highlight editor · the + tile or
// empty space opens the file picker.
dropzone.addEventListener('click', async (e) => {
  if (busy) return;

  const rm = e.target.closest('.thumb-remove');
  if (rm) {
    e.stopPropagation();
    const idx = parseInt(rm.dataset.remove, 10);
    if (Number.isInteger(idx)) {
      images.splice(idx, 1);
      renderThumbs();
    }
    return;
  }

  const thumb = e.target.closest('.thumb');
  if (thumb) {
    const idx = parseInt(thumb.dataset.index, 10);
    if (Number.isInteger(idx)) openEditor(idx);
    return;
  }

  // + tile or empty dropzone → add photos
  const picked = await window.api.pickImage(); // array
  if (Array.isArray(picked) && picked.length) addImages(picked);
});

// Drag & drop (multiple)
['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  })
);
dropzone.addEventListener('drop', (e) => {
  if (busy) return;
  addFiles(e.dataTransfer.files);
});

// --- Highlight editor -------------------------------------------------------
let editIndex = -1;
let drawing = null;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function syncOverlay() {
  // Make the overlay exactly cover the displayed image inside the stage.
  editorOverlay.style.left = `${editorImg.offsetLeft}px`;
  editorOverlay.style.top = `${editorImg.offsetTop}px`;
  editorOverlay.style.width = `${editorImg.offsetWidth}px`;
  editorOverlay.style.height = `${editorImg.offsetHeight}px`;
}

function renderBoxes() {
  editorOverlay.innerHTML = '';
  const hs = (images[editIndex] && images[editIndex].highlights) || [];
  const W = editorOverlay.clientWidth;
  const H = editorOverlay.clientHeight;
  hs.forEach((h, i) => {
    const box = document.createElement('div');
    box.className = 'hl-box';
    box.style.left = `${h.x * W}px`;
    box.style.top = `${h.y * H}px`;
    box.style.width = `${h.w * W}px`;
    box.style.height = `${h.h * H}px`;
    const del = document.createElement('button');
    del.className = 'hl-del';
    del.type = 'button';
    del.textContent = '×';
    del.addEventListener('mousedown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      hs.splice(i, 1);
      renderBoxes();
    });
    box.appendChild(del);
    editorOverlay.appendChild(box);
  });
}

function openEditor(index) {
  if (busy) return;
  editIndex = index;
  const img = images[index];
  img.highlights = img.highlights || [];
  editorImg.onload = () => {
    syncOverlay();
    renderBoxes();
  };
  editorImg.src = `data:${img.mediaType};base64,${img.data}`;
  editorModal.classList.remove('hidden');
  // If the image was cached and onload didn't fire, sync now.
  if (editorImg.complete && editorImg.naturalWidth) {
    syncOverlay();
    renderBoxes();
  }
}

function closeEditor() {
  editorModal.classList.add('hidden');
  editIndex = -1;
  drawing = null;
  renderThumbs(); // refresh highlight badges
}

editorOverlay.addEventListener('mousedown', (e) => {
  if (editIndex < 0 || e.target.classList.contains('hl-del')) return;
  const rect = editorOverlay.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, rect.width);
  const y = clamp(e.clientY - rect.top, 0, rect.height);
  const el = document.createElement('div');
  el.className = 'hl-box';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  editorOverlay.appendChild(el);
  drawing = { x0: x, y0: y, el };
});

window.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const rect = editorOverlay.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, rect.width);
  const y = clamp(e.clientY - rect.top, 0, rect.height);
  drawing.el.style.left = `${Math.min(x, drawing.x0)}px`;
  drawing.el.style.top = `${Math.min(y, drawing.y0)}px`;
  drawing.el.style.width = `${Math.abs(x - drawing.x0)}px`;
  drawing.el.style.height = `${Math.abs(y - drawing.y0)}px`;
});

window.addEventListener('mouseup', () => {
  if (!drawing) return;
  const W = editorOverlay.clientWidth;
  const H = editorOverlay.clientHeight;
  const left = parseFloat(drawing.el.style.left) || 0;
  const top = parseFloat(drawing.el.style.top) || 0;
  const w = parseFloat(drawing.el.style.width) || 0;
  const h = parseFloat(drawing.el.style.height) || 0;
  drawing = null;
  if (w < 8 || h < 8) {
    renderBoxes();
    return;
  }
  const img = images[editIndex];
  img.highlights = img.highlights || [];
  img.highlights.push({ x: left / W, y: top / H, w: w / W, h: h / H });
  renderBoxes();
});

editorClear.addEventListener('click', () => {
  if (images[editIndex]) images[editIndex].highlights = [];
  renderBoxes();
});
editorDone.addEventListener('click', closeEditor);
editorModal.addEventListener('click', (e) => {
  if (e.target === editorModal) closeEditor();
});

// Crop each highlighted region from the original image at full resolution
// (scaled up a little for legibility) to send as extra close-up images.
function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('image load failed'));
    im.src = src;
  });
}

async function buildHighlightCrops() {
  const crops = [];
  for (const image of images) {
    const hs = image.highlights || [];
    if (!hs.length) continue;
    let im;
    try {
      im = await loadImageEl(`data:${image.mediaType};base64,${image.data}`);
    } catch {
      continue;
    }
    const NW = im.naturalWidth;
    const NH = im.naturalHeight;
    for (const h of hs) {
      const sx = clamp(h.x * NW, 0, NW);
      const sy = clamp(h.y * NH, 0, NH);
      const sw = clamp(h.w * NW, 0, NW - sx);
      const sh = clamp(h.h * NH, 0, NH - sy);
      if (sw < 8 || sh < 8) continue;
      const scale = clamp(700 / Math.max(sw, sh), 1, 3);
      const cw = Math.round(sw * scale);
      const ch = Math.round(sh * scale);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext('2d').drawImage(im, sx, sy, sw, sh, 0, 0, cw, ch);
      const url = canvas.toDataURL('image/jpeg', 0.9);
      crops.push({ mediaType: 'image/jpeg', data: url.split(',')[1] });
    }
  }
  return crops;
}

// Paste from clipboard (one or more images)
window.addEventListener('paste', (e) => {
  if (busy) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) addFiles(files);
});

clearBtn.addEventListener('click', () => {
  if (busy) return;
  resetAll();
});

// Full reset — wipes the UI AND tells the main process to drop the active
// conversation (freeing the held messages/images) so the next run starts fresh.
function resetAll() {
  clearImages();
  note.value = '';
  resultEl.classList.add('hidden');
  resultEl.innerHTML = '';
  resultEmpty.classList.remove('hidden');
  renderHomeRecent(); // back on the home screen — keep its recent list fresh
  activityEl.classList.add('hidden');
  activityStepsEl.innerHTML = '';
  usageEl.classList.add('hidden');
  usageEl.textContent = '';
  progressEl.classList.add('hidden');
  hideMap();
  // Reset the follow-up chat.
  chatEl.classList.add('hidden');
  chatLog.innerHTML = '';
  chatInput.value = '';
  currentSessionId = null;
  chatTurnIndex = 0;
  leftStatus.style.color = '';
  leftStatus.textContent = '';
  // Tell main to forget the conversation so the AI is fresh and memory is freed.
  try {
    window.api.resetSession();
  } catch {
    /* main may be mid-call; harmless */
  }
}

// --- Analyze ----------------------------------------------------------------
analyzeBtn.addEventListener('click', runAnalysis);

async function runAnalysis() {
  if (images.length === 0 || busy) return;

  const settings = await window.api.getSettings();
  if (!settings.hasApiKey && !settings.local) {
    openSettings();
    return;
  }

  busy = true;
  updateButtons();
  leftStatus.style.color = '';
  leftStatus.textContent = 'Preparing…';

  resultEmpty.classList.add('hidden');
  usageEl.classList.add('hidden');
  hideMap();
  // Starting fresh: clear any previous run's follow-up chat.
  chatEl.classList.add('hidden');
  chatLog.innerHTML = '';
  currentSessionId = null;
  chatTurnIndex = 0;
  // The structured report appears only once we reach the final step; until then
  // the activity timeline carries the progress.
  resultEl.classList.add('hidden');
  resultEl.classList.remove('cursor');
  resultEl.innerHTML = '';
  resetActivity();

  // Progress bar: start indeterminate until the first step reports pass/total.
  progressEl.classList.remove('hidden');
  progressEl.classList.add('indeterminate');
  progressBar.style.width = '';
  progressMetaEl.classList.add('hidden');
  progressEtaEl.textContent = 'Estimating…';
  progressPercentEl.textContent = '0%';

  // Per-run ETA state: blends discrete step progress with elapsed-vs-estimated
  // time so the bar creeps forward smoothly, not just in big jumps per step.
  let etaTimer = null;
  let runStartedAt = 0;
  let estimatedTotalMs = 0;
  let curStepPass = 0;
  let curStepTotal = 0;
  let curStepStartedAt = 0;

  function updateEtaUi() {
    // The bar's percentage must always agree with "Step X of Y" — so progress
    // is bounded to THIS step's own slice of the bar ([pass-1, pass] / total)
    // and creeps toward (but never reaches) the end of that slice using how
    // long this step alone is expected to take. A slow step just holds near
    // its slice's ceiling instead of racing ahead into later steps' territory
    // (which is what let a slow local model show "97%" while still on step 1).
    const stepStart = curStepTotal ? (curStepPass - 1) / curStepTotal : 0;
    const stepSlice = curStepTotal ? 1 / curStepTotal : 0;
    const stepElapsedMs = Date.now() - curStepStartedAt;
    const stepEstimateMs = estimateStepSeconds(curStepPass, curStepTotal) * 1000;
    const withinStep = stepEstimateMs > 0 ? Math.min(0.92, stepElapsedMs / stepEstimateMs) : 0;
    const pct = Math.round((stepStart + stepSlice * withinStep) * 100);
    progressBar.style.width = `${pct}%`;
    progressPercentEl.textContent = `${pct}%`;

    // The "~Ns left" text is a separate, purely informational overall estimate
    // — it's fine for this to run past its own number on a slow step; it just
    // switches to a plain "taking longer" message instead of a false countdown.
    const elapsed = Date.now() - runStartedAt;
    const remainingMs = estimatedTotalMs - elapsed;
    if (remainingMs > 1500) {
      progressEtaEl.textContent = `~${Math.ceil(remainingMs / 1000)}s left`;
    } else if (elapsed < estimatedTotalMs + 15000) {
      progressEtaEl.textContent = 'almost there…';
    } else {
      progressEtaEl.textContent = 'taking longer than usual…';
    }
  }

  function startEtaTimer(total) {
    if (etaTimer) clearInterval(etaTimer);
    runStartedAt = Date.now();
    estimatedTotalMs = estimateTotalSeconds(total) * 1000;
    progressMetaEl.classList.remove('hidden');
    etaTimer = setInterval(updateEtaUi, 250);
    updateEtaUi();
  }

  function stopEtaTimer() {
    if (etaTimer) {
      clearInterval(etaTimer);
      etaTimer = null;
    }
  }

  // Build high-res crops of any highlighted regions to send to the AI.
  const highlights = await buildHighlightCrops();

  // `raw` accumulates the CURRENT step's streamed text.
  let raw = '';
  let curFinal = false; // are we streaming the final report now?

  function renderReport() {
    const body = cleanForDisplay(raw);
    // During the reasoning model's silent "thinking" phase there's no text yet.
    const placeholder = !body.trim() ? '_Reasoning…_' : '';
    resultEl.innerHTML = renderMarkdown(body || placeholder);
    resultEl.scrollTop = resultEl.scrollHeight;
  }

  const offDelta = window.api.onDelta((delta) => {
    raw += delta;
    if (curFinal) renderReport();
    else stepAppendText(delta);
  });

  const offPass = window.api.onPass((info) => {
    if (info.retry) {
      activityStatusEl.textContent = `rate-limited, retry ${info.retry}…`;
      activityStatusEl.className = 'activity-status warn';
      return;
    }
    // Record the actual duration of whichever step just finished, so the ETA
    // gets more accurate on future runs.
    if (curStepPass && curStepTotal) {
      const secs = (Date.now() - curStepStartedAt) / 1000;
      if (secs > 0.2) recordStepSeconds(curStepPass, curStepTotal, secs);
    }
    raw = '';
    curFinal = Boolean(info.final);
    if (info.total) {
      progressEl.classList.remove('indeterminate');
      if (info.pass === 1) startEtaTimer(info.total);
      curStepPass = info.pass;
      curStepTotal = info.total;
      curStepStartedAt = Date.now();
      updateEtaUi();
    }
    activityStatusEl.textContent = `Step ${info.pass} of ${info.total}`;
    activityStatusEl.className = 'activity-status';

    startStep({
      label: info.label || (info.final ? 'Writing the report' : 'Working…'),
      sub: info.model ? shortModelName(info.model) : '',
      kind: info.final ? 'final' : /search|verif/i.test(info.label || '') ? 'search' : 'model',
    });

    if (info.final) {
      // Reveal the report area and stream the answer there, not into the log.
      resultEl.classList.remove('hidden');
      resultEl.classList.add('cursor');
      resultEl.innerHTML = '';
    }
  });

  const offNote = window.api.onNote((text) => {
    activityStatusEl.textContent = text;
    activityStatusEl.className = 'activity-status';
    if (currentStep) {
      const n = document.createElement('div');
      n.className = 'step-note';
      n.textContent = text;
      currentStep._body.appendChild(n);
      activityEl.scrollTop = activityEl.scrollHeight;
    }
  });

  const offSearch = window.api.onSearch((info) => stepAddSearch(info));
  const offQuestion = window.api.onQuestion((info) => showQuestion(info));

  // The main process resolves the pins (geocoded via OpenStreetMap when possible)
  // and sends them here as a candidates array. These authoritative coordinates
  // win over anything parsed from the text. Tolerates a legacy single-pin shape.
  let located = null;
  const offLocated = window.api.onLocated((payload) => {
    const cands =
      payload && Array.isArray(payload.candidates)
        ? payload.candidates
        : payload && Number.isFinite(payload.lat)
          ? [payload]
          : [];
    if (cands.length) {
      located = cands;
      showLocations(cands);
    }
  });

  const res = await window.api.analyze({
    images: images.map((im) => ({ mediaType: im.mediaType, data: im.data })),
    highlights,
    note: note.value,
  });

  offDelta();
  offPass();
  offNote();
  offSearch();
  offQuestion();
  offLocated();
  // The final step's duration is never recorded by offPass (it only fires at
  // the START of each step), so record it here now that it's actually done.
  if (curStepPass && curStepTotal) {
    const secs = (Date.now() - curStepStartedAt) / 1000;
    if (secs > 0.2) recordStepSeconds(curStepPass, curStepTotal, secs);
  }
  stopEtaTimer();
  finishStep(currentStep);
  currentStep = null;
  activityEl.classList.add('done');
  // Collapse the finished timeline so the report, map and chat are front-and-centre.
  if (res.ok) activityEl.classList.add('collapsed');
  resultEl.classList.remove('cursor');
  busy = false;
  updateButtons();
  leftStatus.style.color = '';
  leftStatus.textContent = '';

  // Finish and fade out the progress bar.
  progressEl.classList.remove('indeterminate');
  progressBar.style.width = '100%';
  progressPercentEl.textContent = '100%';
  progressEtaEl.textContent = res.ok ? 'Done' : 'Stopped';
  setTimeout(() => {
    progressEl.classList.add('hidden');
    progressMetaEl.classList.add('hidden');
  }, 600);

  if (!res.ok) {
    activityStatusEl.textContent = res.error;
    activityStatusEl.className = 'activity-status warn';
    if (!raw) {
      resultEl.classList.add('hidden');
      resultEmpty.classList.remove('hidden');
      renderHomeRecent();
    }
    return;
  }

  // Final synthesis: render the structured answer and map it.
  const finalText = stripThink(raw);
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = renderMarkdown(cleanForDisplay(raw));

  // Prefer the candidates the main process resolved (geocoded via OpenStreetMap
  // when possible); `res.candidates` is authoritative, the event was just for a
  // live pre-completion update.
  const cands =
    res.candidates && res.candidates.length
      ? res.candidates
      : Array.isArray(located)
        ? located
        : [];
  if (cands.length) {
    showLocations(cands);
    const anyOsm = cands.some((c) => c.source === 'osm');
    activityStatusEl.textContent =
      cands.length > 1
        ? `Done — ${cands.length} locations mapped`
        : anyOsm
          ? 'Done — pin placed via OpenStreetMap'
          : 'Done';
  } else {
    const coords = parseCoords(finalText);
    if (coords) {
      showLocations([{ lat: coords.lat, lng: coords.lng, label: bestGuessLine(finalText), primary: true }]);
      activityStatusEl.textContent = 'Done';
    } else {
      hideMap();
      activityStatusEl.textContent = 'Done — no mappable coordinates were returned';
    }
  }

  if (res.usage) {
    usageEl.textContent = `${shortModelName(res.model)} · final step ${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens`;
    usageEl.classList.remove('hidden');
  }

  // Open the follow-up chat so the user can refine the location further, and
  // scroll it into view (with a brief highlight) so it's obvious it's there.
  currentSessionId = res.sessionId || null;
  openChat();
  setTimeout(() => {
    if (typeof chatEl.scrollIntoView === 'function') {
      chatEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    chatEl.classList.remove('flash');
    void chatEl.offsetWidth; // restart the animation
    chatEl.classList.add('flash');
  }, 160);
}

// --- Follow-up chat ---------------------------------------------------------
function openChat() {
  chatEl.classList.remove('hidden');
}

// Each bubble carries its position in the persisted sess.chat array (matching
// order: user, assistant, user, assistant, …) so a "revert" click can tell the
// main process exactly which turn to roll back to.
function addChatBubble(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `chat-msg ${role}`;
  const idx = chatTurnIndex++;
  wrap.dataset.chatIndex = String(idx);

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(cleanForDisplay(text)) || '<p class="muted">…</p>';
  } else {
    bubble.textContent = text;
  }
  wrap.appendChild(bubble);

  if (role === 'assistant') {
    const revert = document.createElement('button');
    revert.type = 'button';
    revert.className = 'chat-revert';
    revert.title = 'Go back to this point in the conversation';
    revert.innerHTML = '↺';
    revert.addEventListener('click', () => revertChatTo(idx));
    wrap.appendChild(revert);
  }

  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}

// "Go back" — discard every chat turn after this assistant reply, restoring
// the map to whatever it showed at that point. Confirms first since it
// permanently drops the later turns from the saved session.
async function revertChatTo(idx) {
  if (chatBusy || busy) return;
  const laterCount = Array.from(chatLog.children).filter(
    (n) => Number(n.dataset.chatIndex) > idx
  ).length;
  if (laterCount === 0) return; // already the latest turn — nothing to revert
  const ok = window.confirm(
    `Go back to this point? The ${laterCount} message${laterCount === 1 ? '' : 's'} after it will be removed.`
  );
  if (!ok) return;

  let res;
  try {
    res = await window.api.revertChat(idx);
  } catch (e) {
    res = { ok: false, error: e.message || String(e) };
  }
  if (!res || !res.ok) return;

  for (const n of Array.from(chatLog.children)) {
    if (Number(n.dataset.chatIndex) > idx) n.remove();
  }
  chatTurnIndex = idx + 1;
  if (res.candidates && res.candidates.length) showLocations(res.candidates);
}

function autoSizeChatInput() {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(120, chatInput.scrollHeight)}px`;
}

// A collapsible "🤔 Thinking" block shown above the reply — the visible half
// of the refine feature's extra reasoning pass (see chat:think in main.js).
function createThinkBlock() {
  const el = document.createElement('div');
  el.className = 'chat-think running';
  el.innerHTML =
    '<button type="button" class="think-head">' +
    '<span class="think-icon"><span class="step-spinner"></span></span>' +
    '<span class="think-title">Thinking it through…</span>' +
    '<span class="think-chevron">⌄</span></button>' +
    '<div class="think-body"></div>';
  el.querySelector('.think-head').addEventListener('click', () => el.classList.toggle('collapsed'));
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function appendThinkText(block, text) {
  if (!block) return;
  const body = block.querySelector('.think-body');
  let pre = body.querySelector('.step-stream');
  if (!pre) {
    pre = document.createElement('div');
    pre.className = 'step-stream';
    body.appendChild(pre);
  }
  pre.textContent += text;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addThinkSearch(block, info) {
  if (!block) return;
  renderSearchCard(block.querySelector('.think-body'), info);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function finishThinkBlock(block, searched) {
  if (!block) return;
  block.classList.remove('running');
  block.classList.add('done', 'collapsed');
  const icon = block.querySelector('.think-icon');
  if (icon) icon.innerHTML = '🤔';
  const title = block.querySelector('.think-title');
  if (title) title.textContent = searched ? 'Thought it through + checked online' : 'Thought it through';
}

async function sendFollowup() {
  if (chatBusy || busy) return;
  const msg = chatInput.value.trim();
  if (!msg) return;

  chatBusy = true;
  chatSend.classList.add('loading');
  chatSend.disabled = true;
  chatInput.value = '';
  autoSizeChatInput();
  addChatBubble('user', msg);

  // Pass 1 (visible): a short "thinking" block, with a live search card if the
  // model decides checking something online would help. Pass 2 (below) is the
  // real, persisted reply — created lazily once it actually starts streaming.
  const think = createThinkBlock();
  let bubble = null;

  const offThink = window.api.onChatThink((info) => {
    if (info.stage === 'done') finishThinkBlock(think, info.searched);
  });
  const offThinkDelta = window.api.onChatThinkDelta((d) => appendThinkText(think, d));
  const offThinkSearch = window.api.onChatSearch((info) => addThinkSearch(think, info));

  let raw = '';
  const offDelta = window.api.onChatDelta((d) => {
    raw += d;
    if (!bubble) bubble = addChatBubble('assistant', '');
    bubble.innerHTML = renderMarkdown(cleanForDisplay(raw)) || '<p class="muted">…</p>';
    chatLog.scrollTop = chatLog.scrollHeight;
  });
  const offLocated = window.api.onChatLocated((payload) => {
    const cands = payload && Array.isArray(payload.candidates) ? payload.candidates : [];
    if (cands.length) showLocations(cands);
  });

  let res;
  try {
    res = await window.api.followup(msg);
  } catch (e) {
    res = { ok: false, error: e.message || String(e) };
  }

  offThink();
  offThinkDelta();
  offThinkSearch();
  offDelta();
  offLocated();
  // Safety net: the 'done' event normally finishes this already; only force it
  // if something went wrong before that event arrived (e.g. no IPC response).
  if (think.classList.contains('running')) finishThinkBlock(think, false);
  chatBusy = false;
  chatSend.classList.remove('loading');
  chatSend.disabled = false;

  if (!bubble) bubble = addChatBubble('assistant', '');

  if (!res.ok) {
    bubble.innerHTML = `<p class="chat-error">${escapeHtml(res.error || 'Something went wrong.')}</p>`;
    return;
  }

  const cleaned = cleanForDisplay(res.text || '').trim();
  const cands = res.candidates && res.candidates.length ? res.candidates : null;
  let html = cleaned ? renderMarkdown(cleaned) : '';
  if (!html) {
    // The model may reply with only a CANDIDATES block (stripped from display);
    // confirm what changed instead of showing an empty bubble.
    if (cands) {
      const top = cands[0];
      html = `<p>📍 Updated the map — best guess is now <strong>${escapeHtml(
        top.label || top.place || 'the new location'
      )}</strong>.</p>`;
    } else {
      html = '<p class="muted">No change to the location.</p>';
    }
  }
  bubble.innerHTML = html;
  if (cands) showLocations(cands);
  chatInput.focus();
}

chatSend.addEventListener('click', sendFollowup);
chatInput.addEventListener('input', autoSizeChatInput);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendFollowup();
  }
});

// --- History (saved chats) --------------------------------------------------
function closeHistory() {
  historyModal.classList.add('hidden');
}

// One saved-chat row, shared by the History modal (with delete) and the home
// screen's "Recent chats" list (without) — so both look and behave the same.
function buildSessionRow(it, { allowDelete, index } = {}) {
  const row = document.createElement('div');
  row.className = 'history-row';
  if (Number.isFinite(index)) row.style.animationDelay = `${index * 0.05}s`;
  const when = new Date(it.updatedAt || it.createdAt || Date.now());
  const turns = it.turns ? ` · ${it.turns} message${it.turns === 1 ? '' : 's'}` : '';
  row.innerHTML =
    '<button type="button" class="history-open">' +
    '<span class="history-title"></span>' +
    '<span class="history-meta muted"></span></button>' +
    (allowDelete ? '<button type="button" class="history-del" title="Delete">×</button>' : '');
  row.querySelector('.history-title').textContent = it.title || 'Untitled location';
  row.querySelector('.history-meta').textContent = when.toLocaleString() + turns;
  row.querySelector('.history-open').addEventListener('click', () => loadHistory(it.id));
  if (allowDelete) {
    row.querySelector('.history-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await window.api.deleteSession(it.id);
      } catch {
        /* ignore */
      }
      if (currentSessionId === it.id) currentSessionId = null;
      openHistory();
      renderHomeRecent(); // keep the home screen's list in sync too
    });
  }
  return row;
}

async function openHistory() {
  historyModal.classList.remove('hidden');
  historyList.innerHTML = '<p class="muted small">Loading…</p>';
  let items = [];
  try {
    items = await window.api.listSessions();
  } catch {
    items = [];
  }
  if (!items.length) {
    historyList.innerHTML = '<p class="muted small">No saved chats yet. Locate a photo to start one.</p>';
    return;
  }
  historyList.innerHTML = '';
  items.forEach((it, i) => historyList.appendChild(buildSessionRow(it, { allowDelete: true, index: i })));
}

// The home screen's short recent-chats list — the "start new or open an old
// one" choice you land on when the app opens, or after Clear.
async function renderHomeRecent() {
  if (!homeRecentList) return;
  let items = [];
  try {
    items = await window.api.listSessions();
  } catch {
    items = [];
  }
  homeRecentList.innerHTML = '';
  if (!items.length) {
    homeRecentList.innerHTML = '<p class="muted small">No saved chats yet — locate a photo to start one.</p>';
    return;
  }
  items.slice(0, 4).forEach((it, i) => homeRecentList.appendChild(buildSessionRow(it, { allowDelete: false, index: i })));
}

async function loadHistory(id) {
  let s = null;
  try {
    s = await window.api.loadSession(id);
  } catch {
    s = null;
  }
  if (!s) return;
  closeHistory();
  restoreSession(s);
}

// Rebuild the UI from a saved session (and main has already made it active).
function restoreSession(s) {
  busy = false;
  chatBusy = false;
  currentSessionId = s.id;

  images = Array.isArray(s.images) ? s.images.map((im) => ({ ...im, highlights: [] })) : [];
  renderThumbs();
  note.value = s.note || '';

  resultEmpty.classList.add('hidden');
  activityEl.classList.add('hidden');
  activityStepsEl.innerHTML = '';
  progressEl.classList.add('hidden');
  progressMetaEl.classList.add('hidden');
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = renderMarkdown(cleanForDisplay(s.reportText || ''));
  usageEl.classList.add('hidden');

  if (Array.isArray(s.candidates) && s.candidates.length) showLocations(s.candidates);
  else hideMap();

  chatLog.innerHTML = '';
  chatTurnIndex = 0;
  for (const m of s.chat || []) addChatBubble(m.role === 'user' ? 'user' : 'assistant', m.text);
  openChat();

  leftStatus.style.color = '';
  leftStatus.textContent = 'Loaded a saved chat — keep refining it below.';
}

historyBtn.addEventListener('click', openHistory);
historyClose.addEventListener('click', closeHistory);
historyModal.addEventListener('click', (e) => {
  if (e.target === historyModal) closeHistory();
});
homeSeeAllBtn.addEventListener('click', openHistory);

// --- Tiny Markdown renderer -------------------------------------------------
// Handles the subset the prompt emits: ## headings, **bold**, `code`,
// and - bulleted lists. Escapes HTML first so model output can't inject markup.
function renderMarkdown(md) {
  const escaped = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = escaped.split('\n');
  let html = '';
  let inList = false;

  const inline = (s) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    if (trimmed.startsWith('## ')) {
      closeList();
      html += `<h2>${inline(trimmed.slice(3))}</h2>`;
    } else if (trimmed.startsWith('# ')) {
      closeList();
      html += `<h2>${inline(trimmed.slice(2))}</h2>`;
    } else if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${inline(trimmed.replace(/^[-*]\s+/, ''))}</li>`;
    } else {
      closeList();
      html += `<p>${inline(trimmed)}</p>`;
    }
  }
  closeList();
  return html;
}

// --- Init -------------------------------------------------------------------
(async function init() {
  const s = await refreshSettingsBadge();
  if (!s.hasApiKey && !s.local) {
    leftStatus.style.color = 'var(--warn)';
    leftStatus.textContent = 'Add a token (or point the endpoint at local Ollama) in Settings to begin.';
  }
  renderHomeRecent();
})();
