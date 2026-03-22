import { GameTree, GameNode, StoneColor } from './types';
import { v4 as uuidv4 } from 'uuid';

// SGF parser with stack-based variation handling.
// Parses the full game tree including all variation branches.

export const parseSGF = (sgfContent: string): GameTree => {
  const rootId = uuidv4();
  const nodes: Record<string, GameNode> = {};

  // Stack-based parser that correctly handles variation branches.
  // '(' pushes the current parent onto the stack (branch point).
  // ')' pops back to the branch point so the next node becomes a sibling variation.
  const branchStack: (string | null)[] = [];
  let currentParentId: string | null = null;
  let isRootCreated = false;

  let i = 0;
  while (i < sgfContent.length) {
    const ch = sgfContent[i];

    if (ch === '(') {
      // Entering a branch — remember where to return after ')'
      branchStack.push(currentParentId);
      i++;
    } else if (ch === ')') {
      // Leaving a branch — restore the branch point
      currentParentId = branchStack.pop() ?? null;
      i++;
    } else if (ch === ';') {
      // Start of a node — collect property text until next structural char
      i++; // skip ';'
      let nodeText = '';
      while (i < sgfContent.length && sgfContent[i] !== '(' && sgfContent[i] !== ')' && sgfContent[i] !== ';') {
        if (sgfContent[i] === '[') {
          // Read property value, handling \] escapes
          nodeText += '[';
          i++;
          while (i < sgfContent.length && sgfContent[i] !== ']') {
            if (sgfContent[i] === '\\' && i + 1 < sgfContent.length) {
              nodeText += sgfContent[i] + sgfContent[i + 1];
              i += 2;
            } else {
              nodeText += sgfContent[i];
              i++;
            }
          }
          if (i < sgfContent.length) {
            nodeText += ']';
            i++; // skip ']'
          }
        } else {
          nodeText += sgfContent[i];
          i++;
        }
      }

      // Create node
      const nodeId = !isRootCreated ? rootId : uuidv4();
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
      while ((match = propRegex.exec(nodeText)) !== null) {
        const key = match[1];
        const val = match[2];

        node.properties[key] = val;

        if (key === 'B' || key === 'W') {
          if (val === '') {
            node.move = {
              color: key === 'B' ? StoneColor.BLACK : StoneColor.WHITE,
              x: -1,
              y: -1,
            };
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
      isRootCreated = true;
    } else {
      // Skip whitespace and other characters
      i++;
    }
  }

  // Ensure root has no parent
  if (nodes[rootId]) {
    nodes[rootId].parentId = null;
  }

  return {
    nodes,
    rootId,
    currentId: rootId,
  };
};

export const generateSGF = (tree: GameTree): string => {
  function serializeNode(node: GameNode): string {
    let s = ';';
    // Write known properties
    for (const [key, val] of Object.entries(node.properties)) {
      if (key === 'C') continue; // handled separately to preserve ordering
      if (key === 'B' || key === 'W') continue; // written from node.move
      s += `${key}[${val}]`;
    }
    if (node.move) {
      if (node.move.x < 0 && node.move.y < 0) {
        s += `${node.move.color}[]`; // pass
      } else {
        const charX = String.fromCharCode(node.move.x + 97);
        const charY = String.fromCharCode(node.move.y + 97);
        s += `${node.move.color}[${charX}${charY}]`;
      }
    }
    if (node.comment) {
      s += `C[${node.comment}]`;
    }
    return s;
  }

  function serializeTree(nodeId: string): string {
    let sgf = '';
    let currentId: string | null = nodeId;

    while (currentId) {
      const node = tree.nodes[currentId];
      sgf += serializeNode(node);

      if (node.childrenIds.length === 0) {
        break;
      } else if (node.childrenIds.length === 1) {
        // Single continuation — no branching needed
        currentId = node.childrenIds[0];
      } else {
        // Multiple children — each becomes a variation wrapped in ()
        for (const childId of node.childrenIds) {
          sgf += '(' + serializeTree(childId) + ')';
        }
        break;
      }
    }
    return sgf;
  }

  return '(' + serializeTree(tree.rootId) + ')';
};
