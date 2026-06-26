'use strict';

// --- DOM refs ---------------------------------------------------------------
const dropzone = document.getElementById('dropzone');
const dropzoneEmpty = document.getElementById('dropzone-empty');
const preview = document.getElementById('preview');
const note = document.getElementById('note');
const analyzeBtn = document.getElementById('analyze-btn');
const clearBtn = document.getElementById('clear-btn');
const leftStatus = document.getElementById('left-status');

const resultEl = document.getElementById('result');
const resultEmpty = document.getElementById('result-empty');
const usageEl = document.getElementById('usage');
const modelBadge = document.getElementById('model-badge');

const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const apiKeyInput = document.getElementById('api-key');
const modelSelect = document.getElementById('model-select');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');

// --- State ------------------------------------------------------------------
let currentImage = null; // { mediaType, data, name }
let busy = false;

// --- Settings ---------------------------------------------------------------
async function refreshSettingsBadge() {
  const s = await window.api.getSettings();
  modelBadge.textContent = s.hasApiKey ? s.model : 'no API key';
  modelBadge.style.color = s.hasApiKey ? '' : 'var(--warn)';
  modelSelect.value = s.model;
  return s;
}

function openSettings() {
  apiKeyInput.value = '';
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

settingsSave.addEventListener('click', async () => {
  await window.api.saveSettings({
    apiKey: apiKeyInput.value, // blank is ignored by main; keeps existing key
    model: modelSelect.value,
  });
  closeSettings();
  await refreshSettingsBadge();
});

// --- Image handling ---------------------------------------------------------
function setImage(img) {
  currentImage = img;
  preview.src = `data:${img.mediaType};base64,${img.data}`;
  preview.classList.remove('hidden');
  dropzoneEmpty.classList.add('hidden');
  leftStatus.textContent = img.name ? `Loaded: ${img.name}` : 'Image ready';
  updateButtons();
}

function clearImage() {
  currentImage = null;
  preview.src = '';
  preview.classList.add('hidden');
  dropzoneEmpty.classList.remove('hidden');
  leftStatus.textContent = '';
  updateButtons();
}

function updateButtons() {
  analyzeBtn.disabled = busy || !currentImage;
  clearBtn.disabled = busy || !currentImage;
  analyzeBtn.textContent = busy ? 'Analyzing…' : 'Locate photo';
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

async function handleFile(file) {
  try {
    setImage(await fileToImage(file));
  } catch (err) {
    leftStatus.textContent = err.message;
    leftStatus.style.color = 'var(--warn)';
  }
}

// Click to pick via native dialog
dropzone.addEventListener('click', async () => {
  if (busy) return;
  const img = await window.api.pickImage();
  if (img) setImage(img);
});

// Drag & drop
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
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// Paste from clipboard
window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) handleFile(file);
      break;
    }
  }
});

clearBtn.addEventListener('click', () => {
  if (busy) return;
  clearImage();
  resultEl.classList.add('hidden');
  resultEl.innerHTML = '';
  resultEmpty.classList.remove('hidden');
  usageEl.classList.add('hidden');
});

// --- Analyze ----------------------------------------------------------------
analyzeBtn.addEventListener('click', runAnalysis);

async function runAnalysis() {
  if (!currentImage || busy) return;

  const settings = await window.api.getSettings();
  if (!settings.hasApiKey) {
    openSettings();
    return;
  }

  busy = true;
  updateButtons();
  leftStatus.style.color = '';
  leftStatus.textContent = 'Asking Claude to read the clues…';

  resultEmpty.classList.add('hidden');
  usageEl.classList.add('hidden');
  resultEl.classList.remove('hidden');
  resultEl.classList.add('cursor');
  resultEl.innerHTML = '';

  let raw = '';
  const unsubscribe = window.api.onDelta((delta) => {
    raw += delta;
    resultEl.innerHTML = renderMarkdown(raw);
    resultEl.scrollTop = resultEl.scrollHeight;
  });

  const res = await window.api.analyze({
    mediaType: currentImage.mediaType,
    data: currentImage.data,
    note: note.value,
  });

  unsubscribe();
  resultEl.classList.remove('cursor');
  busy = false;
  updateButtons();

  if (!res.ok) {
    leftStatus.style.color = 'var(--warn)';
    leftStatus.textContent = res.error;
    if (!raw) {
      resultEl.classList.add('hidden');
      resultEmpty.classList.remove('hidden');
    }
    return;
  }

  resultEl.innerHTML = renderMarkdown(raw);
  leftStatus.textContent = 'Done.';
  if (res.usage) {
    usageEl.textContent = `${res.model} · ${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens`;
    usageEl.classList.remove('hidden');
  }
}

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
  if (!s.hasApiKey) {
    leftStatus.style.color = 'var(--warn)';
    leftStatus.textContent = 'Add your Anthropic API key in Settings to begin.';
  }
})();
