# sokoban-solver

A push-optimal Sokoban solver, written from scratch for make.fun's
“Build the best Sokoban solver, 21 November 2026” bounty.

[![sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/kkazushi-eng/sokoban-solver-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/kkazushi-eng/sokoban-solver-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

Entered in [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121)
on [make.fun](https://make.fun) — join with my referral link:
https://make.fun/r/d8wpcpxt

## How it works

The generated levels are a hallway with one to four rooms off it, and a box
pushed out of a room can never come back, so the rooms are independent
problems whose push-optima add up to the level's optimum. The solver
exploits that directly:

1. **Decompose.** Find the hallway row (the one row of floor spanning the
   board), cut it out, and each remaining floor component is one room, with
   its own boxes and goals. Its door is the component cell touching the
   hallway; the player enters from the hallway square outside it.
2. **Solve each room push-optimally.** A* over push states: a state is the
   sorted box squares plus the player's reachable region (canonicalised to
   its lowest square). The heuristic is the minimum assignment of boxes to
   goals under the push-distance — the fewest pushes one box needs to reach
   a goal when the player can stand anywhere — which is admissible, so the
   first solution found uses the fewest pushes. Search is pruned with
   static dead squares (no goal reachable by pushing) and 2×2 deadlocks.
3. **Stitch.** The player walks the hallway between rooms (plain BFS around
   the boxes), and each room's pushes expand into player moves by walking to
   each push square first. The concatenated moves solve the whole level in
   exactly the sum of the rooms' optima.

The search is bounded by a fixed expansion budget per room (never the wall
clock), so two runs of the program produce byte-identical output. If the
optimal search ever exhausts its budget on a room, the solver retries that
room with a weighted heuristic rather than giving up.

## Layout

- `main.ts` — the whole entry: reads every level from `/input/<id>/level.txt`
  (or `$MAKEFUN_INPUT_DIR`), writes `/output/<id>/solution.txt` (or
  `$MAKEFUN_OUTPUT_DIR`). Node 22, no dependencies, no network.

## License

MIT — see [LICENSE](LICENSE).
