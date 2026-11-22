#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <condition_variable>
#include <ctime>
#include <cstdint>
#include <fstream>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <numeric>
#include <stdexcept>
#include <sstream>
#include <string>
#include <unordered_set>
#include <thread>
#include <vector>

constexpr int MAX_DIMENSIONS = 6;
constexpr int MAX_CELLS = 729;
constexpr int MASK_WORDS = (MAX_CELLS + 1 + 63) / 64;
// Twelve words hold the entire 3^6 board and the slice-allocation bitsets.
struct Mask {
    std::array<uint64_t, MASK_WORDS> words{};
    Mask(uint64_t value = 0) { words[0] = value; }
    explicit operator bool() const { for (auto word : words) if (word) return true; return false; }
    bool operator==(const Mask &b) const { return words == b.words; }
    Mask &operator&=(const Mask &b) { for (int i = 0; i < MASK_WORDS; ++i) words[i] &= b.words[i]; return *this; }
    Mask &operator|=(const Mask &b) { for (int i = 0; i < MASK_WORDS; ++i) words[i] |= b.words[i]; return *this; }
    friend Mask operator&(Mask a, const Mask &b) { return a &= b; }
    friend Mask operator|(Mask a, const Mask &b) { return a |= b; }
    friend Mask operator^(Mask a, const Mask &b) { for (int i = 0; i < MASK_WORDS; ++i) a.words[i] ^= b.words[i]; return a; }
    friend Mask operator~(Mask a) { for (auto &word : a.words) word = ~word; return a; }
    Mask operator<<(int shift) const {
        Mask result;
        if (shift < 0) throw std::logic_error("Negative mask shift");
        int whole = shift / 64, part = shift % 64;
        for (int i = whole; i < MASK_WORDS; ++i) {
            result.words[i] = words[i - whole] << part;
            if (part && i > whole) result.words[i] |= words[i - whole - 1] >> (64 - part);
        }
        return result;
    }
    Mask operator-(uint64_t amount) const {
        Mask result = *this;
        for (auto &word : result.words) {
            uint64_t before = word;
            word -= amount;
            amount = before < amount;
        }
        return result;
    }
};
using Clock = std::chrono::steady_clock;
static std::atomic<bool> interrupted{false};
static_assert(std::atomic<bool>::is_always_lock_free, "The signal flag must be lock-free");
static void on_interrupt(int) { interrupted.store(true, std::memory_order_relaxed); }
static Mask bit(int i) {
    if (i < 0 || i >= MASK_WORDS * 64) throw std::logic_error("Bit index outside mask capacity");
    Mask result; result.words[i / 64] = uint64_t(1) << (i % 64); return result;
}
static int count(Mask m) {
    int result = 0;
    for (auto word : m.words) result += __builtin_popcountll(word);
    return result;
}
static int first(Mask m) {
    for (int i = 0; i < MASK_WORDS; ++i) if (m.words[i]) return 64 * i + __builtin_ctzll(m.words[i]);
    throw std::logic_error("Cannot remove a bit from an empty mask");
}
static int pop(Mask &m) { int i = first(m); m.words[i / 64] &= m.words[i / 64] - 1; return i; }

struct Options {
    int dimensions = 4, rooks = 14;
    int workers = 1, split_depth = 4;
    double seconds = 30;
    double progress_interval = 5;
    uint64_t node_limit = 0;
    size_t cache_limit = 200000;
    bool symmetry = true, slices = true, packing = true, top_bound = true, defense_order = true, cache = false;
    bool construction = true;
    std::string json_file;
};

struct Stats {
    uint64_t nodes = 0, forced = 0, dead_cells = 0, capacity = 0, top_bound = 0;
    uint64_t slices = 0, packing = 0, cache_hits = 0, cache_resets = 0, symmetry_skips = 0;
    void add(const Stats &b) {
        nodes += b.nodes; forced += b.forced; dead_cells += b.dead_cells;
        capacity += b.capacity; top_bound += b.top_bound; slices += b.slices;
        packing += b.packing; cache_hits += b.cache_hits; cache_resets += b.cache_resets;
        symmetry_skips += b.symmetry_skips;
    }
};

struct Task {
    Mask selected, available, uncovered;
    std::vector<int> group;
};

enum class StopReason { none, time_limit, node_limit, interrupted };
static const char *reason_text(StopReason reason) {
    switch (reason) {
        case StopReason::time_limit: return "time_limit";
        case StopReason::node_limit: return "node_limit";
        case StopReason::interrupted: return "interrupted";
        default: return "parallel_cancelled";
    }
}

struct ParallelControl {
    std::atomic<bool> stop{false}, found{false};
    std::atomic<StopReason> reason{StopReason::none};
    std::atomic<uint64_t> nodes{0};
    std::atomic<size_t> next_task{0}, tasks_started{0}, tasks_completed{0};
    std::atomic<int> running{0}, active{0}, peak_active{0};
    std::mutex mutex;
    std::condition_variable changed;
    bool start = false;
    Mask winner;
    std::exception_ptr error;

    void abort(StopReason cause) {
        StopReason expected = StopReason::none;
        reason.compare_exchange_strong(expected, cause);
        stop.store(true);
    }
};

struct WorkerReport {
    std::string thread_id;
    Stats stats;
    uint64_t tasks_started = 0, tasks_completed = 0;
    size_t cached_failures = 0;
};

struct ParallelReport {
    int workers_started = 0, peak_active_workers = 0;
    uint64_t partition_nodes = 0, tasks_generated = 0, tasks_started = 0, tasks_completed = 0;
    double wall_seconds = 0, process_cpu_seconds = 0;
    std::vector<WorkerReport> workers;
};

struct Key {
    Mask available, uncovered;
    int remaining;
    bool operator==(const Key &b) const {
        return available == b.available && uncovered == b.uncovered && remaining == b.remaining;
    }
};
struct KeyHash {
    static uint64_t mix(uint64_t x) {
        x ^= x >> 30; x *= 0xbf58476d1ce4e5b9ULL;
        x ^= x >> 27; x *= 0x94d049bb133111ebULL;
        return x ^ (x >> 31);
    }
    size_t operator()(const Key &k) const {
        uint64_t result = mix(uint64_t(k.remaining));
        for (int i = 0; i < MASK_WORDS; ++i) {
            result ^= mix(k.available.words[i] + uint64_t(i));
            result ^= mix(k.uncovered.words[i] + uint64_t(i + MASK_WORDS));
        }
        return result;
    }
};

struct Board {
    int dimensions, cells, center;
    Mask full, candidates;
    std::vector<std::array<int, MAX_DIMENSIONS>> coordinates;
    std::vector<Mask> attacks;
    std::vector<std::vector<Mask>> axis_attacks;
    std::vector<std::vector<int>> symmetries;
    std::vector<std::array<Mask, 3>> slices;

    explicit Board(int n, bool use_symmetry = true, bool fix_checking_rook = false) : dimensions(n), cells(1), center(0) {
        for (int axis = 0, weight = 1; axis < n; ++axis, weight *= 3) {
            cells *= 3; center += weight;
        }
        full = bit(cells) - 1;
        candidates = full ^ bit(center);
        coordinates.resize(cells);
        attacks.resize(cells);
        axis_attacks.resize(n, std::vector<Mask>(cells));
        slices.resize(n);
        for (int cell = 0; cell < cells; ++cell) {
            int value = cell;
            for (int axis = 0; axis < n; ++axis) {
                coordinates[cell][axis] = value % 3;
                value /= 3;
                slices[axis][coordinates[cell][axis]] |= bit(cell);
            }
        }
        for (int cell = 0; cell < cells; ++cell) {
            for (int axis = 0, weight = 1; axis < n; ++axis, weight *= 3) {
                for (int value = 0; value < 3; ++value) {
                    if (value != coordinates[cell][axis]) {
                        Mask target = bit(cell + (value - coordinates[cell][axis]) * weight);
                        attacks[cell] |= target;
                        axis_attacks[axis][cell] |= target;
                    }
                }
            }
        }
        if (!use_symmetry) {
            std::vector<int> identity(cells);
            std::iota(identity.begin(), identity.end(), 0);
            symmetries.push_back(std::move(identity));
            return;
        }
        std::vector<int> permutation(n);
        std::iota(permutation.begin(), permutation.end(), 0);
        do {
            // The root checking rook is at center+1, on the positive first axis.
            // Generate its stabilizer directly: 3,840 mappings in 6D instead of
            // allocating all 46,080 mappings and discarding most of them later.
            if (fix_checking_rook && permutation[0] != 0) continue;
            for (int flips = 0; flips < (1 << n); ++flips) {
                if (fix_checking_rook && (flips & 1)) continue;
                std::vector<int> mapping(cells);
                for (int cell = 0; cell < cells; ++cell) {
                    int target = 0;
                    for (int axis = 0, weight = 1; axis < n; ++axis, weight *= 3) {
                        int value = coordinates[cell][permutation[axis]];
                        if (flips & (1 << axis)) value = 2 - value;
                        target += value * weight;
                    }
                    mapping[cell] = target;
                }
                symmetries.push_back(std::move(mapping));
            }
        } while (std::next_permutation(permutation.begin(), permutation.end()));
    }
};

// Exact maximum attack-union sizes on an unrestricted lower-dimensional board.
// Every nonempty subset can be moved to contain cell 0 by permuting the three
// coordinate values independently. This is used ONLY for these unrestricted
// profiles; the king-fixed search uses the smaller center-preserving group.
static std::vector<int> coverage_profile(int dimensions) {
    if (dimensions >= 4) {
        // Recursively derive a safe UPPER bound from the smaller-dimensional
        // profile. Never enumerate subsets of a 4D or 5D board to build a table.
        auto lower = coverage_profile(dimensions - 1);
        int slice_cells = 1;
        for (int axis = 1; axis < dimensions; ++axis) slice_cells *= 3;
        std::vector<int> upper;
        for (int total = 0; ; ++total) {
            int best = 0;
            for (int a = 0; a <= total; ++a) {
                for (int b = 0; b <= total - a; ++b) {
                    int c = total - a - b;
                    int sum = 0;
                    for (int inside : {a, b, c})
                        sum += std::min(slice_cells, lower[std::min(inside, int(lower.size()) - 1)] + total - inside);
                    best = std::max(best, sum);
                }
            }
            upper.push_back(best);
            if (best == 3 * slice_cells) return upper;
        }
    }
    Board b(dimensions, false);
    std::vector<int> profile{0};
    for (int size = 1; ; ++size) {
        int maximum = 0;
        std::function<void(int, int, Mask)> visit = [&](int start, int left, Mask covered) {
            if (!left) { maximum = std::max(maximum, count(covered)); return; }
            if (maximum == std::min(b.cells, 2 * dimensions * size)) return;
            for (int i = start; i <= b.cells - left; ++i)
                visit(i + 1, left - 1, covered | b.attacks[i]);
        };
        visit(1, size - 1, b.attacks[0]);
        profile.push_back(maximum);
        if (maximum == b.cells) return profile;
    }
}

class Search {
public:
    Options options;
    std::shared_ptr<const Board> board_storage;
    const Board &board;
    Stats stats;
    Mask solution = 0;
    bool aborted = false;
    std::string abort_reason;
    std::string method = "exhaustive_backtracking";
    std::vector<int> profile;
    Clock::time_point started;
    double last_progress = 0;
    std::unordered_set<Key, KeyHash> failures;
    ParallelReport parallel;

    explicit Search(Options o) : options(std::move(o)),
        board_storage(std::make_shared<Board>(options.dimensions, options.symmetry && options.rooks > 0, options.symmetry && options.rooks > 0)),
        board(*board_storage),
        started(Clock::now()) {
        if (board.dimensions > 1 && options.slices) profile = coverage_profile(board.dimensions - 1);
        if (options.cache && options.cache_limit) failures.reserve(options.cache_limit);
    }

    double elapsed() const { return std::chrono::duration<double>(Clock::now() - started).count(); }

    bool run() {
        if (budget_exceeded()) return false;
        if (options.progress_interval > 0) {
            std::cerr << "Searching " << board.dimensions << "D, " << board.cells << " cells, "
                << options.rooks << " rooks, " << options.workers << " worker(s) requested; progress on stderr, result JSON on stdout.\n";
        }
        if (options.construction && board.dimensions == 5 && options.rooks >= 27) {
            // A nonzero coset of the ternary [4,2,3] Hamming code, repeated in
            // all three fifth-coordinate layers. Non-code cells are attacked
            // within a layer; code cells defend one another across the layers.
            for (int cell = 0; cell < board.cells; ++cell) {
                const auto &p = board.coordinates[cell];
                int a = p[0] - 1, b = p[1] - 1, c = p[2] - 1, d = p[3] - 1;
                auto mod3 = [](int value) { return (value % 3 + 3) % 3; };
                if (mod3(a + c + d) == 1 && mod3(b + c + 2*d) == 0) solution |= bit(cell);
            }
            if (count(solution) != 27) throw std::logic_error("Invalid Hamming-code construction");
            Mask unused = board.candidates & ~solution;
            for (int extra = options.rooks - 27; extra > 0; --extra) solution |= bit(pop(unused));
            method = "verified_5d_hamming_code_construction";
            return true;
        }
        std::vector<int> group;
        if (options.symmetry) {
            group.resize(board.symmetries.size());
            std::iota(group.begin(), group.end(), 0);
        } else {
            for (int s = 0; s < int(board.symmetries.size()); ++s) {
                bool identity = true;
                for (int i = 0; i < board.cells; ++i)
                    if (board.symmetries[s][i] != i) { identity = false; break; }
                if (identity) { group.push_back(s); break; }
            }
        }
        Mask selected = 0, available = board.candidates, uncovered = board.full;
        if (options.symmetry && options.rooks > 0) {
            // Every checkmate checks the center. All 2*n checking squares are
            // equivalent, so an existence search may fix one checking rook.
            int anchor = board.center + 1;
            selected |= bit(anchor); available &= ~bit(anchor);
            uncovered &= ~board.attacks[anchor];
            group = fixing(group, anchor);
        }
        if (options.workers > 1) return run_parallel(selected, available, uncovered, group);
        return dfs(selected, available, uncovered, group);
    }

    // Independent ray tracing: move the king, remove a captured rook, and inspect
    // the nearest occupied cell on every axis ray, including the original center.
    bool verify(Mask rooks) const {
        if (count(rooks) != options.rooks || (rooks & bit(board.center))) return false;
        for (int destination = 0; destination < board.cells; ++destination) {
            Mask remaining_rooks = rooks & ~bit(destination);
            bool attacked = false;
            for (int axis = 0, weight = 1; axis < board.dimensions; ++axis, weight *= 3) {
                for (int direction : {-1, 1}) {
                    int position = destination;
                    int value = board.coordinates[destination][axis];
                    while (value + direction >= 0 && value + direction < 3) {
                        value += direction; position += direction * weight;
                        if (remaining_rooks & bit(position)) { attacked = true; break; }
                    }
                }
            }
            if (!attacked) return false;
        }
        return true;
    }

    void write_json(std::ostream &out, const std::string &status) const {
        size_t cached_failures = failures.size();
        for (const auto &worker : parallel.workers) cached_failures += worker.cached_failures;
        out << "{\n  \"status\": \"" << status << "\",\n  \"dimensions\": " << board.dimensions
            << ",\n  \"method\": \"" << method << "\""
            << ",\n  \"side_length\": 3,\n  \"requested_rooks\": " << options.rooks
            << ",\n  \"elapsed_seconds\": " << elapsed()
            << ",\n  \"time_limit_seconds\": " << options.seconds
            << ",\n  \"node_limit\": " << options.node_limit << ",\n  \"king\": [";
        for (int a = 0; a < board.dimensions; ++a) out << (a ? ", " : "") << 0;
        out << "],\n  \"rooks\": [";
        bool separator = false;
        Mask todo = solution;
        while (todo) {
            int cell = pop(todo);
            out << (separator ? "," : "") << "\n    ["; separator = true;
            for (int a = 0; a < board.dimensions; ++a)
                out << (a ? ", " : "") << board.coordinates[cell][a] - 1;
            out << "]";
        }
        out << (solution ? "\n  " : "") << "],\n  \"verified_by_ray_tracing\": "
            << (solution && verify(solution) ? "true" : "false")
            << ",\n  \"abort_reason\": \"" << abort_reason << "\",\n  \"slice_coverage_profile\": [";
        for (size_t i = 0; i < profile.size(); ++i) out << (i ? ", " : "") << profile[i];
        out << "],\n  \"slice_profile_kind\": \""
            << (profile.empty() ? "disabled" : board.dimensions >= 5 ? "upper_bound_from_exact_3d_profile" : "exact")
            << "\",\n  \"optimizations\": {\"symmetry\": " << (options.symmetry ? "true" : "false")
            << ", \"slices\": " << (options.slices ? "true" : "false")
            << ", \"packing\": " << (options.packing ? "true" : "false")
            << ", \"top_bound\": " << (options.top_bound ? "true" : "false")
            << ", \"defense_order\": " << (options.defense_order ? "true" : "false")
            << ", \"construction\": " << (options.construction ? "true" : "false")
            << ", \"cache\": " << (options.cache && options.cache_limit ? "true" : "false") << "},\n"
            << "  \"stats\": {\n    \"nodes\": " << stats.nodes << ",\n    \"forced_placements\": " << stats.forced
            << ",\n    \"dead_cell_prunes\": " << stats.dead_cells << ",\n    \"capacity_prunes\": " << stats.capacity
            << ",\n    \"top_coverage_prunes\": " << stats.top_bound << ",\n    \"slice_prunes\": " << stats.slices
            << ",\n    \"packing_prunes\": " << stats.packing << ",\n    \"cache_hits\": " << stats.cache_hits
            << ",\n    \"cache_resets\": " << stats.cache_resets << ",\n    \"symmetric_choices_skipped\": " << stats.symmetry_skips
            << ",\n    \"cached_failures\": " << cached_failures << "\n  },\n"
            << "  \"parallel\": {\n    \"workers_requested\": " << options.workers
            << ",\n    \"workers_started\": " << parallel.workers_started
            << ",\n    \"split_depth\": " << options.split_depth
            << ",\n    \"partition_nodes\": " << parallel.partition_nodes
            << ",\n    \"tasks_generated\": " << parallel.tasks_generated
            << ",\n    \"tasks_started\": " << parallel.tasks_started
            << ",\n    \"tasks_completed\": " << parallel.tasks_completed
            << ",\n    \"peak_active_workers\": " << parallel.peak_active_workers
            << ",\n    \"wall_seconds\": " << parallel.wall_seconds
            << ",\n    \"process_cpu_seconds\": " << parallel.process_cpu_seconds << ",\n    \"workers\": [";
        for (size_t i = 0; i < parallel.workers.size(); ++i) {
            const auto &worker = parallel.workers[i];
            out << (i ? "," : "") << "\n      {\"thread_id\": \"" << worker.thread_id
                << "\", \"nodes\": " << worker.stats.nodes
                << ", \"tasks_started\": " << worker.tasks_started
                << ", \"tasks_completed\": " << worker.tasks_completed
                << ", \"cached_failures\": " << worker.cached_failures << "}";
        }
        out << "\n    ]\n  }\n}\n";
    }

private:
    ParallelControl *control = nullptr;
    std::vector<Task> *frontier = nullptr;
    size_t frontier_target = 0;

    Search(const Search &parent, ParallelControl &shared) : options(parent.options),
        board_storage(parent.board_storage), board(*board_storage), profile(parent.profile),
        started(parent.started), control(&shared) {
        options.workers = 1;
        options.progress_interval = 0;
        if (options.cache && options.cache_limit) failures.reserve(options.cache_limit);
    }

    bool run_parallel(Mask selected, Mask available, Mask uncovered, const std::vector<int> &group) {
        std::vector<Task> tasks;
        frontier = &tasks;
        frontier_target = std::max(size_t(64), size_t(options.workers) * 16);
        bool found_while_partitioning = dfs(selected, available, uncovered, group);
        frontier = nullptr;
        parallel.partition_nodes = stats.nodes;
        parallel.tasks_generated = tasks.size();
        if (found_while_partitioning || aborted || tasks.empty()) return found_while_partitioning;

        method = "parallel_exhaustive_backtracking";
        ParallelControl shared;
        shared.nodes.store(stats.nodes);
        int workers = std::min(options.workers, int(tasks.size()));
        shared.running.store(workers);
        std::vector<WorkerReport> reports(workers);
        std::vector<std::thread> threads;
        auto pool_started = Clock::now();
        auto cpu_started = std::clock();
        auto work = [&](int id) {
            try {
                Search worker(*this, shared);
                std::ostringstream name;
                name << std::this_thread::get_id();
                reports[id].thread_id = name.str();
                {
                    std::unique_lock<std::mutex> lock(shared.mutex);
                    shared.changed.wait(lock, [&] { return shared.start; });
                }
                while (!shared.stop.load()) {
                    size_t index = shared.next_task.fetch_add(1);
                    if (index >= tasks.size()) break;
                    ++reports[id].tasks_started;
                    shared.tasks_started.fetch_add(1);
                    int active = shared.active.fetch_add(1) + 1;
                    int peak = shared.peak_active.load();
                    while (peak < active && !shared.peak_active.compare_exchange_weak(peak, active)) {}
                    worker.aborted = false;
                    worker.abort_reason.clear();
                    worker.solution = 0;
                    const Task &task = tasks[index];
                    bool found;
                    try {
                        found = worker.dfs(task.selected, task.available, task.uncovered, task.group);
                    } catch (...) {
                        shared.active.fetch_sub(1);
                        throw;
                    }
                    shared.active.fetch_sub(1);
                    if (found || !worker.aborted) {
                        ++reports[id].tasks_completed;
                        shared.tasks_completed.fetch_add(1);
                    }
                    if (found) {
                        bool expected = false;
                        if (shared.found.compare_exchange_strong(expected, true)) {
                            std::lock_guard<std::mutex> lock(shared.mutex);
                            shared.winner = worker.solution;
                        }
                        shared.stop.store(true);
                        break;
                    }
                    if (worker.aborted) break;
                }
                reports[id].stats = worker.stats;
                reports[id].cached_failures = worker.failures.size();
            } catch (...) {
                std::lock_guard<std::mutex> lock(shared.mutex);
                if (!shared.error) shared.error = std::current_exception();
                shared.stop.store(true);
            }
            shared.running.fetch_sub(1);
            shared.changed.notify_all();
        };
        try {
            for (int id = 0; id < workers; ++id) threads.emplace_back(work, id);
        } catch (...) {
            shared.stop.store(true);
            {
                std::lock_guard<std::mutex> lock(shared.mutex);
                shared.start = true;
            }
            shared.changed.notify_all();
            for (auto &thread : threads) thread.join();
            throw;
        }
        parallel.workers_started = workers;
        {
            std::lock_guard<std::mutex> lock(shared.mutex);
            shared.start = true;
        }
        shared.changed.notify_all();
        while (shared.running.load()) {
            double seconds = elapsed();
            if (!shared.found.load()) {
                if (interrupted.load()) shared.abort(StopReason::interrupted);
                else if (options.seconds > 0 && seconds >= options.seconds) shared.abort(StopReason::time_limit);
            }
            if (options.progress_interval > 0 && seconds - last_progress >= options.progress_interval) {
                std::cerr << board.dimensions << "D/" << options.rooks << ": " << shared.nodes.load()
                    << " nodes, " << seconds << "s, " << shared.active.load() << "/" << workers
                    << " active workers, " << shared.tasks_completed.load() << "/" << tasks.size() << " tasks decided\n";
                last_progress = seconds;
            }
            std::unique_lock<std::mutex> lock(shared.mutex);
            shared.changed.wait_for(lock, std::chrono::milliseconds(50), [&] { return shared.running.load() == 0; });
        }
        for (auto &thread : threads) thread.join();
        if (shared.error) std::rethrow_exception(shared.error);
        parallel.wall_seconds = std::chrono::duration<double>(Clock::now() - pool_started).count();
        auto cpu_finished = std::clock();
        if (cpu_started != std::clock_t(-1) && cpu_finished != std::clock_t(-1))
            parallel.process_cpu_seconds = double(cpu_finished - cpu_started) / CLOCKS_PER_SEC;
        parallel.peak_active_workers = shared.peak_active.load();
        parallel.tasks_started = shared.tasks_started.load();
        parallel.tasks_completed = shared.tasks_completed.load();
        for (const auto &report : reports) stats.add(report.stats);
        parallel.workers = std::move(reports);
        if (shared.found.load()) {
            solution = shared.winner;
            aborted = false;
            abort_reason.clear();
            return true;
        }
        if (shared.reason.load() != StopReason::none) {
            aborted = true;
            abort_reason = reason_text(shared.reason.load());
        } else if (parallel.tasks_completed != tasks.size()) {
            throw std::logic_error("Parallel search ended with undecided tasks");
        }
        return false;
    }

    std::vector<int> fixing(const std::vector<int> &group, int cell) const {
        std::vector<int> result;
        for (int s : group) if (board.symmetries[s][cell] == cell) result.push_back(s);
        return result;
    }

    bool budget_exceeded() {
        double seconds = elapsed();
        if (control) {
            if (interrupted.load()) control->abort(StopReason::interrupted);
            else if (options.seconds > 0 && seconds >= options.seconds) control->abort(StopReason::time_limit);
            else if (options.node_limit && control->nodes.load() >= options.node_limit) control->abort(StopReason::node_limit);
            if (control->stop.load()) {
                aborted = true;
                abort_reason = reason_text(control->reason.load());
            }
            return aborted;
        }
        if (options.progress_interval > 0 && seconds - last_progress >= options.progress_interval) {
            std::cerr << board.dimensions << "D/" << options.rooks << ": " << stats.nodes
                << " nodes, " << seconds << "s, " << failures.size() << " cached failures\n";
            last_progress = seconds;
        }
        if (interrupted || (options.seconds > 0 && seconds >= options.seconds) ||
            (options.node_limit && stats.nodes >= options.node_limit)) {
            aborted = true;
            abort_reason = interrupted ? "interrupted" :
                options.node_limit && stats.nodes >= options.node_limit ? "node_limit" : "time_limit";
        }
        return aborted;
    }

    bool slice_bound(Mask available, Mask uncovered, int remaining) const {
        int available_total = count(available);
        for (int dimension = 0; dimension < board.dimensions; ++dimension) {
            const auto &axis = board.slices[dimension];
            Mask reachable = 1;
            for (Mask slice : axis) {
                int missing = count(uncovered & slice);
                int inside_count = count(available & slice);
                int outside_count = available_total - inside_count;
                int distinct_external_targets = 0;
                for (Mask missing_cells = uncovered & slice;
                     missing_cells && distinct_external_targets < remaining;) {
                    int cell = pop(missing_cells);
                    if (board.axis_attacks[dimension][cell] & available) ++distinct_external_targets;
                }
                Mask allowed = 0;
                for (int inside = std::max(0, remaining - outside_count);
                     inside <= std::min(remaining, inside_count); ++inside) {
                    int internal_capacity = profile[std::min(inside, int(profile.size()) - 1)];
                    int external_capacity = std::min(remaining - inside, distinct_external_targets);
                    if (internal_capacity + external_capacity >= missing) allowed |= bit(inside);
                }
                if (!allowed) return false;
                Mask next = 0;
                for (Mask values = reachable; values;) next |= allowed << pop(values);
                reachable = next & (bit(remaining + 1) - 1);
                if (!reachable) return false;
            }
            if (!(reachable & bit(remaining))) return false;
        }
        return true;
    }

    bool dfs(Mask selected, Mask available, Mask uncovered, std::vector<int> group, int depth = 0) {
        if (control) {
            if (control->stop.load()) { aborted = true; return false; }
            if (options.node_limit) {
                uint64_t nodes = control->nodes.load();
                while (nodes < options.node_limit && !control->nodes.compare_exchange_weak(nodes, nodes + 1)) {}
                if (nodes >= options.node_limit) {
                    control->abort(StopReason::node_limit);
                    aborted = true;
                    return false;
                }
            } else control->nodes.fetch_add(1);
        }
        ++stats.nodes;
        if (((stats.nodes & 255) == 1 || (options.node_limit &&
            (control ? control->nodes.load() : stats.nodes) >= options.node_limit)) && budget_exceeded()) return false;
        int remaining = options.rooks - count(selected);
        std::vector<std::pair<int, Mask>> constraints;
        int target = -1;
        Mask choices = 0;
        // Propagate mandatory rooks until no uncovered cell has a sole attacker.
        while (true) {
            if (remaining < 0 || count(available) < remaining || count(uncovered) > 2 * board.dimensions * remaining) {
                ++stats.capacity; return false;
            }
            if (count(available) == remaining) {
                for (Mask todo = available; todo;) uncovered &= ~board.attacks[pop(todo)];
                stats.forced += remaining;
                if (uncovered) { ++stats.dead_cells; return false; }
                solution = selected | available;
                return true;
            }
            if (!uncovered) {
                while (remaining--) selected |= bit(pop(available));
                solution = selected;
                return true;
            }
            Mask force = 0;
            int fewest = std::numeric_limits<int>::max();
            constraints.clear();
            for (Mask todo = uncovered; todo;) {
                int cell = pop(todo);
                Mask attackers = board.attacks[cell] & available;
                int size = count(attackers);
                if (!size) { ++stats.dead_cells; return false; }
                if (size == 1) { force = attackers; break; }
                constraints.emplace_back(size, attackers);
                bool defense_tie = options.defense_order && size == fewest &&
                    (selected & bit(cell)) && !(selected & bit(target));
                if (size < fewest || defense_tie) { fewest = size; target = cell; choices = attackers; }
            }
            if (!force) break;
            int rook = first(force);
            selected |= force; available &= ~force; uncovered &= ~board.attacks[rook]; --remaining;
            group = fixing(group, rook);
            ++stats.forced;
        }

        Key key{available, uncovered, remaining};
        // Frontier leaves are deferred tasks, never failed states. In particular,
        // no parent of a deferred task may enter the failure cache during planning.
        bool use_cache = options.cache && options.cache_limit && !frontier;
        if (use_cache && failures.find(key) != failures.end()) { ++stats.cache_hits; return false; }
        auto failed = [&]() {
            if (use_cache && !aborted) {
                if (failures.size() >= options.cache_limit) { failures.clear(); ++stats.cache_resets; }
                failures.insert(key);
            }
            return false;
        };

        std::array<int, MAX_CELLS> gain{};
        std::array<int, 2 * MAX_DIMENSIONS + 1> histogram{};
        for (Mask todo = available; todo;) {
            int rook = pop(todo);
            gain[rook] = count(board.attacks[rook] & uncovered);
            ++histogram[gain[rook]];
        }
        if (options.top_bound) {
            int capacity = 0, slots = remaining;
            for (int g = 2 * board.dimensions; g > 0 && slots; --g) {
                int take = std::min(slots, histogram[g]); slots -= take; capacity += take * g;
            }
            if (capacity < count(uncovered)) { ++stats.top_bound; return failed(); }
        }
        if (options.slices && board.dimensions > 1 && !slice_bound(available, uncovered, remaining)) {
            ++stats.slices; return failed();
        }
        if (options.packing && remaining < int(constraints.size())) {
            std::sort(constraints.begin(), constraints.end(), [](const auto &a, const auto &b) { return a.first < b.first; });
            // Any set of pairwise-disjoint attacker sets requires distinct rooks.
            for (int offset = 0; offset < std::min(3, int(constraints.size())); ++offset) {
                Mask used = 0;
                int needed = 0;
                for (int i = 0; i < int(constraints.size()); ++i) {
                    Mask attackers = constraints[(i + offset) % constraints.size()].second;
                    if (!(used & attackers)) {
                        used |= attackers;
                        if (++needed > remaining) { ++stats.packing; return failed(); }
                    }
                }
            }
        }

        if (frontier && (depth >= options.split_depth || frontier->size() >= frontier_target)) {
            frontier->push_back(Task{selected, available, uncovered, std::move(group)});
            return false;
        }

        // Only use symmetries preserving the selected rooks, all exclusions, AND
        // the chosen target. Branch once per orbit, then exclude that whole orbit.
        // Excluding just a representative would not partition the search safely.
        group = fixing(group, target);
        while (choices) {
            int rook = -1, best = -1;
            for (Mask todo = choices; todo;) {
                int candidate = pop(todo);
                int score = 16 * gain[candidate];
                if (options.defense_order) score += count(board.attacks[candidate] & selected & uncovered);
                if (score > best) { best = score; rook = candidate; }
            }
            Mask orbit = 0;
            for (int s : group) orbit |= bit(board.symmetries[s][rook]);
            stats.symmetry_skips += count(orbit) - 1;
            if (dfs(selected | bit(rook), available & ~bit(rook), uncovered & ~board.attacks[rook], fixing(group, rook), depth + 1))
                return true;
            if (aborted) return false;
            available &= ~orbit;
            choices &= ~orbit;
        }
        return failed();
    }
};

static Options parse(int argc, char **argv) {
    Options o;
    for (int i = 1; i < argc; ++i) {
        std::string flag = argv[i];
        auto value = [&]() {
            if (++i >= argc) throw std::runtime_error("Missing value after " + flag);
            return std::string(argv[i]);
        };
        auto unsigned_value = [&]() {
            std::string text = value();
            if (text.empty() || !std::all_of(text.begin(), text.end(), [](char c) { return c >= '0' && c <= '9'; }))
                throw std::runtime_error(flag + " requires a nonnegative integer.");
            return std::stoull(text);
        };
        if (flag == "--dimensions") o.dimensions = std::stoi(value());
        else if (flag == "--rooks") o.rooks = std::stoi(value());
        else if (flag == "--workers") {
            auto workers = unsigned_value();
            if (workers < 1 || workers > 256) throw std::runtime_error("Workers must be between 1 and 256.");
            o.workers = int(workers);
        }
        else if (flag == "--split-depth") {
            auto depth = unsigned_value();
            if (depth < 1 || depth > 6) throw std::runtime_error("Split depth must be between 1 and 6.");
            o.split_depth = int(depth);
        }
        else if (flag == "--time-limit") o.seconds = std::stod(value());
        else if (flag == "--progress-interval") o.progress_interval = std::stod(value());
        else if (flag == "--node-limit") o.node_limit = unsigned_value();
        else if (flag == "--cache-limit") o.cache_limit = unsigned_value();
        else if (flag == "--json") o.json_file = value();
        else if (flag == "--no-symmetry") o.symmetry = false;
        else if (flag == "--no-slices") o.slices = false;
        else if (flag == "--no-packing") o.packing = false;
        else if (flag == "--no-top-bound") o.top_bound = false;
        else if (flag == "--no-defense-order") o.defense_order = false;
        else if (flag == "--cache") o.cache = true;
        else if (flag == "--no-construction") o.construction = false;
        else if (flag == "--no-cache") o.cache = false;
        else if (flag == "--help") {
            std::cout << "Usage: rook-search [--dimensions 1..6] [--rooks N] [--time-limit SECONDS]\n"
                "  [--workers N] [--split-depth 1..6] (native C++ threads; default 1 worker)\n"
                "  [--progress-interval SECONDS] (0 silences progress)\n"
                "  [--node-limit N] (0 disables the node limit)\n"
                "  [--json FILE] [--cache-limit ENTRIES] [--no-symmetry] [--no-slices]\n"
                "  [--no-packing] [--no-top-bound] [--no-defense-order] [--cache] [--no-cache]\n"
                "  [--no-construction]  (force backtracking instead of the 5D construction)\n"
                "Defaults: 4D, 14 rooks, 30 seconds, cache off. Zero time limit: no deadline.\n"
                "Finds one checkmate or proves none exists; a deadline reports unknown.\n";
            std::exit(0);
        } else throw std::runtime_error("Unknown option: " + flag);
    }
    if (o.dimensions < 1 || o.dimensions > MAX_DIMENSIONS) throw std::runtime_error("Dimensions must be between 1 and 6.");
    int cells = 1; for (int i = 0; i < o.dimensions; ++i) cells *= 3;
    if (o.rooks < 0 || o.rooks >= cells) throw std::runtime_error("Rook count must be between 0 and cells-1.");
    if (!std::isfinite(o.seconds) || o.seconds < 0) throw std::runtime_error("Time limit must be finite and nonnegative.");
    if (!std::isfinite(o.progress_interval) || o.progress_interval < 0) throw std::runtime_error("Progress interval must be finite and nonnegative.");
    return o;
}

int main(int argc, char **argv) {
    try {
        auto options = parse(argc, argv);
        std::signal(SIGINT, on_interrupt);
        Search search(options);
        bool found = search.run();
        if (found && !search.verify(search.solution)) throw std::runtime_error("Internal error: independent validation failed.");
        std::string status = found ? "found" : search.aborted ? "unknown" : "infeasible";
        search.write_json(std::cout, status);
        if (!options.json_file.empty()) {
            std::ofstream output(options.json_file);
            if (!output) throw std::runtime_error("Cannot open output file: " + options.json_file);
            search.write_json(output, status);
            if (!output) throw std::runtime_error("Failed writing output file: " + options.json_file);
        }
        return found ? 0 : search.aborted ? 2 : 1;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n'; return 64;
    }
}
