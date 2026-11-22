#!/usr/bin/env python3
"""Measure optional pruning on small boards and the 4D existence searches."""

import argparse
import json
from pathlib import Path
import platform
import statistics
import subprocess


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=root / "build/rook-search")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--time-limit", type=float, default=5)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    if args.repeats < 1 or args.time_limit <= 0:
        parser.error("repeats and time-limit must be positive")
    variants = {
        "default": [],
        "without_defense_order": ["--no-defense-order"],
        "without_slice_bound": ["--no-slices"],
        "without_packing_bound": ["--no-packing"],
        "without_top_coverage_bound": ["--no-top-bound"],
        "without_symmetry": ["--no-symmetry"],
        "with_failure_cache": ["--cache"],
        "basic_backtracking": ["--no-symmetry", "--no-slices", "--no-packing", "--no-top-bound", "--no-defense-order"],
    }
    records = []
    for dimensions, rooks in ((3, 5), (3, 6), (4, 13), (4, 14)):
        for name, flags in variants.items():
            runs = []
            for _ in range(args.repeats):
                process = subprocess.run(
                    [str(args.binary.resolve()), "--dimensions", str(dimensions), "--rooks", str(rooks),
                     "--time-limit", str(args.time_limit), *flags],
                    capture_output=True, text=True, timeout=args.time_limit + 10,
                )
                if process.returncode not in (0, 1, 2):
                    raise RuntimeError(process.stderr)
                runs.append(json.loads(process.stdout))
            record = {
                "dimensions": dimensions, "rooks": rooks, "variant": name,
                "median_seconds": statistics.median(r["elapsed_seconds"] for r in runs),
                "statuses": [r["status"] for r in runs], "stats": runs[-1]["stats"],
            }
            records.append(record)
            print(f"{dimensions}D/{rooks}: {name}: {record['statuses'][0]}, "
                  f"{record['median_seconds']:.6f}s, {record['stats']['nodes']:,} nodes", flush=True)
    if args.json:
        args.json.write_text(json.dumps({"platform": platform.platform(), "records": records}, indent=2) + "\n")


if __name__ == "__main__":
    main()
