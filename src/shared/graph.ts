/**
 * Lays out commits (children before parents, as `git log --date-order` emits them) on vertical lanes.
 *
 * Each row is described by line segments in row-local coordinates: x is a lane index, y is 0 (top edge),
 * 0.5 (node) or 1 (bottom edge). Lanes never shift sideways, so a branch line stays straight until it ends;
 * freed lanes are reused by the next branch that needs one.
 */

export interface GraphCommit {
  hash: string;
  parents: string[];
}

export interface Segment {
  x1: number;
  y1: 0 | 0.5;
  x2: number;
  y2: 0.5 | 1;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  segments: Segment[];
  /** Number of lanes used in this row, for sizing the graph column. */
  width: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  maxWidth: number;
}

interface Lane {
  expects: string;
  color: number;
}

export function layoutGraph(commits: readonly GraphCommit[]): GraphLayout {
  const lanes: (Lane | null)[] = [];
  const rows: GraphRow[] = [];
  let nextColor = 0;
  let maxWidth = 0;

  const freeLane = (): number => {
    const index = lanes.indexOf(null);
    return index < 0 ? lanes.length : index;
  };

  for (const commit of commits) {
    const segments: Segment[] = [];

    let lane = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i]?.expects === commit.hash) {
        lane = i;
        break;
      }
    }
    let color: number;
    if (lane < 0) {
      lane = freeLane();
      color = nextColor++;
    } else {
      color = lanes[lane]!.color;
    }

    for (let i = 0; i < lanes.length; i++) {
      const current = lanes[i];
      if (!current) continue;
      if (current.expects === commit.hash) {
        segments.push({ x1: i, y1: 0, x2: lane, y2: 0.5, color: current.color });
        lanes[i] = null;
      } else {
        segments.push({ x1: i, y1: 0, x2: i, y2: 1, color: current.color });
      }
    }

    const [firstParent, ...otherParents] = commit.parents;
    if (firstParent !== undefined) {
      lanes[lane] = { expects: firstParent, color };
      segments.push({ x1: lane, y1: 0.5, x2: lane, y2: 1, color });
    } else if (lane < lanes.length) {
      lanes[lane] = null;
    }

    for (const parent of otherParents) {
      let target = lanes.findIndex((l) => l?.expects === parent);
      let parentColor: number;
      if (target < 0) {
        target = freeLane();
        parentColor = nextColor++;
        lanes[target] = { expects: parent, color: parentColor };
      } else {
        parentColor = lanes[target]!.color;
      }
      segments.push({ x1: lane, y1: 0.5, x2: target, y2: 1, color: parentColor });
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    let width = lane + 1;
    for (const s of segments) width = Math.max(width, s.x1 + 1, s.x2 + 1);
    maxWidth = Math.max(maxWidth, width);
    rows.push({ lane, color, segments, width });
  }

  return { rows, maxWidth };
}
