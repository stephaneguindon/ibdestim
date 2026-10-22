/* Classic scripts deliberately support opening index.html directly via file://. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.IBD;
  const state = { parsed: null, data: null, visible: [], current: 0, cumulative: true, timer: null,
    source: null, view: { x0: 0, x1: 1, y0: 0, y1: 200 }, pinned: null, screens: [], surfaceCache: null, interpolatorCache: null };
  const format = (n, digits = 3) => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
  const axisFormat = n => Math.abs(n) >= 100000 ? n.toExponential(1) : format(n, Math.abs(n) < .01 && n !== 0 ? 5 : 2);
  const raw = n => String(n);
  const count = (n, noun) => `${format(n, 0)} ${noun}${n === 1 ? '' : 's'}`;
  let plot = null, chart = null, renderPending = false, pointer = null, moved = false;
  let readVersion = 0, legacyPicker = false, pendingRefresh = null, directFileAccessBlocked = false;
  const blockedFileAccess = error => ['NotAllowedError', 'SecurityError', 'NotSupportedError'].includes(error.name);

  function message(text, error = false) {
    $('message').hidden = !text;
    $('message').textContent = text;
    $('message').classList.toggle('error', error);
  }
  function populateMapping(parsed, columns = parsed.mapping) {
    for (const role of ['x', 'y', 'z', 'g']) {
      const select = $(`column-${role}`);
      select.replaceChildren(new Option(role === 'g' ? 'None' : 'Choose a column…', '-1'));
      parsed.headers.forEach((h, i) => select.add(new Option(h, String(i))));
      select.value = String(columns[role]); select.disabled = false;
    }
    $('apply-columns').disabled = false;
    $('mapping-details').open = ['x', 'y', 'z'].some(r => columns[r] < 0);
  }
  function mapping() {
    return Object.fromEntries(['x', 'y', 'z', 'g'].map(r => [r, Number($(`column-${r}`).value)]));
  }
  function applyData({ parsed = state.parsed, columns = mapping(), preserve = false } = {}) {
    try {
      const data = C.prepare(parsed, columns, { rowOrder: $('row-order').checked, batch: $('batch-size').value });
      const previous = state.data, currentId = previous?.generations[state.current];
      const wasLatest = previous && state.current === previous.generations.length - 1;
      const fullView = initialView(), wasFullView = Object.keys(fullView).every(key => Math.abs(state.view[key] - fullView[key]) < 1e-9);
      const pinned = state.pinned;
      stop(); state.data = data; state.pinned = null; hideTooltip();
      if (parsed !== state.parsed) { state.parsed = parsed; populateMapping(parsed, columns); }
      state.current = preserve && previous ? (wasLatest ? data.generations.length - 1 : Math.max(0, data.generations.indexOf(currentId))) : 0;
      if (!preserve || wasFullView) resetView();
      else state.view = clampView({ ...state.view });
      if (preserve && pinned) state.pinned = data.points.find(p => p.x === pinned.x && p.y === pinned.y && p.z === pinned.z && p.generation === pinned.generation) || null;
      const problems = [];
      if (data.rejected.invalid) problems.push(`${count(data.rejected.invalid, 'row')} with missing or non-finite values`);
      if (data.rejected.domain) problems.push(`${count(data.rejected.domain, 'row')} outside the domain (m ∈ [0,1], l a positive integer)`);
      if (data.rejected.generation) problems.push(`${count(data.rejected.generation, 'row')} with no generation`);
      if (data.rejected.header) problems.push(`${count(data.rejected.header, 'repeated header')}`);
      const notices = [];
      if (problems.length) notices.push(`Skipped: ${problems.join('; ')}.`);
      if (state.parsed.headerless) notices.push('No header found. Assuming m, l, logLk for three columns, or generation, m, l, logLk for four. Check the column mapping.');
      if (data.noGenerations) notices.push('No generation column found. Showing all points together. You can use row order to create playback steps.');
      if (data.synthetic) notices.push('Playback steps follow row order. They do not represent actual generations.');
      if (data.generations.some(v => !Number.isFinite(C.number(v)))) notices.push('Text generation IDs are shown in order of first appearance.');
      message(notices.join(' '));
      $('data-badge').textContent = 'Loaded';
      const slider = $('generation'); slider.max = String(data.generations.length - 1); slider.value = '0';
      slider.disabled = data.generations.length < 2;
      $('first-generation').textContent = data.noGenerations ? 'All points' : data.generations[0];
      $('last-generation').textContent = data.noGenerations ? '' : data.generations[data.generations.length - 1];
      $('empty').hidden = true; $('export').disabled = false;
      update();
      return true;
    } catch (error) {
      message(`${preserve ? 'Could not refresh; previous results kept. ' : ''}${error.message}`, true);
      if (!preserve) $('mapping-details').open = true;
      return false;
    }
  }
  function loadParsed(parsed, name) {
    // Do not show the previous file's map under a newly imported file's name.
    stop(); state.data = null; state.visible = []; state.best = null; state.pinned = null; state.surfaceCache = null;
    hideTooltip(); resetView();
    $('empty').hidden = false; $('empty').querySelector('strong').textContent = 'Choose the columns to display this file';
    $('data-badge').textContent = 'Waiting for column mapping';
    $('stat-lk').textContent = '—'; $('stat-pair').textContent = 'm — / l —'; $('stat-count').textContent = '0';
    $('stat-delta').textContent = 'No results loaded'; $('stat-best-gen').textContent = 'For the best visible point'; $('stat-total').textContent = 'No points shown';
    $('ranking').replaceChildren();
    $('legend-min').textContent = 'min'; $('legend-mid').textContent = ''; $('legend-max').textContent = 'max';
    $('generation-info').textContent = 'Choose the columns to replay the search.';
    $('first-generation').textContent = 'First'; $('current-generation').textContent = '—'; $('last-generation').textContent = 'Last';
    for (const id of ['play', 'prev', 'next', 'generation', 'export']) $(id).disabled = true;
    state.parsed = parsed;
    $('file-info').textContent = `${name} · ${count(parsed.rows.length, 'row')}`;
    populateMapping(parsed); applyData(); scheduleDraw();
  }
  function setReading(reading) {
    $('file').disabled = reading;
    $('refresh').disabled = reading || !state.source;
    $('refresh').textContent = reading ? 'Reading…' : 'Refresh data';
  }
  function updateFileTools(text = '') {
    $('file-tools').hidden = !state.source;
    $('refresh').disabled = !state.source;
    $('refresh-info').textContent = text || (state.source?.handle ? 'Read the latest contents of this file.' : 'Your browser will ask you to select the file again.');
  }
  async function readSource(getFile, context = {}) {
    const version = ++readVersion;
    const previousSource = state.source;
    setReading(true);
    try {
      const file = await getFile();
      if (!file || version !== readVersion) return;
      if (file.size > 150 * 1024 * 1024) throw new Error('This file is larger than 150 MB. Try a smaller results file.');
      let text = await file.text();
      if (version !== readVersion) return;
      const refresh = Boolean(context.refresh && previousSource === state.source && file.name === previousSource?.file.name);
      // Newline-terminated logs may be read in the middle of an append. Defer
      // that last line so a partly written score cannot look like a real result.
      const pendingLine = refresh && previousSource.completeLines && !/^[\s\uFEFF]*[\[{]/.test(text) && !/[\r\n]$/.test(text);
      if (pendingLine) text = text.slice(0, text.lastIndexOf('\n') + 1);
      const parsed = C.parse(text);
      if (refresh && state.data) {
        const selected = mapping();
        const columns = Object.fromEntries(Object.entries(selected).map(([role, index]) => [role, index < 0 ? -1 : parsed.headers.indexOf(state.parsed.headers[index])]));
        if (Object.entries(selected).some(([role, index]) => index >= 0 && columns[role] < 0)) throw new Error('Column names changed. Import the file again to update the column mapping.');
        if (!applyData({ parsed, columns, preserve: true })) return;
        $('file-info').textContent = `${file.name} · ${count(parsed.rows.length, 'row')}`;
      } else loadParsed(parsed, file.name);
      state.source = { file, handle: context.handle || null, completeLines: pendingLine || /[\r\n]$/.test(text) };
      const time = new Date().toLocaleTimeString('en-GB');
      updateFileTools(`${refresh ? 'Refreshed' : 'Read'} at ${time}. ` + (pendingLine ? 'Waiting for the last line to finish. ' : '') +
        (state.source.handle ? '' : 'Select the file again to refresh.'));
    } catch (error) {
      if (version !== readVersion || error.name === 'AbortError') return;
      if (context.handle && blockedFileAccess(error)) {
        fallBackToFilePicker(Boolean(context.refresh));
        return;
      }
      const detail = ['NotReadableError', 'NotFoundError'].includes(error.name) ? 'The file changed or is unavailable. Try again or choose the file again.' : error.message;
      message(`${context.refresh ? 'Could not refresh; previous results kept' : 'Could not load file'}: ${detail}`, true);
    } finally {
      if (version === readVersion) { setReading(false); $('file').value = ''; }
    }
  }
  function openStandardPicker(refresh = false) {
    setReading(false);
    pendingRefresh = refresh ? state.source : null;
    // A native picker may consume the original click's user activation. In
    // that case the next explicit click uses the standard input directly.
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    legacyPicker = true;
    try { $('file').click(); } finally { legacyPicker = false; }
  }
  function fallBackToFilePicker(refresh) {
    directFileAccessBlocked = true;
    if (refresh && state.source) {
      state.source.handle = null;
      updateFileTools();
    }
    message('Direct file access is blocked in this browser. Select the file in the standard picker, or click Choose a file again.');
    openStandardPicker(refresh);
  }
  function chooseFile(refresh = false) {
    if (directFileAccessBlocked || typeof window.showOpenFilePicker !== 'function') {
      openStandardPicker(refresh);
      return;
    }
    const context = { refresh };
    readSource(async () => {
      try {
        const [handle] = await window.showOpenFilePicker({ multiple: false,
          types: [{ description: 'Results files', accept: { 'text/plain': ['.txt', '.csv', '.tsv', '.json'] } }] });
        context.handle = handle;
        return await handle.getFile();
      } catch (error) {
        if (blockedFileAccess(error)) {
          fallBackToFilePicker(refresh);
          return null;
        }
        throw error;
      }
    }, context);
  }
  $('file').addEventListener('click', e => {
    if (legacyPicker) return;
    if (directFileAccessBlocked || typeof window.showOpenFilePicker !== 'function') return;
    pendingRefresh = null;
    e.preventDefault(); chooseFile();
  });
  $('file').addEventListener('change', e => {
    const file = e.target.files[0], refresh = pendingRefresh && pendingRefresh === state.source;
    pendingRefresh = null;
    if (file) readSource(() => file, { refresh });
  });
  $('file').addEventListener('cancel', () => { pendingRefresh = null; });
  $('refresh').addEventListener('click', () => {
    if (!state.source) return;
    const handle = state.source.handle;
    if (handle) readSource(() => handle.getFile(), { handle, refresh: true });
    else chooseFile(true);
  });
  for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, e => { e.preventDefault(); $('dropzone').classList.add('dragging'); });
  $('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragging'));
  $('dropzone').addEventListener('drop', e => {
    e.preventDefault(); $('dropzone').classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    const item = [...e.dataTransfer.items].find(item => item.kind === 'file');
    // Obtain the handle promise synchronously while the drop's data store is open.
    let handlePromise;
    try { if (!directFileAccessBlocked) handlePromise = item?.getAsFileSystemHandle?.(); } catch { /* Fall back to the file object. */ }
    if (file) {
      const context = {};
      readSource(async () => {
        if (!directFileAccessBlocked) {
          try { const handle = await handlePromise; if (handle?.kind === 'file') context.handle = handle; } catch { /* Use the dropped file directly. */ }
        }
        if (context.handle) {
          try { return await context.handle.getFile(); }
          catch (error) {
            if (!blockedFileAccess(error)) throw error;
            directFileAccessBlocked = true;
            context.handle = null;
          }
        }
        return file;
      }, context);
    }
  });
  // Avoid navigating away if a file is dropped just outside the import box.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
  $('apply-columns').addEventListener('click', applyData);
  for (const id of ['row-order', 'batch-size']) $(id).addEventListener('change', () => { if (state.parsed && Number($('column-g').value) < 0) applyData(); });

  function update() {
    const d = state.data; if (!d) return;
    state.visible = state.cumulative ? d.points.filter(p => p.gi <= state.current) : d.groups[state.current];
    state.surfaceCache = null;
    state.interpolatorCache = null;
    const best = state.cumulative ? d.progress[state.current] : state.visible.reduce((a, p) => !a || p.z > a.z ? p : a, null);
    state.best = best;
    $('stat-lk').textContent = format(best.z, 3);
    $('stat-pair').replaceChildren(document.createTextNode(`m ${format(best.x, 5)} `), Object.assign(document.createElement('span'), { textContent: '/' }), document.createTextNode(` l ${format(best.y, 0)}`));
    const delta = d.maxZ - best.z;
    $('stat-delta').textContent = delta === 0 ? 'Matches the best in the file' : `Gap to file maximum: ${format(delta, 3)}`;
    $('stat-best-gen').textContent = d.noGenerations ? 'For the best visible point' : `Evaluated in ${d.synthetic ? 'step' : 'generation'} ${best.generation}`;
    $('stat-count').textContent = format(state.visible.length, 0);
    $('stat-total').textContent = `of ${format(d.points.length, 0)} valid points`;
    $('generation-info').textContent = d.noGenerations ? 'No generation IDs. Showing all points.' : `${d.synthetic ? 'Step (from rows)' : 'Generation'} ${d.generations[state.current]} · ${count(d.groups[state.current].length, 'point')} evaluated · ${state.current + 1} / ${d.generations.length}`;
    $('current-generation').textContent = d.noGenerations ? 'All points' : `${d.synthetic ? 'Step' : 'Generation'} ${d.generations[state.current]}`;
    $('generation').value = String(state.current);
    $('prev').disabled = state.current === 0;
    $('next').disabled = state.current === d.generations.length - 1;
    $('play').disabled = d.generations.length < 2;
    const rows = C.topDistinct(state.visible);
    $('ranking').replaceChildren(...rows.map((p, i) => {
      const row = document.createElement('tr');
      [String(i + 1), format(p.x, 5), format(p.y, 0), format(p.z, 3), d.noGenerations ? '—' : p.generation].forEach(value => {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      });
      return row;
    }));
    $('map').setAttribute('aria-label', `${state.visible.length} visible points. Best logLk ${best.z}, at m ${best.x}, l ${best.y}.`);
    if (state.pinned && !state.visible.includes(state.pinned)) { state.pinned = null; hideTooltip(); }
    updateLegend(); scheduleDraw();
  }
  function chooseGeneration(index) {
    if (!state.data) return;
    state.current = Math.max(0, Math.min(state.data.generations.length - 1, index)); update();
  }
  function stop() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null; $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play generations');
  }
  function advance() {
    if (state.current >= state.data.generations.length - 1) { stop(); return; }
    chooseGeneration(state.current + 1);
    state.timer = setTimeout(advance, Number($('speed').value));
  }
  $('play').addEventListener('click', () => {
    if (state.timer) { stop(); return; }
    if (!state.data || state.data.generations.length < 2) return;
    if (state.current === state.data.generations.length - 1) chooseGeneration(0);
    $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', 'Pause playback');
    state.timer = setTimeout(advance, Number($('speed').value));
  });
  $('prev').addEventListener('click', () => { stop(); chooseGeneration(state.current - 1); });
  $('next').addEventListener('click', () => { stop(); chooseGeneration(state.current + 1); });
  $('generation').addEventListener('input', e => { stop(); chooseGeneration(Number(e.target.value)); });
  for (const [id, cumulative] of [['mode-cumulative', true], ['mode-current', false]]) $(id).addEventListener('click', () => {
    state.cumulative = cumulative;
    $('mode-cumulative').setAttribute('aria-pressed', String(cumulative));
    $('mode-current').setAttribute('aria-pressed', String(!cumulative)); update();
  });
  function updateLegend() {
    const d = state.data; if (!d) return;
    const mode = $('contrast').value;
    const low = mode === 'focus' ? Math.max(d.minZ, d.maxZ - 10) : d.minZ;
    const middle = mode === 'quantile' ? d.sortedZ[Math.floor((d.sortedZ.length - 1) / 2)] : (low + d.maxZ) / 2;
    $('legend-min').textContent = `${mode === 'focus' && low > d.minZ ? '≤ ' : ''}${format(low, 2)}`;
    $('legend-mid').textContent = format(middle, 2);
    $('legend-max').textContent = format(d.maxZ, 2);
    const equal = d.minZ === d.maxZ;
    document.querySelector('.colorbar').style.background = equal ? `rgb(${C.color(.5).join(',')})` : '';
    $('scale-note').textContent = equal ? 'All logLk values are equal.' : mode === 'quantile' ? 'Colors show quantile ranks across the whole file, not the size of logLk differences.' : 'Color limits use the whole file and stay fixed during playback.';
  }
  for (const id of ['surface', 'contrast', 'points', 'resolution']) $(id).addEventListener('input', () => {
    state.surfaceCache = null;
    if (id === 'resolution') state.interpolatorCache = null;
    $('resolution-value').textContent = $('resolution').value;
    $('surface-note').textContent = $('surface').value === 'smooth' ? 'Estimated logLk across the full grid. Beyond tested points, the colors are extrapolated.' : $('surface').value === 'cells' ? 'Best logLk in each cell. Untested cells are left blank.' : 'Only evaluated points are shown, colored by logLk.';
    updateLegend(); scheduleDraw();
  });
  $('log-y').addEventListener('change', () => { state.interpolatorCache = null; resetView(); scheduleDraw(); });

  const logY = () => $('log-y').checked;
  function transformedY(y) { return logY() ? Math.log10(y) : y; }
  function initialView() {
    const d = state.data;
    if (!d) return { x0: 0, x1: 1, y0: 0, y1: 200 };
    const lo = transformedY(d.minY), hi = transformedY(d.maxY);
    const pad = Math.max((hi - lo) * .07, logY() ? .05 : 2);
    return { x0: 0, x1: 1, y0: logY() ? Math.max(-.05, lo - pad) : Math.max(0, Math.floor(lo - pad)), y1: hi + pad };
  }
  function resetView() { state.view = initialView(); state.surfaceCache = null; }
  $('reset-view').addEventListener('click', () => { resetView(); scheduleDraw(); });
  $('zoom-in').addEventListener('click', () => zoom(.7));
  $('zoom-out').addEventListener('click', () => zoom(1.4));
  function clampView(v) {
    const full = initialView();
    const dx = Math.min(1, Math.max(1e-7, v.x1 - v.x0));
    v.x0 = Math.max(0, Math.min(1 - dx, v.x0)); v.x1 = v.x0 + dx;
    const total = full.y1 - full.y0, dy = Math.min(total, Math.max(total * 1e-7, v.y1 - v.y0));
    v.y0 = Math.max(full.y0, Math.min(full.y1 - dy, v.y0)); v.y1 = v.y0 + dy;
    return v;
  }
  function zoom(factor, px = .5, py = .5) {
    const v = state.view, cx = v.x0 + px * (v.x1 - v.x0), cy = v.y0 + py * (v.y1 - v.y0);
    const dx = (v.x1 - v.x0) * factor, dy = (v.y1 - v.y0) * factor;
    state.view = clampView({ x0: cx - px * dx, x1: cx + (1 - px) * dx, y0: cy - py * dy, y1: cy + (1 - py) * dy });
    state.surfaceCache = null; scheduleDraw();
  }
  function fit(canvas) {
    const box = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, box.width), h = Math.max(1, box.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); state.surfaceCache = null; }
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  function ticks(lo, hi, target = 6) {
    const diff = hi - lo;
    if (!(diff > 0)) return [lo];
    const base = 10 ** Math.floor(Math.log10(diff / target)), step0 = diff / target / base;
    const step = (step0 <= 1 ? 1 : step0 <= 2 ? 2 : step0 <= 2.5 ? 2.5 : step0 <= 5 ? 5 : 10) * base;
    const result = [];
    for (let v = Math.ceil(lo / step) * step, i = 0; v <= hi + step * 1e-8 && i < 30; v += step, i++) result.push(Math.abs(v) < step * 1e-8 ? 0 : v);
    return result;
  }
  function scheduleDraw() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; drawMap(); drawConvergence(); });
  }
  function heatSurface(bounds) {
    if (state.surfaceCache) return state.surfaceCache;
    const nx = Number($('resolution').value), ny = Math.max(15, Math.round(nx * bounds.h / bounds.w));
    const smooth = $('surface').value === 'smooth', scale = smooth ? 3 : 1;
    const v = state.view;
    let grid, field;
    if (smooth) {
      if (!state.interpolatorCache) {
        const y0 = transformedY(state.data.minY);
        const span = Math.max(transformedY(state.data.maxY) - y0, logY() ? .1 : 1);
        function* samples() {
          for (const p of state.visible) yield { x: p.x, y: (transformedY(p.y) - y0) / span, z: p.z };
        }
        state.interpolatorCache = { y0, span, estimate: C.makeInterpolator(samples(), { bins: nx * 2 }) };
      }
      field = state.interpolatorCache;
    } else {
      grid = new Float64Array(nx * ny); grid.fill(NaN);
      for (const p of state.visible) {
        const fx = (p.x - v.x0) / (v.x1 - v.x0), fy = (transformedY(p.y) - v.y0) / (v.y1 - v.y0);
        if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
        const ix = Math.min(nx - 1, Math.floor(fx * nx)), iy = Math.min(ny - 1, Math.floor((1 - fy) * ny));
        const index = iy * nx + ix;
        if (Number.isNaN(grid[index]) || p.z > grid[index]) grid[index] = p.z;
      }
    }
    const off = document.createElement('canvas'); off.width = nx * scale; off.height = ny * scale;
    const ctx = off.getContext('2d'), pixels = ctx.createImageData(off.width, off.height), mode = $('contrast').value;
    for (let y = 0; y < off.height; y++) {
      for (let x = 0; x < off.width; x++) {
        let z;
        if (smooth) {
          const px = v.x0 + (x + .5) / off.width * (v.x1 - v.x0);
          const py = v.y1 - (y + .5) / off.height * (v.y1 - v.y0);
          z = field.estimate(px, (py - field.y0) / field.span);
        } else z = grid[y * nx + x];
        if (Number.isNaN(z)) continue;
        const rgb = C.color(C.fraction(z, state.data, mode)), index = (y * off.width + x) * 4;
        pixels.data[index] = rgb[0]; pixels.data[index + 1] = rgb[1]; pixels.data[index + 2] = rgb[2]; pixels.data[index + 3] = smooth ? 255 : 165;
      }
    }
    ctx.putImageData(pixels, 0, 0); state.surfaceCache = off; return off;
  }
  function star(ctx, x, y, r = 10) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = i * Math.PI / 5 - Math.PI / 2, radius = i % 2 ? r * .42 : r;
      const sx = x + Math.cos(a) * radius, sy = y + Math.sin(a) * radius;
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.closePath(); ctx.fillStyle = '#ae332f'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.fill(); ctx.stroke();
  }
  function drawMap() {
    const { ctx, w, h } = fit($('map'));
    const bounds = { x: w < 500 ? 55 : 65, y: 20, w: w - (w < 500 ? 75 : 88), h: h - 72 };
    const v = state.view;
    const sx = x => bounds.x + (x - v.x0) / (v.x1 - v.x0) * bounds.w;
    const sy = y => bounds.y + bounds.h - (transformedY(y) - v.y0) / (v.y1 - v.y0) * bounds.h;
    plot = { ...bounds, sx, sy };
    ctx.fillStyle = '#fff'; ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    if (state.data && $('surface').value !== 'none') {
      ctx.imageSmoothingEnabled = $('surface').value === 'smooth';
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(heatSurface(bounds), bounds.x, bounds.y, bounds.w, bounds.h);
    }
    const xticks = ticks(v.x0, v.x1, w < 500 ? 4 : 8);
    const yticks = logY() ? ticks(v.y0, v.y1, 6).map(t => 10 ** t) : ticks(v.y0, v.y1, 6);
    ctx.font = '11px "Segoe UI", Arial, sans-serif'; ctx.lineWidth = 1;
    ctx.strokeStyle = state.data && $('surface').value === 'smooth' ? 'rgba(25,39,55,0.18)' : '#e7e8ea';
    ctx.fillStyle = '#626970';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const t of xticks) { const x = sx(t); ctx.beginPath(); ctx.moveTo(x, bounds.y); ctx.lineTo(x, bounds.y + bounds.h); ctx.stroke(); ctx.fillText(axisFormat(t), x, bounds.y + bounds.h + 10); }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const t of yticks) { const y = sy(t); ctx.beginPath(); ctx.moveTo(bounds.x, y); ctx.lineTo(bounds.x + bounds.w, y); ctx.stroke(); ctx.fillText(axisFormat(t), bounds.x - 10, y); }
    ctx.fillStyle = '#50575e'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('m · migration', bounds.x + bounds.w / 2, h - 4);
    ctx.save(); ctx.translate(13, bounds.y + bounds.h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(`l · population size${logY() ? ' (log)' : ''}`, 0, 0); ctx.restore();
    ctx.strokeStyle = '#bfc4c8'; ctx.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
    state.screens = [];
    if (!state.data) return;
    ctx.save(); ctx.beginPath(); ctx.rect(bounds.x, bounds.y, bounds.w, bounds.h); ctx.clip();
    const mode = $('contrast').value, showPoints = $('points').checked;
    // Bucket draw calls by color to keep large imports interactive.
    const buckets = Array.from({ length: 80 }, () => []), fresh = [];
    for (const p of state.visible) {
      const x = sx(p.x), y = sy(p.y);
      if (x < bounds.x || x > bounds.x + bounds.w || y < bounds.y || y > bounds.y + bounds.h) continue;
      const screen = { x, y, p }; state.screens.push(screen);
      if (showPoints) {
        buckets[Math.min(79, Math.max(0, Math.round(C.fraction(p.z, state.data, mode) * 79)))].push(screen);
        if (p.gi === state.current) fresh.push(screen);
      }
    }
    if (showPoints) {
      const radius = state.screens.length > 30000 ? 1 : state.screens.length > 5000 ? 1.5 : 2.4;
      ctx.globalAlpha = .8;
      buckets.forEach((bucket, i) => {
        if (!bucket.length) return;
        ctx.fillStyle = `rgb(${C.color(i / 79).join(',')})`; ctx.beginPath();
        for (const s of bucket) { ctx.moveTo(s.x + radius, s.y); ctx.arc(s.x, s.y, radius, 0, Math.PI * 2); }
        ctx.fill();
      });
      ctx.globalAlpha = .85; ctx.strokeStyle = '#173e47'; ctx.lineWidth = .7; ctx.beginPath();
      // Dark outlines mark the newly tested generation without masking its logLk color.
      if (fresh.length < 6000) for (const s of fresh) { ctx.moveTo(s.x + radius + .5, s.y); ctx.arc(s.x, s.y, radius + .5, 0, Math.PI * 2); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    const best = state.best;
    if (best) star(ctx, sx(best.x), sy(best.y));
    if (state.pinned) {
      const p = state.pinned; ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), 8, 0, Math.PI * 2);
      ctx.strokeStyle = '#173d43'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.restore();
    if (state.pinned) showTooltip(state.pinned, sx(state.pinned.x), sy(state.pinned.y), true);
  }
  function drawConvergence() {
    const { ctx, w, h } = fit($('convergence'));
    const b = { x: 61, y: 17, w: w - 78, h: h - 49 };
    chart = b; ctx.font = '10px "Segoe UI", Arial, sans-serif';
    if (!state.data) { ctx.fillStyle = '#f3f3f0'; ctx.fillRect(b.x, b.y, b.w, b.h); return; }
    const data = state.data, values = data.progress.map(p => p.z), lo = values[0], hi = values[values.length - 1];
    const padding = Math.max((hi - lo) * .12, .5), bottom = lo - padding, top = hi + padding;
    const sx = i => b.x + (values.length === 1 ? .5 : i / (values.length - 1)) * b.w;
    const sy = v => b.y + b.h - (v - bottom) / (top - bottom) * b.h;
    ctx.strokeStyle = '#e5e6e7'; ctx.fillStyle = '#626970'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (const tick of ticks(bottom, top, 4)) {
      const y = sy(tick); ctx.beginPath(); ctx.moveTo(b.x, y); ctx.lineTo(b.x + b.w, y); ctx.stroke(); ctx.fillText(axisFormat(tick), b.x - 8, y);
    }
    const index = state.current;
    ctx.fillStyle = '#f0f0ed'; ctx.fillRect(sx(index), b.y, b.x + b.w - sx(index), b.h);
    ctx.strokeStyle = '#bfc5cb'; ctx.lineWidth = 1.5; ctx.beginPath();
    values.forEach((v, i) => { if (!i) ctx.moveTo(sx(i), sy(v)); else { ctx.lineTo(sx(i), sy(values[i - 1])); ctx.lineTo(sx(i), sy(v)); } }); ctx.stroke();
    ctx.strokeStyle = '#345c83'; ctx.lineWidth = 2; ctx.beginPath();
    values.slice(0, index + 1).forEach((v, i) => { if (!i) ctx.moveTo(sx(i), sy(v)); else { ctx.lineTo(sx(i), sy(values[i - 1])); ctx.lineTo(sx(i), sy(v)); } }); ctx.stroke();
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.strokeStyle = '#8b969f'; ctx.beginPath(); ctx.moveTo(sx(index), b.y); ctx.lineTo(sx(index), b.y + b.h); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(sx(index), sy(values[index]), 4, 0, Math.PI * 2); ctx.fillStyle = '#345c83'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#626970'; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.fillText(data.noGenerations ? 'All points' : data.generations[0], b.x, b.y + b.h + 12);
    ctx.textAlign = 'right'; ctx.fillText(data.noGenerations ? '' : data.generations[data.generations.length - 1], b.x + b.w, b.y + b.h + 12);
    $('convergence').setAttribute('aria-label', `Running maximum logLk: ${values[index]}, at generation ${data.generations[index]}.`);
  }

  function pointAt(x, y) {
    if (!plot || x < plot.x || x > plot.x + plot.w || y < plot.y || y > plot.y + plot.h) return null;
    let best = null, distance = 100;
    for (const s of state.screens) {
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      // On overlapping coordinates, prefer the greatest likelihood.
      if (d < distance || (d === distance && best && s.p.z > best.p.z)) { best = s; distance = d; }
    }
    return best;
  }
  function hideTooltip() { $('tooltip').hidden = true; }
  function showTooltip(p, x, y, pinned = false) {
    const tooltip = $('tooltip'); tooltip.replaceChildren();
    const title = document.createElement('strong'); title.textContent = pinned ? 'Selected point' : 'Evaluated point'; tooltip.append(title);
    for (const [label, value] of [['m', raw(p.x)], ['l', raw(p.y)], ['logLk', raw(p.z)], [state.data.synthetic ? 'Step' : 'Generation', state.data.noGenerations ? '—' : p.generation]]) {
      const line = document.createElement('div'), key = document.createElement('span'); key.textContent = label;
      line.append(key, document.createTextNode(value)); tooltip.append(line);
    }
    const note = document.createElement('small'); note.textContent = pinned ? 'Click empty space or press Esc to clear' : 'Click to keep selected'; tooltip.append(note);
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(4, Math.min(x + 15, $('plot-wrap').clientWidth - tooltip.offsetWidth - 5))}px`;
    tooltip.style.top = `${Math.max(4, Math.min(y + 10, $('plot-wrap').clientHeight - tooltip.offsetHeight - 5))}px`;
  }
  const coords = e => { const rect = $('map').getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top }; };
  $('map').addEventListener('pointerdown', e => {
    if (e.button !== 0 || !state.data) return;
    const p = coords(e); if (!plot || p.x < plot.x || p.x > plot.x + plot.w || p.y < plot.y || p.y > plot.y + plot.h) return;
    pointer = { ...p, view: { ...state.view } }; moved = false;
    $('map').setPointerCapture(e.pointerId);
  });
  $('map').addEventListener('pointermove', e => {
    const p = coords(e);
    if (pointer) {
      const dx = p.x - pointer.x, dy = p.y - pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) {
        const v = pointer.view, tx = dx / plot.w * (v.x1 - v.x0), ty = dy / plot.h * (v.y1 - v.y0);
        state.view = clampView({ x0: v.x0 - tx, x1: v.x1 - tx, y0: v.y0 + ty, y1: v.y1 + ty });
        state.surfaceCache = null; $('map').style.cursor = 'grabbing'; hideTooltip(); scheduleDraw();
      }
      return;
    }
    if (!state.pinned) { const hit = pointAt(p.x, p.y); if (hit) showTooltip(hit.p, hit.x, hit.y); else hideTooltip(); }
  });
  $('map').addEventListener('pointerup', e => {
    if (!pointer) return;
    const p = coords(e);
    if (!moved) {
      const hit = pointAt(p.x, p.y); state.pinned = hit ? hit.p : null;
      if (!hit) hideTooltip(); scheduleDraw();
    }
    pointer = null; $('map').style.cursor = 'crosshair';
  });
  $('map').addEventListener('pointercancel', () => { pointer = null; $('map').style.cursor = 'crosshair'; });
  $('map').addEventListener('pointerleave', () => { if (!state.pinned) hideTooltip(); });
  $('map').addEventListener('dblclick', () => { resetView(); scheduleDraw(); });
  $('map').addEventListener('wheel', e => {
    if (!state.data || !plot) return;
    const p = coords(e);
    if (p.x < plot.x || p.x > plot.x + plot.w || p.y < plot.y || p.y > plot.y + plot.h) return;
    e.preventDefault(); zoom(Math.exp(Math.max(-.35, Math.min(.35, e.deltaY * .0015))), (p.x - plot.x) / plot.w, 1 - (p.y - plot.y) / plot.h);
  }, { passive: false });
  $('map').addEventListener('keydown', e => {
    if (e.key === 'Escape') { state.pinned = null; hideTooltip(); scheduleDraw(); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(.7); }
    if (e.key === '-') { e.preventDefault(); zoom(1.4); }
    if (e.key === '0') { resetView(); scheduleDraw(); }
  });
  $('convergence').addEventListener('click', e => {
    if (!chart || !state.data) return;
    const rect = $('convergence').getBoundingClientRect(), t = (e.clientX - rect.left - chart.x) / chart.w;
    stop(); chooseGeneration(Math.round(t * (state.data.generations.length - 1)));
  });
  $('export').addEventListener('click', () => {
    if (!state.data) return;
    // Protect spreadsheet readers against formula-like textual generation IDs.
    const csvField = value => {
      let s = String(value); if (/^[=+@-]/.test(s) && !Number.isFinite(Number(s))) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = ['generation,m,l,logLk', ...state.visible.map(p => [state.data.noGenerations ? '' : csvField(p.generation), p.x, p.y, p.z].join(','))];
    const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'ibdestim-visible-points.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  if (window.matchMedia('(max-width: 760px)').matches) $('plot-settings').open = false;
  new ResizeObserver(scheduleDraw).observe($('plot-wrap'));
  new ResizeObserver(scheduleDraw).observe(document.querySelector('.convergence-wrap'));
  scheduleDraw();
})();
