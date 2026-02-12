import { GameTree, GameNode, StoneColor } from '../types';
import { v4 as uuidv4 } from 'uuid';
import * as sabakiSgf from '@sabaki/sgf';
import * as immutableGameTree from '@sabaki/immutable-gametree';

// A simplified SGF parser that handles the main line and basic properties.
// Does not robustly handle complex nested variations for this demo, but builds a linear or simple tree.

const resolveModule = <T,>(moduleRef: T): T => {
  const mod = moduleRef as T & { default?: T };
  return mod?.default ?? moduleRef;
};

const parseSgfFallback = (sgfContent: string): GameTree => {
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

type SabakiNode = {
  id: string | number;
  data: Record<string, string[]>;
  parentId: string | number | null;
  children: SabakiNode[];
};

const normalizeProperties = (data: Record<string, string[] | string>): Record<string, string> => {
  const properties: Record<string, string> = {};
  Object.entries(data).forEach(([key, value]) => {
    const normalizedValue = Array.isArray(value) ? value[0] : value;
    if (typeof normalizedValue === 'string') {
      properties[key] = normalizedValue;
    }
  });
  return properties;
};

const buildGameTreeFromRoot = (rootNode: SabakiNode): GameTree => {
  const nodes: Record<string, GameNode> = {};
  const idMap = new Map<string | number, string>();

  const walk = (node: SabakiNode, parentId: string | null) => {
    const mappedId = idMap.get(node.id) ?? uuidv4();
    idMap.set(node.id, mappedId);

    const properties = normalizeProperties(node.data ?? {});
    const gameNode: GameNode = {
      id: mappedId,
      parentId,
      childrenIds: [],
      properties,
      chatHistory: [],
    };

    const moveValue = properties.B || properties.W || '';
    if (properties.B || properties.W) {
      if (moveValue === '') {
        gameNode.move = {
          color: properties.B ? StoneColor.BLACK : StoneColor.WHITE,
          x: -1,
          y: -1,
        };
      } else {
        const x = moveValue.charCodeAt(0) - 97;
        const y = moveValue.charCodeAt(1) - 97;
        gameNode.move = {
          color: properties.B ? StoneColor.BLACK : StoneColor.WHITE,
          x,
          y,
        };
      }
    }

    if (properties.C) {
      gameNode.comment = properties.C;
    }

    nodes[mappedId] = gameNode;

    node.children?.forEach((child) => {
      const childId = walk(child, mappedId);
      gameNode.childrenIds.push(childId);
    });

    return mappedId;
  };

  const rootId = walk(rootNode, null);

  return {
    nodes,
    rootId,
    currentId: rootId,
  };
};

export const parseSGF = (sgfContent: string): GameTree => {
  const sgfApi = resolveModule(sabakiSgf) as any;
  const gameTreeModule = resolveModule(immutableGameTree) as any;
  if (typeof sgfApi?.parse === 'function') {
    try {
      const getId = (() => {
        let id = 0;
        return () => id++;
      })();
      const rootNodes = sgfApi.parse(sgfContent, { getId });
      const rootNode = Array.isArray(rootNodes) ? rootNodes[0] : rootNodes;

      if (rootNode && typeof gameTreeModule === 'function') {
        const sabakiTree = new gameTreeModule({ getId, root: rootNode });
        if (sabakiTree?.root) {
          return buildGameTreeFromRoot(sabakiTree.root);
        }
      }

      if (rootNode) {
        return buildGameTreeFromRoot(rootNode);
      }
    } catch {
      // fallback below
    }
  }

  return parseSgfFallback(sgfContent);
};

const buildSabakiTreeFromGameTree = (tree: GameTree): SabakiNode => {
  const buildNode = (nodeId: string, parentId: string | null): SabakiNode => {
    const node = tree.nodes[nodeId];
    const data: Record<string, string[]> = {};
    Object.entries(node.properties).forEach(([key, value]) => {
      data[key] = [value];
    });

    if (node.move) {
      if (node.move.x === -1 || node.move.y === -1) {
        data[node.move.color] = [''];
      } else {
        const charX = String.fromCharCode(node.move.x + 97);
        const charY = String.fromCharCode(node.move.y + 97);
        data[node.move.color] = [`${charX}${charY}`];
      }
    }

    if (node.comment) {
      data.C = [node.comment];
    }

    return {
      id: nodeId,
      data,
      parentId,
      children: node.childrenIds.map((childId) => buildNode(childId, nodeId)),
    };
  };

  return buildNode(tree.rootId, null);
};

export const generateSGF = (tree: GameTree): string => {
  // Linear generation for MVP export
  const sgfApi = resolveModule(sabakiSgf) as any;
  if (typeof sgfApi?.stringify === 'function') {
    try {
      const sabakiTree = buildSabakiTreeFromGameTree(tree);
      const result = sgfApi.stringify([sabakiTree]);
      if (typeof result === 'string') return result;
    } catch {
      // fallback below
    }
  }

  let sgf = '(;GM[1]FF[4]SZ[19]';

  let currentId: string | null = tree.nodes[tree.rootId].childrenIds[0] || null;
  const root = tree.nodes[tree.rootId];
  if (root.comment) sgf += `C[${root.comment}]`;

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
