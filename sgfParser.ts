import { GameTree, GameNode, StoneColor } from '../types';
import { v4 as uuidv4 } from 'uuid';

// A simplified SGF parser that handles the main line and basic properties.
// Does not robustly handle complex nested variations for this demo, but builds a linear or simple tree.

export const parseSGF = (sgfContent: string): GameTree => {
  const rootId = uuidv4();
  const nodes: Record<string, GameNode> = {};
  
  // Clean content
  let content = sgfContent.replace(/\s+/g, ' ');
  
  // Very basic stack-based parser
  let currentParentId: string | null = null;
  let lastNodeId: string | null = null;
  
  // This is a naive parser for the MVP. Real SGF parsing is a grammar.
  // We extract nodes denoted by ;
  
  const tokens = content.split(';');
  
  // The first token is usually empty or start of file '('
  
  let isRoot = true;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].trim();
    if (!token || token === '(' || token === ')') continue;

    const nodeId = isRoot ? rootId : uuidv4();
    const node: GameNode = {
      id: nodeId,
      parentId: currentParentId,
      childrenIds: [],
      properties: {},
      chatHistory: [],
    };

    // Extract properties like B[pd], W[dp], C[comment]
    const propRegex = /([A-Z]+)\[([^\]]*)\]/g;
    let match;
    while ((match = propRegex.exec(token)) !== null) {
      const key = match[1];
      const val = match[2];
      
      node.properties[key] = val;

      if (key === 'B' || key === 'W') {
        if (val === '') {
            // Pass
            node.move = {
                color: key === 'B' ? StoneColor.BLACK : StoneColor.WHITE,
                x: -1,
                y: -1
            }
        } else {
            const x = val.charCodeAt(0) - 97;
            const y = val.charCodeAt(1) - 97;
            node.move = {
            color: key === 'B' ? StoneColor.BLACK : StoneColor.WHITE,
            x,
            y,
            };
        }
      }
      if (key === 'C') {
        node.comment = val;
      }
    }

    nodes[nodeId] = node;

    if (currentParentId && nodes[currentParentId]) {
      nodes[currentParentId].childrenIds.push(nodeId);
    }

    currentParentId = nodeId;
    lastNodeId = nodeId;
    isRoot = false;
  }

  // Correct the root parent
  nodes[rootId].parentId = null;

  return {
    nodes,
    rootId,
    currentId: rootId,
  };
};

export const generateSGF = (tree: GameTree): string => {
  // Linear generation for MVP export
  let sgf = '(;GM[1]FF[4]SZ[19]';
  
  let currentId: string | null = tree.nodes[tree.rootId].childrenIds[0] || null;
  // If root has properties, add them
  const root = tree.nodes[tree.rootId];
  if(root.comment) sgf += `C[${root.comment}]`;

  while (currentId) {
    const node = tree.nodes[currentId];
    sgf += ';';
    if (node.move) {
        const charX = String.fromCharCode(node.move.x + 97);
        const charY = String.fromCharCode(node.move.y + 97);
        sgf += `${node.move.color}[${charX}${charY}]`;
    }
    if (node.comment) {
        sgf += `C[${node.comment}]`;
    }
    currentId = node.childrenIds.length > 0 ? node.childrenIds[0] : null;
  }
  
  sgf += ')';
  return sgf;
};
