// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

interface Point {
  x: number;
  y: number;
}

interface ArcLUTEntry {
  t: number;
  arcLen: number;
}

interface BezierSegment {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
  length: number;
  type: "CUBIC" | "LINE";
  lut: ArcLUTEntry[];
}

/**
 * Serialisable params stored between generate calls for auto-sync.
 * Never contains Figma node references — only IDs and plain values.
 */
interface GenerateParams {
  shapeId: string;
  pathId: string;
  mode: "even" | "fixed";
  count: number;
  gap: number;
  rotateToPath: boolean;
  isRealTime: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bezier Engine — arc-length parameterised sampling
// ─────────────────────────────────────────────────────────────────────────────

class BezierEngine {
  /** Evaluates the position on a segment at parameter t ∈ [0, 1]. */
  static evaluate(t: number, seg: BezierSegment): Point {
    if (seg.type === "LINE") {
      return {
        x: seg.p0.x + t * (seg.p3.x - seg.p0.x),
        y: seg.p0.y + t * (seg.p3.y - seg.p0.y),
      };
    }
    const mt = 1 - t;
    return {
      x:
        mt * mt * mt * seg.p0.x +
        3 * mt * mt * t * seg.p1.x +
        3 * mt * t * t * seg.p2.x +
        t * t * t * seg.p3.x,
      y:
        mt * mt * mt * seg.p0.y +
        3 * mt * mt * t * seg.p1.y +
        3 * mt * t * t * seg.p2.y +
        t * t * t * seg.p3.y,
    };
  }

  /** Computes the tangent vector (derivative) at parameter t. */
  static derivative(t: number, seg: BezierSegment): Point {
    if (seg.type === "LINE") {
      return { x: seg.p3.x - seg.p0.x, y: seg.p3.y - seg.p0.y };
    }
    const mt = 1 - t;
    return {
      x:
        3 * mt * mt * (seg.p1.x - seg.p0.x) +
        6 * mt * t * (seg.p2.x - seg.p1.x) +
        3 * t * t * (seg.p3.x - seg.p2.x),
      y:
        3 * mt * mt * (seg.p1.y - seg.p0.y) +
        6 * mt * t * (seg.p2.y - seg.p1.y) +
        3 * t * t * (seg.p3.y - seg.p2.y),
    };
  }

  /** Builds an arc-length LUT for a segment via numerical integration. */
  static buildArcLUT(seg: BezierSegment, steps = 200): ArcLUTEntry[] {
    if (seg.type === "LINE") {
      return [
        { t: 0, arcLen: 0 },
        { t: 1, arcLen: Math.hypot(seg.p3.x - seg.p0.x, seg.p3.y - seg.p0.y) },
      ];
    }
    const lut: ArcLUTEntry[] = [{ t: 0, arcLen: 0 }];
    let prev = seg.p0;
    let accumulated = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const curr = BezierEngine.evaluate(t, seg);
      accumulated += Math.hypot(curr.x - prev.x, curr.y - prev.y);
      lut.push({ t, arcLen: accumulated });
      prev = curr;
    }
    return lut;
  }

  /** Finds parameter t for a given arc length — binary search + interpolation. */
  static tFromArcLength(lut: ArcLUTEntry[], targetLen: number): number {
    const last = lut[lut.length - 1];
    if (targetLen <= 0) return 0;
    if (targetLen >= last.arcLen) return 1;
    let lo = 0, hi = lut.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (lut[mid].arcLen < targetLen) lo = mid;
      else hi = mid;
    }
    const span = lut[hi].arcLen - lut[lo].arcLen;
    const alpha = span === 0 ? 0 : (targetLen - lut[lo].arcLen) / span;
    return lut[lo].t + alpha * (lut[hi].t - lut[lo].t);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate helpers — fix for paths inside frames
//
// pathNode.x / .y are FRAME-RELATIVE. When a path lives inside a frame,
// these are small numbers like 50, 80 — but clones need PAGE-SPACE coords.
// absoluteTransform always gives page-space regardless of nesting depth.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the page-space (world) origin of a node using absoluteTransform.
 * Works correctly regardless of how deeply nested the node is in frames.
 */
function worldOrigin(node: SceneNode): Point {
  const t = node.absoluteTransform;
  return { x: t[0][2], y: t[1][2] };
}

/**
 * Converts a page-space (world) point into the local coordinate space of a
 * container node. Inverts the 2×2 affine rotation/scale matrix.
 */
function worldToLocal(worldX: number, worldY: number, container: BaseNode): Point {
  if (container.type === "PAGE") return { x: worldX, y: worldY };
  const t = (container as SceneNode).absoluteTransform;
  const a = t[0][0], b = t[0][1], tx = t[0][2];
  const c = t[1][0], d = t[1][1], ty = t[1][2];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-10) return { x: worldX - tx, y: worldY - ty };
  const dx = worldX - tx, dy = worldY - ty;
  return {
    x: (d * dx - b * dy) / det,
    y: (-c * dx + a * dy) / det,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Place a clone/instance at a world position.
// Converts to container-local coords — works correctly inside nested frames.
// Rotation is applied around the object's geometric center, not top-left.
// ─────────────────────────────────────────────────────────────────────────────

function placeClone(
  clone: SceneNode,
  cx: number,
  cy: number,
  angleDeg: number,
  rotate: boolean,
  container: BaseNode,
): void {
  const lt = worldToLocal(cx, cy, container);
  if (rotate) {
    const angle = angleDeg * (Math.PI / 180);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const w = clone.width;
    const h = clone.height;
    // Translate so the center (w/2, h/2) lands at the local target point
    const tx = lt.x - cos * (w / 2) + sin * (h / 2);
    const ty = lt.y - sin * (w / 2) - cos * (h / 2);
    clone.relativeTransform = [
      [cos, -sin, tx],
      [sin,  cos, ty],
    ];
  } else {
    clone.x = lt.x - clone.width / 2;
    clone.y = lt.y - clone.height / 2;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Collect all descendant node IDs of a component (including itself).
// Used to detect any edit anywhere inside the component's subtree.
// ─────────────────────────────────────────────────────────────────────────────

function collectDescendantIds(node: BaseNode): Set<string> {
  const ids = new Set<string>();
  const queue: BaseNode[] = [node];
  while (queue.length) {
    const n = queue.shift()!;
    ids.add(n.id);
    if ("children" in n) {
      for (const child of (n as ChildrenMixin).children) {
        queue.push(child);
      }
    }
  }
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin state
// ─────────────────────────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 300, height: 524 });

/** Tracks the current generated group so it can be removed on re-generate. */
let currentArrayGroup: GroupNode | null = null;

/**
 * Session state — stores last generate params for auto-sync.
 * Only plain serialisable values — never Figma node refs.
 */
let lastGenParams: GenerateParams | null = null;

/** Flag to prevent re-entrant generate calls during documentchange. */
let isGenerating = false;

// ─────────────────────────────────────────────────────────────────────────────
// Core generate — called by both UI messages and the documentchange listener.
// ─────────────────────────────────────────────────────────────────────────────

async function runGenerate(params: GenerateParams): Promise<void> {
  if (isGenerating) return;
  isGenerating = true;

  try {
    const shapeNode = (await figma.getNodeByIdAsync(params.shapeId)) as SceneNode | null;
    const pathNode  = (await figma.getNodeByIdAsync(params.pathId)) as any;

    if (!shapeNode || !pathNode) {
      figma.notify("A referenced node no longer exists. Please re-assign.", { error: true });
      figma.ui.postMessage({ type: "done" });
      return;
    }
    if (!pathNode.vectorNetwork) {
      figma.notify("Path node has no vector network.", { error: true });
      figma.ui.postMessage({ type: "done" });
      return;
    }

    // ── Build bezier segments ───────────────────────────────────────────────
    const network = pathNode.vectorNetwork;
    const segments: BezierSegment[] = [];

    for (const seg of network.segments) {
      const v0 = network.vertices[seg.start];
      const v1 = network.vertices[seg.end];
      const p0: Point = { x: v0.x, y: v0.y };
      const p3: Point = { x: v1.x, y: v1.y };
      const tStart = seg.tangentStart ?? { x: 0, y: 0 };
      const tEnd   = seg.tangentEnd   ?? { x: 0, y: 0 };
      const isLine = tStart.x === 0 && tStart.y === 0 && tEnd.x === 0 && tEnd.y === 0;
      const p1: Point = { x: p0.x + tStart.x, y: p0.y + tStart.y };
      const p2: Point = { x: p3.x + tEnd.x,   y: p3.y + tEnd.y };
      const type: "CUBIC" | "LINE" = isLine ? "LINE" : "CUBIC";
      const tmp = { p0, p1, p2, p3, type, length: 0, lut: [] as ArcLUTEntry[] };
      const lut = BezierEngine.buildArcLUT(tmp);
      const length = lut[lut.length - 1].arcLen;
      segments.push({ p0, p1, p2, p3, type, length, lut });
    }

    if (segments.length === 0) {
      figma.notify("Path has no segments.", { error: true });
      figma.ui.postMessage({ type: "done" });
      return;
    }

    const totalLength = segments.reduce((sum: number, s: BezierSegment) => sum + s.length, 0);
    const cumLengths: number[] = [];
    let acc = 0;
    for (const seg of segments) { cumLengths.push(acc); acc += seg.length; }

    // ── Parse count/gap — HTML inputs can send strings via postMessage ──────
    const mode: "even" | "fixed" = String(params.mode) === "fixed" ? "fixed" : "even";
    const rawCount = Math.max(2, parseInt(String(params.count), 10) || 2);
    const rawGap   = Math.max(1, parseFloat(String(params.gap)) || 1);

    const count    = mode === "even" ? rawCount : Math.floor(totalLength / rawGap) + 1;
    const stepDist = mode === "even" ? (count > 1 ? totalLength / (count - 1) : 0) : rawGap;

    // ── Frame-aware placement: use absoluteTransform, not .x/.y ────────────
    const pathTransform = pathNode.absoluteTransform;
    const ptA = pathTransform[0][0], ptC = pathTransform[0][1], ptTx = pathTransform[0][2];
    const ptB = pathTransform[1][0], ptD = pathTransform[1][1], ptTy = pathTransform[1][2];

    // Output goes into the same container as the path (frame or page)
    const outputContainer: BaseNode & ChildrenMixin =
      pathNode.parent && pathNode.parent.type !== "PAGE"
        ? pathNode.parent
        : figma.currentPage;

    const clones: SceneNode[] = [];

    for (let i = 0; i < count; i++) {
      const targetDist = i * stepDist;
      if (targetDist > totalLength + 0.5) break;

      let lo = 0, hi = segments.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cumLengths[mid] <= targetDist) lo = mid;
        else hi = mid - 1;
      }

      const seg       = segments[lo];
      const distInSeg = Math.min(seg.length, targetDist - cumLengths[lo]);
      const localT    = BezierEngine.tFromArcLength(seg.lut, distInSeg);
      const pos       = BezierEngine.evaluate(localT, seg);
      const deriv     = BezierEngine.derivative(localT, seg);

      // Full affine transform — handles rotated/scaled frames correctly
      const worldX  = ptA * pos.x + ptC * pos.y + ptTx;
      const worldY  = ptB * pos.x + ptD * pos.y + ptTy;

      // Rotate derivative by the linear part so tangent is correct on rotated frames
      const worldDx  = ptA * deriv.x + ptC * deriv.y;
      const worldDy  = ptB * deriv.x + ptD * deriv.y;
      const angleDeg = Math.atan2(worldDy, worldDx) * (180 / Math.PI);

      // Create real Figma instance (color/fill/stroke sync is native and automatic)
      const clone: SceneNode =
        shapeNode.type === "COMPONENT"
          ? (shapeNode as ComponentNode).createInstance()
          : (shapeNode as any).clone();

      // Append to container BEFORE setting position (required for correct coords)
      outputContainer.appendChild(clone);
      placeClone(clone, worldX, worldY, angleDeg, !!params.rotateToPath, outputContainer);
      clones.push(clone);
    }

    // Remove previous group
    if (currentArrayGroup && !currentArrayGroup.removed) {
      currentArrayGroup.remove();
    }

    if (clones.length > 0) {
      const group = figma.group(clones, outputContainer as any);
      group.name = `Array along ${pathNode.name}`;
      currentArrayGroup = group;
      figma.currentPage.selection = [group];
      if (!params.isRealTime) {
        figma.notify(`✓ Created ${clones.length} instances`);
      }
    } else {
      if (!params.isRealTime) {
        figma.notify("No instances placed — check count / gap vs. path length.", { error: true });
      }
    }

    figma.ui.postMessage({ type: "done" });

  } finally {
    isGenerating = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// documentchange listener — re-generate when the source component OR any of
// its descendants are edited.
//
// WHY this approach:
//   Figma fires documentchange with change.id = the edited child node's ID,
//   NOT the component root. So checking only change.id === shapeId misses
//   most edits (e.g. changing fill of a rect inside the component).
//
//   Fix: build a Set of all descendant IDs of the component. If any changed
//   ID is in that set → re-generate. We rebuild the set each time because
//   the user might have added/removed children.
//
// loadAllPagesAsync() is required before registering documentchange in
// Figma's incremental loading mode (otherwise throws an error).
// ─────────────────────────────────────────────────────────────────────────────

let syncDebounce: ReturnType<typeof setTimeout> | null = null;

(async () => {
  await figma.loadAllPagesAsync();

  figma.on("documentchange", async (event: DocumentChangeEvent) => {
    if (!lastGenParams || isGenerating) return;

    // Fetch the source component node fresh each time (ID is stable)
    const shapeNode = await figma.getNodeByIdAsync(lastGenParams.shapeId);
    const pathNode  = await figma.getNodeByIdAsync(lastGenParams.pathId);

    if (!shapeNode || !pathNode) return;

    // Build set of all IDs in the component subtree so we catch edits to
    // any child (fill, stroke, text, nested frame, etc.)
    const shapeDescendants = collectDescendantIds(shapeNode);
    const pathDescendants  = collectDescendantIds(pathNode);

    let needsRegenerate = false;
    for (const change of event.documentChanges) {
      // Watch ALL change types — PROPERTY_CHANGE covers fills/strokes/size,
      // CREATE and DELETE cover adding/removing children inside the component
      const id = change.id;
      if (
        shapeDescendants.has(id) ||
        pathDescendants.has(id)
      ) {
        needsRegenerate = true;
        break;
      }
    }

    if (needsRegenerate) {
      if (syncDebounce) clearTimeout(syncDebounce);
      syncDebounce = setTimeout(() => {
        runGenerate({ ...lastGenParams!, isRealTime: true });
      }, 80); // 80ms debounce — fast enough to feel live, safe enough to batch rapid strokes
    }
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
// UI message handler
// ─────────────────────────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: any) => {

  // ── Set shape / path ───────────────────────────────────────────────────────
  if (msg.type === "set-node") {
    currentArrayGroup = null;
    lastGenParams = null;

    const selection = figma.currentPage.selection;
    if (selection.length !== 1) {
      figma.notify("Select exactly one object first.", { error: true });
      return;
    }

    let node: SceneNode = selection[0];

    if (msg.target === "path" && !("vectorNetwork" in node)) {
      figma.notify("Not a vector path — try Outline Stroke or use the Pen tool.", { error: true });
      return;
    }

    // Auto-convert shape to a Component so created copies are real Instances.
    // Instances sync all visual properties (fill, stroke, effects, text) from
    // the master component natively — without needing any plugin code.
    if (msg.target === "shape") {
      if (node.type !== "COMPONENT" && node.type !== "INSTANCE") {
        const component = figma.createComponentFromNode(node);
        component.name = `Array Source: ${node.name}`;
        node = component;
      }
    }

    figma.ui.postMessage({
      type:   "node-confirmed",
      target: msg.target,
      id:     node.id,
      name:   node.name,
    });
    figma.notify(`${msg.target === "shape" ? "Shape" : "Path"} set: "${node.name}"`);
  }

  // ── Generate ───────────────────────────────────────────────────────────────
  if (msg.type === "generate") {
    figma.ui.postMessage({ type: "generating" });

    // Persist params for documentchange auto-sync — plain values only, no node refs
    lastGenParams = {
      shapeId:      msg.shapeId,
      pathId:       msg.pathId,
      mode:         msg.mode,
      count:        msg.count,
      gap:          msg.gap,
      rotateToPath: msg.rotateToPath,
      isRealTime:   !!msg.isRealTime,
    };

    await runGenerate(lastGenParams);
  }
};