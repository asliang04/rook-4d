#!/usr/bin/env python3
"""Exhaustive small-board analysis, independent of the C++ backtracking search."""

import argparse
from collections import Counter
from itertools import combinations, permutations, product
import json
from pathlib import Path
import time


def make_board(dimensions):
    points = list(product((-1, 0, 1), repeat=dimensions))
    masks = [
        sum(1 << j for j, q in enumerate(points)
            if sum(a != b for a, b in zip(p, q)) == 1)
        for p in points
    ]
    return points, masks


def ray_checkmate(dimensions, rooks):
    """Check the original check and every king move, with captures and blockers."""
    king = (0,) * dimensions
    rook_set = set(map(tuple, rooks))
    if king in rook_set or len(rook_set) != len(rooks):
        return False
    if any(len(r) != dimensions or any(v not in (-1, 0, 1) for v in r) for r in rook_set):
        return False
    for destination in product((-1, 0, 1), repeat=dimensions):
        remaining = rook_set - {destination}
        attacked = False
        for axis in range(dimensions):
            for direction in (-1, 1):
                ray = list(destination)
                while -1 <= ray[axis] + direction <= 1:
                    ray[axis] += direction
                    if tuple(ray) in remaining:
                        attacked = True
                        break
        if not attacked:
            return False
    return True


def coverage_profile(dimensions):
    """Unrestricted maximum attack coverage for each rook count, until full."""
    points, attacks = make_board(dimensions)
    profile = [0]
    for size in range(1, len(points) + 1):
        best = 0
        # Deliberately no symmetry reduction: independently check the C++ table.
        for rooks in combinations(range(len(points)), size):
            covered = 0
            for r in rooks:
                covered |= attacks[r]
            best = max(best, covered.bit_count())
            if best == min(len(points), 2 * dimensions * size):
                break
        profile.append(best)
        if best == len(points):
            return profile
    raise AssertionError("The full board must cover itself in a nontrivial dimension")


def analyze():
    started = time.perf_counter()
    points, attacks = make_board(3)
    index = {p: i for i, p in enumerate(points)}
    center = index[(0, 0, 0)]
    candidates = [i for i in range(27) if i != center]
    full = (1 << 27) - 1
    transformations = []
    for axes in permutations(range(3)):
        for signs in product((-1, 1), repeat=3):
            transformations.append([
                index[tuple(signs[a] * p[axes[a]] for a in range(3))]
                for p in points
            ])
    orbits = set()
    component_patterns = Counter()
    slice_patterns = Counter()
    solutions = 0
    checked = 0
    example = None
    for rooks in combinations(candidates, 6):
        checked += 1
        covered = 0
        for r in rooks:
            covered |= attacks[r]
        if covered != full:
            continue
        coordinates = [points[r] for r in rooks]
        if not ray_checkmate(3, coordinates):
            raise AssertionError("Coverage model disagrees with king-move simulation")
        solutions += 1
        if example is None:
            example = coordinates
        canonical = min(sum(1 << transform[r] for r in rooks) for transform in transformations)
        orbits.add(canonical)
        slice_pattern = sorted(tuple(sorted(Counter(p[a] for p in coordinates).values())) for a in range(3))
        slice_patterns[str(slice_pattern)] += 1
        unseen = set(rooks)
        components = []
        while unseen:
            pending = [unseen.pop()]
            size = 0
            while pending:
                r = pending.pop()
                size += 1
                neighbors = [s for s in unseen if attacks[r] & (1 << s)]
                unseen.difference_update(neighbors)
                pending.extend(neighbors)
            components.append(size)
        component_patterns[str(sorted(components))] += 1
    return {
        "unrestricted_1d_coverage_profile": coverage_profile(1),
        "unrestricted_2d_coverage_profile": coverage_profile(2),
        "unrestricted_3d_coverage_profile": coverage_profile(3),
        "six_rook_placements_checked": checked,
        "six_rook_checkmates": solutions,
        "six_rook_checkmates_up_to_rotations_and_reflections": len(orbits),
        "all_checkmates_verified_by_ray_tracing": True,
        "defense_component_patterns": dict(sorted(component_patterns.items())),
        "sorted_slice_occupancy_patterns": dict(sorted(slice_patterns.items())),
        "example": example,
        "elapsed_seconds": time.perf_counter() - started,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    result = json.dumps(analyze(), indent=2) + "\n"
    print(result, end="")
    if args.json:
        args.json.write_text(result)
