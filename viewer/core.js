/* Parsing and numerical helpers. No network or browser dependencies. */
(function (root) {
  'use strict';
  const aliases = {
    x: ['m', 'migration', 'migrationrate', 'x', 'param1', 'parameter1'],
    y: ['l', 'n', 'populationsize', 'size', 'y', 'param2', 'parameter2'],
    z: ['lk', 'loglk', 'logl', 'loglikelihood', 'loglik', 'likelihood', 'score'],
    g: ['iter', 'iteration', 'generation', 'generationid', 'gen', 'genid', 'idgeneration', 'step']
  };
  const normalized = s => String(s).toLowerCase().replace(/^\uFEFF/, '').replace(/[^a-z0-9]/g, '');
  function number(s) {
    if (s === null || s === undefined || String(s).trim() === '') return NaN;
    return Number(String(s).trim().replace(',', '.'));
  }
  function fields(line, delimiter) {
    if (delimiter === ' ') return line.trim().split(/\s+/);
    const result = []; let field = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { field += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === delimiter && !quoted) { result.push(field.trim()); field = ''; }
      else field += ch;
    }
    if (quoted) throw new Error('Unclosed quote in a row. Multiline fields are not supported.');
    result.push(field.trim()); return result;
  }
  function infer(headers) {
    const keys = headers.map(normalized), map = {};
    for (const role of Object.keys(aliases)) map[role] = keys.findIndex(key => aliases[role].includes(key));
    return map;
  }
  function parse(text) {
    text = text.replace(/^\uFEFF/, '').trim();
    if (!text) throw new Error('The file is empty.');
    if (text[0] === '[' || text[0] === '{') {
      const obj = JSON.parse(text), records = Array.isArray(obj) ? obj : (obj.results || obj.points || obj.data);
      if (!Array.isArray(records) || !records.length) throw new Error('Expected a JSON array of points, or an object containing results, points or data.');
      if (Array.isArray(records[0])) return fromRows(records, true);
      if (!records.every(r => r && typeof r === 'object' && !Array.isArray(r))) throw new Error('Use an object for every JSON point, or an array for every row.');
      const headers = [...new Set(records.flatMap(Object.keys))];
      return { headers, rows: records.map(r => headers.map(h => r[h])), mapping: infer(headers), headerless: false };
    }
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
    if (!lines.length) throw new Error('The file contains no results.');
    const first = lines[0];
    const delimiter = first.includes('\t') ? '\t' : first.includes(';') ? ';' : first.includes(',') ? ',' : ' ';
    return fromRows(lines.map(line => fields(line, delimiter)));
  }
  function fromRows(rows, json = false) {
    const headerless = rows[0].every(v => Number.isFinite(number(v)));
    const width = rows[0].length;
    if (width < 3) throw new Error('At least three columns are needed: m, l and logLk.');
    if (headerless && width > 4) throw new Error('This headerless file is ambiguous. Add column names (m, l, logLk, generation). The repository data.txt contains model inputs, not results.');
    const headers = headerless ? (width === 3 ? ['m', 'l', 'logLk'] : ['generation', 'm', 'l', 'logLk']) : rows.shift().map(String);
    if (new Set(headers).size !== headers.length) throw new Error('Column names must be unique.');
    if (!rows.length) throw new Error('The file has a header but no results.');
    return { headers, rows, mapping: infer(headers), headerless, json };
  }
  function prepare(parsed, mapping = parsed.mapping, options = {}) {
    const { x, y, z, g } = mapping;
    if ([x, y, z].some(i => i < 0 || i >= parsed.headers.length)) throw new Error('Select the m, l and logLk columns to display results.');
    if (new Set([x, y, z]).size !== 3 || (g >= 0 && [x, y, z].includes(g))) throw new Error('Use a different column for each field.');
    const points = [], rejected = { invalid: 0, domain: 0, header: 0, generation: 0 };
    const batch = Math.max(1, Math.floor(Number(options.batch) || 100));
    parsed.rows.forEach((row, index) => {
      if (row.every((v, i) => normalized(v) === normalized(parsed.headers[i]))) { rejected.header++; return; }
      const px = number(row[x]), py = number(row[y]), pz = number(row[z]);
      if (![px, py, pz].every(Number.isFinite)) { rejected.invalid++; return; }
      if (px < 0 || px > 1 || py <= 0 || !Number.isSafeInteger(py)) { rejected.domain++; return; }
      let generation = g >= 0 ? row[g] : (options.rowOrder ? Math.floor(index / batch) + 1 : 0);
      if (generation === undefined || generation === null || String(generation).trim() === '') { rejected.generation++; return; }
      generation = String(generation).trim();
      points.push({ x: px, y: py, z: pz, generation, row: index + 1 });
    });
    if (!points.length) throw new Error('No valid points. Check the columns: m must be between 0 and 1, l a positive integer, and logLk a finite number.');
    const generations = [...new Set(points.map(p => p.generation))];
    if (generations.every(v => Number.isFinite(number(v)))) generations.sort((a, b) => number(a) - number(b));
    const indices = new Map(generations.map((g, i) => [g, i]));
    const groups = generations.map(() => []);
    let minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      p.gi = indices.get(p.generation); groups[p.gi].push(p);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    let best = null;
    const progress = groups.map(group => {
      for (const p of group) if (!best || p.z > best.z) best = p;
      return best;
    });
    // Deterministic reservoir-sized sample limits sort cost for very large imports.
    const stride = Math.max(1, Math.ceil(points.length / 100000));
    const sortedZ = points.filter((_, i) => i % stride === 0).map(p => p.z).sort((a, b) => a - b);
    return { points, generations, groups, progress, minZ, maxZ, minY, maxY, sortedZ, rejected,
      synthetic: g < 0 && Boolean(options.rowOrder), noGenerations: g < 0 && !options.rowOrder };
  }
  function lowerBound(array, value) {
    let lo = 0, hi = array.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (array[mid] < value) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function fraction(z, data, mode) {
    if (data.maxZ === data.minZ) return 0.5;
    if (mode === 'quantile') {
      if (z <= data.minZ) return 0;
      if (z >= data.maxZ) return 1;
      return Math.max(0, Math.min(1, lowerBound(data.sortedZ, z) / Math.max(1, data.sortedZ.length - 1)));
    }
    const lo = mode === 'focus' ? Math.max(data.minZ, data.maxZ - 10) : data.minZ;
    return Math.max(0, Math.min(1, (z - lo) / (data.maxZ - lo)));
  }
  const stops = [[44, 95, 186], [66, 164, 203], [179, 217, 219], [243, 208, 149], [221, 121, 86], [183, 48, 60]];
  function color(t) {
    const p = Math.max(0, Math.min(1, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p));
    return stops[i].map((v, c) => Math.round(v + (stops[i + 1][c] - v) * (p - i)));
  }
  function topDistinct(points, count = 8) {
    const pairs = new Map();
    for (const p of points) {
      const key = `${p.x}:${p.y}`, prev = pairs.get(key);
      if (!prev || p.z > prev.z) pairs.set(key, p);
    }
    return [...pairs.values()].sort((a, b) => b.z - a.z).slice(0, count);
  }
  function makeInterpolator(samples, { bins = 0, neighbors = 24 } = {}) {
    // Coordinates must share a meaningful metric (the viewer normalizes both
    // parameters). Keep the best observed value at duplicate/aggregated sites.
    const sites = new Map();
    for (const p of samples) {
      const key = bins ? `${Math.floor(p.x * bins)}:${Math.floor(p.y * bins)}` : `${p.x}:${p.y}`;
      const previous = sites.get(key);
      if (!previous || p.z > previous.z) sites.set(key, p);
    }
    function build(points, depth = 0) {
      if (!points.length) return null;
      const axis = depth % 2 ? 'y' : 'x';
      points.sort((a, b) => a[axis] - b[axis]);
      const middle = points.length >>> 1;
      return { point: points[middle], axis,
        left: build(points.slice(0, middle), depth + 1),
        right: build(points.slice(middle + 1), depth + 1) };
    }
    const tree = build([...sites.values()]);
    const limit = Math.max(1, Math.floor(neighbors)), nearest = [];
    return (x, y) => {
      if (!tree) return NaN;
      nearest.length = 0;
      function visit(node) {
        if (!node) return;
        const p = node.point, dx = x - p.x, dy = y - p.y, d2 = dx * dx + dy * dy;
        if (nearest.length < limit || d2 < nearest[nearest.length - 1].d2) {
          let lo = 0, hi = nearest.length;
          while (lo < hi) { const mid = (lo + hi) >>> 1; if (nearest[mid].d2 < d2) lo = mid + 1; else hi = mid; }
          nearest.splice(lo, 0, { point: p, d2 });
          if (nearest.length > limit) nearest.pop();
        }
        const delta = node.axis === 'x' ? dx : dy;
        visit(delta < 0 ? node.left : node.right);
        if (nearest.length < limit || delta * delta <= nearest[nearest.length - 1].d2) visit(delta < 0 ? node.right : node.left);
      }
      visit(tree);
      if (nearest[0].d2 < 1e-24 || nearest.length === 1) return nearest[0].point.z;
      // Inverse squared distance, with weights tapering near the furthest
      // neighbor. Unlike a fixed radius, this covers even very sparse regions;
      // the taper reduces jumps when the set of nearest neighbors changes.
      const radius = Math.sqrt(nearest[nearest.length - 1].d2) * 1.01;
      let estimate = 0, total = 0;
      for (const { point, d2 } of nearest) {
        const taper = 1 - Math.sqrt(d2) / radius;
        const weight = nearest[0].d2 / d2 * taper * taper;
        const nextTotal = total + weight;
        estimate = estimate * (total / nextTotal) + point.z * (weight / nextTotal);
        total = nextTotal;
      }
      return estimate;
    };
  }
  const api = { parse, prepare, infer, number, fraction, color, topDistinct, makeInterpolator };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IBD = api;
})(typeof window === 'undefined' ? this : window);
