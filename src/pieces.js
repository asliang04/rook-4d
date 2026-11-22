// Small solid meshes in cell-local coordinates. The base rests at y = -14;
// every vertex stays inside the cell's [-15, 15] bounds.
const sides = 12;
const ring = (y, radius) => Array.from({ length: sides }, (_, i) => {
  const angle = i * Math.PI * 2 / sides;
  return [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
});

function lathe(profile) {
  const rings = profile.map(([y, radius]) => ring(y, radius));
  const faces = [rings[0], [...rings.at(-1)].reverse()];
  for (let row = 0; row < rings.length - 1; row++) {
    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides;
      faces.push([rings[row][i], rings[row + 1][i], rings[row + 1][next], rings[row][next]]);
    }
  }
  return faces;
}

function box(x, y, z, width, height, depth) {
  const corners = [
    [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
    [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],
    [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
    [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],
    [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
  ];
  return corners.map((face) => face.map(([a, b, c]) => [
    x + a * width / 2, y + b * height / 2, z + c * depth / 2,
  ]));
}

const base = [[-14, 10], [-12, 10], [-10, 8], [-9, 7]];
const rook = lathe([...base, [-3, 5], [4, 6], [5, 9], [8, 9]]);
for (const x of [-5, 5]) for (const z of [-5, 5]) rook.push(...box(x, 10, z, 4, 4, 4));
const king = [
  ...lathe([...base, [-3, 4], [1, 5], [2, 7], [4, 7], [5, 4], [7, 3]]),
  ...box(0, 10, 0, 2.8, 8, 2.8),
  ...box(0, 11, 0, 9, 2.8, 2.8),
];

function withNormal(vertices) {
  const a = vertices[1].map((n, i) => n - vertices[0][i]);
  const b = vertices[2].map((n, i) => n - vertices[0][i]);
  const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = Math.hypot(...cross);
  return { vertices, normal: cross.map((n) => n / length) };
}

export const PIECE_MESHES = {
  rook: rook.map(withNormal),
  king: king.map(withNormal),
};
