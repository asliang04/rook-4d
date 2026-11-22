import { AXES, cellId, coordinates, getCells } from './chess.js';
import { PIECE_MESHES } from './pieces.js';

const NS = 'http://www.w3.org/2000/svg';
function svgNode(tag, attrs = {}, children = []) {
  const node = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  children.forEach((child) => node.append(child));
  return node;
}

function rotate([x, y, z], { yaw, pitch }) {
  const xx = x * Math.cos(yaw) + z * Math.sin(yaw);
  const zz = -x * Math.sin(yaw) + z * Math.cos(yaw);
  return [xx, y * Math.cos(pitch) - zz * Math.sin(pitch), y * Math.sin(pitch) + zz * Math.cos(pitch)];
}

const project = (p) => [180 + p[0], 163 - p[1]];
const faces = [
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
];

function pieceAt(id, state) {
  return id === state.king ? 'king' : state.rooks.includes(id) ? 'rook' : 'empty';
}

function cellClass(id, state, analysis) {
  const parity = getCells(state.dimensions)[id].reduce((sum, coordinate) => sum + coordinate + 1, 0) % 2;
  return [
    'cell', parity === 0 ? 'parity-even' : 'parity-odd', pieceAt(id, state),
    state.attacks && analysis.attacked.includes(id) ? 'attacked' : '',
    state.escapes && analysis.safeMoves.includes(id) ? 'safe' : '',
    state.selected === id ? 'selected' : '',
  ].filter(Boolean).join(' ');
}

function cellLabel(id, state, analysis) {
  return `(${coordinates(id, state.dimensions)}), ${pieceAt(id, state)}${analysis.attacked.includes(id) ? ', rook-controlled' : ''}${analysis.safeMoves.includes(id) ? ', safe king move' : ''}`;
}

function sliceLabel(slice) {
  return slice.length
    ? slice.map((value, index) => `${AXES[index + 3]} = ${value + 1}`).join(', ')
    : 'x, y, z';
}

function drawPiece(id, piece, center, state) {
  const group = svgNode('g', { class: `chess-piece ${piece}-marker`, 'data-piece': id, 'aria-hidden': 'true' });
  const surfaces = PIECE_MESHES[piece].map(({ vertices, normal }) => {
    const points = vertices.map((vertex) => rotate(vertex.map((n, axis) => n + center[axis]), state.rotation));
    return { points, normal: rotate(normal, state.rotation), depth: points.reduce((sum, p) => sum + p[2], 0) / points.length };
  }).filter(({ normal }) => normal[2] > 0.001).sort((a, b) => a.depth - b.depth);
  for (const { points, normal } of surfaces) {
    const light = Math.max(0, (-normal[0] * 0.35 + normal[1] * 0.7 + normal[2]) / 1.27);
    const shade = Math.round(piece === 'king' ? 155 + light * 100 : 22 + light * 62);
    group.append(svgNode('polygon', {
      points: points.map((p) => project(p).join(',')).join(' '),
      fill: `rgb(${shade}, ${shade}, ${shade})`,
      stroke: `rgb(${shade}, ${shade}, ${shade})`,
      class: 'piece-surface',
    }));
  }
  return group;
}

// Each panel is one 3D slice. All panels share the same yaw and pitch.
export function drawCube(slice, state, analysis) {
  const svg = svgNode('svg', {
    viewBox: '0 0 360 340', class: 'cube-svg',
    'aria-label': `Rotatable cube${slice.length ? `, ${sliceLabel(slice)}` : ''}`,
  });
  const cells = getCells(state.dimensions);
  const gap = 42 + state.spacing * 0.25;
  const half = 15;
  const visibleFaces = faces.filter((face) => rotate(face.normal, state.rotation)[2] > 0.001);
  const ordered = cells.flatMap((coord, id) =>
    coord.slice(3).every((value, index) => value === slice[index])
      ? [{ id, center: coord.slice(0, 3).map((value) => (value - 1) * gap) }]
      : [],
  ).sort((a, b) => rotate(a.center, state.rotation)[2] - rotate(b.center, state.rotation)[2]);

  const bound = gap + half;
  for (let axis = 0; axis < 3; axis++) {
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      const other = [0, 1, 2].filter((n) => n !== axis);
      const ends = [-1, 1].map((sign) => {
        const point = [0, 0, 0];
        point[axis] = sign * bound;
        point[other[0]] = a * bound;
        point[other[1]] = b * bound;
        return project(rotate(point, state.rotation));
      });
      svg.append(svgNode('line', { x1: ends[0][0], y1: ends[0][1], x2: ends[1][0], y2: ends[1][1], class: 'volume-edge' }));
    }
  }

  for (const { id, center } of ordered) {
    const group = svgNode('g', { class: cellClass(id, state, analysis), 'data-cell': id, role: 'button', tabindex: 0, 'aria-label': cellLabel(id, state, analysis), 'aria-pressed': state.selected === id });
    const title = svgNode('title');
    title.textContent = cellLabel(id, state, analysis);
    group.append(title);
    const piece = pieceAt(id, state);
    for (const face of visibleFaces) {
      const points = face.corners.map((corner) => project(rotate(corner.map((n, axis) => center[axis] + n * half), state.rotation)).join(',')).join(' ');
      const brightness = 0.65 + rotate(face.normal, state.rotation)[1] * 0.18 + rotate(face.normal, state.rotation)[2] * 0.18;
      group.append(svgNode('polygon', { points, class: 'cell-face', 'fill-opacity': brightness * (piece === 'empty' ? 0.4 : 0.2) }));
      if (state.attacks && analysis.attacked.includes(id)) {
        group.append(svgNode('polygon', { points, class: 'control-highlight' }));
      }
    }
    if (piece !== 'empty') {
      const floorPoints = [[-14, -14.5, -14], [-14, -14.5, 14], [14, -14.5, 14], [14, -14.5, -14]];
      const points = floorPoints.map((p) => project(rotate(p.map((n, axis) => n + center[axis]), state.rotation)).join(',')).join(' ');
      group.append(svgNode('polygon', { points, class: 'piece-platform' }));
      const shadow = Array.from({ length: 16 }, (_, i) => {
        const angle = i * Math.PI / 8;
        return project(rotate([center[0] + Math.cos(angle) * 11, center[1] - 14.4, center[2] + Math.sin(angle) * 11], state.rotation)).join(',');
      }).join(' ');
      group.append(svgNode('polygon', { points: shadow, class: 'piece-shadow' }));
      group.append(drawPiece(id, piece, center, state));
    }
    svg.append(group);
  }

  const origin = [41, 303];
  ['x', 'y', 'z'].forEach((axis, i) => {
    const vector = [0, 0, 0];
    vector[i] = 24;
    const [x, y] = rotate(vector, state.rotation);
    svg.append(svgNode('line', { x1: origin[0], y1: origin[1], x2: origin[0] + x, y2: origin[1] - y, class: `axis axis-${axis}` }));
    const label = svgNode('text', { x: origin[0] + x * 1.4 - 3, y: origin[1] - y * 1.4 + 4, class: `axis-label axis-${axis}` });
    label.textContent = axis;
    svg.append(label);
  });
  return svg;
}

export function drawLayers(slice, state, analysis) {
  const layers = document.createElement('div');
  layers.className = 'layers';
  for (let z = 0; z < 3; z++) {
    const layer = document.createElement('div');
    layer.className = 'layer';
    layer.innerHTML = `<span class="layer-label">z = ${z + 1}</span><div class="layer-grid"></div>`;
    const grid = layer.querySelector('.layer-grid');
    for (let y = 2; y >= 0; y--) for (let x = 0; x < 3; x++) {
      const id = cellId([x, y, z, ...slice]);
      const cell = document.createElement('button');
      cell.className = cellClass(id, state, analysis);
      cell.dataset.cell = id;
      cell.setAttribute('aria-label', cellLabel(id, state, analysis));
      cell.setAttribute('aria-pressed', state.selected === id);
      cell.title = cellLabel(id, state, analysis);
      const piece = pieceAt(id, state);
      if (piece === 'empty') cell.textContent = `${x + 1},${y + 1}`;
      else {
        const marker = document.createElement('span');
        marker.className = `flat-piece ${piece}-marker`;
        marker.textContent = piece === 'king' ? '♚' : '♜';
        cell.append(marker);
      }
      grid.append(cell);
    }
    layers.append(layer);
  }
  return layers;
}
