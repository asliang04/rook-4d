import './style.css';
import { AXES, centerId, coordinates, getCells, parseCoordinates, analyze } from './chess.js';
import { drawCube, drawLayers } from './cubes.js';
import { MAX_POSITION_LENGTH, normalizePosition, parsePosition, serializePosition } from './positions.js';
import fourDimensionalMate from '../rook-checkmate/results/4d_14.json';
import fiveDimensionalMate from '../rook-checkmate/results/5d_27.json';

const icons = {
  rook: '<path d="M6 20h12M7 17h10l-1-8 2-1V4h-3v2h-2V4h-2v2H9V4H6v4l2 1-1 8Z"/>',
  king: '<path d="M12 3v6M9 5h6M6 20h12M8 17h8l3-8-5 3-2-3-2 3-5-3 3 8Z"/>',
  erase: '<path d="m4 14 9-10 7 7-9 9H8l-4-4v-2Zm4-4 7 7M11 20h9"/>',
  cube: '<path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10v9M3 8l9 5 9-5M7.5 5.5l9 5v9"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5ZM3 13l9 5 9-5M3 18l9 5 9-5"/>',
  reset: '<path d="M3 4v6h6M3 10a9 9 0 1 1 2 8"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const initialRotation = () => ({ yaw: -0.6, pitch: 0.42 });
const examples = new Map([['4d-14', fourDimensionalMate], ['5d-27', fiveDimensionalMate]]);
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_RADIUS = 24;

const state = {
  dimensions: 4, king: centerId(4), rooks: [], selected: centerId(4),
  tool: 'rook', view: '3d', attacks: true, escapes: false,
  spacing: 55, rotation: initialRotation(), rotationLocked: false,
};
let analysis = analyze(state.king, state.rooks, state.dimensions);

document.querySelector('#app').innerHTML = `
  <main aria-label="Rook checkmate tool">
    <section class="position-library" aria-label="Load or save a position">
      <div class="position-example-actions">
        <button id="load-4d-mate" class="primary-button">Load 4D · 14-rook mate</button>
        <button id="load-5d-mate" class="primary-button">Load 5D · 27-rook mate</button>
      </div>
      <details id="position-io" class="position-io">
        <summary>Import / export a position</summary>
        <form id="position-import-form">
          <label for="position-text">Rook PGN or solver JSON</label>
          <textarea id="position-text" rows="6" spellcheck="false" aria-describedby="position-notice"></textarea>
          <div class="position-import-actions">
            <button class="primary-button" type="submit">Load position ${icon('arrow')}</button>
            <button id="position-current" class="secondary-button" type="button">Use current board</button>
            <button id="position-export-pgn" class="secondary-button" type="button">Download PGN</button>
            <button id="position-export-json" class="secondary-button" type="button">Download JSON</button>
          </div>
          <label class="position-file-label" for="position-file">Or open a position file <input id="position-file" type="file" accept=".pgn,.json,.txt,application/json,text/plain,application/x-chess-pgn"></label>
        </form>
      </details>
      <p id="position-notice" class="position-load-notice" role="status" aria-live="polite"></p>
    </section>

    <section id="board-shell" class="board-shell" aria-label="Four-dimensional chess board">
      <div class="board-toolbar">
        <div class="tool-group" aria-label="Cell action">
          <button data-tool="rook" class="active" aria-pressed="true">${icon('rook')}<span>Place rook</span></button>
          <button data-tool="erase" aria-pressed="false">${icon('erase')}<span>Erase</span></button>
          <button id="clear" title="Remove every rook and keep the centered king">${icon('reset')}<span>Clear all rooks</span></button>
        </div>
        <label class="dimension-picker" for="dimension-slider">
          <span>Dimensions</span>
          <span class="dimension-slider-row"><b>3D</b><input id="dimension-slider" type="range" min="3" max="5" step="1" value="4"><b>5D</b></span>
          <output id="dimension-output" for="dimension-slider">4D</output>
        </label>
        <div class="view-group" aria-label="Board view">
          <button data-view="3d" class="active" aria-pressed="true">${icon('cube')} 3D cubes</button>
          <button data-view="flat" aria-pressed="false">${icon('layers')} Flat layers</button>
        </div>
      </div>
      <div class="board-summary">
        <span id="position-status" class="status-pill" role="status">King is safe</span>
        <dl class="metrics">
          <div><dt>Rooks</dt><dd id="rook-count">0</dd></div>
          <div><dt>Cells controlled</dt><dd id="controlled-count"></dd></div>
          <div><dt>Safe king moves</dt><dd id="escape-count"></dd></div>
        </dl>
      </div>
      <div class="board-controls">
        <div class="legend"><label><input id="show-attacks" type="checkbox" checked><span class="swatch attack-swatch"></span> Rook control</label><label><input id="show-escapes" type="checkbox"><span class="swatch escape-swatch"></span> Safe king moves</label><span><span class="swatch king-swatch"></span> King</span></div>
        <div class="rotation-controls"><label class="spacing-label" for="spacing">Cell spacing <input id="spacing" type="range" min="0" max="100" value="55"></label><button class="icon-button" id="rotate-left" aria-label="Rotate all cubes left" title="Rotate left">↶</button><button class="icon-button" id="rotate-up" aria-label="Tilt all cubes upward" title="Tilt up">↑</button><button class="icon-button" id="reset-view" aria-label="Reset rotation and spacing" title="Reset view">${icon('reset')}</button></div>
      </div>
      <div id="board" class="board-grid"></div>
      <div class="selection-bar"><span id="selection"></span><span id="cell-detail">King</span></div>
    </section>

    <section class="panel" aria-label="Edit by coordinate">
      <form id="coordinate-form"><label for="coordinates">Coordinates <span id="coordinate-label"></span></label><div class="coordinate-row"><input id="coordinates" name="coordinates" autocomplete="off" spellcheck="false" aria-describedby="notice"><button class="primary-button" id="coordinate-submit" type="submit">Place rook ${icon('arrow')}</button></div></form>
      <p id="notice" class="notice" role="status" aria-live="polite"></p>
      <div id="pieces" class="piece-tray" aria-label="Pieces"></div>
    </section>
  </main>
  <div id="rotation-lock-status" class="rotation-lock-status" role="status"></div>
`;

const $ = (selector) => document.querySelector(selector);
const notify = (message) => { $('#notice').textContent = message; };
const activeAxes = () => AXES.slice(0, state.dimensions);
const centerCoordinate = () => Array(state.dimensions).fill(2).join(', ');
let pendingCubeTap = null;

function setRotationLocked(locked) {
  state.rotationLocked = locked;
  $('#board-shell').classList.toggle('rotation-locked', locked);
  $('#rotation-lock-status').textContent = locked ? 'Rotation lock on' : '';
}

function clearPendingCubeTap() {
  if (pendingCubeTap) clearTimeout(pendingCubeTap.timer);
  pendingCubeTap = null;
}

function applyPendingCubeTap() {
  const tap = pendingCubeTap;
  clearPendingCubeTap();
  if (tap?.cell !== undefined && tap.stage.isConnected && state.view === '3d') editCell(tap.cell);
}

function handleCubeTap(event, stage, cell) {
  const tap = pendingCubeTap;
  const x = event.clientX;
  const y = event.clientY;
  const time = performance.now();
  // Reserve two near taps on the same spot for rotation, without editing a cell.
  if (tap && tap.stage === stage && tap.cell === cell && time - tap.time <= DOUBLE_TAP_MS &&
      Math.hypot(x - tap.x, y - tap.y) <= DOUBLE_TAP_RADIUS) {
    clearPendingCubeTap();
    setRotationLocked(!state.rotationLocked);
    return;
  }

  applyPendingCubeTap();
  pendingCubeTap = { stage, cell, x, y, time, timer: setTimeout(applyPendingCubeTap, DOUBLE_TAP_MS) };
}

function slicesFor(dimensions) {
  return Array.from({ length: 3 ** (dimensions - 3) }, (_, id) =>
    Array.from({ length: dimensions - 3 }, (__, axis) => Math.floor(id / (3 ** axis)) % 3),
  );
}

function sliceKey(slice) {
  return slice.join('-');
}

function parseSlice(key) {
  return key === '' ? [] : key.split('-').map(Number);
}

function renderBoardStructure() {
  const slices = slicesFor(state.dimensions);
  $('#board').className = `board-grid dimension-${state.dimensions}`;
  $('#board').innerHTML = slices.map((slice) => `
    <section class="cube-panel">
      ${slice.length ? `<h2 class="cube-heading">${slice.map((value, index) => `${AXES[index + 3]} = ${value + 1}`).join(' · ')}</h2>` : ''}
      <div class="cube-stage" data-slice="${sliceKey(slice)}"></div>
    </section>
  `).join('');
}

function renderDimensionLabels() {
  const axes = activeAxes().join(', ');
  $('#board-shell').setAttribute('aria-label', `${state.dimensions}-dimensional chess board`);
  $('#dimension-output').textContent = `${state.dimensions}D`;
  $('#dimension-slider').setAttribute('aria-valuetext', `${state.dimensions} dimensions`);
  $('#coordinate-label').textContent = `${axes} · each from 1 to 3`;
}

function renderViews() {
  document.querySelectorAll('.cube-stage').forEach((stage) => {
    const slice = parseSlice(stage.dataset.slice);
    stage.replaceChildren(state.view === '3d' ? drawCube(slice, state, analysis) : drawLayers(slice, state, analysis));
  });
  $('#board').classList.toggle('flat-view', state.view === 'flat');
  $('.rotation-controls').hidden = state.view === 'flat';
}

function renderPosition() {
  const focused = document.activeElement?.closest('[data-cell]')?.dataset.cell;
  const total = getCells(state.dimensions).length;
  analysis = analyze(state.king, state.rooks, state.dimensions);
  renderViews();
  if (focused !== undefined) $(`[data-cell="${focused}"]`)?.focus({ preventScroll: true });
  $('#rook-count').textContent = state.rooks.length;
  $('#controlled-count').innerHTML = `${analysis.attacked.length}<span>/${total}</span>`;
  $('#escape-count').textContent = analysis.safeMoves.length;
  const status = $('#position-status');
  status.textContent = analysis.checkmate ? 'Checkmate' : analysis.stalemate ? 'Stalemate' : analysis.inCheck ? 'King in check' : 'King is safe';
  status.className = `status-pill ${analysis.checkmate ? 'mate' : analysis.inCheck ? 'check' : ''}`;
  $('#pieces').innerHTML = `<span class="piece-chip king-chip" aria-label="Fixed king at ${coordinates(state.king, state.dimensions)}">${icon('king')}<span>(${coordinates(state.king, state.dimensions)})</span></span>${state.rooks.map((rook) => `<button class="piece-chip" data-remove="${rook}" aria-label="Remove rook at ${coordinates(rook, state.dimensions)}" title="Remove rook">${icon('rook')}<span>(${coordinates(rook, state.dimensions)})</span><span class="remove-mark">×</span></button>`).join('')}`;
  $('#selection').textContent = `(${coordinates(state.selected, state.dimensions)})`;
  $('#cell-detail').textContent = [state.selected === state.king ? 'King' : state.rooks.includes(state.selected) ? 'Rook' : 'Empty cell', analysis.attacked.includes(state.selected) ? 'Rook-controlled' : '', analysis.safeMoves.includes(state.selected) ? 'Safe king move' : ''].filter(Boolean).join(' · ');
}

function setTool(tool) {
  applyPendingCubeTap();
  state.tool = tool;
  document.querySelectorAll('[data-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === tool);
    button.setAttribute('aria-pressed', button.dataset.tool === tool);
  });
  $('#coordinate-submit').innerHTML = `${tool === 'rook' ? 'Place rook' : 'Erase rook'} ${icon('arrow')}`;
}

function editCell(id) {
  state.selected = id;
  $('#coordinates').value = coordinates(id, state.dimensions);
  if (id === state.king) notify(`The king is fixed at (${centerCoordinate()}). Choose another cell for your rook.`);
  else if (state.rooks.includes(id)) {
    state.rooks = state.rooks.filter((rook) => rook !== id);
    notify(`Rook removed from (${coordinates(id, state.dimensions)}).`);
  } else if (state.tool === 'rook') {
    state.rooks.push(id);
    notify(`Rook placed at (${coordinates(id, state.dimensions)}).`);
  } else notify('This cell is already empty.');
  renderPosition();
}

function setDimensions(dimensions) {
  if (dimensions === state.dimensions) return;
  clearPendingCubeTap();
  state.dimensions = dimensions;
  state.king = centerId(dimensions);
  state.selected = state.king;
  state.rooks = [];
  $('#dimension-slider').value = dimensions;
  $('#coordinates').value = Array(dimensions).fill(1).join(', ');
  renderDimensionLabels();
  renderBoardStructure();
  renderPosition();
  notify('');
}

function positionMessage(message, error = false) {
  $('#position-notice').textContent = message;
  $('#position-notice').classList.toggle('error', error);
  $('#position-text').setAttribute('aria-invalid', error);
}

function loadPosition(position) {
  // Parse/validate before calling this function, so invalid imports never clear
  // the existing board. Assign dimensions and pieces together before rendering.
  clearPendingCubeTap();
  state.dimensions = position.dimensions;
  state.king = position.king;
  state.rooks = [...position.rooks];
  state.selected = state.king;
  state.view = '3d';
  $('#dimension-slider').value = state.dimensions;
  $('#coordinates').value = Array(state.dimensions).fill(1).join(', ');
  $('#coordinates').removeAttribute('aria-invalid');
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
    button.setAttribute('aria-pressed', button.dataset.view === state.view);
  });
  renderDimensionLabels();
  renderBoardStructure();
  renderPosition();
  positionMessage('');
  notify('');
}

function loadExample(key) {
  const position = normalizePosition(examples.get(key));
  position.name = `${position.dimensions}D · ${position.rooks.length}-rook checkmate`;
  $('#position-text').value = serializePosition(position);
  loadPosition(position);
}

function importText(text) {
  try {
    const position = parsePosition(text);
    loadPosition(position);
    return true;
  } catch (error) {
    positionMessage(error.message, true);
    return false;
  }
}

function exportPosition(format) {
  const content = serializePosition(state, format);
  $('#position-text').value = content;
  const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `rook-${state.dimensions}d-${state.rooks.length}-rooks.${format}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  positionMessage(`${format.toUpperCase()} exported.`);
}

$('#load-4d-mate').addEventListener('click', () => loadExample('4d-14'));
$('#load-5d-mate').addEventListener('click', () => loadExample('5d-27'));
$('#position-import-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!importText($('#position-text').value)) $('#position-text').focus();
});
$('#position-current').addEventListener('click', () => {
  $('#position-text').value = serializePosition(state);
  positionMessage('Position updated.');
});
$('#position-export-pgn').addEventListener('click', () => exportPosition('pgn'));
$('#position-export-json').addEventListener('click', () => exportPosition('json'));
$('#position-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > MAX_POSITION_LENGTH) throw new Error('Position files must be 256 KB or smaller.');
    const text = await file.text();
    if (importText(text)) $('#position-text').value = text;
  } catch (error) { positionMessage(error.message, true); }
  finally { event.target.value = ''; }
});

document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
  applyPendingCubeTap();
  state.view = button.dataset.view;
  if (state.view === 'flat') setRotationLocked(false);
  document.querySelectorAll('[data-view]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', item === button); });
  renderViews();
}));
$('#dimension-slider').addEventListener('input', (event) => setDimensions(Number(event.target.value)));
$('#coordinate-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = parseCoordinates($('#coordinates').value, state.dimensions);
  $('#coordinates').setAttribute('aria-invalid', id === null);
  if (id === null) {
    notify(`Enter ${state.dimensions} whole numbers from 1 to 3, such as ${Array(state.dimensions).fill(0).map((_, index) => index % 3 + 1).join(', ')}.`);
    return;
  }
  editCell(id);
});
$('#pieces').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  const id = Number(button.dataset.remove);
  state.rooks = state.rooks.filter((rook) => rook !== id);
  notify(`Rook removed from (${coordinates(id, state.dimensions)}).`);
  renderPosition();
});
$('#clear').addEventListener('click', () => {
  clearPendingCubeTap();
  state.rooks = [];
  notify('All rooks cleared.');
  renderPosition();
});
$('#show-attacks').addEventListener('change', (event) => { state.attacks = event.target.checked; renderViews(); });
$('#show-escapes').addEventListener('change', (event) => { state.escapes = event.target.checked; renderViews(); });
$('#spacing').addEventListener('input', (event) => { state.spacing = Number(event.target.value); renderViews(); });
$('#reset-view').addEventListener('click', () => { state.rotation = initialRotation(); state.spacing = 55; $('#spacing').value = 55; renderViews(); });
$('#rotate-left').addEventListener('click', () => { state.rotation.yaw -= Math.PI / 8; renderViews(); });
$('#rotate-up').addEventListener('click', () => { state.rotation.pitch += Math.PI / 8; renderViews(); });

let drag = null;
let suppressClick = false;
let boardPointerType = '';
$('#board').addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !event.isPrimary) return;
  suppressClick = false;
  boardPointerType = event.pointerType;
  if (state.view !== '3d' || !event.target.closest('.cube-svg')) return;
  drag = {
    x: event.clientX, y: event.clientY, yaw: state.rotation.yaw, pitch: state.rotation.pitch,
    moved: false, pointer: event.pointerId,
    horizontalOnly: event.pointerType === 'touch' && !state.rotationLocked,
  };
});
$('#board').addEventListener('pointermove', (event) => {
  if (!drag || drag.pointer !== event.pointerId) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  // With rotation unlocked, let vertical touch gestures scroll the page.
  if (drag.horizontalOnly && !drag.moved && Math.abs(dy) > 5 && Math.abs(dy) >= Math.abs(dx)) {
    drag = null;
    suppressClick = true;
    return;
  }
  if (drag.moved || (drag.horizontalOnly ? Math.abs(dx) > 5 : Math.hypot(dx, dy) > 5)) {
    if (!drag.moved) $('#board').setPointerCapture(event.pointerId);
    drag.moved = true;
    state.rotation = { yaw: drag.yaw + dx * 0.008, pitch: drag.pitch + (drag.horizontalOnly ? 0 : dy * 0.008) };
    renderViews();
  }
});
$('#board').addEventListener('pointerup', (event) => {
  if (!drag || drag.pointer !== event.pointerId) return;
  suppressClick = drag.moved;
  if ($('#board').hasPointerCapture(event.pointerId)) $('#board').releasePointerCapture(event.pointerId);
  drag = null;
});
$('#board').addEventListener('pointercancel', (event) => {
  if (drag?.pointer !== event.pointerId) return;
  drag = null;
  suppressClick = true;
});
$('#board').addEventListener('pointerleave', () => { if (drag && !drag.moved) drag = null; });
$('#board').addEventListener('click', (event) => {
  // Some browsers deliver click as a MouseEvent without pointerType.
  const touch = event.pointerType === 'touch' || (event.detail > 0 && boardPointerType === 'touch');
  boardPointerType = '';
  if (suppressClick && event.detail > 0) { suppressClick = false; return; }
  const cell = event.target.closest('[data-cell], [data-piece]');
  const id = cell ? Number(cell.dataset.cell ?? cell.dataset.piece) : undefined;
  const cube = event.target.closest('.cube-svg');
  if (touch && cube) handleCubeTap(event, cube.parentElement, id);
  else if (id !== undefined) editCell(id);
});
$('#board').addEventListener('keydown', (event) => {
  const cell = event.target.closest('g[data-cell]');
  if (cell && ['Enter', ' '].includes(event.key)) { event.preventDefault(); editCell(Number(cell.dataset.cell)); }
});

renderDimensionLabels();
renderBoardStructure();
$('#coordinates').value = Array(state.dimensions).fill(1).join(', ');
renderPosition();
$('#position-text').value = serializePosition({ ...normalizePosition(fiveDimensionalMate), name: '5D · 27-rook checkmate' });
const requestedExample = new URLSearchParams(window.location.search).get('position');
if (examples.has(requestedExample)) loadExample(requestedExample);
