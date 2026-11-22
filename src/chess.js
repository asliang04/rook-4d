export const AXES = ['x', 'y', 'z', 'w', 'v'];

const boards = new Map();

export function getCells(dimensions) {
  if (!boards.has(dimensions)) {
    boards.set(dimensions, Array.from({ length: 3 ** dimensions }, (_, id) =>
      Array.from({ length: dimensions }, (__, axis) => Math.floor(id / (3 ** axis)) % 3),
    ));
  }
  return boards.get(dimensions);
}

export const centerId = (dimensions) => (3 ** dimensions - 1) / 2;

export const cellId = (cell) => cell.reduce((id, value, axis) => id + value * (3 ** axis), 0);

export const coordinates = (id, dimensions) => getCells(dimensions)[id].map((n) => n + 1).join(', ');

export function parseCoordinates(value, dimensions) {
  const trimmed = value.trim();
  const unwrapped = trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1).trim() : trimmed;
  const parts = unwrapped.split(/[ ,]+/);
  if (parts.length !== dimensions || parts.some((part) => !/^[1-3]$/.test(part))) return null;
  return cellId(parts.map((part) => Number(part) - 1));
}

export function aligned(a, b, dimensions) {
  const cells = getCells(dimensions);
  return cells[a].filter((n, axis) => n !== cells[b][axis]).length === 1;
}

export function kingNeighbors(king, dimensions) {
  const cells = getCells(dimensions);
  return cells.flatMap((cell, id) =>
    id !== king && cell.every((n, axis) => Math.abs(n - cells[king][axis]) <= 1) ? [id] : [],
  );
}

// Include X-rays through the king, which vacates its cell when moving.
export function isAttacked(target, rooks, dimensions) {
  return rooks.some((rook) => aligned(rook, target, dimensions));
}

export function analyze(king, rooks, dimensions) {
  const cells = getCells(dimensions);
  const inCheck = isAttacked(king, rooks, dimensions);
  // Evaluate after vacating the king's old cell and capturing any target rook.
  const safeMoves = kingNeighbors(king, dimensions).filter((target) =>
    !isAttacked(target, rooks.filter((rook) => rook !== target), dimensions),
  );
  return {
    inCheck,
    safeMoves,
    checkmate: inCheck && safeMoves.length === 0,
    stalemate: !inCheck && safeMoves.length === 0,
    attacked: cells.flatMap((_, id) => isAttacked(id, rooks, dimensions) ? [id] : []),
  };
}
