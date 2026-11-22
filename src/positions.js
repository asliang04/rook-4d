import { cellId, centerId, getCells } from './chess.js';

export const MAX_POSITION_LENGTH = 256 * 1024;

const supportedDimension = (value) => Number.isInteger(value) && value >= 3 && value <= 5;

export function normalizePosition(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('A position must be a JSON object.');
  const dimensions = data.dimensions;
  if (!supportedDimension(dimensions)) throw new Error('Dimensions must be 3, 4, or 5.');
  if (data.side_length !== undefined && data.side_length !== 3) throw new Error('This board requires a side length of 3.');
  if (['infeasible', 'unknown'].includes(data.status)) throw new Error('This solver result does not contain a solved position.');
  if (!Array.isArray(data.rooks)) throw new Error('The position must include a rooks array.');
  if (data.rooks.length >= 3 ** dimensions) throw new Error('There are too many rooks for this board.');
  if (data.requested_rooks !== undefined && data.requested_rooks !== data.rooks.length) {
    throw new Error('The rook count does not match the solver result.');
  }
  // Solver records include an all-zero king. Website exports explicitly declare
  // one-based coordinates; do not guess the basis from individual rook values.
  const system = data.coordinate_system ??
    (Array.isArray(data.king) && data.king.length === dimensions && data.king.every((n) => n === 0) ? 'centered' : 'one-based');
  if (!['centered', 'one-based'].includes(system)) throw new Error('Coordinate system must be "centered" or "one-based".');
  const lower = system === 'centered' ? -1 : 1;
  const convert = (point, label) => {
    if (!Array.isArray(point) || point.length !== dimensions ||
        point.some((n) => !Number.isInteger(n) || n < lower || n > lower + 2)) {
      throw new Error(`${label} needs ${dimensions} whole-number coordinates from ${lower} to ${lower + 2}.`);
    }
    return cellId(point.map((n) => n - lower));
  };
  const king = centerId(dimensions);
  if (data.king !== undefined && convert(data.king, 'The king') !== king) throw new Error('The king must stay at the center.');
  const rooks = data.rooks.map((point, i) => convert(point, `Rook ${i + 1}`));
  if (rooks.includes(king)) throw new Error('A rook cannot occupy the king’s center cell.');
  if (new Set(rooks).size !== rooks.length) throw new Error('Two rooks cannot occupy the same cell.');
  return {
    dimensions, king, rooks: rooks.sort((a, b) => a - b),
    name: typeof data.name === 'string' ? data.name.slice(0, 120) : 'Rook position',
  };
}

function parsePoint(value) {
  let text = value.trim();
  if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
  const parts = text.split(/[,\s]+/);
  if (!parts.length || parts.some((part) => !/^-?\d+$/.test(part))) {
    throw new Error('Use comma-separated coordinates; separate rooks with semicolons.');
  }
  return parts.map(Number);
}

function parseRookPgn(text) {
  const tag = /\s*\[([A-Za-z][A-Za-z0-9_]*)\s+"((?:[^"\\\r\n]|\\["\\])*)"\s*\]/y;
  const tags = new Map();
  let cursor = 0;
  while (true) {
    tag.lastIndex = cursor;
    const match = tag.exec(text);
    if (!match) break;
    if (tags.has(match[1])) throw new Error(`The ${match[1]} tag appears more than once.`);
    tags.set(match[1], match[2].replace(/\\(["\\])/g, '$1'));
    cursor = tag.lastIndex;
  }
  if (!tags.size) throw new Error('Paste a Rook PGN position record or solver JSON.');
  if (!/^[345]$/.test(tags.get('Dimensions') ?? '') || !tags.has('Rooks')) {
    throw new Error('Rook PGN needs a Dimensions tag (3, 4, or 5) and a Rooks tag. Use “Use current board” for an example.');
  }
  const dimensions = Number(tags.get('Dimensions'));
  if (tags.has('Variant') && tags.get('Variant') !== `Rook${dimensions}D`) throw new Error('The Variant and Dimensions tags must describe the same Rook board.');
  if (tags.has('Coordinates') && tags.get('Coordinates') !== '1-3') throw new Error('Rook PGN uses coordinates from 1 to 3.');
  const trailing = text.slice(cursor).trim();
  if (trailing && !['*', '1-0', '0-1', '1/2-1/2'].includes(trailing)) {
    throw new Error('Import a position using King and Rooks tags. Move lists are not supported.');
  }
  const rookText = tags.get('Rooks').trim();
  return normalizePosition({
    dimensions, coordinate_system: 'one-based', name: tags.get('Event'),
    king: tags.has('King') ? parsePoint(tags.get('King')) : Array(dimensions).fill(2),
    rooks: rookText ? rookText.split(';').map(parsePoint) : [],
  });
}

export function parsePosition(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Paste a position or choose a .pgn or .json file first.');
  if (value.length > MAX_POSITION_LENGTH) throw new Error('Position files must be 256 KB or smaller.');
  const text = value.replace(/^\uFEFF/, '').trim();
  if (text.startsWith('{') || text.startsWith('[') && !/^\[\s*[A-Za-z]/.test(text)) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON. Paste a solver result or an exported position.'); }
    return normalizePosition(data);
  }
  return parseRookPgn(text);
}

export function serializePosition(position, format = 'pgn') {
  if (!supportedDimension(position.dimensions)) throw new Error('Dimensions must be 3, 4, or 5.');
  const cells = getCells(position.dimensions);
  if (!Array.isArray(position.rooks) || position.rooks.some((id) => !Number.isInteger(id) || !cells[id])) {
    throw new Error('The position contains an invalid rook cell.');
  }
  const record = {
    format: 'rook-position', version: 1, name: position.name ?? 'Rook position',
    dimensions: position.dimensions, coordinate_system: 'one-based',
    king: Array(position.dimensions).fill(2),
    rooks: position.rooks.map((id) => cells[id].map((n) => n + 1)),
  };
  const normalized = normalizePosition(record);
  record.rooks = normalized.rooks.map((id) => cells[id].map((n) => n + 1));
  if (format === 'json') return `${JSON.stringify(record, null, 2)}\n`;
  if (format !== 'pgn') throw new Error('Choose PGN or JSON for export.');
  const escape = (value) => String(value).replace(/[\r\n]/g, ' ').replace(/[\\"]/g, '\\$&');
  const tags = {
    Event: record.name, Variant: `Rook${record.dimensions}D`, Dimensions: record.dimensions,
    Coordinates: '1-3', King: record.king.join(','),
    Rooks: record.rooks.map((point) => `(${point.join(',')})`).join('; '), Result: '*',
  };
  return `${Object.entries(tags).map(([key, value]) => `[${key} "${escape(value)}"]`).join('\n')}\n\n*\n`;
}
