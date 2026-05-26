let configs = [];
let esMap = {};
let logScrollPaused = {};
let activeLogs = {};
let cardState = {};
let fileDialogCallback = null;
let ctxDialogTarget = null;
let globalRuntimeCfg = '';
let globalHfCache = '';
let focusedCard = null;
let focusedCardEl = null;
let expandedCard = null;
let sortMode = 'recent';
let lastUsed = {};
let runtimeExists = {};

function setSortMode(mode) {
  if (expandedCard) {
    showToast('Collapse the card first to change sort order', 'err');
    return;
  }
  sortMode = mode;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === mode));
  renderCards();
  const firstCard = document.querySelector('.card:not(.hidden)');
  if (firstCard) {
    focusCard(firstCard.dataset.name);
  } else if (configs.length) {
    focusCard(configs[0].name);
  }
  validateRuntimes();
}

async function loadConfigs() {
  try {
    configs = await fetch('/api/configs').then(r => r.json());
    configs.forEach(c => {
      if (!cardState[c.name]) cardState[c.name] = { mode: 'constructor', editing: false, originalArgs: c.args_str, originalEnv: c.env_str, originalRuntime: c.runtime };
      cardState[c.name].originalArgs = c.args_str;
      cardState[c.name].originalEnv = c.env_str;
      cardState[c.name].originalRuntime = c.runtime || '';
      if (c.last_used) lastUsed[c.name] = c.last_used;
    });
  } catch(e) {
    console.error('loadConfigs error:', e);
  }
  renderCards();
  if (configs.length) {
    focusCard(focusedCard || configs[0].name);
  }
}

function focusCard(name) {
  if (focusedCardEl) focusedCardEl.classList.remove('focused');
  if (name) {
    const card = document.getElementById('card-' + cssEscape(name));
    if (card) { card.classList.add('focused'); focusedCardEl = card; }
    focusedCard = name;
  } else {
    focusedCard = null;
    focusedCardEl = null;
  }
  updateGlobalMenuBtns();
  updateGlobalExpandBtn();
}

function toggleExpand(optName, enterEdit) {
  const name = optName || expandedCard || focusedCard;
  if (!name) return;
  const container = document.getElementById('cardsContainer');
  if (!container) return;

  if (expandedCard === name) {
    const st = cardState[name];
    if (st && st.editing) {
      if (st.isNew) {
        cancelEdit(name);
        return;
      }
      st.editing = false;
      updateCardHeader(name);
      const runBtn = document.getElementById('card-'+cssEscape(name))?.querySelector('.toolbar-btn.run, .toolbar-btn.stop');
      if (runBtn) runBtn.disabled = false;
    }
    expandedCard = null;
    container.classList.remove('expanded');
    container.querySelectorAll('.card').forEach(el => el.classList.remove('expanded', 'hidden'));
  } else {
    expandedCard = name;
    container.classList.add('expanded');
    container.querySelectorAll('.card').forEach(el => {
      if (el.id === 'card-' + cssEscape(name)) {
        el.classList.add('expanded');
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
        el.classList.remove('expanded');
      }
    });
    if (enterEdit) {
      const st = cardState[name];
      if (st) {
        st.editing = true;
        updateCardHeader(name);
        const runBtn = document.getElementById('card-'+cssEscape(name))?.querySelector('.toolbar-btn.run, .toolbar-btn.stop');
        if (runBtn) runBtn.disabled = true;
      }
    }
  }
  updateSortDisabled();
  updateGlobalExpandBtn();
}

function onCardClick(event, name) {
  focusCard(name);
}

function extractModelPath(argsStr) {
  const m = argsStr.match(/(?:--model|-m)(?:\s+|=)(?:"([^"]*)"|(\S+))/);
  return m ? (m[1] || m[2]) : '';
}

function setModelPath(argsStr, newPath) {
  const hasModel = /(?:--model|-m)(?:\s*=|[\s=])/.test(argsStr);
  if (hasModel) {
    return argsStr.replace(/(?:--model|-m)(?:\s+|=)(?:"([^"]*)"|(\S+))/, `--model ${newPath}`);
  }
  return argsStr ? `--model ${newPath} ${argsStr}` : `--model ${newPath}`;
}

function setCtxInArgs(argsStr, val) {
  if (/--ctx-size(?:\s+|=)/.test(argsStr)) {
    return argsStr.replace(/--ctx-size(?:\s+|=)(\d+)/, '--ctx-size ' + val);
  }
  if (/-c(?:\s+|=)/.test(argsStr)) {
    return argsStr.replace(/-c(?:\s+|=)(\d+)/, '-c ' + val);
  }
  return argsStr + ' --ctx-size ' + val;
}

function parseArgs(argsStr) {
  const tokens = argsStr.match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
  const params = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-') && t.length > 1) {
      const eqIdx = t.indexOf('=');
      if (eqIdx > 1) {
        params.push({ flag: t.substring(0, eqIdx), value: t.substring(eqIdx + 1) });
      } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        params.push({ flag: t, value: tokens[i + 1] });
        i++;
      } else {
        params.push({ flag: t, value: '' });
      }
    } else {
      params.push({ flag: null, value: t });
    }
  }
  return params;
}

function buildArgsStr(params) {
  return params.map(p => {
    if (p.flag === null) return p.value;
    const val = /\s/.test(p.value) ? '"' + p.value + '"' : p.value;
    return p.flag + (val ? ' ' + val : '');
  }).join(' ');
}

function renderArgsDisplay(name, argsStr) {
  const params = parseArgs(argsStr);
  const en = escJs(name);
  const cfg = configs.find(c => c.name === name);
  const rtPath = effectiveRuntime(cfg);
  const isCustom = !!cfg.runtime;
  const parts = [];

  // runtime button as first element
  {
    const rtLabel = isCustom ? '<span class="llama-icon">🦙</span>' : '🦙';
    const rtBase = rtPath ? (rtPath.split('/').pop().split('\\').pop() || rtPath) : '';
    const rtTitle = rtPath ? escHtml(rtPath) : 'Click to select runtime binary';
    const rtDisplay = rtBase || 'select';
    parts.push(`<span class="arg-row"><span class="arg-flag runtime-btn-label">run</span> <button class="arg-btn runtime-btn${isCustom ? ' custom' : ''}" id="runtime-${cssEscape(name)}" onclick="showRuntimeDialog('${en}')" title="${rtTitle}">${rtLabel} ${rtDisplay}</button></span>`);
  }

  params.forEach((p, idx) => {
    if (p.flag === null) { parts.push(escHtml(p.value)); return; }
    const flag = escHtml(p.flag);
    if (p.flag === '--model' || p.flag === '-m') {
      const path = p.value;
      const basename = path.split('/').pop().split('\\').pop() || path;
      parts.push(`<span class="arg-row"><span class="arg-del" onclick="removeArg('${en}',${idx})" title="Remove">✕</span><span class="arg-flag" onclick="showFileDialog('${en}')">${flag}</span><span class="arg-sep"></span><span class="arg-val" onclick="showFileDialog('${en}')" title="${escHtml(path)}">${escHtml(basename)}</span></span>`);
      return;
    }
    if (p.flag === '--ctx-size' || p.flag === '-c') {
      parts.push(`<span class="arg-row"><span class="arg-del" onclick="removeArg('${en}',${idx})" title="Remove">✕</span><span class="arg-flag" onclick="showCtxDialog('${en}')">${flag}</span><span class="arg-sep"></span><span class="arg-val" onclick="showCtxDialog('${en}')">${escHtml(p.value)}</span></span>`);
      return;
    }
    parts.push(`<span class="arg-row"><span class="arg-del" onclick="removeArg('${en}',${idx})" title="Remove">✕</span><span class="arg-flag" onclick="showParamDialog('${en}',${idx})">${flag}</span><span class="arg-sep"></span><span class="arg-val" onclick="showParamDialog('${en}',${idx})">${escHtml(p.value || '(empty)')}</span></span>`);
  });

  parts.push(` <button class="arg-btn add-param" onclick="showAddParamDialog('${en}')" title="Add parameter">+</button>`);
  return parts.join(' ');
}

function updateArg(name, idx, newValue) {
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  const params = parseArgs(cfg.args_str);
  if (idx >= 0 && idx < params.length) {
    params[idx].value = newValue;
    cfg.args_str = buildArgsStr(params);
    updateArgsSection(name);
  }
}

function removeArg(name, idx) {
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  const params = parseArgs(cfg.args_str);
  if (idx >= 0 && idx < params.length) {
    params.splice(idx, 1);
    cfg.args_str = buildArgsStr(params);
    updateArgsSection(name);
  }
}

let browseCurrentDir = '/home';
let showHidden = true;
let browseDirOnly = false;
let browseFromSettings = false;

async function showFileDialog(name) {
  browseDirOnly = false;
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  fileDialogCallback = (path) => {
    cfg.args_str = setModelPath(cfg.args_str, path);
    updateArgsSection(name);
  };
  document.getElementById('fileDialogPath').placeholder = '/path/to/model.gguf';
  document.getElementById('fileDialogModelName').textContent = cfg.name;
  document.getElementById('showHiddenBtn').classList.toggle('active', showHidden);
  const path = extractModelPath(cfg.args_str);
  browseCurrentDir = path ? path.substring(0, path.lastIndexOf('/')) || '/home' : '/home';
  document.getElementById('fileDialogPath').value = path;
  document.getElementById('fileDialog').classList.add('active');
  if (path) {
    try {
      const r = await fetch('/api/stat?path=' + encodeURIComponent(path));
      const st = await r.json();
      const el = document.getElementById('fileDialogModelName');
      el.classList.toggle('model-name-ok', st.exists);
      el.classList.toggle('model-name-missing', !st.exists);
    } catch(_) {}
  }
  browseDir(browseCurrentDir);
}

function showRuntimeDialog(name) {
  browseDirOnly = false;
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  runtimeDialogTarget = name;
  const resetBtn = document.getElementById('fileDialogResetBtn');
  resetBtn.style.display = cfg.runtime ? '' : 'none';
    fileDialogCallback = async (path) => {
      cfg.runtime = path;
      delete runtimeExists[path];
      const esced = cssEscape(name);
      const rtBtn = document.getElementById('runtime-'+esced);
      if (rtBtn) {
        rtBtn.classList.add('custom');
        rtBtn.title = path;
        const base = path.split('/').pop().split('\\').pop() || path;
        rtBtn.innerHTML = '<span class="llama-icon">🦙</span> ' + escHtml(base);
      }
      updateArgsSection(name);
      validateRuntimes();
  if (cardState[name]?.editing) return;
  await saveCardConfig(name);
  };
  const path = cfg.runtime || '';
  document.getElementById('fileDialogPath').placeholder = '/path/to/llama-server';
  document.getElementById('fileDialogModelName').textContent = cfg.name + ' — runtime binary';
  document.getElementById('showHiddenBtn').classList.toggle('active', showHidden);
  browseCurrentDir = path ? path.substring(0, path.lastIndexOf('/')) || '/home' : '/home';
  document.getElementById('fileDialogPath').value = path;
  document.getElementById('fileDialog').classList.add('active');
  browseDir(browseCurrentDir);
}

function resetRuntimeDialog() {
  const name = runtimeDialogTarget;
  if (!name) return;
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  cfg.runtime = '';
  closeFileDialog();
  const esced = cssEscape(name);
  const rtBtn = document.getElementById('runtime-'+esced);
  if (rtBtn) {
    rtBtn.classList.remove('custom');
    rtBtn.title = 'Click to select runtime binary';
    rtBtn.innerHTML = '🦙';
  }
  updateArgsSection(name);
  validateRuntimes();
  saveCardConfig(name);
  showToast('Custom runtime reset — uses global default', 'ok');
  runtimeDialogTarget = null;
}

function closeFileDialog() {
  document.getElementById('fileDialog').classList.remove('active');
  document.getElementById('fileDialogResetBtn').style.display = 'none';
  fileDialogCallback = null;
  runtimeDialogTarget = null;
  browseDirOnly = false;
  if (browseFromSettings) {
    browseFromSettings = false;
    document.getElementById('settingsDialog').classList.add('active');
  }
}

function confirmFileDialog() {
  if (!fileDialogCallback) return;
  if (browseDirOnly) {
    const path = document.getElementById('fileDialogPath').value.trim() || browseCurrentDir;
    fileDialogCallback(path);
  } else {
    const path = document.getElementById('fileDialogPath').value.trim();
    if (!path) return;
    fileDialogCallback(path);
  }
  fileDialogCallback = null;
  closeFileDialog();
}

async function browseDir(dir) {
  browseCurrentDir = dir;
  if (browseDirOnly) {
    document.getElementById('fileDialogPath').value = dir;
  }
  const list = document.getElementById('browseList');
  const info = document.getElementById('browseInfo');
  list.innerHTML = '<div style="padding:10px;color:#484f58">Loading...</div>';
  try {
    const data = await fetch('/api/browse?dir=' + encodeURIComponent(dir) + '&showHidden=' + (showHidden ? '1' : '0')).then(r => {
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    });
    browseCurrentDir = data.dir;
    const entries = data.entries;
    const filtered = browseDirOnly ? entries.filter(e => e.is_dir) : entries;
    list.innerHTML = filtered.map(e => {
      const d = browseCurrentDir;
      const cls = e.is_dir ? 'browse-item dir' : 'browse-item file';
      const icon = e.is_dir ? '📁' : '📄';
      const size = e.is_dir ? '' : formatFileSize(e.size);
      const fullPath = d === '/' ? '/' + e.name : d + '/' + e.name;
      const onclick = e.is_dir
        ? (e.name === '..' ? `browseUp()"` : `browseDir('${escJs(fullPath)}')"`)
        : `selectFile('${escJs(fullPath)}')"`;
      return `<div class="${cls}" onclick="${onclick}>` +
        `<span>${icon}</span><span class="name" title="${escHtml(fullPath)}">${escHtml(e.name)}</span>` +
        (size ? `<span class="size">${size}</span>` : '') + '</div>';
    }).join('');
    info.textContent = '📁 ' + browseCurrentDir + '  •  ' + filtered.length + ' entries' + (browseDirOnly ? ' (dirs only)' : '');
  } catch(e) {
    list.innerHTML = '<div style="padding:10px;color:#f85149">Error: ' + escHtml(e.message) + '</div>';
    info.textContent = 'Load error';
  }
}

function toggleHidden() {
  showHidden = !showHidden;
  document.getElementById('showHiddenBtn').classList.toggle('active', showHidden);
  browseDir(browseCurrentDir);
}

let promptCallback = null;

function showPrompt(title, placeholder, callback) {
  promptCallback = callback;
  document.getElementById('promptDialogTitle').textContent = title;
  document.getElementById('promptDialogInput').value = '';
  document.getElementById('promptDialogInput').placeholder = placeholder || '';
  document.getElementById('promptDialog').classList.add('active');
  setTimeout(() => document.getElementById('promptDialogInput').focus(), 100);
}

function closePromptDialog() {
  document.getElementById('promptDialog').classList.remove('active');
  promptCallback = null;
}

function confirmPromptDialog() {
  const val = document.getElementById('promptDialogInput').value.trim();
  if (!val) return;
  const cb = promptCallback;
  closePromptDialog();
  if (cb) cb(val);
}

let confirmCallback = null;

function showConfirm(title, msg, callback) {
  confirmCallback = callback;
  document.getElementById('confirmDialogTitle').textContent = title;
  document.getElementById('confirmDialogMsg').textContent = msg;
  document.getElementById('confirmDialog').classList.add('active');
}

function closeConfirmDialog() {
  document.getElementById('confirmDialog').classList.remove('active');
  confirmCallback = null;
}

function confirmConfirmDialog() {
  const cb = confirmCallback;
  closeConfirmDialog();
  if (cb) cb(true);
}

function browseNewFolder() {
  showPrompt('New folder name', 'folder-name', (name) => {
    const path = browseCurrentDir === '/' ? '/' + name : browseCurrentDir + '/' + name;
    fetch('/api/mkdir', { method:'POST', body: new URLSearchParams({path}) })
      .then(r => {
        if (r.ok) { browseDir(browseCurrentDir); }
        else { r.text().then(t => showToast('Error creating folder: ' + t, 'err')); }
      })
      .catch(() => showToast('Failed to create folder', 'err'));
  });
}

function browseUp() {
  const parent = browseCurrentDir;
  if (parent === '/') return;
  const up = parent.substring(0, parent.lastIndexOf('/')) || '/';
  browseDir(up);
}

function selectFile(fullPath) {
  document.getElementById('fileDialogPath').value = fullPath;
  document.querySelectorAll('.browse-item').forEach(el => el.classList.remove('selected'));
  const items = document.getElementById('browseList').querySelectorAll('.browse-item');
  items.forEach(el => {
    if (el.querySelector('.name')?.textContent === fullPath.split('/').pop()) {
      el.classList.add('selected');
    }
  });
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  if (bytes < 1024*1024*1024) return (bytes/(1024*1024)).toFixed(1) + ' MB';
  return (bytes/(1024*1024*1024)).toFixed(2) + ' GB';
}

function pickCtxChip(el) {
  document.querySelectorAll('#ctxDialogChips .ctx-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('ctxDialogInput').value = el.dataset.value;
}

function showCtxDialog(name) {
  ctxDialogTarget = name;
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  const ctx = parseCtxFromArgs(cfg.args_str) || 2048;
  document.getElementById('ctxDialogInput').value = ctx;

  const vals = [2048, 4096, 8192, 16384, 32768, 65536, 131072];
  document.getElementById('ctxDialogChips').innerHTML = vals.map(v =>
    `<span class="ctx-chip${v === ctx ? ' active' : ''}" data-value="${v}" onclick="pickCtxChip(this)">${v >= 1024 ? (v/1024)+'K' : v}</span>`
  ).join('');

  document.getElementById('ctxDialog').classList.add('active');
  setTimeout(() => document.getElementById('ctxDialogInput').focus(), 100);
}

function closeCtxDialog() {
  document.getElementById('ctxDialog').classList.remove('active');
  ctxDialogTarget = null;
}

function updateGlobalMenuBtns() {
  const hasFocus = !!focusedCard && configs.some(c => c.name === focusedCard);
  const db = document.getElementById('deleteCardBtn');
  if (db) db.disabled = !hasFocus;
}

function updateGlobalExpandBtn() {
  const btn = document.getElementById('expandBtn');
  if (!btn) return;
  const container = document.getElementById('cardsContainer');

  // Sync expandedCard to DOM state
  {
    const domExpanded = container?.classList.contains('expanded');
    if (expandedCard && !domExpanded) expandedCard = null;
    if (domExpanded) {
      const ec = container.querySelector('.card.expanded');
      if (!ec) {
        container.classList.remove('expanded');
        expandedCard = null;
      } else if (!expandedCard) {
        expandedCard = ec.id.replace(/^card-/, '');
      }
    }
  }

  const nowExpanded = container?.classList.contains('expanded');
  btn.disabled = !(nowExpanded || (focusedCard && configs.some(c => c.name === focusedCard)));
}

function showAddCardDialog(name, args, runtime, desc) {
  document.getElementById('addCardDialogName').value = name || '';
  document.getElementById('addCardDialogDesc').value = desc || '';
  document.getElementById('addCardDialogArgs').value = args || '';
  const rtInput = document.getElementById('addCardDialogRuntime');
  rtInput.value = runtime || '';
  const sysRt = document.getElementById('addCardUseSysRuntime');
  sysRt.checked = !runtime;
  rtInput.disabled = sysRt.checked;

  document.getElementById('addCardPasteInput').value = '';
  document.getElementById('addCardParseStatus').textContent = '';

  document.getElementById('addCardDialog').classList.add('active');
  setTimeout(() => document.getElementById('addCardDialogName').focus(), 100);
  if (name) document.getElementById('addCardDialogName').select();
}

function closeAddCardDialog() {
  document.getElementById('addCardDialog').classList.remove('active');
}

async function cloneCard(sourceName) {
  const src = configs.find(c => c.name === sourceName);
  if (!src) return;
  let name = src.name;
  let i = 1;
  while (configs.some(c => c.name === name)) name = src.name + ' (' + i++ + ')';
  const desc = src.description || '';
  const args = src.args_str || '';

  const tempCard = {
    name, description: desc, args_str: args, env_str: src.env_str || '', runtime: src.runtime || '',
    running: false, ready: false, pid: 0, port: 0, ctx_size: src.ctx_size || 2048, default_ctx: src.default_ctx || 2048
  };
  configs.push(tempCard);
  cardState[name] = {
    mode: 'raw', editing: true, isNew: true,
    originalArgs: args, originalEnv: src.env_str || '', originalRuntime: src.runtime || ''
  };

  renderCards();
  focusCard(name);
  toggleExpand(name, true);
}

async function addQuickCard() {
  let name = 'New Config';
  let i = 1;
  while (configs.some(c => c.name === name)) name = 'New Config (' + i++ + ')';
  const desc = 'This config description';
  const args = '--model /path/to/model.gguf --ctx-size 2048 -ngl 999';

  const tempCard = {
    name, description: desc, args_str: args, env_str: '', runtime: '',
    running: false, ready: false, pid: 0, port: 0, ctx_size: 2048, default_ctx: 2048
  };
  configs.push(tempCard);
  cardState[name] = {
    mode: 'raw', editing: true, isNew: true,
    originalArgs: args, originalEnv: '', originalRuntime: ''
  };

  renderCards();
  focusCard(name);
  toggleExpand(name, true);
}

async function parsePasteCommand() {
  const cmd = document.getElementById('addCardPasteInput').value.trim();
  const status = document.getElementById('addCardParseStatus');
  if (!cmd) { status.textContent = 'Paste a command first'; return; }
  status.textContent = 'Parsing...';
  try {
    const r = await fetch('/api/parse-command', {
      method: 'POST',
      body: new URLSearchParams({command: cmd})
    });
    if (!r.ok) { status.textContent = 'Parse failed'; return; }
    const d = await r.json();
    document.getElementById('addCardDialogArgs').value = d.args;
    const rtInput = document.getElementById('addCardDialogRuntime');
    rtInput.value = d.binary;
    const sysRt = document.getElementById('addCardUseSysRuntime');
    sysRt.checked = false;
    rtInput.disabled = false;
    // Auto-fill name from model path or hf-file
    const nameMatch = d.args.match(/--hf-file\s+(\S+)/) || d.args.match(/-m\s+(\S+)/) || d.args.match(/--model\s+(\S+)/);
    if (nameMatch) {
      const rawName = nameMatch[1].split('/').pop().replace(/\.gguf$/, '');
      document.getElementById('addCardDialogName').value = rawName;
    }
    status.textContent = '✅ Parsed: ' + d.binary;
  } catch(e) {
    status.textContent = 'Parse error';
  }
}

function addCardBrowseRuntime() {
  browseDirOnly = false;
  fileDialogCallback = (path) => {
    document.getElementById('addCardDialogRuntime').value = path;
    document.getElementById('addCardUseSysRuntime').checked = false;
    document.getElementById('addCardDialogRuntime').disabled = false;
  };
  document.getElementById('fileDialogPath').placeholder = '/path/to/llama-server';
  document.getElementById('fileDialogModelName').textContent = 'Custom runtime binary';
  document.getElementById('fileDialogResetBtn').style.display = 'none';
  document.getElementById('showHiddenBtn').classList.toggle('active', showHidden);
  browseCurrentDir = '/home';
  document.getElementById('fileDialogPath').value = '';
  document.getElementById('fileDialog').classList.add('active');
  browseDir(browseCurrentDir);
}

function addCardToggleRuntime() {
  const rtInput = document.getElementById('addCardDialogRuntime');
  rtInput.disabled = document.getElementById('addCardUseSysRuntime').checked;
  if (rtInput.disabled) rtInput.value = '';
}

async function confirmAddCardDialog() {
  const name = document.getElementById('addCardDialogName').value.trim();
  if (!name) return;
  const desc = document.getElementById('addCardDialogDesc').value.trim();
  const args = document.getElementById('addCardDialogArgs').value.trim();
  const useSys = document.getElementById('addCardUseSysRuntime').checked;
  const runtime = useSys ? '' : document.getElementById('addCardDialogRuntime').value.trim();
  closeAddCardDialog();
  try {
    const r = await fetch('/api/card/create', {
      method: 'POST',
      body: new URLSearchParams({name})
    });
    if (!r.ok) {
      const err = await r.text();
      showToast('Error: ' + err, 'err');
      return;
    }
    const params = new URLSearchParams({name, args_str: args || ''});
    if (runtime) params.set('runtime', runtime);
    if (desc) params.set('description', desc);
    const r2 = await fetch('/api/config/update', { method:'POST', body: params });
    if (!r2.ok) showToast('Card created but config save failed', 'err');
    await reloadAll();
    focusCard(name);
    showToast('➕ Card created', 'ok');
  } catch(e) {
    showToast('Create error', 'err');
  }
}

async function deleteFocusedCard() {
  const name = focusedCard;
  if (!name) return;
  showConfirm('Delete card', 'Delete card "' + name + '"? This cannot be undone.', async () => {
    try {
      const r = await fetch('/api/card/delete', {
        method: 'POST',
        body: new URLSearchParams({name})
      });
      if (!r.ok) {
        const err = await r.text();
        showToast('Error: ' + err, 'err');
        return;
      }
      focusedCard = null;
      await reloadAll();
      updateGlobalMenuBtns();
      showToast('🗑️ Card deleted', 'ok');
    } catch(e) {
      showToast('Delete error', 'err');
    }
  });
}

async function reloadAll() {
  configs = await fetch('/api/configs').then(r => r.json());
  if (expandedCard && !configs.some(c => c.name === expandedCard)) expandedCard = null;
  configs.forEach(c => {
    if (!cardState[c.name]) cardState[c.name] = { mode: 'constructor', editing: false, originalArgs: c.args_str, originalEnv: c.env_str, originalRuntime: c.runtime };
    cardState[c.name].originalArgs = c.args_str;
    cardState[c.name].originalEnv = c.env_str;
    cardState[c.name].originalRuntime = c.runtime || '';
    if (c.last_used) lastUsed[c.name] = c.last_used;
  });
  renderCards();
  const refocus = focusedCard && configs.some(c => c.name === focusedCard) ? focusedCard : (configs.length ? configs[0].name : null);
  if (refocus) focusCard(refocus);
}

function confirmCtxDialog() {
  const name = ctxDialogTarget;
  const val = parseInt(document.getElementById('ctxDialogInput').value);
  if (!name || !val || val < 128) return;
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  cfg.args_str = setCtxInArgs(cfg.args_str, val);
  updateArgsSection(name);
  closeCtxDialog();
}

function renderCards() {
  const container = document.getElementById('cardsContainer');
  const q = document.getElementById('searchInput').value.toLowerCase().trim();

  let sorted = [...configs];
  if (sortMode === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sortMode === 'recent') {
    sorted.sort((a, b) => (lastUsed[b.name] || 0) - (lastUsed[a.name] || 0));
  }

  const filtered = q ? sorted.filter(c => c.name.toLowerCase().includes(q)) : sorted;

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><h3>${configs.length ? '😕 Nothing found' : '📭 No configurations'}</h3><p>${configs.length ? 'Try a different search' : 'Add models to config.json'}</p></div>`;
    return;
  }

  container.className = 'cards' + (expandedCard ? ' expanded' : '');

  container.innerHTML = filtered.map(c => {
    const isRunning = c.running;
    const isReady = c.ready;
    const st = cardState[c.name] || { mode: 'constructor' };
    const isExpanded = expandedCard === c.name;
    const isHidden = expandedCard && !isExpanded;

    return `
    <div class="card ${isRunning ? 'running' : ''}${isExpanded ? ' expanded' : ''}${isHidden ? ' hidden' : ''}" id="card-${cssEscape(c.name)}" data-name="${escJs(c.name)}" onclick="onCardClick(event,'${escJs(c.name)}')">
      <div class="field args-section">
        <div class="args-header">
          <div class="args-controls" style="flex:1">
            <div class="toolbar-group">
              ${isRunning
                ? `<button class="toolbar-btn stop" onclick="stopModel('${escJs(c.name)}')" title="${isReady ? '▶ Running' : '▶ Starting'} (pid: ${c.pid})">⏹</button>`
                : `<button class="toolbar-btn run" onclick="runModel('${escJs(c.name)}')" title="Stopped">▶</button>`
              }
              <button class="toolbar-btn${activeLogs[c.name] ? ' active' : ''}" onclick="toggleLogs('${escJs(c.name)}')" id="logs-btn-${cssEscape(c.name)}" title="${activeLogs[c.name] ? 'Pause' : 'Show'} logs">${activeLogs[c.name] ? '⏸' : '📋'}</button>
              <button class="toolbar-btn web-btn${isRunning && isReady ? '' : ' hidden'}" onclick="window.open(location.protocol+'//'+location.hostname+':'+(${c.port}||8080))" title="Open chat">🌐</button>
            </div>
            <span class="card-title${isRunning ? (isReady ? ' running' : ' starting') : ''}" id="card-title-${cssEscape(c.name)}">${escHtml(c.name)}</span>
            <button class="edit-btn" onclick="toggleEdit('${escJs(c.name)}')" id="edit-btn-${cssEscape(c.name)}" title="Edit card">✏️</button>
            <button class="edit-btn clone-btn" onclick="cloneCard('${escJs(c.name)}')" id="clone-btn-${cssEscape(c.name)}" title="Clone card">👥</button>
            <div class="card-edit-fields" id="card-fields-${cssEscape(c.name)}" style="display:none">
              <div class="card-edit-row">
                <input class="card-name-input" id="card-name-${cssEscape(c.name)}" value="${escHtml(c.name)}" spellcheck="false" placeholder="Model name">
                <button class="edit-btn edit-save" onclick="confirmEdit('${escJs(c.name)}')" id="edit-save-${cssEscape(c.name)}" title="Save changes">💾 Save</button>
                <button class="edit-btn edit-cancel" onclick="cancelEdit('${escJs(c.name)}')" id="edit-cancel-${cssEscape(c.name)}" title="Cancel editing">✕ Cancel</button>
              </div>
              <textarea class="card-desc-input" id="card-desc-${cssEscape(c.name)}" spellcheck="false" placeholder="Description" rows="2">${escHtml(c.description || '')}</textarea>
            </div>
            <div style="flex:1"></div>
            <div class="toolbar-group">
              <button class="toolbar-btn${st.mode === 'constructor' ? ' active' : ''}" data-mode="constructor" onclick="setMode('${escJs(c.name)}','constructor')" title="Constructor mode">📐</button>
              <button class="toolbar-btn${st.mode === 'raw' ? ' active' : ''}" data-mode="raw" onclick="setMode('${escJs(c.name)}','raw')" title="Raw args (command line)">&gt;_</button>
              <button class="toolbar-btn${st.mode === 'env' ? ' active' : ''}" data-mode="env" onclick="setMode('${escJs(c.name)}','env')" title="Environment variables">💲</button>
            </div>
          </div>
        </div>
        <div class="args-body" id="args-body-${cssEscape(c.name)}">
          <div class="args-display" id="args-display-${cssEscape(c.name)}">${st.mode === 'constructor' ? renderArgsDisplay(c.name, c.args_str) : escHtml(st.mode === 'env' ? (c.env_str || '') : c.args_str)}</div>
        </div>
      </div>

      <div class="logs-area ${activeLogs[c.name] ? 'active' : ''}" id="logs-area-${cssEscape(c.name)}">
        <div class="logs-header">
          <span>Process output</span>
          <div>
            <button class="scroll-btn ${logScrollPaused[c.name] ? 'paused' : ''}" id="scroll-btn-${cssEscape(c.name)}" onclick="toggleScrollPause('${escJs(c.name)}')">${logScrollPaused[c.name] ? '⏸ Auto-scroll' : '▶ Auto-scroll'}</button>
          </div>
        </div>
        <div class="logs-content" id="logs-content-${cssEscape(c.name)}"></div>
      </div>
    </div>`;
  }).join('');

  configs.forEach(c => {
    const titleEl = document.getElementById('card-title-'+cssEscape(c.name));
    if (titleEl && c.description) titleEl.title = c.description;
    if (activeLogs[c.name] && c.running) {
      connectSSE(c.name);
    }
    const st = cardState[c.name];
    if (st && st.mode !== 'constructor') {
      updateArgsSection(c.name);
    }
    if (st && st.editing) {
      updateCardHeader(c.name);
    }
  });
  updateCardsStatus();
  validateRuntimes();
}

async function validateRuntimes() {
  for (const c of configs) {
    if (!c.runtime) continue;
    const rtPath = c.runtime;
    if (!rtPath) continue;
    if (runtimeExists[rtPath] === undefined) {
      try {
        const r = await fetch('/api/stat?path=' + encodeURIComponent(rtPath));
        const st = await r.json();
        runtimeExists[rtPath] = st.exists;
      } catch(_) { runtimeExists[rtPath] = false; }
    }
    const btn = document.getElementById('runtime-' + cssEscape(c.name));
    if (!btn) continue;
    btn.classList.remove('custom', 'rt-exists', 'rt-missing');
    if (runtimeExists[rtPath]) {
      btn.classList.add('rt-exists');
    } else {
      btn.classList.add('rt-missing');
    }
  }
}

let paramDialogTarget = null;
let paramDialogIdx = -1;
let runtimeDialogTarget = null;

function showParamDialog(name, idx) {
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  const params = parseArgs(cfg.args_str);
  if (idx < 0 || idx >= params.length) return;
  paramDialogTarget = name;
  paramDialogIdx = idx;
  document.getElementById('paramDialogFlag').textContent = params[idx].flag;
  document.getElementById('paramDialogInput').value = params[idx].value;
  document.getElementById('paramDialog').classList.add('active');
  setTimeout(() => document.getElementById('paramDialogInput').focus().select(), 100);
}

function closeParamDialog() {
  document.getElementById('paramDialog').classList.remove('active');
  paramDialogTarget = null;
  paramDialogIdx = -1;
}

function confirmParamDialog() {
  const name = paramDialogTarget;
  const idx = paramDialogIdx;
  const val = document.getElementById('paramDialogInput').value.trim();
  if (!name || idx < 0) return;
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  const params = parseArgs(cfg.args_str);
  if (idx >= 0 && idx < params.length) {
    params[idx].value = val;
    cfg.args_str = buildArgsStr(params);
    updateArgsSection(name);
  }
  closeParamDialog();
}

let addParamTarget = null;
let cachedParams = null;
let addParamAvailable = [];

async function showAddParamDialog(name) {
  addParamTarget = name;
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  if (!cachedParams) {
    try {
      cachedParams = await fetch('/api/params').then(r => r.json());
    } catch(e) {
      cachedParams = null;
      showToast('Failed to load params from binary', 'err');
      return;
    }
  }
  const params = parseArgs(cfg.args_str);
  const usedFlags = new Set(params.filter(p => p.flag).map(p => p.flag));
  addParamAvailable = cachedParams
    .filter(p => !p.flags.some(f => usedFlags.has(f)))
    .sort((a, b) => a.flag.localeCompare(b.flag));
  if (addParamAvailable.length === 0) {
    showToast('All available parameters already added', 'err');
    return;
  }
  document.getElementById('addParamFilter').value = '';
  document.getElementById('addParamValue').value = '';
  renderAddParamOptions();
  document.getElementById('addParamDialog').classList.add('active');
  setTimeout(() => document.getElementById('addParamFilter').focus(), 100);
}

function renderAddParamOptions() {
  const filter = document.getElementById('addParamFilter').value;
  const norm = filter.replace(/^-+/g, '').toLowerCase();
  const select = document.getElementById('addParamSelect');
  select.innerHTML = addParamAvailable
    .filter(p => !norm || p.flags.some(f => f.replace(/^-+/g, '').toLowerCase().startsWith(norm)))
    .map(p => `<option value="${escJs(p.flag)}" title="${escHtml(p.desc)}">${escHtml(p.flags.join(', '))}</option>`)
    .join('');
}

function closeAddParamDialog() {
  document.getElementById('addParamDialog').classList.remove('active');
  addParamTarget = null;
}

function confirmAddParamDialog() {
  const name = addParamTarget;
  if (!name) return;
  const flag = document.getElementById('addParamSelect').value;
  if (!flag) {
    showToast('No parameter selected', 'err');
    return;
  }
  if (flag === '--ctx-size' || flag === '-c') {
    closeAddParamDialog();
    showCtxDialog(name);
    return;
  }
  const value = document.getElementById('addParamValue').value.trim();
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  cfg.args_str = (cfg.args_str + ' ' + flag + (value ? ' ' + value : '')).trim();
  updateArgsSection(name);
  closeAddParamDialog();
}

function cssEscape(s) {
  return s.replace(/[ "']/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escJs(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type + ' show';
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.classList.remove('show'), 3000);
}

function parseCtxFromArgs(argsStr) {
  const m = argsStr.match(/(?:--ctx-size|-c)(?:\s+|=)(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

async function loadGlobalConfig() {
  try {
    const data = await fetch('/api/global-config').then(r => r.json());
    globalRuntimeCfg = data.global_runtime || '';
    globalHfCache = data.hf_cache || '';
    configs.forEach(c => {
      if (c.runtime && c.runtime === globalRuntimeCfg) c.runtime = '';
    });
    updateGlobalRuntimeBtn();
    renderCards();
    if (focusedCard) {
      focusCard(focusedCard);
    } else if (configs.length) {
      focusCard(configs[0].name);
    }
  } catch(e) {
    console.error('loadGlobalConfig error:', e);
  }
}

function updateGlobalRuntimeBtn() {
  const btn = document.getElementById('settingsBtn');
  if (!btn) return;
  let title = 'Application settings';
  if (globalRuntimeCfg) title += ' | Runtime: ' + globalRuntimeCfg;
  if (globalHfCache) title += ' | HF cache: ' + globalHfCache;
  btn.title = title;
}

function showSettingsDialog() {
  document.getElementById('settingsRuntimeInput').value = globalRuntimeCfg || '';
  document.getElementById('settingsCacheInput').value = globalHfCache || '';
  document.getElementById('settingsDialog').classList.add('active');
}

function closeSettingsDialog() {
  document.getElementById('settingsDialog').classList.remove('active');
}

function settingsBrowseRuntime() {
  browseFromSettings = true;
  closeSettingsDialog();
  browseDirOnly = false;
  fileDialogCallback = (path) => {
    document.getElementById('settingsRuntimeInput').value = path;
  };
  document.getElementById('fileDialogPath').placeholder = '/path/to/llama-server';
  document.getElementById('fileDialogModelName').textContent = 'Global runtime binary';
  document.getElementById('fileDialogResetBtn').style.display = 'none';
  document.getElementById('showHiddenBtn').classList.toggle('active', showHidden);
  browseCurrentDir = globalRuntimeCfg
    ? globalRuntimeCfg.substring(0, globalRuntimeCfg.lastIndexOf('/')) || '/home'
    : '/home';
  document.getElementById('fileDialogPath').value = globalRuntimeCfg || '';
  document.getElementById('fileDialog').classList.add('active');
  browseDir(browseCurrentDir);
}

function settingsClearRuntime() {
  document.getElementById('settingsRuntimeInput').value = '';
}

function settingsBrowseCache() {
  browseFromSettings = true;
  closeSettingsDialog();
  browseDirOnly = true;
  fileDialogCallback = (path) => {
    document.getElementById('settingsCacheInput').value = path;
  };
  document.getElementById('fileDialogPath').placeholder = '/path/to/hf_cache';
  document.getElementById('fileDialogModelName').textContent = 'HF cache folder';
  document.getElementById('fileDialogResetBtn').style.display = 'none';
  document.getElementById('showHiddenBtn').classList.toggle('active', showHidden);
  browseCurrentDir = globalHfCache || '/home';
  document.getElementById('fileDialogPath').value = globalHfCache || '';
  document.getElementById('fileDialog').classList.add('active');
  browseDir(browseCurrentDir);
}

function settingsClearCache() {
  document.getElementById('settingsCacheInput').value = '';
}

async function confirmSettingsDialog() {
  const runtime = document.getElementById('settingsRuntimeInput').value.trim();
  const cache = document.getElementById('settingsCacheInput').value.trim();
  try {
    const params = new URLSearchParams();
    if (runtime !== globalRuntimeCfg) params.set('runtime', runtime);
    if (cache !== globalHfCache) params.set('hf_cache', cache);
    if (!params.toString()) { closeSettingsDialog(); return; }
    const r = await fetch('/api/global-config/update', {
      method: 'POST',
      body: params
    });
    if (r.ok) {
      const runtimeChanged = runtime !== globalRuntimeCfg;
      globalRuntimeCfg = runtime;
      globalHfCache = cache;
      updateGlobalRuntimeBtn();
      if (runtimeChanged) {
        renderCards();
      }
      showToast('✅ Settings saved', 'ok');
      closeSettingsDialog();
    } else {
      showToast('Error saving settings', 'err');
    }
  } catch(e) {
    showToast('Save error', 'err');
  }
}

async function runModel(name) {
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  await saveCardConfig(name);
  const ctxSize = parseCtxFromArgs(cfg.args_str) || 2048;
  try {
    const r = await fetch('/api/run', { method:'POST', body: new URLSearchParams({name, ctx_size: ctxSize}) });
    const d = await r.json();
    if (d.status === 'ok') {
      showToast(d.msg, 'ok');
      await refreshStatus();
      if (!esMap[name]) connectSSE(name);
    } else {
      showToast(d.msg || 'Start error', 'err');
    }
  } catch(e) {
    showToast('Request error', 'err');
  }
}

async function stopModel(name) {
  await saveCardConfig(name);
  try {
    const r = await fetch('/api/stop', { method:'POST', body: new URLSearchParams({name}) });
    const d = await r.json();
    showToast(d.msg, 'ok');
    if (esMap[name]) { esMap[name].close(); delete esMap[name]; }
    endLogSession(name);
    await refreshStatus();
  } catch(e) {
    showToast('Stop error', 'err');
  }
}

async function restartModel(name) {
  await stopModel(name);
  setTimeout(() => runModel(name), 500);
}

let rawInput = {};

function effectiveRuntime(cfg) {
  return cfg.runtime || globalRuntimeCfg || '';
}

function buildFullCmd(cfg) {
  const rt = effectiveRuntime(cfg);
  return (rt ? rt + ' ' : '') + cfg.args_str;
}

function parseFullCmd(text, name) {
  let cleaned = text.replace(/\\\s*\n\s*/g, ' ');
  cleaned = cleaned.replace(/^stdbuf\s+-oL\s+/, '');
  const tokens = cleaned.match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
  if (tokens.length === 0) return;
  const rt = tokens[0];
  const args = tokens.slice(1).join(' ');
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  const effRt = effectiveRuntime(cfg);
  if (rt !== effRt) {
    cfg.runtime = rt;
    delete runtimeExists[rt];
  } else if (rt === effRt && effRt !== '' && !cfg.runtime) {
  }
  cfg.args_str = args;
}

function parsePastedCommand(text, hfCache) {
  let cleaned = text.replace(/^stdbuf\s+-oL\s+/m, '');

  const lines = cleaned.split('\n');
  const envLines = [];
  const cmdParts = [];
  let pending = '';

  for (let i = 0; i < lines.length; i++) {
    let line = (pending + lines[i]).trimEnd();
    pending = '';

    if (line.endsWith('\\')) {
      pending = line.slice(0, -1).trimEnd() + ' ';
      continue;
    }

    line = line.trim();
    if (!line) continue;

    const envMatch = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|(\S+))$/);
    if (envMatch) {
      const val = envMatch[2] !== undefined ? envMatch[2] : envMatch[3];
      envLines.push(envMatch[1] + '=' + val);
    } else {
      cmdParts.push(line);
    }
  }

  if (pending) {
    const trimmed = pending.trim();
    if (trimmed) cmdParts.push(trimmed);
  }

  const processedEnvLines = envLines.map(ev => {
    const m = ev.match(/^(LLAMA_CACHE)=(.+)$/);
    if (m && m[2] && !m[2].startsWith('/')) {
      const base = hfCache || '';
      if (base) {
        return 'LLAMA_CACHE=' + base.replace(/\/$/, '') + '/' + m[2];
      }
    }
    return ev;
  });

  const envStr = processedEnvLines.length > 0 ? processedEnvLines.join('\n') : undefined;

  if (cmdParts.length === 0) return null;

  const fullCmd = cmdParts.join(' ');
  const tokens = fullCmd.match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];

  let runtime;

  if (tokens.length > 0 && !tokens[0].startsWith('-')) {
    runtime = tokens[0];
  }

  return { cmd: fullCmd, runtime, envStr };
}

async function setMode(name, mode) {
  const state = cardState[name];
  if (!state) return;
  if (state.mode === mode) return;
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;

  if (state.mode === 'raw' && mode === 'constructor' && rawInput[name] !== undefined) {
    parseFullCmd(rawInput[name], name);
    delete rawInput[name];
  } else if (state.mode === 'constructor' && mode === 'raw') {
    rawInput[name] = buildFullCmd(cfg);
  }
  if (mode === 'raw' && rawInput[name] === undefined) {
    rawInput[name] = buildFullCmd(cfg);
  }

  await saveCardConfig(name);
  state.mode = mode;
  updateArgsSection(name);
}

function updateArgsSection(name) {
  const card = document.getElementById('card-' + cssEscape(name));
  if (!card) return;

  const state = cardState[name];
  const cfg = configs.find(c => c.name === name);
  if (!cfg || !state) return;

  // update mode buttons
  card.querySelectorAll('.toolbar-btn[data-mode]').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
  });

  const body = card.querySelector('.args-body');
  if (!body) return;

  if (state.mode === 'constructor') {
    body.innerHTML = `<div class="args-display">${renderArgsDisplay(name, cfg.args_str)}</div>`;
  } else if (state.mode === 'env') {
    body.innerHTML = `<div class="args-textarea-wrap"><textarea class="args-textarea" id="env-args-${cssEscape(name)}" spellcheck="false" placeholder="KEY=VALUE&#10;ANOTHER_KEY=value">${escHtml(cfg.env_str || '')}</textarea><button class="args-clear" data-for="env-args-${cssEscape(name)}" title="Clear">✕</button></div>`;
    const ta = document.getElementById('env-args-'+cssEscape(name));
    if (ta) {
      ta.focus();
      ta.addEventListener('input', function() {
        cfg.env_str = this.value;
      });
      const clearBtn = ta.parentElement.querySelector('.args-clear');
      clearBtn.addEventListener('click', function() {
        ta.value = '';
        cfg.env_str = '';
        ta.focus();
      });
    }
  } else {
    const display = rawInput[name] !== undefined ? rawInput[name] : buildFullCmd(cfg);
    body.innerHTML = `<div class="args-textarea-wrap"><textarea class="args-textarea" id="raw-args-${cssEscape(name)}" spellcheck="false">${escHtml(display)}</textarea><button class="args-clear" data-for="raw-args-${cssEscape(name)}" title="Clear">✕</button></div>`;
    const ta = document.getElementById('raw-args-'+cssEscape(name));
    if (ta) {
      ta.focus();
      ta.addEventListener('input', function() {
        rawInput[name] = this.value;
      });
      const clearBtn = ta.parentElement.querySelector('.args-clear');
      clearBtn.addEventListener('click', function() {
        ta.value = '';
        rawInput[name] = '';
        ta.focus();
      });
      ta.addEventListener('paste', function(e) {
        const pastedText = (e.clipboardData || window.clipboardData).getData('text');
        if (!pastedText) return;
        const hasNewlines = pastedText.includes('\n');
        const hasContinuation = /\\\s*\n/.test(pastedText);
        const hasEnvVars = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(pastedText.trim());
        if (!hasNewlines && !hasContinuation && !hasEnvVars) return;

        const parsed = parsePastedCommand(pastedText, globalHfCache);
        if (!parsed) return;

        e.preventDefault();
        const start = this.selectionStart;
        const end = this.selectionEnd;
        this.value = this.value.substring(0, start) + parsed.cmd + this.value.substring(end);
        this.selectionStart = this.selectionEnd = start + parsed.cmd.length;

        rawInput[name] = this.value;

        if (parsed.envStr !== undefined) {
          cfg.env_str = parsed.envStr;
        }

        if (parsed.runtime) {
          const setRuntimePath = (path) => {
            cfg.runtime = path;
            delete runtimeExists[path];
            const esced = cssEscape(name);
            const rtBtn = document.getElementById('runtime-'+esced);
            if (rtBtn) {
              rtBtn.classList.add('custom');
              const base = path.split('/').pop().split('\\').pop() || path;
              rtBtn.title = path;
              rtBtn.innerHTML = '<span class="llama-icon">🦙</span> ' + escHtml(base);
            }
          };
          const replaceWithSystemRt = () => {
            const sysRt = globalRuntimeCfg;
            cfg.runtime = '';
            delete runtimeExists[parsed.runtime];
            if (sysRt && this.value.startsWith(parsed.runtime)) {
              this.value = sysRt + this.value.substring(parsed.runtime.length);
              this.selectionStart = this.selectionEnd = this.value.length;
              rawInput[name] = this.value;
            }
            const esced = cssEscape(name);
            const rtBtn = document.getElementById('runtime-'+esced);
            if (rtBtn) {
              rtBtn.classList.remove('custom');
              const base = sysRt ? sysRt.split('/').pop().split('\\').pop() || sysRt : 'select';
              rtBtn.title = sysRt || 'Click to select runtime binary';
              rtBtn.innerHTML = '<span class="llama-icon">🦙</span> ' + escHtml(base);
            }
          };
          if (runtimeExists[parsed.runtime] !== undefined) {
            if (runtimeExists[parsed.runtime]) setRuntimePath(parsed.runtime);
            else replaceWithSystemRt();
          } else {
            fetch('/api/stat?path=' + encodeURIComponent(parsed.runtime))
              .then(r => r.json())
              .then(st => {
                runtimeExists[parsed.runtime] = st.exists;
                if (st.exists) setRuntimePath(parsed.runtime);
                else replaceWithSystemRt();
              })
              .catch(() => replaceWithSystemRt());
          }
        }

      });
    }
  }
  validateRuntimes();
}

async function saveCardConfig(name) {
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  const state = cardState[name];
  if (state?.isNew) return;
  // if in raw mode and we have unparsed input, parse it now
  if (state && state.mode === 'raw' && rawInput[name] !== undefined) {
    parseFullCmd(rawInput[name], name);
    delete rawInput[name];
  }
  try {
    const r = await fetch('/api/config/update', {
      method:'POST',
      body: new URLSearchParams({name, args_str: cfg.args_str, env_str: cfg.env_str || '', runtime: cfg.runtime || '', description: cfg.description || ''})
    });
    if (!r.ok) {
      const errText = await r.text();
      showToast('Error: ' + (errText || r.statusText), 'err');
      return;
    }
    cardState[name].originalArgs = cfg.args_str;
    cardState[name].originalEnv = cfg.env_str || '';
    cardState[name].originalRuntime = cfg.runtime || '';
    const titleEl = document.getElementById('card-title-'+cssEscape(name));
    if (titleEl) {
      if (cfg.description) titleEl.title = cfg.description;
      else titleEl.removeAttribute('title');
    }
    updateArgsSection(name);
    showToast('💾 Saved to config.json', 'ok');
  } catch(e) {
    showToast('Save error', 'err');
  }
}

document.getElementById('fileDialog').addEventListener('click', function(e) {
  if (e.target === this) closeFileDialog();
});
document.getElementById('fileDialogPath').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); browseDir(this.value); }
  if (e.key === 'Escape') closeFileDialog();
});

document.getElementById('ctxDialog').addEventListener('click', function(e) {
  if (e.target === this) closeCtxDialog();
});
document.getElementById('ctxDialogInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') confirmCtxDialog();
  if (e.key === 'Escape') closeCtxDialog();
});

document.getElementById('paramDialog').addEventListener('click', function(e) {
  if (e.target === this) closeParamDialog();
});
document.getElementById('paramDialogInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); confirmParamDialog(); }
  if (e.key === 'Escape') closeParamDialog();
});

document.getElementById('addParamDialog').addEventListener('click', function(e) {
  if (e.target === this) closeAddParamDialog();
});
document.getElementById('addParamValue').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); confirmAddParamDialog(); }
  if (e.key === 'Escape') closeAddParamDialog();
});
document.getElementById('addParamFilter').addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeAddParamDialog();
  if (e.key === 'ArrowDown') { e.preventDefault(); document.getElementById('addParamSelect').focus(); }
});
document.getElementById('addParamSelect').addEventListener('dblclick', function(e) {
  if (this.value) confirmAddParamDialog();
});


document.getElementById('addCardDialog').addEventListener('click', function(e) {
  if (e.target === this) closeAddCardDialog();
});
document.getElementById('addCardDialogName').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); confirmAddCardDialog(); }
  if (e.key === 'Escape') closeAddCardDialog();
});

document.getElementById('promptDialog').addEventListener('click', function(e) {
  if (e.target === this) closePromptDialog();
});
document.getElementById('promptDialogInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); confirmPromptDialog(); }
  if (e.key === 'Escape') closePromptDialog();
});

document.getElementById('confirmDialog').addEventListener('click', function(e) {
  if (e.target === this) closeConfirmDialog();
});
document.getElementById('confirmDialog').addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeConfirmDialog();
});

function connectSSE(name) {
  if (esMap[name]) { esMap[name].close(); delete esMap[name]; }
  if (!configs.find(c => c.name === name)?.running) return;

  const content = document.getElementById(`logs-content-${cssEscape(name)}`);
  if (!content) return;

  endLogSession(name);

  const session = document.createElement('div');
  session.className = 'log-session active';
  const bd = document.createElement('div');
  bd.className = 'log-session-bd';
  session.appendChild(bd);
  content.appendChild(session);

  const es = new EventSource(`/logs/${encodeURIComponent(name)}`);
  esMap[name] = es;

  es.onmessage = function(e) {
    if (e.data.startsWith('{')) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'finished' || msg.type === 'error') {
          appendLog(name, '--- ' + msg.msg + ' ---');
          endLogSession(name);
          es.close();
          delete esMap[name];
          return;
        }
        if (msg.type === 'connected') return;
      } catch(_) {}
    }
    appendLog(name, e.data);
  };

  es.onerror = function() {
    if (es.readyState === EventSource.CLOSED) {
      appendLog(name, '--- Connection closed ---');
      delete esMap[name];
      return;
    }
    const cfg = configs.find(c => c.name === name);
    if (!cfg || !cfg.running) {
      es.close();
      delete esMap[name];
    }
  };
}

function endLogSession(name) {
  const content = document.getElementById(`logs-content-${cssEscape(name)}`);
  if (!content) return;
  const active = content.querySelector('.log-session.active');
  if (!active) return;
  active.classList.remove('active');
  active.classList.add('ended');

  const hd = document.createElement('div');
  hd.className = 'log-session-hd';
  const time = new Date().toLocaleTimeString();
  hd.innerHTML = `<span>Session ended ${time}</span>`;
  const del = document.createElement('button');
  del.className = 'log-del';
  del.textContent = '✕';
  del.onclick = function(e) { e.stopPropagation(); active.remove(); };
  hd.appendChild(del);
  active.insertBefore(hd, active.firstChild);

  hd.onclick = function(e) {
    if (e.target.tagName !== 'BUTTON') active.classList.toggle('collapsed');
  };
}

function appendLog(name, line) {
  const content = document.getElementById(`logs-content-${cssEscape(name)}`);
  if (!content) return;
  const bd = content.querySelector('.log-session.active .log-session-bd');
  if (!bd) return;
  bd.textContent += line + '\n';
  if (!logScrollPaused[name]) {
    content.scrollTop = content.scrollHeight;
  }
}

function clearLogs(name) {
  const content = document.getElementById(`logs-content-${cssEscape(name)}`);
  if (!content) return;
  content.innerHTML = '';
  if (esMap[name]) {
    const session = document.createElement('div');
    session.className = 'log-session active';
    const bd = document.createElement('div');
    bd.className = 'log-session-bd';
    session.appendChild(bd);
    content.appendChild(session);
  }
}

function toggleLogs(name) {
  const area = document.getElementById(`logs-area-${cssEscape(name)}`);
  const btn = document.getElementById(`logs-btn-${cssEscape(name)}`);
  if (!area) return;
  activeLogs[name] = !activeLogs[name];
  area.classList.toggle('active', activeLogs[name]);
  btn.innerHTML = activeLogs[name] ? '⏸' : '📋';
  if (activeLogs[name]) {
    const cfg = configs.find(c => c.name === name);
    if (cfg?.running && !esMap[name]) connectSSE(name);
  }
}

function updateCardHeader(name) {
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  const st = cardState[name];
  if (!st) return;

  const title = document.getElementById('card-title-'+cssEscape(name));
  const fields = document.getElementById('card-fields-'+cssEscape(name));
  if (!title || !fields) return;

  if (st.editing) {
    title.style.display = 'none';
    fields.style.display = 'flex';
    const ni = document.getElementById('card-name-'+cssEscape(name));
    if (ni) { ni.value = cfg.name; }
    const di = document.getElementById('card-desc-'+cssEscape(name));
    if (di) { di.value = cfg.description || ''; }
    setTimeout(() => ni?.focus(), 50);
  } else {
    title.style.display = '';
    fields.style.display = 'none';
    title.textContent = cfg.name;
  }
  updateEditBtns(name, !!st.editing);
}

function updateEditBtns(name, editing) {
  const editBtn = document.getElementById('edit-btn-'+cssEscape(name));
  const cloneBtn = document.getElementById('clone-btn-'+cssEscape(name));
  if (editBtn) editBtn.style.display = editing ? 'none' : 'inline-flex';
  if (cloneBtn) cloneBtn.style.display = editing ? 'none' : 'inline-flex';
}

async function toggleEdit(name) {
  const cfg = configs.find(c => c.name === name);
  if (!cfg || cfg.running) return;
  const st = cardState[name];
  if (!st) return;

  if (expandedCard !== name) {
    focusCard(name);
    toggleExpand(name, true);
  } else {
    st.editing = true;
    updateCardHeader(name);
    const runBtn = document.getElementById('card-'+cssEscape(name))?.querySelector('.toolbar-btn.run, .toolbar-btn.stop');
    if (runBtn) runBtn.disabled = true;
  }
}

async function confirmEdit(name) {
  const cfg = configs.find(c => c.name === name);
  if (!cfg) return;
  const st = cardState[name];
  if (!st) return;

  const nameInput = document.getElementById('card-name-'+cssEscape(name));
  const descInput = document.getElementById('card-desc-'+cssEscape(name));
  const newName = nameInput ? nameInput.value.trim() : cfg.name;
  const desc = descInput ? descInput.value.trim() : '';

  if (!newName) {
    showToast('Name cannot be empty', 'err');
    return;
  }

  if (st.isNew) {
    if (st.mode === 'raw' && rawInput[name] !== undefined) {
      parseFullCmd(rawInput[name], name);
      delete rawInput[name];
    }
    try {
      const r = await fetch('/api/card/create', {
        method: 'POST',
        body: new URLSearchParams({name: newName})
      });
      if (!r.ok) {
        const err = await r.text();
        showToast('Error: ' + err, 'err');
        return;
      }
      const argsSt = cfg.args_str || '';
      const envSt = cfg.env_str || '';
      const rt = cfg.runtime || '';
      const params = new URLSearchParams({name: newName, args_str: argsSt, env_str: envSt, runtime: rt});
      if (desc) params.set('description', desc);
      const r2 = await fetch('/api/config/update', { method: 'POST', body: params });
      if (!r2.ok) showToast('Card created but config save failed', 'err');
      delete st.isNew;
      await reloadAll();
      focusCard(newName);
      showToast('➕ Card created', 'ok');
    } catch(e) {
      showToast('Create error', 'err');
      return;
    }
  } else {
    if (newName !== cfg.name) {
      try {
        const r = await fetch('/api/card/rename', {
          method: 'POST',
          body: new URLSearchParams({name, new_name: newName})
        });
        if (!r.ok) {
          const err = await r.text();
          showToast('Error: ' + err, 'err');
          st.editing = true;
          updateCardHeader(name);
          return;
        }
        if (desc) {
          const newCfg = configs.find(c => c.name === newName);
          if (newCfg) {
            newCfg.description = desc;
            await fetch('/api/config/update', {
              method: 'POST',
              body: new URLSearchParams({name: newName, args_str: newCfg.args_str, env_str: newCfg.env_str || '', runtime: newCfg.runtime || '', description: desc})
            });
          }
        }
        await reloadAll();
        focusCard(newName);
        showToast('✏️ Card updated', 'ok');
        return;
      } catch(e) {
        showToast('Rename error', 'err');
        st.editing = true;
        updateCardHeader(name);
        return;
      }
    }

    if (cfg.description !== desc) {
      cfg.description = desc;
      await saveCardConfig(name);
    }
  }

  st.editing = false;
  updateCardHeader(name);
  const runBtn = document.getElementById('card-'+cssEscape(name))?.querySelector('.toolbar-btn.run, .toolbar-btn.stop');
  if (runBtn) runBtn.disabled = false;
}

async function cancelEdit(name) {
  const st = cardState[name];
  if (!st) return;

  st.editing = false;

  if (st.isNew) {
    const idx = configs.findIndex(c => c.name === name);
    if (idx >= 0) configs.splice(idx, 1);
    delete cardState[name];
    if (focusedCard === name) focusedCard = null;
    if (expandedCard === name) {
      expandedCard = null;
      const container = document.getElementById('cardsContainer');
      if (container) container.classList.remove('expanded');
    }
    renderCards();
    if (configs.length) focusCard(configs[0].name);
    updateGlobalExpandBtn();
  } else {
    const cfg = configs.find(c => c.name === name);
    if (cfg) {
      cfg.args_str = st.originalArgs;
      cfg.env_str = st.originalEnv;
      cfg.runtime = st.originalRuntime;
      updateArgsSection(name);
    }
    updateCardHeader(name);
    const runBtn = document.getElementById('card-'+cssEscape(name))?.querySelector('.toolbar-btn.run, .toolbar-btn.stop');
    if (runBtn) runBtn.disabled = false;
  }
}

function toggleScrollPause(name) {
  logScrollPaused[name] = !logScrollPaused[name];
  const btn = document.getElementById(`scroll-btn-${cssEscape(name)}`);
  if (!btn) return;
  btn.textContent = logScrollPaused[name] ? '⏸ Auto-scroll' : '▶ Auto-scroll';
  btn.classList.toggle('paused', logScrollPaused[name]);
}

async function refreshStatus() {
  try {
    const fresh = await fetch('/api/configs').then(r => r.json());
    fresh.forEach(f => {
      const cfg = configs.find(c => c.name === f.name);
      if (!cfg) return;
      cfg.running = f.running;
      cfg.ready = f.ready;
      cfg.ctx_size = f.ctx_size;
      cfg.pid = f.pid;
      cfg.uptime = f.uptime;
      cfg.port = f.port;
      if (f.last_used) lastUsed[f.name] = f.last_used;
    });
    updateCardsStatus();
    configs.forEach(c => {
      if (activeLogs[c.name] && c.running && !esMap[c.name]) {
        connectSSE(c.name);
      }
    });
    const anyReady = configs.some(c => c.ready);
    const h1 = document.querySelector('h1');
    if (h1) h1.classList.toggle('running', anyReady);
  } catch(e) {}
}

function updateCardsStatus() {
  configs.forEach(c => {
    const card = document.getElementById('card-' + cssEscape(c.name));
    if (!card) return;
    if (card.classList.contains('hidden')) return;

    card.classList.toggle('running', c.running);

    const title = card.querySelector('.card-title');
    if (title) {
      title.classList.toggle('running', c.running && c.ready);
      title.classList.toggle('starting', c.running && !c.ready);
    }

    const toolbar = card.querySelector('.toolbar-group');
    if (!toolbar) return;

    const logsBtnHtml = '<button class="toolbar-btn' + (activeLogs[c.name] ? ' active' : '') + '" onclick="toggleLogs(\''+escJs(c.name)+'\')" id="logs-btn-'+cssEscape(c.name)+'" title="' + (activeLogs[c.name] ? 'Pause' : 'Show') + ' logs">' + (activeLogs[c.name] ? '⏸' : '📋') + '</button>';
    const isEditing = cardState[c.name]?.editing;

    if (c.running) {
      const label = c.ready ? '▶ Running' : '▶ Starting';
      const pidLabel = '(pid: ' + c.pid + ')';
      toolbar.innerHTML =
        '<button class="toolbar-btn stop' + (isEditing ? ' disabled-btn' : '') + '" onclick="stopModel(\''+escJs(c.name)+'\')" title="' + label + ' ' + pidLabel + '"' + (isEditing ? ' disabled' : '') + '>⏹</button>' +
        logsBtnHtml +
        '<button class="toolbar-btn web-btn' + (c.ready ? '' : ' hidden') + '" onclick="window.open(location.protocol+\'//\'+location.hostname+\':\'+'+(c.port||8080)+')" title="Open chat">🌐</button>';
    } else {
      toolbar.innerHTML =
        '<button class="toolbar-btn run' + (isEditing ? ' disabled-btn' : '') + '" onclick="runModel(\''+escJs(c.name)+'\')" title="' + (isEditing ? 'Editing — save first' : 'Stopped') + '"' + (isEditing ? ' disabled' : '') + '>▶</button>' +
        logsBtnHtml +
        '<button class="toolbar-btn web-btn hidden" onclick="window.open(location.protocol+\'//\'+location.hostname+\':\'+'+(c.port||8080)+')" title="Open chat">🌐</button>';
    }

    updateEditBtns(c.name, !!cardState[c.name]?.editing);
  });
}

function formatBytes(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + 'GB';
  return mb.toFixed(0) + 'MB';
}

function tempColor(temp) {
  if (temp < 55) return '#3fb950';
  if (temp < 70) return '#d29922';
  if (temp < 80) return '#f0883e';
  return '#f85149';
}

function refreshGPUInfo() {
  fetch('/api/gpu-info')
    .then(r => r.json())
    .then(gpus => {
      const el = document.getElementById('gpuInfo');
      if (!el) return;
      if (!gpus || gpus.length === 0) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.innerHTML = gpus.map(g =>
        `<span class="gpu-item" title="${g.name}
CUDA ${g.index}
Memory: ${formatBytes(g.mem_used)} used / ${formatBytes(g.mem_tot)} total / ${formatBytes(g.mem_tot - g.mem_used)} free
Temp: ${g.temp}°C
Power: ${g.power_w}W">` +
        `<span class="gpu-idx">CUDA ${g.index}</span>` +
        `<span class="gpu-mem">${formatBytes(g.mem_tot - g.mem_used)}</span>` +
        `<span class="gpu-temp" style="color:${tempColor(g.temp)}">${g.temp}°C</span>` +
        `</span>`
      ).join('');
    })
    .catch(() => {});
}

setInterval(refreshStatus, 8000);
setInterval(refreshGPUInfo, 3000);

function showFirstRunPage() {
  const header = document.querySelector('.header');
  if (header) header.style.display = 'none';
  const footer = document.querySelector('.footer');
  if (footer) footer.style.display = 'none';

  const container = document.getElementById('cardsContainer');
  container.className = '';
  container.style.display = '';
  container.innerHTML = `
<div style="max-width:680px;margin:0 auto;padding:40px 20px;text-align:center">
  <h1 style="font-family:'DSEG7',monospace;font-size:32px;color:#58a6ff;margin-bottom:4px;letter-spacing:2px">7L</h1>
  <p style="color:#8b949e;font-size:14px;margin-bottom:30px">llama.cpp Model Manager</p>
  <p style="color:#8b949e;font-size:14px">🔍 Scanning system for llama.cpp resources...</p>
</div>`;

  fetch('/api/first-run/smart-scan')
    .then(r => r.json())
    .then(s => renderWizardPage1(s))
    .catch(() => {
      container.innerHTML = `
<div style="max-width:680px;margin:0 auto;padding:40px 20px;text-align:center">
  <h1 style="font-family:'DSEG7',monospace;font-size:32px;color:#58a6ff;margin-bottom:4px;letter-spacing:2px">7L</h1>
  <p style="color:#8b949e;font-size:14px;margin-bottom:30px">llama.cpp Model Manager</p>
  <p style="color:#f85149;font-size:14px;margin-bottom:20px">❌ Scan failed</p>
</div>`;
    });
}

let wizardScanData = null;
let wizardRuntime = '';
let wizardHfCache = '';

function renderWizardPage1(s) {
  wizardScanData = s;
  wizardRuntime = s.binaries && s.binaries.length > 0 ? s.binaries[0].path : '';
  wizardHfCache = s.hf_cache || '/home/user/.cache/huggingface/hub';

  const hasBin = s.binaries && s.binaries.length > 0;
  const hasModels = s.models && s.models.length > 0;
  const multiBin = hasBin && s.binaries.length > 1;

  const binHtml = !hasBin ? '<span style="color:#f85149">not found</span>' :
    multiBin ? `<select class="fr-select" id="wizBinSelect" onchange="wizardRuntime=this.value">
      ${s.binaries.map((b,i) => `<option value="${escHtml(b.path)}"${i===0?' selected':''}>${escHtml(b.path)}${b.version ? ' — '+escHtml(b.version) : ''}</option>`).join('')}
    </select>` :
    `<span style="color:#c9d1d9">${escHtml(s.binaries[0].path)}${s.binaries[0].version ? ' — '+escHtml(s.binaries[0].version) : ''}</span>`;

  const container = document.getElementById('cardsContainer');
  container.innerHTML = `
<div style="max-width:680px;margin:0 auto;padding:40px 20px">
  <h1 style="font-family:'DSEG7',monospace;font-size:32px;color:#58a6ff;margin-bottom:4px;letter-spacing:2px">7L</h1>
  <p style="color:#8b949e;font-size:14px;margin-bottom:24px">llama.cpp Model Manager — Setup Wizard</p>

  <div id="wizScanResults" class="fr-scan-results">
    <div class="fr-scan-item"><span class="fr-scan-label">Runtime</span><span class="fr-scan-val">${binHtml}</span></div>
    <div class="fr-scan-item"><span class="fr-scan-label">Models</span><span class="fr-scan-val" id="wizModelsCount">${hasModels ? s.models.length + ' found' : '<span style="color:#8b949e">none found</span>'}</span></div>
    <div class="fr-scan-item"><span class="fr-scan-label">HF cache</span><span class="fr-scan-val" id="wizCacheStatus">${wizardHfCache ? escHtml(wizardHfCache) : '<span style="color:#8b949e">not found</span>'}</span></div>
  </div>

  <h2 style="font-size:16px;color:#c9d1d9;margin:20px 0 14px;border-bottom:1px solid #21262d;padding-bottom:6px"><span style="margin-right:6px">⚙️</span>Configuration</h2>

  <div style="margin-bottom:14px">
    <label class="fr-label">HuggingFace cache folder <span style="color:#484f58">(created if missing)</span></label>
    <div class="fr-row">
      <input class="fr-input" id="wizCacheInput" value="${escHtml(wizardHfCache)}" spellcheck="false" oninput="wizardHfCache=this.value">
      <button class="btn btn-cancel" style="white-space:nowrap;padding:4px 10px;font-size:12px" onclick="wizBrowseCache()">📁 Browse</button>
    </div>
  </div>

  <div style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end">
    <button class="btn btn-save" onclick="wizardFinish()" style="padding:8px 24px;font-size:14px">${hasModels ? '🚀 Start using 7L' : '➡️ Next'}</button>
  </div>

  <div id="wizProgress" style="display:none;margin-top:16px;padding:12px;background:#161b22;border:1px solid #30363d;border-radius:6px;text-align:center;font-size:13px;color:#8b949e">
    <span id="wizProgressText">Processing...</span>
  </div>
</div>`;
}

function wizBrowseCache() {
  browseDirOnly = true;
  fileDialogCallback = function(path) {
    const inp = document.getElementById('wizCacheInput');
    if (inp) { inp.value = path; wizardHfCache = path; }
  };
  document.getElementById('fileDialogModelName').textContent = 'Select HF cache folder';
  document.getElementById('fileDialogPath').placeholder = '/path/to/cache';
  document.getElementById('fileDialogPath').value = wizardHfCache || '/home';
  document.getElementById('fileDialogResetBtn').style.display = 'none';
  browseCurrentDir = wizardHfCache || '/home';
  showHidden = true;
  document.getElementById('showHiddenBtn').classList.add('active');
  document.getElementById('fileDialog').classList.add('active');
  browseDir(browseCurrentDir);
}

function wizSetProgress(msg) {
  const prog = document.getElementById('wizProgress');
  if (prog) { prog.style.display = 'block'; document.getElementById('wizProgressText').textContent = msg; }
}

async function wizardFinish() {
  wizSetProgress('Saving configuration...');
  const hasModels = wizardScanData && wizardScanData.models && wizardScanData.models.length > 0;
  try {
    const r = await fetch('/api/wizard/save', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        runtime: wizardRuntime,
        hf_cache: wizardHfCache,
        models: hasModels ? wizardScanData.models.map(m => ({path: m.path, name: m.name})) : []
      })
    });
    const d = await r.json();
    if (d.status === 'ok') {
      if (d.hasModels) {
        wizSetProgress('✅ Done! Loading...');
        setTimeout(() => location.reload(), 800);
      } else {
        showWizardPage2();
      }
    } else {
      wizSetProgress('❌ Error: ' + (d.msg || 'unknown'));
    }
  } catch(e) {
    wizSetProgress('❌ Request failed: ' + e.message);
  }
}

function showWizardPage2() {
  const container = document.getElementById('cardsContainer');
  container.innerHTML = `
<div style="max-width:680px;margin:0 auto;padding:40px 20px">
  <h1 style="font-family:'DSEG7',monospace;font-size:32px;color:#58a6ff;margin-bottom:4px;letter-spacing:2px">7L</h1>
  <p style="color:#8b949e;font-size:14px;margin-bottom:20px">llama.cpp Model Manager — Setup Wizard</p>

  <div style="background:#161b22;border:1px solid #d29922;border-radius:8px;padding:16px;margin-bottom:20px">
    <p style="color:#d29922;font-weight:600;margin-bottom:8px">⚠️ No models found</p>
    <p style="color:#8b949e;font-size:13px;line-height:1.5">
      The scan didn't find any GGUF model files on your system. Let's create your first model card.
      You can use a template to download from HuggingFace, or paste any launch command.
    </p>
  </div>

  <h2 style="font-size:16px;color:#c9d1d9;margin:0 0 14px">Create your first card</h2>

  <div class="first-run-card clickable" onclick="wizTemplateLlama()" style="margin-bottom:10px">
    <div class="fr-card-title">🦙 Llama 3.2 3B Instruct (Bartowski)</div>
    <div class="fr-card-desc">Creates a card that downloads <code>Llama-3.2-3B-Instruct.Q4_K_M.gguf</code> from HuggingFace via <code>--hf-repo</code> / <code>--hf-file</code>. You can review and edit before saving.</div>
  </div>

  <div class="first-run-card clickable" onclick="wizPasteCommand()" style="margin-bottom:10px">
    <div class="fr-card-title">📋 Paste launch command</div>
    <div class="fr-card-desc">Paste any <code>llama-server</code> command (with <code>--model</code>, <code>--hf-repo</code>, etc.) and we'll parse it into a card for you.</div>
  </div>

  <div id="wizPage2Paste" style="display:none;margin-top:10px;padding:14px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
    <label class="fr-label" style="margin-top:0">Paste your launch command</label>
    <textarea id="wizPasteInput" class="filedialog-input" spellcheck="false" style="min-height:80px;font-family:monospace;font-size:13px;margin-bottom:8px" placeholder="llama-server --hf-repo bartowski/Llama-3.2-3B-Instruct-GGUF --hf-file Llama-3.2-3B-Instruct.Q4_K_M.gguf -c 4096"></textarea>
    <button class="btn btn-save" onclick="wizParseAndOpen()" style="font-size:13px;padding:6px 16px">📋 Parse & Open</button>
    <span id="wizPasteStatus" style="font-size:12px;color:#8b949e;margin-left:10px"></span>
  </div>

  <div id="wizPage2Progress" style="display:none;margin-top:16px;padding:12px;background:#161b22;border:1px solid #30363d;border-radius:6px;text-align:center;font-size:13px;color:#8b949e">
    <span id="wizPage2ProgressText">Processing...</span>
  </div>
</div>`;
}

function wizTemplateLlama() {
  showAddCardDialog(
    'llama-3.2-3b-instruct',
    '--hf-repo bartowski/Llama-3.2-3B-Instruct-GGUF --hf-file Llama-3.2-3B-Instruct.Q4_K_M.gguf -c 4096',
    ''
  );
}

function wizPasteCommand() {
  const pasteDiv = document.getElementById('wizPage2Paste');
  if (pasteDiv) pasteDiv.style.display = 'block';
}

async function wizParseAndOpen() {
  const cmd = document.getElementById('wizPasteInput').value.trim();
  const status = document.getElementById('wizPasteStatus');
  if (!cmd) { status.textContent = 'Paste a command first'; return; }
  status.textContent = 'Parsing...';
  try {
    const r = await fetch('/api/parse-command', {
      method: 'POST',
      body: new URLSearchParams({command: cmd})
    });
    if (!r.ok) { status.textContent = 'Parse failed'; return; }
    const d = await r.json();
    // Auto-name from model or hf-file
    const nameMatch = d.args.match(/--hf-file\s+(\S+)/) || d.args.match(/-m\s+(\S+)/) || d.args.match(/--model\s+(\S+)/);
    const name = nameMatch ? nameMatch[1].split('/').pop().replace(/\.gguf$/, '') : 'my-model';
    showAddCardDialog(name, d.args, d.binary);
    status.textContent = '✅ Parsed';
  } catch(e) {
    status.textContent = 'Parse error';
  }
}

fetch('/api/first-run')
  .then(r => r.json())
  .then(data => {
    if (data.firstRun) {
      showFirstRunPage();
    } else {
      loadConfigs();
      loadGlobalConfig();
      refreshStatus();
      refreshGPUInfo();
      updateGlobalExpandBtn();
      updateSortDisabled();
    }
  })
  .catch(() => {
    loadConfigs();
    loadGlobalConfig();
    refreshStatus();
    refreshGPUInfo();
    updateGlobalExpandBtn();
    updateSortDisabled();
  });
