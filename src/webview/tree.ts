/** Generic folder tree for slash-separated names, used for branches and changed files. */
export interface TreeFolder<T> {
  kind: 'folder';
  /** Unique key: the folder path. */
  key: string;
  label: string;
  children: TreeNode<T>[];
}

export interface TreeLeaf<T> {
  kind: 'leaf';
  key: string;
  label: string;
  item: T;
}

export type TreeNode<T> = TreeFolder<T> | TreeLeaf<T>;

/**
 * Builds a folder tree; chains of folders with a single subfolder are merged into one node
 * ("src/app/core"), as Rider and VS Code do.
 */
export function buildTree<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  keyPrefix = '',
): TreeNode<T>[] {
  const root: TreeFolder<T> = { kind: 'folder', key: keyPrefix, label: '', children: [] };
  for (const item of items) {
    const parts = pathOf(item).split('/');
    let folder = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = `${folder.key}/${parts[i]}`;
      let next = folder.children.find((c): c is TreeFolder<T> => c.kind === 'folder' && c.key === key);
      if (!next) {
        next = { kind: 'folder', key, label: parts[i], children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({
      kind: 'leaf',
      key: `${keyPrefix}:${pathOf(item)}`,
      label: parts[parts.length - 1],
      item,
    });
  }
  return sortNodes(root.children.map(compact));
}

function compact<T>(node: TreeNode<T>): TreeNode<T> {
  if (node.kind === 'leaf') return node;
  let current = node;
  let label = node.label;
  while (current.children.length === 1 && current.children[0].kind === 'folder') {
    current = current.children[0];
    label = `${label}/${current.label}`;
  }
  return { ...current, label, children: current.children.map(compact) };
}

function sortNodes<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  for (const node of nodes) if (node.kind === 'folder') node.children = sortNodes(node.children);
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

export interface FlatRow<T> {
  node: TreeNode<T>;
  depth: number;
}

export function flatten<T>(
  nodes: TreeNode<T>[],
  collapsed: ReadonlySet<string>,
  depth = 0,
  out: FlatRow<T>[] = [],
): FlatRow<T>[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === 'folder' && !collapsed.has(node.key)) flatten(node.children, collapsed, depth + 1, out);
  }
  return out;
}

/** Keys of the folders among the nodes and under them, the nodes themselves included. */
export function folderKeys<T>(nodes: readonly TreeNode<T>[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue;
    out.push(node.key);
    folderKeys(node.children, out);
  }
  return out;
}

/** Items of all leaves under a node. */
export function leavesOf<T>(node: TreeNode<T>, out: T[] = []): T[] {
  if (node.kind === 'leaf') out.push(node.item);
  else for (const child of node.children) leavesOf(child, out);
  return out;
}
