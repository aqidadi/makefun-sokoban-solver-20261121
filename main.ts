import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DIRECTIONS = [-1, 1, 0, 0] as const; // left, right, up, down are indexed below
const LETTERS = ['l', 'r', 'u', 'd'] as const;

interface Board {
  width: number;
  height: number;
  walls: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}
interface Room { boxes: number[]; goals: number[]; }
interface SearchNode { boxes: number[]; player: number; parent: number; fromBox: number; dir: number; }

function parse(text: string): Board {
  const rows = text.split(/\r?\n/).filter((row) => row.length > 0);
  const width = Math.max(...rows.map((row) => row.length));
  const height = rows.length;
  const walls = new Uint8Array(width * height).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < height; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const cell = y * width + x;
      const ch = row[x]!;
      if (ch === '#') continue;
      walls[cell] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(cell);
      if (ch === '$' || ch === '*') boxes.push(cell);
      if (ch === '@' || ch === '+') player = cell;
    }
  }
  // Close the outside edge so every neighbor lookup is safe and deterministic.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!x || !y || x === width - 1 || y === height - 1) walls[y * width + x] = 1;
  }
  boxes.sort((a, b) => a - b);
  if (player < 0 || boxes.length !== goals.length) throw new Error('Malformed Sokoban level');
  return { width, height, walls, goals, boxes, player };
}

function liveCells(board: Board): Uint8Array {
  const { width, walls } = board;
  const live = new Uint8Array(walls.length);
  const queue = board.goals.slice();
  for (const goal of queue) live[goal] = 1;
  for (let head = 0; head < queue.length; head++) {
    const target = queue[head]!;
    for (let d = 0; d < 4; d++) {
      const delta = d === 0 ? -1 : d === 1 ? 1 : d === 2 ? -width : width;
      const prior = target - delta;
      const stand = prior - delta;
      if (!walls[prior] && !walls[stand] && !live[prior]) {
        live[prior] = 1;
        queue.push(prior);
      }
    }
  }
  return live;
}

function splitRooms(board: Board, live: Uint8Array): Room[] {
  const { width, height, walls } = board;
  const hallway = Math.floor(board.player / width);
  const cut = new Uint8Array(walls.length);
  for (let x = 0; x < width; x++) {
    const cell = hallway * width + x;
    if (!walls[cell] && !live[cell]) cut[cell] = 1;
  }
  if (board.boxes.some((cell) => cut[cell])) throw new Error('A box starts in the hallway');

  const component = new Int32Array(walls.length).fill(-1);
  const regions: number[][] = [];
  for (let start = 0; start < walls.length; start++) {
    if (walls[start] || cut[start] || component[start] >= 0) continue;
    const id = regions.length;
    const cells = [start];
    component[start] = id;
    for (let head = 0; head < cells.length; head++) {
      const cell = cells[head]!;
      for (let d = 0; d < 4; d++) {
        const next = cell + (d === 0 ? -1 : d === 1 ? 1 : d === 2 ? -width : width);
        if (!walls[next] && !cut[next] && component[next] < 0) {
          component[next] = id;
          cells.push(next);
        }
      }
    }
    regions.push(cells);
  }

  const rooms = regions.map(() => ({ boxes: [] as number[], goals: [] as number[] }));
  for (const cell of board.boxes) rooms[component[cell]]!.boxes.push(cell);
  for (const cell of board.goals) {
    const id = component[cell]!;
    if (id < 0) throw new Error('A goal falls outside every room');
    rooms[id]!.goals.push(cell);
  }
  const active = rooms.filter((room) => room.boxes.length > 0);
  if (active.some((room) => room.boxes.length !== room.goals.length)) throw new Error('Room has unequal box and goal counts');
  return active;
}

function region(board: Board, occupied: Uint8Array, start: number, marks: Int32Array, stamp: number, stack: Int32Array): number {
  const { width, walls } = board;
  let low = start;
  let size = 0;
  stack[size++] = start;
  marks[start] = stamp;
  while (size) {
    const cell = stack[--size]!;
    if (cell < low) low = cell;
    for (let d = 0; d < 4; d++) {
      const next = cell + (d === 0 ? -1 : d === 1 ? 1 : d === 2 ? -width : width);
      if (!walls[next] && !occupied[next] && marks[next] !== stamp) {
        marks[next] = stamp;
        stack[size++] = next;
      }
    }
  }
  return low;
}

function stuckSquare(board: Board, occupied: Uint8Array, goals: Uint8Array, live: Uint8Array, cell: number): boolean {
  if (!live[cell]) return true;
  const { width, walls } = board;
  for (const top of [cell, cell - 1, cell - width, cell - width - 1]) {
    const a = top, b = top + 1, c = top + width, d = c + 1;
    if ((walls[a] || occupied[a]) && (walls[b] || occupied[b]) && (walls[c] || occupied[c]) && (walls[d] || occupied[d])) {
      if ((occupied[a] && !goals[a]) || (occupied[b] && !goals[b]) || (occupied[c] && !goals[c]) || (occupied[d] && !goals[d])) return true;
    }
  }
  return false;
}

function pathTo(board: Board, occupied: Uint8Array, from: number, to: number, parent: Int32Array, steps: Int8Array, queue: Int32Array): string {
  if (from === to) return '';
  parent.fill(-1);
  let tail = 0;
  let end = 0;
  queue[end++] = from;
  parent[from] = from;
  while (tail < end && parent[to] < 0) {
    const cell = queue[tail++]!;
    for (let d = 0; d < 4; d++) {
      const next = cell + (d === 0 ? -1 : d === 1 ? 1 : d === 2 ? -board.width : board.width);
      if (!board.walls[next] && !occupied[next] && parent[next] < 0) {
        parent[next] = cell;
        steps[next] = d;
        queue[end++] = next;
      }
    }
  }
  if (parent[to] < 0) throw new Error('Push square is unreachable');
  const chars: string[] = [];
  for (let cell = to; cell !== from; cell = parent[cell]!) chars.push(LETTERS[steps[cell]!]!);
  return chars.reverse().join('');
}

function solveRoom(board: Board, boxes: number[], goalsList: number[], fixedBoxes: number[]): { moves: string; boxes: number[] } {
  const { width, walls } = board;
  const size = walls.length;
  const occupied = new Uint8Array(size);
  for (const cell of fixedBoxes) occupied[cell] = 1;
  const goals = new Uint8Array(size);
  for (const cell of goalsList) goals[cell] = 1;
  const live = liveCells({ ...board, goals: goalsList });
  if (boxes.some((cell) => !live[cell])) throw new Error('Unsolvable box on a dead square');

  const nowMarks = new Int32Array(size);
  const nextMarks = new Int32Array(size);
  const floodStack = new Int32Array(size);
  let stamp = 0;
  const initial = boxes.slice().sort((a, b) => a - b);
  for (const cell of initial) occupied[cell] = 1;
  const firstLow = region(board, occupied, board.player, nowMarks, ++stamp, floodStack);
  for (const cell of initial) occupied[cell] = 0;
  const keyOf = (bs: number[], low: number) => `${low}:${bs.join(',')}`;
  const nodes: SearchNode[] = [{ boxes: initial, player: board.player, parent: -1, fromBox: -1, dir: -1 }];
  const known = new Set<string>([keyOf(initial, firstLow)]);
  const goalCount = goalsList.length;
  let found = initial.every((cell) => goals[cell]) ? 0 : -1;

  for (let head = 0; head < nodes.length && found < 0; head++) {
    const node = nodes[head]!;
    for (const cell of node.boxes) occupied[cell] = 1;
    region(board, occupied, node.player, nowMarks, ++stamp, floodStack);
    const reachableStamp = stamp;
    for (const box of node.boxes) {
      for (let d = 0; d < 4; d++) {
        const delta = d === 0 ? -1 : d === 1 ? 1 : d === 2 ? -width : width;
        const stand = box - delta;
        const target = box + delta;
        if (nowMarks[stand] !== reachableStamp || walls[target] || occupied[target] || !live[target]) continue;

        occupied[box] = 0;
        occupied[target] = 1;
        if (stuckSquare(board, occupied, goals, live, target)) {
          occupied[target] = 0;
          occupied[box] = 1;
          continue;
        }
        const nextBoxes = node.boxes.slice();
        nextBoxes[nextBoxes.indexOf(box)] = target;
        nextBoxes.sort((a, b) => a - b);
        const low = region(board, occupied, box, nextMarks, ++stamp, floodStack);
        const stateKey = keyOf(nextBoxes, low);
        occupied[target] = 0;
        occupied[box] = 1;
        if (known.has(stateKey)) continue;
        known.add(stateKey);
        const childIndex = nodes.length;
        nodes.push({ boxes: nextBoxes, player: box, parent: head, fromBox: box, dir: d });
        if (nextBoxes.reduce((n, cell) => n + (goals[cell] ? 1 : 0), 0) === goalCount) {
          found = childIndex;
          break;
        }
      }
      if (found >= 0) break;
    }
    for (const cell of node.boxes) occupied[cell] = 0;
  }
  if (found < 0) throw new Error('Push-state search exhausted without a solution');

  const chain: number[] = [];
  for (let node = found; node > 0; node = nodes[node]!.parent) chain.push(node);
  chain.reverse();
  let player = board.player;
  let current = initial;
  let moves = '';
  for (const childIndex of chain) {
    const child = nodes[childIndex]!;
    for (const cell of fixedBoxes) occupied[cell] = 1;
    for (const cell of current) occupied[cell] = 1;
    const delta = child.fromBox - (child.dir === 0 ? -1 : child.dir === 1 ? 1 : child.dir === 2 ? -width : width);
    moves += pathTo(board, occupied, player, delta, new Int32Array(size), new Int8Array(size), new Int32Array(size));
    for (const cell of current) occupied[cell] = 0;
    for (const cell of fixedBoxes) occupied[cell] = 0;
    moves += LETTERS[child.dir]!.toUpperCase();
    player = child.fromBox;
    current = child.boxes;
  }
  return { moves, boxes: current };
}

function solve(text: string): string {
  const board = parse(text);
  const rooms = splitRooms(board, liveCells(board));
  if (rooms.length === 0) return '';
  let player = board.player;
  let currentBoxes = board.boxes.slice();
  let result = '';
  for (const room of rooms) {
    const roomStarts = new Set(room.boxes);
    const targetBoxes = currentBoxes.filter((cell) => roomStarts.has(cell));
    const fixed = currentBoxes.filter((cell) => !roomStarts.has(cell));
    const solved = solveRoom({ ...board, player }, targetBoxes, room.goals, fixed);
    result += solved.moves;
    const old = new Set(targetBoxes);
    currentBoxes = [...currentBoxes.filter((cell) => !old.has(cell)), ...solved.boxes].sort((a, b) => a - b);
    for (const ch of solved.moves) player += ch.toLowerCase() === 'u' ? -board.width : ch.toLowerCase() === 'd' ? board.width : ch.toLowerCase() === 'l' ? -1 : 1;
  }
  return result;
}

for (const id of readdirSync(INPUT).sort()) {
  const moves = solve(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`, 'utf8');
}
