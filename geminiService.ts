import { GoogleGenAI } from "@google/genai";
import { BoardState, StoneColor, PlayerLevel, PlayerLevelConfig, SemanticAnnotation } from "./types";
import { boardToAscii, generateAdvancedReport } from "./goLogic";
import { fetchKataGoAnalysis } from "./katagoService";

// Lazy-initialized Gemini client — deferred to first use so the app renders
// even when VITE_GEMINI_API_KEY is not set (e.g. Vercel build without env var).
let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!_ai) {
    const key = import.meta.env.VITE_GEMINI_API_KEY;
    if (!key) {
      throw new Error('VITE_GEMINI_API_KEY is not set. Add it to your .env file or Vercel environment variables.');
    }
    _ai = new GoogleGenAI({ apiKey: key });
  }
  return _ai;
}

// ---------------------------------------------------------------------------
// Player Level Configuration — exported constants
// ---------------------------------------------------------------------------

export const PLAYER_LEVEL_CONFIGS: Record<PlayerLevel, PlayerLevelConfig> = {
  beginner: {
    level: 'beginner',
    label: 'Beginner',
    rankRange: '25k–15k',
    vocabulary: 'basic',
    focusAreas: ['big moves', 'life and death basics', 'capturing stones', 'territory vs influence'],
    style: {
      useAnalogies: true,
      encouragement: true,
      showExactValues: false,
      technicalDepth: 'shallow',
    },
  },
  intermediate: {
    level: 'intermediate',
    label: 'Intermediate',
    rankRange: '14k–5k',
    vocabulary: 'standard',
    focusAreas: ['shape efficiency', 'direction of play', 'joseki choices', 'attack and defense'],
    style: {
      useAnalogies: true,
      encouragement: false,
      showExactValues: false,
      technicalDepth: 'moderate',
    },
  },
  advanced: {
    level: 'advanced',
    label: 'Advanced',
    rankRange: '4k–1d',
    vocabulary: 'full',
    focusAreas: ['positional judgment', 'timing', 'thickness utilization', 'endgame technique'],
    style: {
      useAnalogies: false,
      encouragement: false,
      showExactValues: true,
      technicalDepth: 'deep',
    },
  },
  strong: {
    level: 'strong',
    label: 'Strong',
    rankRange: '2d+',
    vocabulary: 'professional',
    focusAreas: ['positional judgment', 'whole-board thinking', 'ko strategy', 'precise yose'],
    style: {
      useAnalogies: false,
      encouragement: false,
      showExactValues: true,
      technicalDepth: 'expert',
    },
  },
};

// ---------------------------------------------------------------------------
// Composable Prompt Templates — exported constants
// ---------------------------------------------------------------------------

export const LEVEL_INSTRUCTION_SETS: Record<PlayerLevel, string> = {
  beginner: `
STUDENT LEVEL: Beginner (25k–15k)
LANGUAGE RULES:
- Use simple, everyday language. Avoid jargon — when you must use a Go term, define it briefly.
- Use analogies to explain concepts (e.g., "Think of this group like a house — it needs two doors (eyes) to survive").
- Focus on the biggest, most impactful moves. Don't discuss subtle positional nuances.
- Be encouraging. Acknowledge what the student did right before discussing mistakes.
- Never show raw engine values (winrate percentages, score leads). Use qualitative descriptions instead ("Black is doing well", "This area is important").
FOCUS AREAS: big moves, life/death basics, capturing, territory vs influence.
`,

  intermediate: `
STUDENT LEVEL: Intermediate (14k–5k)
LANGUAGE RULES:
- Use standard Go terminology (sente, gote, joseki, shape, thickness) without extensive definitions.
- Explain the reasoning behind moves — not just what to play, but why.
- Discuss shape efficiency, direction of play, and common patterns.
- Use analogies occasionally for complex concepts, but prefer direct explanations.
- You may reference winrate qualitatively ("a significant advantage") but avoid exact decimals.
FOCUS AREAS: shape, direction of play, joseki, attack and defense.
`,

  advanced: `
STUDENT LEVEL: Advanced (4k–1d)
LANGUAGE RULES:
- Use full Go terminology without explanation. The student knows standard terms.
- Provide precise analysis: include score lead values and winrate shifts when relevant.
- Discuss positional judgment, timing, and strategic trade-offs in depth.
- Compare the played move against the engine recommendation with specific reasoning.
- Be analytical and direct. Skip encouragement — focus on accuracy.
FOCUS AREAS: positional judgment, timing, thickness, endgame technique.
`,

  strong: `
STUDENT LEVEL: Strong (2d+)
LANGUAGE RULES:
- Use professional Go terminology. Reference professional game patterns when applicable.
- Provide precise engine values: exact score lead, winrate delta, principal variation.
- Discuss whole-board strategic considerations and subtle positional concepts.
- Analyze ko implications, aji, and long-term strategic balance.
- Be concise and precise. This student wants data-driven analysis, not hand-holding.
FOCUS AREAS: whole-board judgment, ko strategy, precise yose, professional patterns.
`,
};

const SYSTEM_BASE = `You are an expert Go (Baduk/Weiqi) tutor using advanced analysis tools.

INPUTS PROVIDED:
1. [INFLUENCE & TERRITORY]: Heuristic estimates of territorial control.
2. [SHAPE ANALYSIS]: Detection of specific shapes (Empty Triangle, Ponnuki, etc).
3. [GROUP SAFETY]: Weak groups with low liberties.
4. [SUPERHUMAN ENGINE DATA]: KataGo analysis — the ground truth for best moves.

CORE INSTRUCTIONS:
1. Report the engine's recommended move.
2. Use the Shape and Safety analysis to explain *why* the board is in its current state.
3. Adapt your explanation depth and vocabulary to the student's level (specified below).
`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildKataGoContext(kataGoData: any): string {
  if (kataGoData && kataGoData.bot_move) {
    const botMove = kataGoData.bot_move;
    const bestTen = kataGoData.diagnostics?.best_ten || [];
    return `
[SUPERHUMAN ENGINE DATA (KATAGO) - ABSOLUTE TRUTH]
The engine has analyzed the position. You MUST follow its recommendation.

BEST MOVE: ${botMove}
- Win Probability: ${kataGoData.diagnostics?.winprob ? (kataGoData.diagnostics.winprob * 100).toFixed(1) + '%' : 'N/A'}
- Score Lead: ${kataGoData.diagnostics?.score ?? 'N/A'}

Alternative Moves:
${bestTen.slice(0, 4).map((m: any) => `- ${m.move} (Score: ${m.score}, Win: ${((m.winrate || m.winprob || 0) * 100).toFixed(1)}%)`).join('\n')}
`;
  } else if (kataGoData && kataGoData.moveInfos) {
    const topMoves = kataGoData.moveInfos.slice(0, 3);
    return `
[SUPERHUMAN ENGINE DATA (KATAGO)]
Best Move: ${topMoves[0].move}
Win Rate: ${(topMoves[0].winrate * 100).toFixed(1)}%
`;
  }
  return '\n[WARNING: KataGo returned valid JSON but no move data found.]';
}

function buildSemanticContext(annotation: SemanticAnnotation): string {
  const parts: string[] = ['[SEMANTIC ANALYSIS]'];
  parts.push(`Move ${annotation.moveNumber}: classified as ${annotation.classification.toUpperCase()}`);
  parts.push(`Game Phase: ${annotation.gamePhase}`);
  parts.push(`Score Delta: ${annotation.scoreDelta > 0 ? '+' : ''}${annotation.scoreDelta.toFixed(1)} points`);
  parts.push(`Winrate Delta: ${annotation.winrateDelta > 0 ? '+' : ''}${(annotation.winrateDelta * 100).toFixed(1)}%`);

  if (annotation.mistakeType) {
    parts.push(`Mistake Type: ${annotation.mistakeType}`);
  }
  if (annotation.themes.length > 0) {
    parts.push(`Themes: ${annotation.themes.join(', ')}`);
  }
  if (annotation.engineTopMove) {
    parts.push(`Engine Top Move: ${annotation.engineTopMove}`);
  }
  if (annotation.enginePV.length > 0) {
    parts.push(`Principal Variation: ${annotation.enginePV.join(' ')}`);
  }

  return parts.join('\n');
}

function composePrompt(
  level: PlayerLevel,
  turnStr: string,
  komi: number,
  scriptReport: string,
  kataGoContext: string,
  semanticContext?: string,
): string {
  const levelInstructions = LEVEL_INSTRUCTION_SETS[level];
  const parts = [
    SYSTEM_BASE,
    levelInstructions,
    `Current Turn: ${turnStr}`,
    `Komi: ${komi}`,
    '',
    scriptReport,
    '',
    kataGoContext,
  ];
  if (semanticContext) {
    parts.push('', semanticContext);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a board position with level-adaptive commentary.
 * Backward compatible — playerLevel defaults to 'intermediate'.
 */
export const analyzePosition = async (
  boardState: BoardState,
  playerTurn: StoneColor,
  komi: number,
  userQuestion?: string,
  gtpMoves: string[] = [],
  playerLevel: PlayerLevel = 'intermediate',
): Promise<string> => {
  const boardAscii = boardToAscii(boardState.grid);
  const turnStr = playerTurn === StoneColor.BLACK ? "Black" : "White";

  // 1. Run Advanced Internal Analysis (Influence, Shapes, Deadstones)
  const scriptReport = generateAdvancedReport(boardState.grid);

  // 2. Fetch KataGo Analysis
  let kataGoContext = "";
  let engineMovesSent = JSON.stringify(gtpMoves);

  try {
    const kataGoData = await fetchKataGoAnalysis(gtpMoves, komi);
    kataGoContext = buildKataGoContext(kataGoData);
  } catch (e: any) {
    console.error("Failed to inject KataGo context", e);
    kataGoContext = `\n[Error fetching Engine Data: ${e.message}]`;
  }

  // 3. Compose level-adaptive prompt
  const systemPrompt = composePrompt(playerLevel, turnStr, komi, scriptReport, kataGoContext);

  const userPrompt = userQuestion
    ? `Student Question: "${userQuestion}"\n\nBoard:\n${boardAscii}`
    : `What is the best move? Board:\n${boardAscii}`;

  try {
    const response = await getAI().models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [
        { role: 'user', parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }
      ],
      config: {
        temperature: 0.3,
      }
    });

    const aiText = response.text || "I couldn't generate an analysis.";

    // APPEND DEBUG INFO FOR THE USER
    const debugBlock = `
\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
**🛠️ DEBUG CONTEXT**
**Moves Sent:** \`${engineMovesSent}\`
**Player Level:** ${playerLevel}

**Engine Data:**
${kataGoContext.trim()}

**Script Analysis:**
${scriptReport.trim()}
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯`;

    return aiText + debugBlock;

  } catch (error) {
    console.error("Gemini API Error:", error);
    return "Sorry, error communicating with AI.\n\n" + kataGoContext;
  }
};

/**
 * Interactive chat with level-adaptive analysis.
 * Backward compatible — playerLevel is optional.
 */
export const chatWithGemini = async (
  history: { role: 'user' | 'model'; content: string }[],
  boardState: BoardState,
  komi: number,
  gtpMoves: string[] = [],
  playerLevel: PlayerLevel = 'intermediate',
): Promise<string> => {
  return analyzePosition(
    boardState,
    history.length % 2 === 0 ? StoneColor.BLACK : StoneColor.WHITE,
    komi,
    history[history.length - 1].content,
    gtpMoves,
    playerLevel,
  );
};

/**
 * Generate level-appropriate commentary for a specific key moment.
 *
 * This is the function the Phase 4 orchestrator will call for lazy
 * commentary generation on key moments identified by the semantic extractor.
 */
export const generateKeyMomentCommentary = async (
  annotation: SemanticAnnotation,
  playerLevel: PlayerLevel,
  userQuestion?: string,
): Promise<string> => {
  const semanticContext = buildSemanticContext(annotation);

  const levelInstructions = LEVEL_INSTRUCTION_SETS[playerLevel];

  const systemPrompt = `You are an expert Go tutor providing commentary on a key moment in a game.

${levelInstructions}

${semanticContext}

INSTRUCTIONS:
- Explain why this moment is significant for the student's learning.
- If the move was a mistake, explain the nature of the error and what would have been better.
- If the move was brilliant or good, explain what made it strong.
- Reference the engine's recommended move and principal variation when relevant.
- Keep your response focused and concise (2-4 paragraphs).
`;

  const userPrompt = userQuestion
    ? `The student asks: "${userQuestion}"`
    : `Please explain move ${annotation.moveNumber} (${annotation.classification}).`;

  try {
    const response = await getAI().models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [
        { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }
      ],
      config: {
        temperature: 0.3,
      }
    });

    return response.text || "I couldn't generate commentary for this moment.";
  } catch (error) {
    console.error("Gemini Key Moment Error:", error);
    return `Error generating commentary for move ${annotation.moveNumber}.`;
  }
};

/**
 * Summarize a Q&A exchange into a tiny comment for the game tree.
 */
export const summarizeCommentary = async (question: string, answer: string): Promise<string> => {
  try {
    const response = await getAI().models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [
        {
            role: 'user',
            parts: [{ text: `Summarize this Go advice into a tiny comment (MAX 8 WORDS). Plain text.

            Q: ${question}
            A: ${answer}

            Summary:` }]
        }
      ],
      config: {
        temperature: 0.5,
        maxOutputTokens: 20,
      }
    });

    return response.text?.trim() || "";
  } catch (error) {
    console.error("Gemini Summary Error:", error);
    return "";
  }
};
