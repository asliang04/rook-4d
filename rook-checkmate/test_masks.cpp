// Structural checks only. This program NEVER calls Search::run or dfs.
#define main rook_search_cli_main
#include "search.cpp"
#undef main
#include <cassert>

int main() {
    for (int index : {0, 63, 64, 127, 128, 255, 256, 511, 512, 728, 729, 767}) {
        Mask mask = bit(index);
        assert(bool(mask) && count(mask) == 1 && first(mask) == index);
        assert(pop(mask) == index && !mask);
    }
    Mask sample;
    for (int index : {0, 63, 64, 255, 511, 728}) sample |= bit(index);
    for (int shift : {0, 1, 63, 64, 65, 127, 255, 256, 511, 512, 729, 768}) {
        Mask expected;
        for (int index : {0, 63, 64, 255, 511, 728})
            if (index + shift < MASK_WORDS * 64) expected |= bit(index + shift);
        assert((sample << shift) == expected);
    }
    assert(count(bit(729) - 1) == 729);
    std::unordered_set<Key, KeyHash> keys;
    keys.insert(Key{bit(1), bit(2), 1});
    keys.insert(Key{bit(1) | bit(728), bit(2), 1});
    assert(keys.size() == 2);

    Board board(6, true, true);
    assert(board.cells == 729 && board.center == 364);
    assert(count(board.full) == 729 && count(board.candidates) == 728);
    assert(board.symmetries.size() == 3840);
    for (int cell = 0; cell < board.cells; ++cell) {
        assert(count(board.attacks[cell]) == 12);
        for (Mask neighbors = board.attacks[cell]; neighbors;) {
            int neighbor = pop(neighbors);
            assert(bool(board.attacks[neighbor] & bit(cell)));
            int different = 0;
            for (int axis = 0; axis < 6; ++axis)
                different += board.coordinates[cell][axis] != board.coordinates[neighbor][axis];
            assert(different == 1);
        }
    }
    for (const auto &mapping : board.symmetries) {
        assert(mapping[board.center] == board.center && mapping[board.center + 1] == board.center + 1);
        for (int cell : {0, 364, 728}) {
            Mask transformed;
            for (Mask neighbors = board.attacks[cell]; neighbors;) transformed |= bit(mapping[pop(neighbors)]);
            assert(transformed == board.attacks[mapping[cell]]);
        }
    }
    auto profile = coverage_profile(5);
    assert(profile.front() == 0 && profile.back() == 243);
    for (int r = 0; r < int(profile.size()); ++r) {
        assert(profile[r] <= std::min(243, 10*r));
        if (r) assert(profile[r] >= profile[r - 1]);
    }
    std::cout << "Mask boundaries, 6D geometry, anchor symmetries, and recursive bounds passed; no position search run.\n";
}
