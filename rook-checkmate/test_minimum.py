import contextlib
import io
import json
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import find_minimum


class MinimumRunnerTests(unittest.TestCase):
    def test_lower_bounds(self):
        self.assertEqual([find_minimum.lower_bound(n) for n in range(1, 7)], [2, 3, 6, 12, 25, 63])

    def test_6d_plan_never_starts_a_solver_or_creates_an_output_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'not-created'
            with patch('find_minimum.run_solver', side_effect=AssertionError('No search allowed')), contextlib.redirect_stdout(io.StringIO()) as stream:
                status = find_minimum.main(['--dimensions', '6', '--max-rooks', '81', '--dry-run', '--output-dir', str(output)])
            self.assertEqual(status, 0)
            self.assertIn('lower bound 63', stream.getvalue())
            self.assertFalse(output.exists())

    def test_63_to_70_starts_at_66_with_parallel_workers(self):
        with contextlib.redirect_stdout(io.StringIO()) as stream:
            self.assertEqual(find_minimum.main(['--max-rooks', '70', '--workers', '4', '--dry-run']), 0)
        self.assertIn('starting at 66', stream.getvalue())
        self.assertIn('"--workers"', stream.getvalue())

    def test_completed_cache_requires_matching_solver_and_verified_found_result(self):
        record = {'dimensions': 3, 'requested_rooks': 6, 'method': 'exhaustive_backtracking',
                  'status': 'infeasible', 'runner': {'solver_sha256': 'abc'}}
        self.assertTrue(find_minimum.valid_result(record, 3, 6, 'abc'))
        self.assertFalse(find_minimum.valid_result(record, 3, 6, 'different'))
        self.assertFalse(find_minimum.valid_result({**record, 'status': 'unknown'}, 3, 6, 'abc'))
        self.assertFalse(find_minimum.valid_result({**record, 'status': 'found'}, 3, 6, 'abc'))
        self.assertFalse(find_minimum.valid_result({**record, 'runner': None}, 3, 6, 'abc'))

    def test_unknown_stops_the_minimum_search_and_saves_report(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            solver = root / 'fake-solver'
            solver.write_text('placeholder executable fingerprint')
            result = {'dimensions': 3, 'requested_rooks': 7, 'method': 'exhaustive_backtracking', 'status': 'unknown'}
            with patch('find_minimum.run_solver', return_value=(result, False)) as run, contextlib.redirect_stdout(io.StringIO()):
                status = find_minimum.main(['--dimensions', '3', '--max-rooks', '8', '--solver', str(solver), '--output-dir', str(root/'out')])
            self.assertEqual(status, 2)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(json.loads((root/'out/3d_7.json').read_text())['status'], 'unknown')

    def oracle(self, statuses, calls):
        # Only the known 4D/14 witness is used for mocked successful replies.
        fixture = json.loads((Path(__file__).parent/'results/4d_14.json').read_text())
        def run(command):
            count = int(command[command.index('--rooks') + 1])
            calls.append(count)
            status = statuses[count]
            if status == 'found':
                self.assertEqual(count, 14)
                result = copy.deepcopy(fixture)
            else:
                result = {'dimensions': 4, 'requested_rooks': count, 'method': 'parallel_exhaustive_backtracking', 'rooks': []}
            result['status'] = status
            return result, False
        return run

    def binary_case(self, maximum, statuses):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            solver = root/'fake-solver'
            solver.write_text('fixed executable fingerprint')
            calls = []
            arguments = ['--dimensions', '4', '--max-rooks', str(maximum), '--workers', '4',
                         '--solver', str(solver), '--output-dir', str(root/'out')]
            with patch('find_minimum.run_solver', side_effect=self.oracle(statuses, calls)), contextlib.redirect_stdout(io.StringIO()):
                status = find_minimum.main(arguments)
            summary = json.loads((root/'out/search-summary.json').read_text())
            return status, calls, summary

    def test_found_moves_down_and_infeasible_moves_up(self):
        status, calls, summary = self.binary_case(16, {14: 'found', 12: 'infeasible', 13: 'infeasible'})
        self.assertEqual((status, calls), (0, [14, 12, 13]))
        self.assertEqual(summary['status'], 'minimum_established')
        self.assertEqual(summary['proven_lower_bound'], 14)
        self.assertEqual(summary['best_feasible_rooks'], 14)

    def test_infeasible_midpoint_moves_up_to_a_witness(self):
        status, calls, _ = self.binary_case(15, {13: 'infeasible', 14: 'found'})
        self.assertEqual((status, calls), (0, [13, 14]))

    def test_timeout_preserves_bounds_after_a_success(self):
        status, calls, summary = self.binary_case(16, {14: 'found', 12: 'unknown'})
        self.assertEqual((status, calls), (2, [14, 12]))
        self.assertEqual(summary['status'], 'unknown')
        self.assertEqual(summary['proven_lower_bound'], 12)
        self.assertEqual(summary['best_feasible_rooks'], 14)

    def test_range_without_a_witness_does_not_claim_a_minimum(self):
        status, calls, summary = self.binary_case(13, {12: 'infeasible', 13: 'infeasible'})
        self.assertEqual((status, calls), (1, [12, 13]))
        self.assertEqual(summary['status'], 'infeasible_in_requested_range')
        self.assertIsNone(summary['best_feasible_rooks'])


if __name__ == '__main__':
    unittest.main()
