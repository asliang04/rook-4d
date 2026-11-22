import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from analyze_3d import analyze, ray_checkmate


ROOT = Path(__file__).resolve().parent


class SearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="rook-tests-")
        if os.environ.get("ROOK_SEARCH_BINARY"):
            cls.binary = Path(os.environ["ROOK_SEARCH_BINARY"]).resolve()
        else:
            cls.binary = Path(cls.temporary.name) / "rook-search"
            compiler = shutil.which("clang++") or shutil.which("g++")
            if compiler is None:
                raise RuntimeError("A C++17 compiler is required")
            subprocess.run([compiler, "-std=c++17", "-O3", "-Wall", "-Wextra", "-Werror", "-pthread",
                            str(ROOT / "search.cpp"), "-o", str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def search(self, dimensions, rooks, *flags):
        process = subprocess.run(
            [str(self.binary), "--dimensions", str(dimensions), "--rooks", str(rooks),
             "--time-limit", "60", *flags], capture_output=True, text=True, timeout=70,
        )
        self.assertIn(process.returncode, (0, 1, 2), process.stderr)
        result = json.loads(process.stdout)
        self.assertEqual(process.returncode, {"found": 0, "infeasible": 1, "unknown": 2}[result["status"]])
        if result["status"] == "found":
            self.assertEqual(len(result["rooks"]), rooks)
            self.assertTrue(result["verified_by_ray_tracing"])
            self.assertTrue(ray_checkmate(dimensions, result["rooks"]))
        return result

    def test_small_board_minima(self):
        for dimensions, minimum in ((1, 2), (2, 3), (3, 6)):
            with self.subTest(dimensions=dimensions):
                self.assertEqual(self.search(dimensions, minimum - 1)["status"], "infeasible")
                self.assertEqual(self.search(dimensions, minimum)["status"], "found")

    def test_small_board_with_optional_pruning_disabled(self):
        flags = ("--no-symmetry", "--no-slices", "--no-packing", "--no-top-bound", "--no-defense-order", "--no-cache")
        self.assertEqual(self.search(3, 5, *flags)["status"], "infeasible")
        self.assertEqual(self.search(3, 6, *flags)["status"], "found")

    def test_independent_exhaustive_3d_analysis(self):
        report = analyze()
        self.assertEqual(report["six_rook_placements_checked"], 230230)
        self.assertEqual(report["six_rook_checkmates"], 147)
        self.assertEqual(report["six_rook_checkmates_up_to_rotations_and_reflections"], 7)
        self.assertEqual(report["unrestricted_3d_coverage_profile"], [0, 6, 12, 18, 22, 25, 27])
        result = self.search(4, 14)
        self.assertEqual(result["slice_coverage_profile"], report["unrestricted_3d_coverage_profile"])
        self.assertEqual(result["slice_profile_kind"], "exact")

    def test_4d_minimum(self):
        for rooks, status in ((12, "infeasible"), (13, "infeasible"), (14, "found")):
            with self.subTest(rooks=rooks):
                self.assertEqual(self.search(4, rooks)["status"], status)

    def test_4d_13_without_symmetry_slice_or_packing_pruning(self):
        result = self.search(4, 13, "--no-symmetry", "--no-slices", "--no-packing", "--no-cache")
        self.assertEqual(result["status"], "infeasible")

    def test_5d_minimum_and_requested_35_rooks(self):
        for rooks, status in ((25, "infeasible"), (26, "infeasible"), (27, "found"), (35, "found")):
            with self.subTest(rooks=rooks):
                result = self.search(5, rooks)
                self.assertEqual(result["status"], status)
                self.assertEqual(result["slice_profile_kind"], "upper_bound_from_exact_3d_profile")
                if status == "found":
                    self.assertEqual(result["method"], "verified_5d_hamming_code_construction")

    def test_5d_25_with_other_bounds_disabled(self):
        result = self.search(5, 25, "--no-symmetry", "--no-top-bound", "--no-packing", "--no-cache")
        self.assertEqual(result["status"], "infeasible")

    def test_large_masks_and_padding(self):
        for dimensions, rooks in ((4, 79), (5, 240), (5, 242)):
            with self.subTest(dimensions=dimensions, rooks=rooks):
                self.assertEqual(self.search(dimensions, rooks, "--no-construction")["status"], "found")

    def test_bounded_failure_cache(self):
        result = self.search(4, 12, "--cache", "--cache-limit", "16")
        self.assertEqual(result["status"], "infeasible")
        self.assertGreater(result["stats"]["cache_resets"], 0)
        self.assertLessEqual(result["stats"]["cached_failures"], 16)

    def test_deadline_is_unknown(self):
        result = self.search(4, 14, "--time-limit", "0.000000000001")
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["abort_reason"], "time_limit")

    def test_undefended_rook_is_capturable(self):
        self.assertFalse(ray_checkmate(2, [(1, 0)]))

    def test_node_budget_reports_unknown_on_a_small_board(self):
        result = self.search(4, 14, '--node-limit', '1', '--progress-interval', '0')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['abort_reason'], 'node_limit')
        self.assertEqual(result['stats']['nodes'], 1)

    def test_parallel_proof_uses_concurrent_native_workers(self):
        result = self.search(4, 13, '--workers', '4', '--split-depth', '3', '--progress-interval', '0')
        self.assertEqual(result['status'], 'infeasible')
        self.assertEqual(result['method'], 'parallel_exhaustive_backtracking')
        report = result['parallel']
        self.assertEqual(report['workers_started'], 4)
        used = [worker for worker in report['workers'] if worker['nodes'] > 0]
        self.assertGreaterEqual(len(used), 2)
        self.assertEqual(len({worker['thread_id'] for worker in used}), len(used))
        self.assertGreaterEqual(report['peak_active_workers'], 2)
        self.assertEqual(report['tasks_completed'], report['tasks_generated'])
        self.assertEqual(report['partition_nodes'] + sum(worker['nodes'] for worker in used), result['stats']['nodes'])

    def test_parallel_sat_and_exact_shared_node_limit(self):
        self.assertEqual(self.search(4, 14, '--workers', '4', '--split-depth', '2')['status'], 'found')
        result = self.search(4, 13, '--workers', '4', '--split-depth', '1', '--node-limit', '2000')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['abort_reason'], 'node_limit')
        self.assertEqual(result['stats']['nodes'], 2000)
        self.assertLess(result['parallel']['tasks_completed'], result['parallel']['tasks_generated'])

    def test_parallel_partition_depths_preserve_infeasibility(self):
        for depth in (1, 4, 6):
            with self.subTest(depth=depth):
                result = self.search(4, 12, '--workers', '3', '--split-depth', str(depth), '--cache')
                self.assertEqual(result['status'], 'infeasible')

    def test_parallel_timeout_is_unknown(self):
        result = self.search(4, 13, '--workers', '4', '--time-limit', '0.005')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['abort_reason'], 'time_limit')

    def test_invalid_arguments(self):
        for flags in (("--dimensions", "7"), ("--rooks", "81"), ("--time-limit", "-1"), ("--progress-interval", "-1"), ("--node-limit", "-1"), ('--workers', '0'), ('--workers', '257'), ('--split-depth', '0')):
            process = subprocess.run([str(self.binary), *flags], capture_output=True, text=True)
            self.assertEqual(process.returncode, 64)
            self.assertTrue(process.stderr)


if __name__ == "__main__":
    unittest.main()
