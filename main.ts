// sokoban-solver-20261121 — a push-optimal Sokoban solver, written from scratch for
// make.fun's "Build the best Sokoban solver, 21 November 2026" bounty.
//
// The generated levels are a hallway with one to four rooms off it, and a box pushed
// out of a room through its door can never be pushed back, so each room is an
// independent problem and the level's push-optimum is the sum of the rooms' optima.
// This solver decomposes the level into rooms, solves every room push-optimally with
// A* over push states (admissible minimum-assignment heuristic on push-distances,
// static dead squares, 2x2 deadlock pruning), and stitches the rooms together with
// the player's walks along the hallway.
//
// Deterministic by construction: no clock reads, no randomness, every budget is a
// count of search expansions, so two runs produce byte-identical output.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed direction order (up, down, left, right); every iteration order in this
// file follows it, so the search is deterministic.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];

/** A parsed level. */
interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall, per level cell
  goals: number[]; // sorted level cells
  boxes: number[]; // sorted level cells
  player: number; // level cell
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Shortest walk (BFS, fixed neighbour order) from `from` to `to` over the cells
 * where `free(cell)` holds, as a string of u/d/l/r moves; null when unreachable.
 * `free` must hold for both endpoints. Deterministic: the first shortest path
 * found in the fixed neighbour order.
 */
function walkPath(
  w: number,
  size: number,
  free: (cell: number) => boolean,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(size).fill(-2);
  const prevDir = new Int8Array(size).fill(-1);
  const queue = [from];
  prev[from] = -1;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || ny < 0) continue;
      const n = ny * w + nx;
      if (n >= size || prev[n] !== -2 || !free(n)) continue;
      prev[n] = c;
      prevDir[n] = d;
      if (n === to) {
        let moves = '';
        for (let t = n; t !== from; t = prev[t]) moves = CH[prevDir[t]] + moves;
        return moves;
      }
      queue.push(n);
    }
  }
  return null;
}

/** One room of a level: its floor cells, its boxes and goals, its door and hall square. */
interface Room {
  cells: number[]; // level cells of the room (interior + door), sorted
  boxes: number[]; // level cells, sorted
  goals: number[]; // level cells, sorted
  door: number; // level cell of the room's door
  hall: number; // level cell of the hallway square outside the door
}

/**
 * Split a level into rooms. The hallway is the one row whose cells are all floor
 * from x = 1 to x = w - 2; cutting it out leaves one floor component per room.
 * Returns null when the level does not decompose cleanly (a box or goal outside
 * the rooms, a component whose boxes and goals do not match, or no door).
 */
function decompose(lv: Level): Room[] | null {
  const { w, h, wall } = lv;
  const hallRows: number[] = [];
  for (let y = 0; y < h; y++) {
    let all = true;
    for (let x = 1; x <= w - 2; x++) if (wall[y * w + x]) { all = false; break; }
    if (all) hallRows.push(y);
  }
  // The player starts on the hallway row: that pins it down when a room row
  // happens to be floor all the way across too (a room's top row can be).
  const playerRow = (lv.player / w) | 0;
  const ranked = [
    ...hallRows.filter((y) => y === playerRow),
    ...hallRows.filter((y) => y !== playerRow),
  ];
  for (const hallY of ranked) {
    const rooms = tryDecompose(lv, hallY);
    if (rooms !== null) return rooms;
  }
  return null;
}

function tryDecompose(lv: Level, hallY: number): Room[] | null {
  const { w, h, wall, boxes, goals } = lv;
  const inHall = (c: number): boolean => ((c / w) | 0) === hallY;
  const goalSet = new Set(goals);
  for (const b of boxes) if (inHall(b)) return null;
  for (const g of goals) if (inHall(g)) return null;
  // Components of the floor with the hallway row cut out.
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  const boxAt = new Set(boxes);
  for (let start = 0; start < w * h; start++) {
    if (wall[start] || inHall(start) || seen[start]) continue;
    const comp: number[] = [start];
    seen[start] = 1;
    for (let i = 0; i < comp.length; i++) {
      const c = comp[i];
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (wall[n] || inHall(n) || seen[n]) continue;
        seen[n] = 1;
        comp.push(n);
      }
    }
    comp.sort((a, b) => a - b);
    const rBoxes = comp.filter((c) => boxAt.has(c));
    const rGoals = comp.filter((c) => goalSet.has(c));
    if (rBoxes.length === 0 && rGoals.length === 0) return null;
    if (rBoxes.length !== rGoals.length) return null;
    // The door: the component cell touching the hallway row.
    let door = -1;
    let hall = -1;
    for (const c of comp) {
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const n = (cy + DY[d]) * w + (cx + DX[d]);
        if (n >= 0 && n < w * h && inHall(n) && !wall[n]) {
          if (door === -1 || c < door) { door = c; hall = n; }
        }
      }
    }
    if (door === -1) return null;
    rooms.push({ cells: comp, boxes: rBoxes, goals: rGoals, door, hall });
  }
  // Every box must belong to exactly one room.
  const placed = rooms.reduce((a, r) => a + r.boxes.length, 0);
  if (placed !== boxes.length) return null;
  rooms.sort((a, b) => a.cells[0] - b.cells[0]);
  return rooms;
}

/** A push: which box (level cell it stood on) and which direction it was pushed. */
interface Push {
  box: number; // local cell the box stood on
  dir: number; // 0..3
}

/** Shared, deterministic expansion budget across a whole run (never the clock). */
interface Budget {
  used: number;
  cap: number;
}

/**
 * Solve one room push-optimally (A* over pushes) and return its pushes, or null.
 * `roomCells` are the room's level cells (interior + door); `hall` is the hallway
 * square outside the door, where the player starts and where a box may never go.
 * `weight` scales the heuristic (1 = optimal); `cap` bounds this call's expansions.
 */
function solveRoom(
  lv: Level,
  room: Room,
  weight: number,
  cap: number,
  budget: Budget,
): { pushes: Push[]; expansions: number } | null {
  const { w } = lv;
  const n = room.cells.length + 1; // room cells + the hall square
  const hallLocal = n - 1;
  // Local indexing: room cells first (sorted), then the hall square.
  const localOf = new Int32Array(w * lv.h).fill(-1);
  const levelOf = new Int32Array(n);
  room.cells.forEach((c, i) => { localOf[c] = i; levelOf[i] = c; });
  localOf[room.hall] = hallLocal;
  levelOf[hallLocal] = room.hall;
  const isBoxCell = new Uint8Array(n); // a box may stand here (room cells only)
  for (let i = 0; i < room.cells.length; i++) isBoxCell[i] = 1;
  const xs = new Int32Array(n);
  const ys = new Int32Array(n);
  for (let i = 0; i < n; i++) { xs[i] = levelOf[i] % w; ys[i] = (levelOf[i] / w) | 0; }
  const at = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= w || y >= lv.h) return -1;
    return localOf[y * w + x];
  };
  // Neighbours within the room's walkable cells (room cells + hall square).
  const adj: number[][][] = [];
  for (let i = 0; i < n; i++) {
    const list: number[][] = [];
    for (let d = 0; d < 4; d++) {
      const nb = at(xs[i] + DX[d], ys[i] + DY[d]);
      if (nb >= 0) list.push([nb, d]);
    }
    adj.push(list);
  }
  const goals = room.goals.map((g) => localOf[g]);
  const goalSet = new Set(goals);
  const startBoxes = room.boxes.map((b) => localOf[b]).sort((a, b) => a - b);
  const nb = goals.length;

  // Push-distance: pushDist[g][c] = the fewest pushes one box needs to travel
  // from cell c to goal g when the player can stand anywhere walkable (reverse
  // BFS over the push graph: a box moves y -> x when the player can stand at
  // 2y - x, the square behind it).
  const pushDist: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(n).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (const [y] of adj[x]) {
        // y is a neighbour of x; can a box at y be pushed onto x?
        if (!isBoxCell[y] || dist[y] >= 0) continue;
        const behind = at(2 * xs[y] - xs[x], 2 * ys[y] - ys[x]);
        if (behind < 0) continue;
        dist[y] = dist[x] + 1;
        queue.push(y);
      }
    }
    pushDist.push(dist);
  }
  // Static dead squares: a box here (off a goal) can never reach any goal.
  const dead = new Uint8Array(n);
  for (let c = 0; c < room.cells.length; c++) {
    if (goalSet.has(c)) continue;
    let ok = false;
    for (let gi = 0; gi < nb; gi++) if (pushDist[gi][c] >= 0) { ok = true; break; }
    if (!ok) dead[c] = 1;
  }
  // All permutations of the goal indices, for the minimum-assignment heuristic.
  const perms: number[][] = [];
  const buildPerm = (cur: number[], used: boolean[]): void => {
    if (cur.length === nb) { perms.push([...cur]); return; }
    for (let i = 0; i < nb; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      buildPerm(cur, used);
      cur.pop();
      used[i] = false;
    }
  };
  buildPerm([], new Array(nb).fill(false));
  // Minimum assignment of the boxes to distinct goals under push-distance.
  // Admissible: every push moves one box one square, so a box needs at least
  // its push-distance to reach its goal. Infinity when no assignment works.
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let sum = 0;
      let ok = true;
      for (let i = 0; i < nb; i++) {
        const d = pushDist[p[i]][boxes[i]];
        if (d < 0) { ok = false; break; }
        sum += d;
      }
      if (ok && sum < best) best = sum;
    }
    return best;
  };
  const solved = (boxes: number[]): boolean => {
    for (let i = 0; i < nb; i++) if (boxes[i] !== goals[i]) return false;
    return true;
  };
  // A 2x2 block of walls/boxes with no goal inside is a deadlock.
  const blocked = (x: number, y: number, occ: Uint8Array): boolean => {
    const c = at(x, y);
    if (c < 0) return true;
    return occ[c] === 1;
  };
  const is2x2Dead = (cell: number, occ: Uint8Array): boolean => {
    const x = xs[cell];
    const y = ys[cell];
    for (let ox = -1; ox <= 0; ox++) {
      for (let oy = -1; oy <= 0; oy++) {
        const bx = x + ox;
        const by = y + oy;
        if (!blocked(bx, by, occ) || !blocked(bx + 1, by, occ) ||
            !blocked(bx, by + 1, occ) || !blocked(bx + 1, by + 1, occ)) continue;
        let hasGoal = false;
        for (const [gx, gy] of [[bx, by], [bx + 1, by], [bx, by + 1], [bx + 1, by + 1]]) {
          const g = at(gx, gy);
          if (g >= 0 && goalSet.has(g)) { hasGoal = true; break; }
        }
        if (!hasGoal) return true;
      }
    }
    return false;
  };

  // State storage. A state is packed into one number: the canonical player
  // square (the lowest square of the player's reachable region) folded in with
  // the sorted box squares, so equal positions share one key.
  const pack = (boxes: number[], player: number): number => {
    let k = 0;
    for (let i = 0; i < nb; i++) k = k * n + boxes[i];
    return k * n + player;
  };
  const unpack = (k: number): { boxes: number[]; player: number } => {
    const boxes = new Array<number>(nb);
    let player = k % n;
    k = (k - player) / n;
    for (let i = nb - 1; i >= 0; i--) {
      boxes[i] = k % n;
      k = (k - boxes[i]) / n;
    }
    return { boxes, player };
  };
  // The player's reachable region from `from`, around the boxes in `occ`:
  // returns the region's lowest square (the canonical player square) and marks
  // the region in `region`.
  const regionLowest = (from: number, occ: Uint8Array, region: Uint8Array): number => {
    region.fill(0);
    const queue = [from];
    region[from] = 1;
    let low = from;
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi];
      if (c < low) low = c;
      for (const [nbCell] of adj[c]) {
        if (occ[nbCell] || region[nbCell]) continue;
        region[nbCell] = 1;
        queue.push(nbCell);
      }
    }
    return low;
  };

  const startH = heuristic(startBoxes);
  if (startH === Infinity) return null;
  if (solved(startBoxes)) return { pushes: [], expansions: 0 };
  const stKey: number[] = [];
  const stG: number[] = [];
  const stParent: number[] = [];
  const stPushBox: number[] = [];
  const stPushDir: number[] = [];
  const best = new Map<number, number>();
  const occ0 = new Uint8Array(n);
  for (const b of startBoxes) occ0[b] = 1;
  const reg0 = new Uint8Array(n);
  const startPlayer = regionLowest(hallLocal, occ0, reg0);
  const startKey = pack(startBoxes, startPlayer);
  stKey.push(startKey);
  stG.push(0);
  stParent.push(-1);
  stPushBox.push(-1);
  stPushDir.push(-1);
  best.set(startKey, 0);
  // Open list: [f, g, seq, state]; smallest f first, deeper g first on ties.
  const heap: number[][] = [];
  let seq = 0;
  const less = (a: number[], b: number[]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: number[]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const t = heap[i]; heap[i] = heap[p]; heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number[] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        const t = heap[i]; heap[i] = heap[c]; heap[c] = t;
        i = c;
      }
    }
    return top;
  };
  heapPush([startH * weight, 0, seq++, 0]);

  const region = new Uint8Array(n);
  const region2 = new Uint8Array(n);
  const occ = new Uint8Array(n);
  let expansions = 0;
  while (heap.length > 0) {
    if (expansions >= cap || budget.used >= budget.cap) return null;
    const [, g, , s] = heapPop();
    if (best.get(stKey[s]) !== s) continue;
    const { boxes, player } = unpack(stKey[s]);
    expansions++;
    budget.used++;
    occ.fill(0);
    for (const b of boxes) occ[b] = 1;
    regionLowest(player, occ, region);
    for (let bi = 0; bi < nb; bi++) {
      const b = boxes[bi];
      for (let d = 0; d < 4; d++) {
        const t = at(xs[b] + DX[d], ys[b] + DY[d]);
        if (t < 0 || !isBoxCell[t] || occ[t]) continue;
        const behind = at(xs[b] - DX[d], ys[b] - DY[d]);
        if (behind < 0 || !region[behind]) continue;
        if (dead[t]) continue;
        const nBoxes = boxes.slice();
        nBoxes[bi] = t;
        nBoxes.sort((a, b2) => a - b2);
        occ[t] = 1;
        occ[b] = 0;
        if (is2x2Dead(t, occ)) { occ[t] = 0; occ[b] = 1; continue; }
        const h = heuristic(nBoxes);
        if (h === Infinity) { occ[t] = 0; occ[b] = 1; continue; }
        const nPlayer = regionLowest(b, occ, region2);
        const key = pack(nBoxes, nPlayer);
        occ[t] = 0;
        occ[b] = 1;
        const ng = g + 1;
        const prevIdx = best.get(key);
        if (prevIdx !== undefined && stG[prevIdx] <= ng) continue;
        const idx = stKey.length;
        stKey.push(key);
        stG.push(ng);
        stParent.push(s);
        stPushBox.push(b);
        stPushDir.push(d);
        best.set(key, idx);
        if (solved(nBoxes)) {
          const pushes: Push[] = [];
          for (let cur = idx; cur > 0; cur = stParent[cur]) {
            pushes.push({ box: stPushBox[cur], dir: stPushDir[cur] });
          }
          pushes.reverse();
          return { pushes, expansions };
        }
        heapPush([ng + weight * h, ng, seq++, idx]);
      }
    }
  }
  return null;
}

/**
 * Expand one room's pushes into player moves. The player starts on `hall`
 * (the hallway square outside the door) and ends wherever the last push leaves
 * them; `boxes` (level cells, sorted) is updated in place to the solved state.
 * Returns the moves, or null when a walk fails (should not happen).
 */
function roomMoves(
  lv: Level,
  room: Room,
  pushes: Push[],
  boxes: number[],
  player: number,
): { moves: string; player: number } | null {
  const { w, h, wall } = lv;
  const n = room.cells.length + 1;
  const hallLocal = n - 1;
  const localOf = new Int32Array(w * h).fill(-1);
  const levelOf = new Int32Array(n);
  room.cells.forEach((c, i) => { localOf[c] = i; levelOf[i] = c; });
  localOf[room.hall] = hallLocal;
  levelOf[hallLocal] = room.hall;
  const xs = new Int32Array(n);
  const ys = new Int32Array(n);
  for (let i = 0; i < n; i++) { xs[i] = levelOf[i] % w; ys[i] = (levelOf[i] / w) | 0; }
  const at = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= w || y >= h) return -1;
    return localOf[y * w + x];
  };
  let cur = localOf[player];
  // Only this room's boxes live in the local frame; other rooms' boxes are
  // untouched and stay where they are in the global array.
  let curBoxes = boxes
    .filter((b) => localOf[b] >= 0)
    .map((b) => localOf[b])
    .sort((a, b) => a - b);
  let moves = '';
  for (const push of pushes) {
    const box = push.box;
    const d = push.dir;
    const from = at(xs[box] - DX[d], ys[box] - DY[d]);
    if (from < 0) return null;
    const occ = new Set(curBoxes);
    const walk = walkPath(w, w * h, (c) => {
      const lc = localOf[c];
      return lc >= 0 && !occ.has(lc);
    }, levelOf[cur], levelOf[from]);
    if (walk === null) return null;
    moves += walk;
    moves += CH[d];
    // Apply the push: the box moves one square in direction d, the player
    // steps onto the box's old square.
    const target = at(xs[box] + DX[d], ys[box] + DY[d]);
    if (target < 0) return null;
    curBoxes = curBoxes.map((b) => (b === box ? target : b)).sort((a, b) => a - b);
    cur = box;
  }
  // Write this room's solved box positions back (level cells, sorted),
  // leaving every other room's boxes where they were.
  const solvedHere = new Set(curBoxes.map((b) => levelOf[b]));
  const kept = boxes.filter((b) => localOf[b] < 0);
  boxes.length = 0;
  for (const b of kept) boxes.push(b);
  for (const b of solvedHere) boxes.push(b);
  boxes.sort((a, b) => a - b);
  return { moves, player: levelOf[cur] };
}

/** Solve one level; the moves string, or '' when the level cannot be solved. */
function solveLevel(text: string): string {
  const lv = parseLevel(text);
  const rooms = decompose(lv);
  if (rooms === null) {
    console.error('sokoban-solver: level does not decompose into rooms');
    return '';
  }
  const budget: Budget = { used: 0, cap: 6_000_000 };
  const boxes = [...lv.boxes];
  let player = lv.player;
  let moves = '';
  const boxSet = (): Set<number> => new Set(boxes);
  for (const room of rooms) {
    if (room.boxes.length === 0) continue;
    // Walk the player to this room's hall square (hallway is never blocked:
    // boxes stay in their rooms).
    const occ = boxSet();
    const walk = walkPath(lv.w, lv.w * lv.h, (c) => !lv.wall[c] && !occ.has(c), player, room.hall);
    if (walk === null) {
      console.error('sokoban-solver: cannot walk to a room door');
      return '';
    }
    moves += walk;
    player = room.hall;
    // Solve the room: optimal A* first, then weighted retries if the budget runs out.
    let solvedRoom: { pushes: Push[]; expansions: number } | null = null;
    for (const [weight, cap] of [[1, 500_000], [2, 500_000], [8, 500_000]] as const) {
      solvedRoom = solveRoom(lv, room, weight, cap, budget);
      if (solvedRoom !== null) break;
    }
    if (solvedRoom === null) {
      console.error('sokoban-solver: room unsolved, giving up on this level');
      return '';
    }
    const expanded = roomMoves(lv, room, solvedRoom.pushes, boxes, player);
    if (expanded === null) {
      console.error('sokoban-solver: room moves failed to expand');
      return '';
    }
    moves += expanded.moves;
    player = expanded.player;
  }
  // Safety net: the replay must end with every box on a goal.
  const goalSet = new Set(lv.goals);
  if (!boxes.every((b) => goalSet.has(b))) {
    console.error('sokoban-solver: internal error, boxes off goals at the end');
    return '';
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const text = readFileSync(join(I, id, 'level.txt'), 'utf8');
  const moves = solveLevel(text);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
