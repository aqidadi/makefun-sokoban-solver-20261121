# Push-Optimal Sokoban Solver

An offline Node.js 22 solver for make.fun's Sokoban bounty. It decomposes each board into independent rooms and runs push-level breadth-first search with reachable-region canonicalization and deadlock pruning.

## Run

```sh
node main.ts
```

The grader provides levels under `/input/<instance>/level.txt`; the solver writes `/output/<instance>/solution.txt`. For local testing, set `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` to equivalent directories.

## Validation

The official make.fun kit's process driver scored all five public practice instances at 1,000/1,000 each. Two runs matched byte for byte. This practice score does not guarantee a paid placement on the hidden final set.
