import { StoneColor, BoardState, Coordinate } from '../types';
import {
  createBoardForMove,
  getDeadStoneVertices,
  getInfluenceSummary,
  getMoveName,
  getPatternMatches,
  ShapePattern,
  toSign,
} from './sabakiAdapters';

export const BOARD_SIZE = 19;

export const createEmptyGrid = (size: number = BOARD_SIZE): StoneColor[][] => {
  return Array.from({ length: size }, () => Array(size).fill(StoneColor.EMPTY));
};

export const getNeighbors = (x: number, y: number, size: number = BOARD_SIZE): Coordinate[] => {
  const neighbors: Coordinate[] = [];
  if (x > 0) neighbors.push({ x: x - 1, y });
  if (x < size - 1) neighbors.push({ x: x + 1, y });
  if (y > 0) neighbors.push({ x, y: y - 1 });
  if (y < size - 1) neighbors.push({ x, y: y + 1 });
  return neighbors;
};

// Returns true if the group has liberties.
// Also returns the group of stones.
export const checkLiberties = (
  grid: StoneColor[][],
  x: number,
  y: number,
  color: StoneColor
): { hasLiberties: boolean; group: Coordinate[] } => {
  const visited = new Set<string>();
  const stack: Coordinate[] = [{ x, y }];
  const group: Coordinate[] = [];
  let hasLiberties = false;

  while (stack.length > 0) {
    const current = stack.pop()!;
    const key = `${current.x},${current.y}`;

    if (visited.has(key)) continue;
    visited.add(key);
    group.push(current);

    const neighbors = getNeighbors(current.x, current.y);
    for (const n of neighbors) {
      const stone = grid[n.y][n.x];
      if (stone === StoneColor.EMPTY) {
        hasLiberties = true;
      } else if (stone === color && !visited.has(`${n.x},${n.y}`)) {
        stack.push(n);
      }
    }
  }

  return { hasLiberties, group };
};

export const playMove = (
  currentState: BoardState,
  x: number,
  y: number,
  color: StoneColor
): { newState: BoardState; valid: boolean; message?: string } => {
  if (currentState.grid[y][x] !== StoneColor.EMPTY) {
    return { newState: currentState, valid: false, message: 'Point is occupied' };
  }

  // Check Ko
  if (currentState.koPoint && currentState.koPoint.x === x && currentState.koPoint.y === y) {
    return { newState: currentState, valid: false, message: 'Ko rule violation' };
  }

  const sabakiBoard = createBoardForMove(currentState.grid);
  if (sabakiBoard?.makeMove) {
    try {
      const sign = toSign(color);
      if (sabakiBoard.setCaptures) {
        sabakiBoard.setCaptures(1, currentState.captures.B);
        sabakiBoard.setCaptures(-1, currentState.captures.W);
      }
      const nextBoard = sabakiBoard.makeMove(sign, [x, y], {
        preventOverwrite: true,
        preventSuicide: true,
      });
      if (nextBoard?.signMap) {
        const newGrid = nextBoard.signMap.map((row: number[]) =>
          row.map((value: number) =>
            value === 1 ? StoneColor.BLACK : value === -1 ? StoneColor.WHITE : StoneColor.EMPTY
          )
        );
        const capturedStones: Coordinate[] = [];
        for (let row = 0; row < currentState.grid.length; row++) {
          for (let col = 0; col < currentState.grid[row].length; col++) {
            if (
              currentState.grid[row][col] !== StoneColor.EMPTY &&
              newGrid[row][col] === StoneColor.EMPTY
            ) {
              capturedStones.push({ x: col, y: row });
            }
          }
        }

        let newKoPoint: Coordinate | null = null;
        if (capturedStones.length === 1) {
          newKoPoint = capturedStones[0];
        }

        const newCaptures = {
          B: typeof nextBoard.getCaptures === 'function' ? nextBoard.getCaptures(1) : currentState.captures.B,
          W: typeof nextBoard.getCaptures === 'function' ? nextBoard.getCaptures(-1) : currentState.captures.W,
        };

        return {
          newState: {
            grid: newGrid,
            captures: newCaptures,
            lastMove: { x, y },
            koPoint: newKoPoint,
          },
          valid: true,
        };
      }
    } catch (error: any) {
      return { newState: currentState, valid: false, message: error?.message ?? 'Invalid move' };
    }
  }

  // Clone grid
  const newGrid = currentState.grid.map((row) => [...row]);
  newGrid[y][x] = color;

  const opponent = color === StoneColor.BLACK ? StoneColor.WHITE : StoneColor.BLACK;
  let capturedStones: Coordinate[] = [];

  // Check neighbors for captures
  const neighbors = getNeighbors(x, y);
  for (const n of neighbors) {
    if (newGrid[n.y][n.x] === opponent) {
      const result = checkLiberties(newGrid, n.x, n.y, opponent);
      if (!result.hasLiberties) {
        capturedStones = [...capturedStones, ...result.group];
      }
    }
  }

  // Remove captured stones
  capturedStones.forEach((s) => {
    newGrid[s.y][s.x] = StoneColor.EMPTY;
  });

  // Check suicide
  if (capturedStones.length === 0) {
    const selfResult = checkLiberties(newGrid, x, y, color);
    if (!selfResult.hasLiberties) {
      return { newState: currentState, valid: false, message: 'Suicide move not allowed' };
    }
  }

  // Update captures
  const newCaptures = { ...currentState.captures };
  if (color === StoneColor.BLACK) {
    newCaptures.B += capturedStones.length;
  } else {
    newCaptures.W += capturedStones.length;
  }

  // Set Ko point
  let newKoPoint: Coordinate | null = null;
  if (capturedStones.length === 1) {
    const s = capturedStones[0];
    const selfResult = checkLiberties(newGrid, x, y, color);
    if (selfResult.group.length === 1 && selfResult.hasLiberties) {
       newKoPoint = { x: s.x, y: s.y };
    }
  }

  return {
    newState: {
      grid: newGrid,
      captures: newCaptures,
      lastMove: { x, y },
      koPoint: newKoPoint,
    },
    valid: true,
  };
};

export const boardToAscii = (grid: StoneColor[][]): string => {
  const size = grid.length;
  let ascii = '   ';
  const coords = 'ABCDEFGHJKLMNOPQRST'.slice(0, size);
  for (let i = 0; i < size; i++) ascii += `${coords[i]} `;
  ascii += '\n';
  
  for (let y = 0; y < size; y++) {
    const rowNum = size - y;
    ascii += `${rowNum < 10 ? ' ' : ''}${rowNum} `;
    for (let x = 0; x < size; x++) {
       const s = grid[y][x];
       if (s === StoneColor.BLACK) ascii += 'X ';
       else if (s === StoneColor.WHITE) ascii += 'O ';
       else ascii += '. ';
    }
    ascii += `${rowNum}\n`;
  }
  ascii += '   ';
  for (let i = 0; i < size; i++) ascii += `${coords[i]} `;
  return ascii;
};

export const toGtpCoordinate = (x: number, y: number): string => {
  const letters = 'ABCDEFGHJKLMNOPQRST'; // I is skipped in Go
  if (x < 0 || x >= 19 || y < 0 || y >= 19) return 'pass';
  const col = letters[x];
  const row = 19 - y;
  return `${col}${row}`;
};

// --- ADVANCED ANALYSIS IMPLEMENTATIONS (Ported from Sabaki ideas) ---

// 1. INFLUENCE (Territory Estimation)
// Uses simple exponential decay: Influence = Sum(Color * e^(-distance/decay))
const calculateInfluenceHeuristic = (grid: StoneColor[][]): { blackArea: number, whiteArea: number } => {
    const size = grid.length;
    const DECAY = 2.0; 

    const stones: {x: number, y: number, color: number}[] = [];
    for(let y=0; y<size; y++) {
        for(let x=0; x<size; x++) {
            if (grid[y][x] === StoneColor.BLACK) stones.push({x, y, color: 1});
            if (grid[y][x] === StoneColor.WHITE) stones.push({x, y, color: -1});
        }
    }

    let blackArea = 0;
    let whiteArea = 0;

    for(let y=0; y<size; y++) {
        for(let x=0; x<size; x++) {
            let val = 0;
            for(const s of stones) {
                const dist = Math.sqrt(Math.pow(x - s.x, 2) + Math.pow(y - s.y, 2));
                val += s.color * Math.exp(-dist / DECAY);
            }
            if (val > 0.5) blackArea++;
            if (val < -0.5) whiteArea++;
        }
    }

    return { blackArea, whiteArea };
};

// 2. BOARDMATCHER (Pattern/Shape Matching)
const PATTERNS: ShapePattern[] = [
    {
        name: "Empty Triangle",
        size: 2,
        grid: [[1, 1], [1, 0]],
        type: 'BAD'
    },
    {
        name: "Ponnuki",
        size: 3,
        grid: [[0, 1, 0], [1, 0, 1], [0, 1, 0]],
        type: 'GOOD'
    },
    {
        name: "Hane at Head of Two",
        size: 3,
        grid: [[0, 1, 0], [1, -1, 0], [1, -1, 0]], // Simplistic representation
        type: 'GOOD'
    }
];

const rotateGrid = (g: number[][]) => {
    const N = g.length;
    const res = Array.from({length:N}, () => Array(N).fill(0));
    for(let r=0; r<N; r++){
        for(let c=0; c<N; c++){
            res[c][N-1-r] = g[r][c];
        }
    }
    return res;
};

const findShapesHeuristic = (grid: StoneColor[][]): string[] => {
    const size = grid.length;
    const found: Set<string> = new Set();
    const numGrid = grid.map(row => row.map(c => c === StoneColor.BLACK ? 1 : c === StoneColor.WHITE ? -1 : 0));

    for(const pat of PATTERNS) {
        const colors = [1, -1]; 
        for(const colorSign of colors) {
            let pGrid = pat.grid.map(row => row.map(x => x === 1 ? colorSign : x === -1 ? -colorSign : x));
            
            for(let r=0; r<4; r++) {
                pGrid = rotateGrid(pGrid);
                for(let y=0; y<=size-pat.size; y++) {
                    for(let x=0; x<=size-pat.size; x++) {
                        let match = true;
                        for(let py=0; py<pat.size; py++) {
                            for(let px=0; px<pat.size; px++) {
                                const boardVal = numGrid[y+py][x+px];
                                const patVal = pGrid[py][px];
                                if (patVal !== 2 && boardVal !== patVal) {
                                    match = false;
                                    break;
                                }
                            }
                            if(!match) break;
                        }
                        if(match) {
                           const cName = colorSign === 1 ? "Black" : "White";
                           found.add(`${pat.type}: ${cName} ${pat.name} at ${toGtpCoordinate(x, y)}`);
                        }
                    }
                }
            }
        }
    }
    return Array.from(found);
};

// 3. DEADSTONES (Heuristic: Weak Groups)
const analyzeSafetyHeuristic = (grid: StoneColor[][]): string[] => {
   const size = grid.length;
   const visited = new Set<string>();
   const report: string[] = [];

   for(let y=0; y<size; y++) {
       for(let x=0; x<size; x++) {
           const color = grid[y][x];
           if(color === StoneColor.EMPTY) continue;
           if(visited.has(`${x},${y}`)) continue;

           const { group } = checkLiberties(grid, x, y, color);
           group.forEach(s => visited.add(`${s.x},${s.y}`));

           const libs = new Set<string>();
           group.forEach(s => {
                getNeighbors(s.x, s.y).forEach(n => {
                    if (grid[n.y][n.x] === StoneColor.EMPTY) libs.add(`${n.x},${n.y}`);
                });
           });

           if (libs.size <= 2) {
               const cName = color === StoneColor.BLACK ? "Black" : "White";
               report.push(`DANGER: ${cName} group at ${toGtpCoordinate(group[0].x, group[0].y)} has only ${libs.size} liberties.`);
           }
       }
   }
   return report;
};

export const calculateInfluence = (grid: StoneColor[][]): { blackArea: number, whiteArea: number } => {
    return getInfluenceSummary(grid) ?? calculateInfluenceHeuristic(grid);
};

export const findShapes = (
  grid: StoneColor[][],
  lastMove: Coordinate | null,
  lastMoveColor: StoneColor | null
): string[] => {
    const sabakiMatches = getPatternMatches(grid, PATTERNS);
    const heuristicMatches = findShapesHeuristic(grid);
    const moveName =
      lastMove && lastMoveColor
        ? getMoveName(grid, toSign(lastMoveColor), lastMove)
        : null;

    return [
      ...(moveName ? [`MOVE NAME: ${moveName} at ${toGtpCoordinate(lastMove.x, lastMove.y)}`] : []),
      ...sabakiMatches,
      ...heuristicMatches,
    ];
};

export const analyzeSafety = async (grid: StoneColor[][]): Promise<string[]> => {
  const deadVertices = await getDeadStoneVertices(grid, { iterations: 80 });
  if (deadVertices.length > 0) {
    return deadVertices.map((vertex) => `DANGER: Weak group near ${toGtpCoordinate(vertex.x, vertex.y)}.`);
  }
  return analyzeSafetyHeuristic(grid);
};

export const generateAdvancedReport = async (
  grid: StoneColor[][],
  lastMove: Coordinate | null,
  lastMoveColor: StoneColor | null
): Promise<string> => {
    const influence = calculateInfluence(grid);
    const shapes = findShapes(grid, lastMove, lastMoveColor);
    const safety = await analyzeSafety(grid);

    return `
[INFLUENCE & TERRITORY]
- Black Potential Area: ${influence.blackArea} points
- White Potential Area: ${influence.whiteArea} points

[SHAPE ANALYSIS]
${shapes.length > 0 ? shapes.slice(0, 6).join('\n') : "- No critical shapes detected."}

[GROUP SAFETY]
${safety.length > 0 ? safety.slice(0, 6).join('\n') : "- All groups appear stable (>2 libs)."}
    `;
};
