import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, centerId, getCells, parseCoordinates } from '../src/chess.js';
import { MAX_POSITION_LENGTH, normalizePosition, parsePosition, serializePosition } from '../src/positions.js';

const solver = JSON.parse(readFileSync(new URL('../rook-checkmate/results/5d_27.json', import.meta.url), 'utf8'));
const mate = normalizePosition(solver);
const basic = () => ({ dimensions: 3, king: [2, 2, 2], rooks: [[1, 1, 1], [3, 1, 1]] });

test('the actual 27-rook solver result becomes a 5D checkmate in the website rules', () => {
  const position = parsePosition(JSON.stringify(solver));
  assert.equal(position.dimensions, 5);
  assert.equal(position.king, centerId(5));
  assert.equal(position.rooks.length, 27);
  const expected = solver.rooks.map((point) => parseCoordinates(point.map((n) => n + 2).join(','), 5)).sort((a, b) => a - b);
  assert.deepEqual(position.rooks, expected);
  const result = analyze(position.king, position.rooks, 5);
  assert.equal(result.checkmate, true);
  assert.equal(result.safeMoves.length, 0);
  assert.equal(result.attacked.length, 243);
});

test('the 14-rook 4D solver result stays checkmate through the PGN viewer', () => {
  const result = JSON.parse(readFileSync(new URL('../rook-checkmate/results/4d_14.json', import.meta.url), 'utf8'));
  const position = normalizePosition(result);
  const imported = parsePosition(serializePosition(position));
  assert.deepEqual(imported, position);
  assert.equal(imported.dimensions, 4);
  assert.equal(imported.king, centerId(4));
  assert.equal(imported.rooks.length, 14);
  const analysis = analyze(imported.king, imported.rooks, 4);
  assert.equal(analysis.inCheck, true);
  assert.equal(analysis.checkmate, true);
  assert.equal(analysis.safeMoves.length, 0);
  assert.equal(analysis.attacked.length, 81);
});

test('PGN position records preserve all 27 rooks and escape quoted names', () => {
  const position = { ...mate, name: 'A "quoted" \\ position' };
  const text = serializePosition(position);
  assert.match(text, /\[Variant "Rook5D"\]/);
  assert.deepEqual(parsePosition(text), position);
  assert.equal(analyze(mate.king, parsePosition(text).rooks, 5).checkmate, true);
});

test('JSON exports explicitly use the website coordinate system', () => {
  const text = serializePosition(mate, 'json');
  const data = JSON.parse(text);
  assert.equal(data.coordinate_system, 'one-based');
  assert.deepEqual(data.king, [2, 2, 2, 2, 2]);
  assert.ok(data.rooks.flat().every((n) => n >= 1 && n <= 3));
  assert.deepEqual(parsePosition(text), mate);
});

test('empty and arbitrary positions round-trip in all supported dimensions', () => {
  for (const dimensions of [3, 4, 5]) for (const rooks of [[], [0], [0, 3 ** dimensions - 1]]) {
    const position = { dimensions, king: centerId(dimensions), rooks, name: 'Rook position' };
    for (const format of ['pgn', 'json']) assert.deepEqual(parsePosition(serializePosition(position, format)), position);
  }
});

test('centered and one-based imports are distinguished by declared basis or central king', () => {
  const centered = normalizePosition({ dimensions: 3, king: [0, 0, 0], rooks: [[1, 1, 1]] });
  const oneBased = normalizePosition({ dimensions: 3, king: [2, 2, 2], rooks: [[1, 1, 1]] });
  assert.deepEqual(centered.rooks, [26]);
  assert.deepEqual(oneBased.rooks, [0]);
  assert.deepEqual(normalizePosition({ dimensions: 3, coordinate_system: 'centered', rooks: [[1, 1, 1]] }).rooks, [26]);
  assert.throws(() => normalizePosition({ ...basic(), coordinate_system: 'guess' }), /Coordinate system/);
});

test('import does not mutate a supplied solver record', () => {
  const copy = structuredClone(solver);
  normalizePosition(copy);
  assert.deepEqual(copy, solver);
});

test('overlapping pieces, noncentral kings, and duplicate rooks are rejected', () => {
  assert.throws(() => normalizePosition({ ...basic(), rooks: [[2, 2, 2]] }), /king/);
  assert.throws(() => normalizePosition({ ...basic(), king: [1, 2, 2] }), /center/);
  assert.throws(() => normalizePosition({ ...basic(), rooks: [[1, 1, 1], [1, 1, 1]] }), /same cell/);
});

test('invalid dimensions, shapes, coordinate types, bounds, and side lengths are rejected', () => {
  for (const dimensions of [0, 2, 6, 3.5, '5']) assert.throws(() => normalizePosition({ ...basic(), dimensions }), /Dimensions/);
  for (const rook of [[1, 1], [0, 1, 1], [4, 1, 1], [1.5, 1, 1], ['1', 1, 1], null]) {
    assert.throws(() => normalizePosition({ ...basic(), rooks: [rook] }), /coordinates/);
  }
  assert.throws(() => normalizePosition({ ...basic(), side_length: 4 }), /side length/);
  assert.throws(() => normalizePosition({ ...basic(), rooks: null }), /rooks array/);
  assert.throws(() => normalizePosition(null), /JSON object/);
});

test('solver failures and inconsistent rook counts cannot masquerade as positions', () => {
  for (const status of ['infeasible', 'unknown']) assert.throws(() => normalizePosition({ ...solver, status }), /solved position/);
  assert.throws(() => normalizePosition({ ...solver, requested_rooks: 26 }), /rook count/);
});

test('PGN parser accepts an empty rook tag and optional surrounding parentheses', () => {
  assert.deepEqual(parsePosition('[Dimensions "3"]\n[Rooks ""]\n*').rooks, []);
  assert.deepEqual(parsePosition('[Dimensions "3"]\n[Rooks "1,1,1; (3,1,1)"]\n*').rooks, [0, 2]);
});

test('malformed PGN, wrong variants, and unsupported move histories are rejected', () => {
  const prefix = '[Dimensions "3"]\n[Rooks "(1,1,1)"]\n';
  for (const text of [
    '[Event "ordinary chess"]\n1. e4 e5',
    `${prefix}[Dimensions "3"]`,
    `${prefix}[Variant "Rook5D"]`,
    `${prefix}[Coordinates "0-2"]`,
    `${prefix}1. e4`,
    `${prefix}[King "(2,2,2)"] trailing`,
    '[Dimensions "3"]\n[Rooks "(1.5,1,1)"]',
    '[Dimensions "3"]\n[Rooks "(1,1,1); "]',
    '[Dimensions "3"]\n[Rooks "unterminated]',
  ]) assert.throws(() => parsePosition(text));
});

test('blank, malformed, oversized, and nonobject JSON imports are rejected', () => {
  for (const text of ['', '   ', '{"dimensions":', '[]', 'null', '[1,2,3]']) assert.throws(() => parsePosition(text));
  assert.throws(() => parsePosition('x'.repeat(MAX_POSITION_LENGTH + 1)), /256 KB/);
  assert.deepEqual(parsePosition(`\uFEFF${JSON.stringify(basic())}`).rooks, [0, 2]);
});

test('every imported rook ID stays within the selected board', () => {
  for (const id of mate.rooks) assert.ok(getCells(mate.dimensions)[id]);
});
