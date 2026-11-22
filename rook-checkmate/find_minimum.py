#!/usr/bin/env python3
"""Binary-search rook counts using native parallel exhaustive searches."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent


def lower_bound(dimensions):
    if dimensions == 1:
        return 2
    quotient, remainder = divmod(3 ** (dimensions - 1), 2 * dimensions)
    return 3 * quotient + min(remainder, 3)


def command_for(args, count):
    return [str(args.solver.resolve()), '--dimensions', str(args.dimensions), '--rooks', str(count),
            '--workers', str(args.workers), '--split-depth', str(args.split_depth),
            '--no-construction', '--time-limit', str(args.time_limit),
            '--progress-interval', str(args.progress_interval), '--node-limit', str(args.node_limit)]


def run_solver(command):
    # Progress goes straight to the terminal. Only the final JSON is captured.
    child = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
    was_interrupted = False
    try:
        stdout, _ = child.communicate()
    except KeyboardInterrupt:
        was_interrupted = True
        if child.poll() is None:
            child.send_signal(signal.SIGINT)
        stdout, _ = child.communicate()
    if child.returncode not in (0, 1, 2):
        raise RuntimeError(f'Solver exited with code {child.returncode}.')
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError('The solver did not return a complete JSON report.') from error
    expected = {0: 'found', 1: 'infeasible', 2: 'unknown'}[child.returncode]
    if result.get('status') != expected:
        raise RuntimeError('Solver exit status and JSON report disagree.')
    return result, was_interrupted


def valid_result(result, dimensions, count, fingerprint):
    if not isinstance(result, dict):
        return False
    if result.get('dimensions') != dimensions or result.get('requested_rooks') != count:
        return False
    runner = result.get('runner')
    if not isinstance(runner, dict) or runner.get('solver_sha256') != fingerprint:
        return False
    if result.get('method') not in ('exhaustive_backtracking', 'parallel_exhaustive_backtracking'):
        return False
    if result.get('status') == 'infeasible':
        return True
    return (result.get('status') == 'found' and result.get('verified_by_ray_tracing') is True
            and isinstance(result.get('rooks'), list) and len(result['rooks']) == count)


def save_result(destination, result):
    with tempfile.NamedTemporaryFile(mode='w', dir=destination.parent, prefix='.rook-', suffix='.tmp', delete=False) as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
        temporary = Path(stream.name)
    temporary.replace(destination)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dimensions', type=int, default=6, choices=range(1, 7))
    parser.add_argument('--max-rooks', type=int)
    available_cpus = getattr(os, 'process_cpu_count', os.cpu_count)() or 1
    parser.add_argument('--workers', type=int, default=min(available_cpus, 256), help='Native C++ worker threads per candidate; defaults to available CPUs.')
    parser.add_argument('--split-depth', type=int, default=4, help='Backtracking levels used to partition the parallel work (1..6).')
    parser.add_argument('--time-limit', type=float, default=3600, help='Seconds per rook count; 0 means unlimited.')
    parser.add_argument('--progress-interval', type=float, default=5)
    parser.add_argument('--node-limit', type=int, default=0, help='Nodes per count; 0 means unlimited.')
    parser.add_argument('--solver', type=Path, default=ROOT / 'build/rook-search')
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--dry-run', action='store_true', help='Print the plan without starting a solver or writing files.')
    args = parser.parse_args(argv)
    if not 1 <= args.workers <= 256 or not 1 <= args.split_depth <= 6:
        parser.error('workers must be 1..256 and split-depth must be 1..6')
    first = lower_bound(args.dimensions)
    maximum = args.max_rooks if args.max_rooks is not None else (81 if args.dimensions == 6 else 3 ** args.dimensions - 1)
    if not first <= maximum < 3 ** args.dimensions:
        parser.error(f'max-rooks must be between {first} and {3 ** args.dimensions - 1}')
    if not math.isfinite(args.time_limit) or args.time_limit < 0:
        parser.error('time-limit must be finite and nonnegative')
    if not math.isfinite(args.progress_interval) or args.progress_interval < 0 or args.node_limit < 0:
        parser.error('progress-interval and node-limit must be nonnegative and finite')
    output = args.output_dir or ROOT / 'results' / f'{args.dimensions}d-search'
    midpoint = (first + maximum) // 2
    print(f'{args.dimensions}D: {3 ** args.dimensions} cells; lower bound {first}; binary search {first}..{maximum}, '
          f'starting at {midpoint}, with {args.workers} native workers.', flush=True)
    if args.dry_run:
        print(json.dumps({'strategy': 'binary', 'range': [first, maximum], 'first_rooks': midpoint,
                          'first_command': command_for(args, midpoint), 'output_directory': str(output)}, indent=2))
        print('Dry run: no solver invoked and no files written.')
        return 0
    if not args.solver.is_file():
        parser.error(f'Solver missing: {args.solver}. Run make first.')
    fingerprint = hashlib.sha256(args.solver.read_bytes()).hexdigest()
    output.mkdir(parents=True, exist_ok=True)
    low, high, best = first, maximum, None
    history = []

    def summary(status):
        return {'status': status, 'strategy': 'binary', 'dimensions': args.dimensions,
                'requested_range': [first, maximum], 'proven_lower_bound': low,
                'best_feasible_rooks': best, 'next_test_interval': [low, high] if low <= high else None,
                'workers': args.workers, 'solver_sha256': fingerprint, 'history': history}

    while low <= high:
        count = (low + high) // 2
        if hashlib.sha256(args.solver.read_bytes()).hexdigest() != fingerprint:
            raise RuntimeError('The solver binary changed during the run. Restart the runner to use the new build.')
        destination = output / f'{args.dimensions}d_{count}.json'
        result = None
        if destination.exists():
            try:
                saved = json.loads(destination.read_text())
                if valid_result(saved, args.dimensions, count, fingerprint):
                    result = saved
                    print(f'Reusing completed result for {count} rooks.', flush=True)
            except (OSError, json.JSONDecodeError):
                pass
        was_interrupted = False
        if result is None:
            command = command_for(args, count)
            print(f'Searching midpoint {count} in {low}..{high} with {args.workers} workers...', flush=True)
            result, was_interrupted = run_solver(command)
            if hashlib.sha256(args.solver.read_bytes()).hexdigest() != fingerprint:
                raise RuntimeError('The solver binary changed during a search; the result was not cached. Restart the runner.')
            if result.get('dimensions') != args.dimensions or result.get('requested_rooks') != count:
                raise RuntimeError('The solver returned a different board or rook count.')
            result['runner'] = {'solver_sha256': fingerprint, 'arguments': command[1:], 'strategy': 'binary'}
            if result.get('status') != 'unknown' and not valid_result(result, args.dimensions, count, fingerprint):
                raise RuntimeError('The solver returned an unverified or unsupported result.')
            save_result(destination, result)
        status = result['status']
        print(f'{count} rooks: {status}; saved at {destination}', flush=True)
        history.append({'rooks': count, 'status': status})
        if status == 'found':
            best = count
            high = count - 1
        elif status == 'infeasible':
            # Adding rooks preserves coverage. Infeasibility at count therefore
            # also excludes every smaller count, even if it was never searched.
            low = count + 1
        else:
            save_result(output / 'search-summary.json', summary('unknown'))
            print(f'Stopped at {count}: no infeasibility proof. Re-run with a larger budget; completed results will be reused.')
            return 130 if was_interrupted else 2
        save_result(output / 'search-summary.json', summary('running'))
        if was_interrupted:
            save_result(output / 'search-summary.json', summary('interrupted'))
            return 130
    if best is not None:
        save_result(output / 'search-summary.json', summary('minimum_established'))
        print(f'Minimum established: {best}. All smaller counts are excluded by the lower bound or exhaustive infeasibility proofs.')
        return 0
    save_result(output / 'search-summary.json', summary('infeasible_in_requested_range'))
    print(f'Every count through {maximum} is excluded by infeasibility proofs. Increase --max-rooks to continue.')
    return 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        raise SystemExit(str(error))
