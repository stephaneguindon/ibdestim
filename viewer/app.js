/* Classic scripts deliberately support opening index.html directly via file://. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.IBD;
  const state = { parsed: null, data: null, topPoints: [], visible: [], current: 0, cumulative: true, timer: null,
    source: null, view: { x0: 0, x1: 1, y0: 0, y1: 200 }, pinned: null, densityCache: null };
  const format = (n, digits = 3) => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
  const axisFormat = n => Math.abs(n) >= 100000 ? n.toExponential(1) : format(n, Math.abs(n) < .01 && n !== 0 ? 5 : 2);
  const raw = n => String(n);
  const count = (n, noun) => `${format(n, 0)} ${noun}${n === 1 ? '' : 's'}`;
  let chart = null, renderPending = false, mapDrawing = false, mapQueued = false, plotReady = false;
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
      const fullView = initialView();
      fullView.y1 = generationYLimits(state.visible, previous).upper;
      const wasFullView = Object.keys(fullView).every(key => Math.abs(state.view[key] - fullView[key]) < 1e-9);
      const pinned = state.pinned;
      stop(); state.data = data; state.topPoints = C.topLikelihood(data.points); state.pinned = null; hideTooltip();
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
      if (data.noGenerations) notices.push('No generation column found. Showing the overall top 20% of valid points by logLk. You can use row order to create playback steps.');
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
    stop(); state.data = null; state.topPoints = []; state.visible = []; state.best = null; state.pinned = null;
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
    const evaluatedTopPoints = state.topPoints.filter(p => p.gi <= state.current);
    state.visible = state.cumulative ? evaluatedTopPoints : evaluatedTopPoints.filter(p => p.gi === state.current);
    const full = initialView(), { upper, padding } = generationYLimits(state.visible, d);
    state.view.y1 = upper;
    state.view.y0 = Math.min(state.view.y0, Math.max(full.y0, upper - Math.max(padding, 1e-7)));

    const best = state.visible.reduce((a, p) => !a || p.z > a.z ? p : a, null);
    state.best = best;
    $('stat-lk').textContent = format(best?.z, 3);
    $('stat-pair').replaceChildren(document.createTextNode(`m ${format(best?.x, 5)} `), Object.assign(document.createElement('span'), { textContent: '/' }), document.createTextNode(` l ${format(best?.y, 0)}`));
    $('stat-delta').textContent = !best ? 'No points retained for this generation' :
      d.maxZ === best.z ? 'Matches the best in the file' : `Gap to file maximum: ${format(d.maxZ - best.z, 3)}`;
    $('stat-best-gen').textContent = !best ? 'No retained point to show' :
      d.noGenerations ? 'For the best visible point' : `Evaluated in ${d.synthetic ? 'step' : 'generation'} ${best.generation}`;
    $('stat-count').textContent = format(state.visible.length, 0);
    $('stat-total').textContent = `of ${format(d.points.length, 0)} valid points`;
    const evaluatedCount = d.evaluatedCounts.slice(0, state.current + 1).reduce((sum, n) => sum + n, 0);
    $('generation-info').textContent = d.noGenerations ? 'No generation IDs. Showing the top 20% of all valid points by logLk.' :
      `${d.synthetic ? 'Step (from rows)' : 'Generation'} ${d.generations[state.current]} · ${state.cumulative ? `${format(state.visible.length, 0)} plotted of ${format(evaluatedCount, 0)} evaluated so far (top 20% overall by logLk)` : `${format(state.visible.length, 0)} points from this generation in the overall top 20% by logLk · ${format(d.evaluatedCounts[state.current], 0)} evaluated this generation`} · ${state.current + 1} / ${d.generations.length}`;
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
    $('map').setAttribute('aria-label', best ?
      `${likelihoodBackground() ? 'LogLk and point density' : 'Point density'} for ${state.visible.length} visible tested points. Best logLk ${best.z}, at m ${best.x}, l ${best.y}.` :
      `No points from this generation are in the overall top 20% by logLk through generation ${d.generations[state.current]}.`);
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
  const likelihoodBackground = () => $('metric').value === 'loglk';
  function updatePresentation() {
    const likelihood = likelihoodBackground(), surface = $('surface').value;
    for (const option of $('contrast').options) {
      const unavailable = likelihood ? option.value === 'log' : option.value === 'focus';
      option.hidden = unavailable; option.disabled = unavailable;
    }
    if ($('contrast').selectedOptions[0].disabled) $('contrast').value = 'quantile';
    $('legend-title').textContent = likelihood ? 'logLk' : 'Points/cell';
    $('legend').hidden = surface === 'none' || surface === 'contours';
    $('surface-note').textContent = surface === 'none' ? 'Hover over a point for its logLk and the best result in its cell.' :
      surface === 'contours' ? 'Contours show the density of visible points; dots are colored by logLk.' : likelihood
      ? 'Colors show the best visible logLk in each cell. Untested cells are gray.' + (surface === 'smooth' ? ' Contours show point density.' : '')
      : 'Colors show the number of visible tested points in each cell. Blue: fewer points; red: more points.';
    $('map-caption').textContent = (surface === 'none' ? 'm ∈ [0, 1], l ∈ ℕ⁺. Showing tested points.' :
      surface === 'contours' ? 'Contours: density of visible tested points.' : likelihood
      ? 'Color: best logLk per cell.' + (surface === 'smooth' ? ' Contours: density of tested points.' : '')
      : 'Color: density of tested points.' + (surface === 'smooth' ? ' Contours include sparse regions.' : '')) +
      ($('points').checked ? ' Dot color: logLk.' : '');
  }
  function updateLegend() {
    if (!state.data) {
      $('legend-min').textContent = likelihoodBackground() ? 'min' : '0';
      $('legend-mid').textContent = ''; $('legend-max').textContent = 'max';
      document.querySelector('.colorbar').style.background = '';
      $('scale-note').textContent = likelihoodBackground() ? 'Blue: lower logLk; red: higher logLk. Untested cells are gray.' : 'Blue: fewer points; red: more points. Each tested point contributes once to the density.';
      return;
    }
    const colors = colorSettings();
    $('legend-min').textContent = `${$('contrast').value === 'focus' && colors.low > densityReference().likelihoodScores.minZ ? '≤ ' : ''}${format(colors.low, 2)}`;
    $('legend-mid').textContent = format(colors.middle, 2);
    $('legend-max').textContent = format(colors.high, 2);
    document.querySelector('.colorbar').style.background = colors.low === colors.high ? `rgb(${C.color(.5).join(',')})` : '';
    $('scale-note').textContent = $('surface').value === 'none' ? 'Background hidden. Hover over points to inspect their results.' :
      $('surface').value === 'contours' ? 'Dot colors show logLk. Contours show the density of visible points.' :
      ($('contrast').value === 'quantile' ? (likelihoodBackground() ? 'Quantiles use the best logLk in each occupied cell across the whole file. ' : 'Quantiles use occupied cells in the whole file. ') : '') +
      'Grid and color limits stay fixed during playback and zoom.';
  }
  for (const id of ['metric', 'surface', 'contrast', 'points', 'show-best', 'resolution']) $(id).addEventListener('input', () => {
    $('resolution-value').textContent = $('resolution').value;
    updatePresentation(); updateLegend(); scheduleDraw();
  });
  $('log-y').addEventListener('change', () => { resetView(); update(); });

  const logY = () => $('log-y').checked;
  function transformedY(y) { return logY() ? Math.log10(y) : y; }
  function initialView() {
    const d = state.data;
    if (!d) return { x0: 0, x1: 1, y0: 0, y1: logY() ? Math.log10(200) : 200 };
    const lo = transformedY(d.minY), hi = transformedY(d.maxY);
    const pad = Math.max((hi - lo) * .07, logY() ? .05 : 2);
    return { x0: 0, x1: 1, y0: logY() ? Math.max(-.05, lo - pad) : Math.max(0, Math.floor(lo - pad)), y1: hi + pad };
  }
  function generationYLimits(points, data) {
    if (!data) {
      const upper = logY() ? Math.log10(200) : 200;
      return { upper, padding: 2 };
    }
    let min = Infinity, max = -Infinity;
    for (const point of points) {
      const y = transformedY(point.y);
      min = Math.min(min, y); max = Math.max(max, y);
    }
    if (!points.length) { min = transformedY(data.minY); max = transformedY(data.maxY); }
    const padding = Math.max((max - min) * .07, logY() ? .05 : 2);
    return { upper: max + padding, padding };
  }
  function resetView() { state.view = initialView(); }
  $('reset-view').addEventListener('click', () => { resetView(); update(); });
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
    scheduleDraw();
  }
  function fit(canvas) {
    const box = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, box.width), h = Math.max(1, box.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
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
  function densityReference() {
    const nx = Number($('resolution').value), ny = Math.max(15, Math.round(nx * .6));
    const cached = state.densityCache;
    if (cached && cached.data === state.data && cached.nx === nx && cached.log === logY()) return cached;
    const full = initialView(), y0 = logY() ? 10 ** full.y0 : full.y0, y1 = logY() ? 10 ** full.y1 : full.y1;
    // Anchor bins to the whole file, so zooming and playback cannot move them.
    // The tiny extra width keeps points on the upper edge in the final bin.
    const dx = 1 / nx * (1 + 1e-9), dy = (y1 - y0) / ny * (1 + 1e-9);
    const counts = new Uint32Array(nx * ny), bestScores = new Float64Array(nx * ny);
    bestScores.fill(-Infinity);
    for (const p of state.data.points) {
      const ix = Math.min(nx - 1, Math.floor(p.x / dx));
      const iy = Math.min(ny - 1, Math.floor((p.y - y0) / dy));
      const index = iy * nx + ix;
      counts[index]++; bestScores[index] = Math.max(bestScores[index], p.z);
    }
    const sortedZ = Array.from(counts).filter(n => n > 0).sort((a, b) => a - b);
    const likelihoodZ = Array.from(bestScores).filter(Number.isFinite).sort((a, b) => a - b);
    state.densityCache = {
      data: state.data, nx, ny, log: logY(),
      xbins: { start: 0, end: 1, size: dx }, ybins: { start: y0, end: y1, size: dy },
      scores: { minZ: 0, maxZ: sortedZ[sortedZ.length - 1], sortedZ },
      likelihoodScores: { minZ: likelihoodZ[0], maxZ: likelihoodZ[likelihoodZ.length - 1], sortedZ: likelihoodZ }
    };
    return state.densityCache;
  }
  function densityGrid() {
    const { nx, ny, xbins, ybins } = densityReference();
    const z = Array.from({ length: ny }, () => Array(nx).fill(0));
    const best = Array.from({ length: ny }, () => Array(nx).fill(null));
    for (const p of state.visible) {
      const ix = Math.min(nx - 1, Math.floor((p.x - xbins.start) / xbins.size));
      const iy = Math.min(ny - 1, Math.floor((p.y - ybins.start) / ybins.size));
      z[iy][ix]++;
      if (!best[iy][ix] || p.z > best[iy][ix].z) best[iy][ix] = p;
    }
    return {
      x: Array.from({ length: nx }, (_, i) => xbins.start + (i + .5) * xbins.size),
      y: Array.from({ length: ny }, (_, i) => ybins.start + (i + .5) * ybins.size), z, best,
      details: z.map((row, iy) => row.map((n, ix) => {
        const point = best[iy][ix];
        return [n, point ? format(point.z, 6) : '—', generationText(point)];
      }))
    };
  }
  function densityContours(grid) {
    const max = Math.max(1, grid.z.reduce((highest, row) => row.reduce((best, count) => Math.max(best, count), highest), 0));
    const start = Math.log1p(.5), end = Math.log1p(max);
    const levels = Math.min(12, Math.max(1, Math.ceil(Math.log2(max + 1))));
    // Include sparse regions even when another cell is much denser.
    return {
      x: grid.x, y: grid.y, z: grid.z.map(row => row.map(n => Math.log1p(n))),
      type: 'contour', name: 'Density contours', meta: 'density-contours',
      autocontour: false,
      contours: { coloring: 'none', start, end, size: levels > 1 ? (end - start) / (levels - 1) : 1 },
      line: { color: 'rgba(30,48,65,0.5)', width: .8, smoothing: .7 },
      hoverinfo: 'skip', showscale: false, showlegend: false
    };
  }
  function colorSettings(forLikelihood = likelihoodBackground(), points = null) {
    if (!state.data) return { min: 0, max: 1, colorscale: [[0, '#2c5fba'], [1, '#b7303c']] };
    const reference = densityReference(), mode = $('contrast').value;
    const scores = points?.map(p => p.z).sort((a, b) => a - b);
    const d = scores?.length
      ? { minZ: scores[0], maxZ: scores[scores.length - 1], sortedZ: scores }
      : forLikelihood ? reference.likelihoodScores : reference.scores;
    const low = mode === 'focus' ? Math.max(d.minZ, d.maxZ - 10) : d.minZ, high = d.maxZ;
    const middle = mode === 'quantile' ? d.sortedZ[Math.floor((d.sortedZ.length - 1) / 2)] : mode === 'log' ? Math.sqrt(1 + high) - 1 : (low + high) / 2;
    if (low === high) {
      const color = `rgb(${C.color(.5).join(',')})`;
      return { min: low - .5, max: high + .5, low, high, middle, colorscale: [[0, color], [1, color]] };
    }
    const fraction = n => mode === 'log' ? Math.log1p(n) / Math.log1p(high) : C.fraction(n, d, mode);
    const values = mode === 'quantile'
      ? Array.from({ length: 257 }, (_, i) => d.sortedZ[Math.round(i / 256 * (d.sortedZ.length - 1))])
      : Array.from({ length: 257 }, (_, i) => low + i / 256 * (high - low));
    const stops = new Map([low, ...values, high].map(n => [(n - low) / (high - low), `rgb(${C.color(fraction(n)).join(',')})`]));
    return { min: low, max: high, low, high, middle, colorscale: [...stops].sort((a, b) => a[0] - b[0]) };
  }
  const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function generationText(point) { return point && !state.data.noGenerations ? escapeHTML(point.generation) : '—'; }
  function cellDetails(grid, row, column) { return grid.details[row][column]; }
  function pointTrace(points, marker, name, grid) {
    const { nx, ny, xbins, ybins } = densityReference();
    return {
      type: state.visible.length > 5000 ? 'scattergl' : 'scatter', mode: 'markers', name, meta: 'evaluated',
      x: points.map(p => p.x), y: points.map(p => p.y),
      customdata: points.map(p => {
        const ix = Math.min(nx - 1, Math.floor((p.x - xbins.start) / xbins.size));
        const iy = Math.min(ny - 1, Math.floor((p.y - ybins.start) / ybins.size));
        return [p.z, generationText(p), p.row, ...cellDetails(grid, iy, ix)];
      }),
      marker, showlegend: false,
      hovertemplate: `m: %{x:.6g}<br>l: %{y:,.0f}<br>logLk: %{customdata[0]:.6f}<br>${state.data.synthetic ? 'Step' : 'Generation'}: %{customdata[1]}<br><br>Tested points in cell: %{customdata[3]:,d}<br>Best logLk in cell: %{customdata[4]}<br>Best in ${state.data.synthetic ? 'step' : 'generation'}: %{customdata[5]}<extra></extra>`
    };
  }
  function drawMap() {
    if (!window.Plotly) { $('plot-error').hidden = false; return; }
    if (mapDrawing) { mapQueued = true; return; }
    const traces = [], colors = colorSettings(), pointColors = colorSettings(true, state.visible), v = state.view;
    if (state.data) {
      const background = $('surface').value, grid = densityGrid();
      if (background !== 'none' && background !== 'contours') {
        const likelihood = likelihoodBackground();
        // Both metrics and hover details use the same bounded grid on either axis.
        const heatmap = {
          type: 'heatmap', name: likelihood ? 'Best logLk per cell' : 'Tested point density', meta: 'cells',
          x: grid.x, y: grid.y, z: likelihood ? grid.best.map(row => row.map(p => p ? p.z : null)) : grid.z,
          customdata: grid.z.map((row, iy) => row.map((_, ix) => cellDetails(grid, iy, ix))),
          coloraxis: 'coloraxis', showlegend: false, hoverongaps: false,
          hovertemplate: `m: %{x:.6g}<br>l: %{y:,.2f}<br>Tested points in cell: %{customdata[0]:,d}<br>Best logLk in cell: %{customdata[1]}<br>Best in ${state.data.synthetic ? 'step' : 'generation'}: %{customdata[2]}<extra></extra>`
        };
        if (!likelihood && background === 'smooth') Object.assign(heatmap, {
          type: 'contour', autocontour: true, ncontours: 16,
          contours: { coloring: 'heatmap' }, line: { width: 0 }
        });
        traces.push(heatmap);
      }
      if (background === 'smooth' || background === 'contours') traces.push(densityContours(grid));
      if ($('points').checked) {
        const size = state.visible.length > 30000 ? 7.5 : state.visible.length > 5000 ? 9 : 12;
        traces.push(pointTrace(state.visible, {
          size, color: state.visible.map(p => p.z), cmin: pointColors.min, cmax: pointColors.max,
          colorscale: pointColors.colorscale, showscale: false, opacity: .3,
          line: { color: '#173e47', width: state.visible.map(p => p.gi === state.current && state.data.groups[state.current].length < 6000 ? .8 : 0) }
        }, 'Tested points', grid));
      }
      if ($('show-best').checked && state.best) traces.push(pointTrace([state.best], { size: 16, symbol: 'star', color: '#ae332f', line: { color: '#fff', width: 1.5 } }, 'Best visible point', grid));
      if (state.pinned) traces.push(pointTrace([state.pinned], { size: 16, symbol: 'circle-open', color: '#173d43', line: { width: 2 } }, 'Selected point', grid));
    }
    const axis = { zeroline: false, showline: true, mirror: true, linecolor: '#bfc4c8', gridcolor: 'rgba(25,39,55,0.14)', automargin: true, tickfont: { size: 11 }, fixedrange: !state.data };
    const layout = {
      autosize: true, width: $('map').clientWidth, height: $('map').clientHeight,
      margin: { l: 65, r: 22, t: 35, b: 55 }, paper_bgcolor: '#fff', plot_bgcolor: likelihoodBackground() && $('surface').value !== 'none' ? '#e8ecef' : '#fff',
      font: { family: '"Segoe UI", Arial, sans-serif', size: 12, color: '#50575e' },
      dragmode: 'pan', hovermode: 'closest', showlegend: false,
      xaxis: { ...axis, title: { text: 'm · migration', standoff: 12 }, type: 'linear', range: [v.x0, v.x1], autorange: false },
      yaxis: { ...axis, title: { text: `l · population size${logY() ? ' (log)' : ''}`, standoff: 12 }, type: logY() ? 'log' : 'linear', range: [v.y0, v.y1], autorange: false },
      coloraxis: { cauto: false, cmin: colors.min, cmax: colors.max, colorscale: colors.colorscale, showscale: false },
      hoverlabel: { bgcolor: '#fff', bordercolor: '#92989e', font: { color: '#292c30', size: 12 } }
    };
    mapDrawing = true;
    // Serialize renders: playback and refresh can arrive while Plotly is drawing.
    Promise.resolve().then(() => Plotly.react($('map'), traces, layout, {
      displaylogo: false, scrollZoom: true, doubleClick: 'reset', responsive: false,
      modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'resetScale2d'],
      toImageButtonOptions: { format: 'png', filename: 'ibdestim-parameter-space', scale: 2 }
    })).then(() => {
      if (!plotReady) { bindPlotEvents(); plotReady = true; }
      $('plot-error').hidden = true;
      if (state.pinned) showTooltip(state.pinned);
    }).catch(error => {
      message(`Could not draw the Plotly figure: ${error.message}`, true);
    }).finally(() => {
      mapDrawing = false;
      if (mapQueued) { mapQueued = false; scheduleDraw(); }
    });
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

  function hideTooltip() { $('tooltip').hidden = true; }
  function showTooltip(p) {
    const tooltip = $('tooltip'); tooltip.replaceChildren();
    const title = document.createElement('strong'); title.textContent = 'Selected point'; tooltip.append(title);
    for (const [label, value] of [['m', raw(p.x)], ['l', raw(p.y)], ['logLk', raw(p.z)], [state.data.synthetic ? 'Step' : 'Generation', state.data.noGenerations ? '—' : p.generation]]) {
      const line = document.createElement('div'), key = document.createElement('span'); key.textContent = label;
      line.append(key, document.createTextNode(value)); tooltip.append(line);
    }
    const note = document.createElement('small'); note.textContent = 'Click the selected point again or press Esc to clear'; tooltip.append(note);
    tooltip.hidden = false;
  }
  function bindPlotEvents() {
    const map = $('map');
    map.on('plotly_click', event => {
      const hit = event.points.find(p => p.data.meta === 'evaluated');
      if (!hit) { state.pinned = null; hideTooltip(); scheduleDraw(); return; }
      const point = state.visible.find(p => p.row === hit.customdata[2]);
      state.pinned = point === state.pinned ? null : point;
      if (!state.pinned) hideTooltip();
      scheduleDraw();
    });
    map.on('plotly_relayout', event => {
      if (mapDrawing) return;
      if (event['xaxis.autorange'] || event['yaxis.autorange']) { resetView(); update(); return; }
      const range = axis => event[`${axis}.range`] || [event[`${axis}.range[0]`], event[`${axis}.range[1]`]];
      const x = range('xaxis'), y = range('yaxis'), v = state.view;
      if (![...x, ...y].some(Number.isFinite)) return;
      state.view = clampView({ x0: x[0] ?? v.x0, x1: x[1] ?? v.x1, y0: y[0] ?? v.y0, y1: y[1] ?? v.y1 });
      scheduleDraw();
    });
    map.on('plotly_doubleclick', () => { resetView(); update(); return false; });
  }
  $('map').addEventListener('keydown', e => {
    if (e.key === 'Escape') { state.pinned = null; hideTooltip(); scheduleDraw(); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(.7); }
    if (e.key === '-') { e.preventDefault(); zoom(1.4); }
    if (e.key === '0') { resetView(); update(); }
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
  updatePresentation(); updateLegend(); scheduleDraw();
})();
