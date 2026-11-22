import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCells, centerId, cellId, coordinates, aligned, parseCoordinates,
  kingNeighbors, analyze,
} from '../src/chess.js';

test('3D, 4D, and 5D boards contain the expected cells and central king', () => {
  for (const dimensions of [3, 4, 5]) {
    const cells = getCells(dimensions);
    assert.equal(cells.length, 3 ** dimensions);
    assert.deepEqual(cells[centerId(dimensions)], Array(dimensions).fill(1));
    cells.forEach((cell, id) => assert.equal(cellId(cell), id));
    assert.equal(coordinates(centerId(dimensions), dimensions), Array(dimensions).fill(2).join(', '));
  }
});

test('coordinate entry requires one bounded coordinate per active dimension', () => {
  assert.equal(parseCoordinates('(1, 2, 3)', 3), cellId([0, 1, 2]));
  assert.equal(parseCoordinates('3 3 3 3', 4), 80);
  assert.equal(parseCoordinates('3, 3, 3, 3, 3', 5), 242);
  for (const [value, dimensions] of [
    ['0,1,1', 3], ['1,1,1,4', 4], ['1,1,1,1', 5],
    ['1.5,1,1', 3], ['garbage', 4], ['(1,1,1', 3], ['1,1,1)', 3],
  ]) assert.equal(parseCoordinates(value, dimensions), null);
});

test('rooks move on exactly one axis in every supported dimension', () => {
  for (const dimensions of [3, 4, 5]) {
    const origin = Array(dimensions).fill(0);
    const alongLastAxis = [...origin];
    alongLastAxis[dimensions - 1] = 2;
    const diagonal = [...origin];
    diagonal[0] = 1;
    diagonal[dimensions - 1] = 1;
    assert.ok(aligned(cellId(origin), cellId(alongLastAxis), dimensions));
    assert.ok(!aligned(cellId(origin), cellId(diagonal), dimensions));
    assert.ok(!aligned(0, 0, dimensions));
  }
});

test('a centered king has every other cell as a neighboring move', () => {
  assert.equal(kingNeighbors(centerId(3), 3).length, 26);
  assert.equal(kingNeighbors(centerId(4), 4).length, 80);
  assert.equal(kingNeighbors(centerId(5), 5).length, 242);
});

test('king can capture an undefended rook but cannot capture a protected one', () => {
  for (const dimensions of [3, 4, 5]) {
    const king = cellId(Array(dimensions).fill(0));
    const first = Array(dimensions).fill(0);
    const second = Array(dimensions).fill(0);
    first[0] = 1;
    second[0] = 2;
    assert.ok(analyze(king, [cellId(first)], dimensions).safeMoves.includes(cellId(first)));
    assert.ok(!analyze(king, [cellId(first), cellId(second)], dimensions).safeMoves.includes(cellId(first)));
  }
});

test('rook control X-rays through the central king on every active axis', () => {
  for (const dimensions of [3, 4, 5]) {
    const king = centerId(dimensions);
    for (let axis = 0; axis < dimensions; axis++) for (const side of [0, 2]) {
      const rook = Array(dimensions).fill(1);
      const target = Array(dimensions).fill(1);
      rook[axis] = side;
      target[axis] = 2 - side;
      const position = analyze(king, [cellId(rook)], dimensions);
      assert.ok(position.inCheck);
      assert.ok(position.attacked.includes(cellId(target)));
      assert.ok(!position.safeMoves.includes(cellId(target)));
      assert.equal(position.attacked.length, dimensions * 2);
      assert.ok(position.safeMoves.includes(cellId(rook)), 'undefended rook can still be captured');
    }
  }
});

test('a full attack map checkmates the central king in every dimension', () => {
  for (const dimensions of [3, 4, 5]) {
    const king = centerId(dimensions);
    const rooks = getCells(dimensions).flatMap((_, id) => id === king ? [] : [id]);
    assert.ok(analyze(king, rooks, dimensions).checkmate);
  }
});
