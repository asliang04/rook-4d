CXX = clang++
CXXFLAGS = -std=c++17 -O3 -Wall -Wextra -Werror -pthread

.PHONY: all test analyze benchmark
all: build/rook-search

build/rook-search: search.cpp
	mkdir -p build
	$(CXX) $(CXXFLAGS) $< -o $@.tmp
	mv $@.tmp $@

build/test-masks: test_masks.cpp search.cpp
	mkdir -p build
	$(CXX) $(CXXFLAGS) $< -o $@

test: build/rook-search build/test-masks
	./build/test-masks
	ROOK_SEARCH_BINARY="$(abspath build/rook-search)" python3 -m unittest -v test_search.py test_minimum.py

analyze:
	python3 analyze_3d.py

benchmark: build/rook-search
	python3 benchmark.py
