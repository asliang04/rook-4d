# Rook checkmate search

An exhaustive backtracking solver for a side-length-three board in one through
six dimensions. The default is to find one 4D checkmate using exactly 14 rooks.
The Python analysis independently enumerates the small 3D problem.
`find_minimum.py` selects rook counts by binary search and uses native C++ worker
threads to parallelize each individual existence/infeasibility search.

## Rules

- Coordinates are `-1`, `0`, or `1`; the king is at `(0, ..., 0)`.
- A rook moves along exactly one coordinate axis.
- The king may change any nonempty subset of coordinates by one. From the center,
  it can therefore reach every other cell in one move.
- There are no other pieces. All rooks have the same color, opposite the king.
- A position must already be checkmate. This does not search sequences of moves.

Every cell must have a rook in a *different* cell on one of its axis lines.
This includes the king's original square (check) and every occupied rook square
(protection against capture). A rook does not protect itself. An intervening
friendly rook also attacks the target, so the existence of a rook on an axis
line is sufficient even with blockers. Every reported construction is additionally
checked using independent ray tracing after each possible king move and capture.

## Build and run

Requires a C++17 compiler and Python 3 for the analysis and tests. No external
packages are required.

```sh
cd rook-checkmate
make
./build/rook-search --dimensions 4 --rooks 14
./build/rook-search --dimensions 4 --rooks 13 --time-limit 0
./build/rook-search --dimensions 5 --rooks 26 --time-limit 60
./build/rook-search --dimensions 5 --rooks 27
./build/rook-search --dimensions 5 --rooks 35
```

Output is JSON, including coordinates, runtime, visited nodes, pruning counters,
the method used, and an independent validation result. `--json FILE` also saves
it to a file. Exit codes are `0` for a construction, `1` for an exhausted search
with no construction, `2` for an interrupted/deadline-limited search, and `64`
for invalid arguments or another error. `unknown` is never an infeasibility proof.
The default deadline is 30 seconds; `--time-limit 0` removes it.

The 5D construction is enabled for requests of at least 27 rooks. To run only
backtracking for these cases, pass `--no-construction`. A successful existence
search stops at the first checkmate; it does not enumerate every checkmate.

## Pruning and ordering

1. Twelve-word bitmasks hold up to 729 cells, attack sets, candidates, and coverage.
2. At least one rook checks the center. Fix one such rook to `(1,0,...,0)`
   without loss of generality.
3. Propagate cells with just one remaining attacker, impossible cells, and the
   exact-cardinality case where every remaining candidate must be selected.
4. Branch on the uncovered cell with the fewest possible attackers. Break ties
   in favor of defending already placed rooks; prefer candidates with greater
   new coverage and, on ties, greater defense coverage.
5. Reject insufficient coverage capacity using both `2*n*remaining` and the sum
   of the largest remaining marginal attack counts. Overlaps can only reduce
   that sum, so this is a safe upper bound.
6. Greedily pack uncovered cells with disjoint remaining attacker sets. Each
   packed cell needs a distinct future rook.
7. Bound coverage in every codimension-one slice, enforce available candidates,
   and count distinct targets reachable from outside. A bitset allocation DP
   checks that the per-slice requirements fit the total remaining rook budget.
8. Branch once per orbit under symmetries preserving previous choices and the
   branching cell. After that branch fails, exclude the entire orbit. All other
   excluded candidates remain preserved by the subgroup used for subsequent
   branches. This avoids unsafe canonicalization of arbitrary partial boards.
9. Optional bounded failure memoization stores `(available, uncovered, budget)`.
   It is disabled by default: the measured searches had no cache hits, so hash
   lookups consumed time and memory. Enable it with `--cache`; `--cache-limit`
   controls capacity and full caches are cleared safely.

For the fixed checking rook, the root symmetry subgroup is generated directly.
In 6D this allocates 3,840 cell mappings instead of all 46,080 full-board
symmetries. With symmetry disabled, only the identity mapping is generated.

Use `--help` for flags disabling individual optimizations. The benchmark script
compares those variants, including a simpler backtracker.

## Native parallel search

The solver's `--workers N` option starts actual `std::thread` workers inside the
C++ executable. These workers execute CPU-bound backtracking in parallel on
available cores; Python only selects the next rook count. The direct solver
defaults to one worker for compatibility. The minimum runner defaults to the
number of available logical CPUs (eight on the machine used for these checks).

The coordinator partitions a shallow portion of the search into a bounded queue
of subtrees. Workers claim the next subtree when they finish one. They share
immutable board tables; selected pieces, recursion state, statistics, and bounded
failure caches belong to individual workers. `--split-depth 4` is the default;
values 1 through 6 control partition depth. Very small problems may finish while
partitioning and require no worker threads.

Partitioned subtrees are deferred work, not infeasibility proofs. Failure
memoization is disabled during partitioning, and a count is reported infeasible
only when every queued task has completed. A verified solution cancels the other
workers. A timeout, global node limit, or Ctrl+C cancels the pool and produces
`unknown` unless a verified solution was found. Both the wall-time budget and the
node budget apply to the entire count, including partitioning. If caching is
enabled, `--cache-limit` applies separately to each worker.

Result JSON includes a `parallel` section with unique native thread IDs,
per-worker node counts, completed task counts, peak concurrent active workers,
pool wall time, and total process CPU time. A four-worker 4D/13 validation used
about 0.56 CPU-seconds during 0.14 seconds of pool wall time, confirming execution
on approximately four cores. Tests compare serial and parallel results, verify
complete task coverage for infeasibility proofs, and check cancellation limits.
The measured run is saved in `results/parallel_validation_4d_13.json`.

```sh
./build/rook-search --dimensions 4 --rooks 13 --workers 4 --progress-interval 1
```

## What the 3D enumeration contributes

`python3 analyze_3d.py` examines all **230,230** placements of six rooks among the
26 noncentral cells. It finds **147 checkmates**, or **7 classes** up to rotations
and reflections. Every one is checked by simulating king moves and captures.

The unrestricted maximum attack coverage for each rook count is:

| Dimension | Maximum coverage, starting at zero rooks |
| --- | --- |
| 1 | 0, 2, 3 |
| 2 | 0, 4, 7, 9 |
| 3 | 0, 6, 12, 18, 22, 25, 27 |

The C++ solver computes these tables; the Python enumeration independently
checks them without the C++ table generator's symmetry reduction. The 3D table
provides stronger bounds inside the 4D search than the linear `6*m` estimate.

For 5D, an exact 4D coverage table would itself be expensive. Instead, derive a
safe upper bound from the exact 3D table `F3`:

```
F4_upper(r) = max over a+b+c=r of
             sum(min(27, F3(inside) + r-inside) for inside in [a,b,c])
```

`F3` saturates at 27. This gives
`[0,8,16,24,32,40,48,56,64,72,77,80,81]`, saturating at 81.
The JSON explicitly labels this as an upper bound, not an exact table.

For 6D the same recurrence is applied once more to derive a safe 5D slice
coverage bound. It uses the existing 4D upper-bound table rather than enumerating
5D placements. A nested upper bound remains safe for rejecting branches.

All minimum 3D configurations have rook-defense components of sizes either
`[2,2,2]` or `[2,4]`. That observation motivates defending selected rooks early.
Those component patterns are **not** imposed as restrictions in higher dimensions.

## Computed minima and the 5D construction

The saved runs rule out 13 rooks in 4D and find a 14-rook checkmate. A second
13-rook search disables symmetry, slice, and packing pruning and reaches the same
infeasibility result. In 5D, the searches rule out 25 and 26 rooks and construct
a checkmate with 27. The 26-rook result was also checked with both the marginal
coverage bound and packing bound disabled. See `results/` for the actual runs.

These results concern the model above. Adding a rook preserves its coverage
condition, so infeasibility with 13 or 26 also excludes every smaller rook count:
any smaller solution could be padded to that number. Together with the explicit
constructions, the computed minima are therefore **14 in 4D** and **27 in 5D**.

For the 27-rook construction, choose the nine 4D points satisfying, modulo 3,

```
a + c + d = 1
b + c + 2*d = 0
```

Use each point in all three fifth-coordinate layers. The four parity-check
columns represent all four one-dimensional directions in the two-dimensional
vector space over three elements. Thus every point outside the nine-point set
differs from exactly one member in exactly one coordinate, and is attacked within
its layer. Points in the set are defended by the corresponding rooks in the
other two layers. The nonzero syndrome excludes the central king. This gives
27 rooks, and adding eight unused cells gives the requested 35-rook checkmate.

## Validation and benchmarks

```sh
make test
python3 analyze_3d.py --json results/analysis_3d.json
python3 benchmark.py --repeats 3 --json results/benchmarks.json
```

Tests include known 1D–3D minima, independent enumeration of all minimum 3D
placements, optional-pruning cross-checks, 4D and 5D minimum searches, independent
physical validation of constructions, multiword bitmask boundaries, bounded cache
resets, invalid arguments, and deadline handling. Saved timings depend on the
machine and build; constructive 5D runs are labeled separately from backtracking.

## Run the 6D search yourself

6D has **729 cells** and 728 possible rook cells around the fixed central king.
The integer slice argument proves a lower bound of **63 rooks**. An upper bound
of 81 follows by repeating a known 27-rook 5D position in each of the three
sixth-coordinate slices. Neither bound establishes the exact 6D minimum.

No 6D position search was run while adding this support. The structural C++ test
checks the 6D graph, mask boundaries, symmetry subgroup, and slice tables without
calling the search. The 6D solver uses exhaustive backtracking; it has no
automatic 6D construction shortcut.

Build and run a parallel binary search. For the requested 63–70 range:

```sh
cd rook-checkmate
make
python3 find_minimum.py --dimensions 6 --max-rooks 70 --workers 8 --time-limit 3600
```

The runner starts at the midpoint, **66**, and grants **one wall-clock hour per
tested count**, shared by all eight workers. A checkmate at 66 moves the next
probe to 64; an infeasibility proof at 66 moves it to 68. It continues bisecting
until the feasible and infeasible bounds meet. Adding rooks preserves checkmate
coverage, so infeasibility at a count also excludes every smaller count.

The 63–70 interval needs at most four decisive count probes. Use `--max-rooks 81`
to include the full known bound; that interval starts at 72 and needs at most five
probes. Omit `--workers` to use the available CPU count, or use `--workers 1` for
serial execution.

The runner writes individual reports and `search-summary.json` under
`results/6d-search/`. The summary distinguishes the proven lower bound from the
best verified feasible count; the requested maximum is not assumed feasible.
Finding a checkmate narrows the interval and does not by itself establish the
minimum. A timeout or node limit returns `unknown`, leaves the bounds unchanged,
and stops the runner without claiming a minimum.

Re-run the same command with a larger budget, or `--time-limit 0` for no deadline.
Completed results are reused when they match the exact solver binary hash.
Interrupted or timed-out counts restart from the beginning; the traversal stack
is not checkpointed. Ctrl+C requests a graceful stop and saves an `unknown`
report. Rebuilding the executable invalidates the runner's cached proofs.

Preview the plan without starting a search or writing results:

```sh
python3 find_minimum.py --dimensions 6 --max-rooks 70 --workers 8 --dry-run
```

To test a single rook count instead:

```sh
./build/rook-search --dimensions 6 --rooks 70 --workers 8 --no-construction \
  --time-limit 3600 --progress-interval 5 --json results/6d_70.json
```

Use `--node-limit 1000000` for a bounded experiment. Progress goes to stderr;
stdout remains a JSON report. `--progress-interval 0` silences progress.
Structural checks and the existing 1D–5D regression tests run with `make test`;
the test suite does not launch a 6D position search.
