# Rook / 3D–5D

A browser-based chess position simulation with selectable 3×3×3, 3×3×3×3,
and 3×3×3×3×3 boards. The king is permanently fixed at coordinate 2 on every
active axis.

## Run

Requires Node.js 22.12+.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3001. Run `npm run build` to create a static site in `dist`.
Run `npm test` to check the chess rules and coordinate handling.

## GitHub Pages

In the repository's **Settings → Pages**, select **GitHub Actions** as the
source. The deployment workflow tests the code, builds the site, and publishes
`dist` on pushes to `main`. Run **Deploy to GitHub Pages** from the Actions tab
to deploy an existing commit. The build uses relative asset paths, so the
site and links such as `?position=4d-14` also work under `/rook-4d/`.

## Load a checkmate

Click **Load 4D · 14-rook mate** above the board, or open
http://127.0.0.1:3001/?position=4d-14. This loads
`rook-checkmate/results/4d_14.json` into the same PGN-style viewer, with 14 rooks,
all 81 cells controlled, no safe king moves, and **Checkmate**. The board opens in
**3D cubes** so you can rotate its three slices together.

### 5D 27-rook checkmate

Click **Load 5D · 27-rook mate** above the board, or open
http://127.0.0.1:3001/?position=5d-27. The site loads the verified solver result
from `rook-checkmate/results/5d_27.json`, switches to 5D and 3D cubes, and
evaluates every king move and capture. It displays 27 rooks, all 243 cells
controlled, no safe king moves, and **Checkmate**. Rotate the nine slices together,
or switch to **Flat layers** to inspect individual cells.

Open **Import / export a position** to paste a record or choose a `.pgn`, `.json`,
or `.txt` file. **Load position** opens the board in 3D cube view after validation. Invalid
imports leave the current board intact. **Use current board** fills the editor;
the download buttons export the current position as PGN or JSON. Files are read
locally in the browser.

### Position formats

Solver JSON is accepted directly. Its centered `-1, 0, 1` coordinates are converted
automatically when the record has an all-zero king. Website JSON exports declare
`"coordinate_system": "one-based"` and use the displayed coordinates `1, 2, 3`.
An explicit `"coordinate_system": "centered"` is also accepted. JSON without a
coordinate-system field or all-zero king defaults to one-based coordinates.

Rook PGN is a PGN-style **position** format with custom coordinate tags. It does
not replay ordinary two-dimensional chess move lists. For example:

```pgn
[Event "Example position"]
[Variant "Rook5D"]
[Dimensions "5"]
[Coordinates "1-3"]
[King "2,2,2,2,2"]
[Rooks "(1,2,3,1,2); (3,2,3,1,2)"]
[Result "*"]

*
```

Separate rooks with semicolons. Every rook needs one coordinate per dimension;
duplicates, out-of-range cells, and the king's center cell are rejected. This
short example illustrates the format; the built-in buttons load the full
14-rook and 27-rook checkmates. Dimensions and Rooks tags are required; an omitted King tag
defaults to the center.

## Controls

- Use the dimension slider to choose 3D, 4D, or 5D. Changing dimensions clears rooks.
- 3D uses one cube. 4D uses three `w` slices. 5D uses nine `(w, v)` slices,
  with `w` across columns and `v` across rows.
- Drag any cube to rotate every cube together. Buttons also rotate and reset the view.
- On touchscreens, swipe sideways to rotate, swipe vertically to scroll, and use
  the tilt button to adjust the angle.
- Click a cell to add a rook; click it again to remove it. Erase mode only removes rooks.
- Cell shades alternate by the parity of the sum of all active coordinates.
- Enter one coordinate per active axis (`x, y, z, w, v`), each from **1 to 3**,
  to edit a cell directly.
- Increase **Cell spacing** to expose inner cells, or use **Flat layers** to access
  all 27, 81, or 243 cells without overlapping geometry. Cells support keyboard activation.
- **Rook control** marks attacked cells with a translucent red highlight; **Safe king moves**
  marks hypothetical escapes with dashed borders. The king is white, rooks are black,
  and the king always stays centered.
- Shaded chess pieces rotate with the board and rest on visible bases inside their
  cells. Nearer cells overlap farther pieces to help show their depth.
- **Clear all rooks** in the board toolbar removes all rooks and preserves the king.
  Positions reset on reload, except the `?position=4d-14` and `?position=5d-27`
  links reload their respective examples.
- On narrow screens, slices stack vertically and flat cells have larger tap targets.

## Rules

A rook moves any distance along exactly one active axis. A hypothetical king
move changes any combination of its coordinates by one. All rooks are on the same
team, opposing the single king.

Rook control includes protected rook cells and X-rays through the king. For
example, a rook at (3, 2, 2, 2, 2) also highlights (1, 2, 2, 2, 2): moving there
would expose the king to that rook. Safe king moves are evaluated after vacating its
old square and capturing any destination rook, allowing captures of undefended rooks.
Checkmate means the king is attacked with no safe move or capture; stalemate means
it has no safe moves but is not attacked. The simulation evaluates the position
you construct; it has no automatic search or minimum-rook verification.

The board uses native SVG with a shared rotation and no external graphics library.
There is no backend or account requirement.
