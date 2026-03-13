import { GoogleGenAI } from "@google/genai";
import { StoneColor } from "./types";
import { scorePosition, BOARD_SIZE } from "./goLogic";
import type { ScoringResult } from "./goLogic";

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!_ai) {
    const key = import.meta.env.VITE_GEMINI_API_KEY;
    if (!key) {
      throw new Error("VITE_GEMINI_API_KEY is not set.");
    }
    _ai = new GoogleGenAI({ apiKey: key });
  }
  return _ai;
}

export interface ImageScoringResult {
  grid: StoneColor[][];
  score: ScoringResult;
  boardSize: number;
  confidence: "high" | "medium" | "low";
  rawResponse: string;
}

const DETECTION_PROMPT = `You are analyzing a photograph of a Go (Baduk/Weiqi) board at the end of a game.

Your task: identify the position of every stone on the board and output a machine-readable grid.

RULES:
1. The standard board is 19x19. If you can clearly see it's a 13x13 or 9x9, use that size instead.
2. Output ONLY a grid of characters, one row per line, top-to-bottom (row 19 first for 19x19):
   - "B" for a black stone
   - "W" for a white stone
   - "." for an empty intersection
3. Each row must have exactly N characters separated by spaces (where N is the board size).
4. Output the grid between <grid> and </grid> tags.
5. Before the grid, output the board size on a line: SIZE=19 (or 13 or 9).
6. After the grid, rate your confidence: CONFIDENCE=high|medium|low
7. Do NOT include coordinates, labels, or any other text inside the grid tags.

Example for a 9x9 board fragment:
SIZE=9
<grid>
. . . . . . . . .
. . B . . . W . .
. . . . . . . . .
. . . B . W . . .
. . . . . . . . .
. . . B . W . . .
. . . . . . . . .
. . W . . . B . .
. . . . . . . . .
</grid>
CONFIDENCE=medium

Now analyze the image and output the board state.`;

function parseGridResponse(response: string): {
  grid: StoneColor[][];
  boardSize: number;
  confidence: "high" | "medium" | "low";
} {
  // Extract board size
  const sizeMatch = response.match(/SIZE=(\d+)/);
  const boardSize = sizeMatch ? parseInt(sizeMatch[1], 10) : BOARD_SIZE;

  // Extract grid content
  const gridMatch = response.match(/<grid>([\s\S]*?)<\/grid>/);
  if (!gridMatch) {
    throw new Error("Could not parse board grid from AI response.");
  }

  const gridText = gridMatch[1].trim();
  const rows = gridText.split("\n").map((r) => r.trim()).filter((r) => r.length > 0);

  if (rows.length !== boardSize) {
    throw new Error(
      `Expected ${boardSize} rows but got ${rows.length}. The AI may have misread the board.`
    );
  }

  const grid: StoneColor[][] = [];
  for (const row of rows) {
    const cells = row.split(/\s+/);
    if (cells.length !== boardSize) {
      throw new Error(
        `Expected ${boardSize} columns but got ${cells.length} in row: "${row}"`
      );
    }
    const gridRow: StoneColor[] = cells.map((c) => {
      const upper = c.toUpperCase();
      if (upper === "B" || upper === "X") return StoneColor.BLACK;
      if (upper === "W" || upper === "O") return StoneColor.WHITE;
      return StoneColor.EMPTY;
    });
    grid.push(gridRow);
  }

  // Extract confidence
  const confMatch = response.match(/CONFIDENCE=(high|medium|low)/i);
  const confidence = (confMatch ? confMatch[1].toLowerCase() : "low") as
    | "high"
    | "medium"
    | "low";

  return { grid, boardSize, confidence };
}

/**
 * Analyze an uploaded board image using Gemini Vision,
 * detect stone positions, and score the game.
 */
export async function scoreBoardImage(
  imageBase64: string,
  mimeType: string,
  komi: number = 6.5
): Promise<ImageScoringResult> {
  const ai = getAI();

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-05-20",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: imageBase64, mimeType } },
          { text: DETECTION_PROMPT },
        ],
      },
    ],
    config: {
      temperature: 0.1,
    },
  });

  const rawResponse = response.text || "";
  const { grid, boardSize, confidence } = parseGridResponse(rawResponse);
  const score = scorePosition(grid, komi);

  return { grid, score, boardSize, confidence, rawResponse };
}

/**
 * Convert a File object to base64 data string (without the data: prefix).
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:image/...;base64," prefix
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
