/**
 * Represents a 2D point with x and y coordinates.
 */
interface Point {
  x: number;
  y: number;
}

/**
 * Represents an entry in the Arc Length Look-Up Table (LUT).
 * Maps a curve parameter 't' to its corresponding accumulated arc length.
 */
interface ArcLUTEntry {
  t: number;
  arcLen: number;
}

/**
 * Represents a segment of a vector path — either a cubic Bezier or a line.
 */
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
  /**
   * Evaluates the position on a segment at parameter t ∈ [0, 1].
   */
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

  /**
   * Computes the tangent vector (derivative) at parameter t.
   */
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

  /**
   * Builds an arc-length LUT for a segment via numerical integration.
   */
  static buildArcLUT(seg: BezierSegment, steps = 200): ArcLUTEntry[] {
    if (seg.type === "LINE") {
      return [
        { t: 0, arcLen: 0 },
        {
          t: 1,
          arcLen: Math.hypot(seg.p3.x - seg.p0.x, seg.p3.y - seg.p0.y),
        },
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

  /**
   * Finds parameter t for a given arc length using binary search + interpolation.
   */
  static tFromArcLength(lut: ArcLUTEntry[], targetLen: number): number {
    const last = lut[lut.length - 1];
    if (targetLen <= 0) return 0;
    if (targetLen >= last.arcLen) return 1;

    let lo = 0,
      hi = lut.length - 1;
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
//
// absoluteTransform always gives page-space regardless of nesting depth.
// We also need the inverse to convert page coords → parent-local coords
// for relativeTransform / .x / .y on placed clones.
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
 * Converts a page-space (world) point into the local coordinate space of
 * a container node (frame / group / page). Inverts the affine transform.
 */
function worldToLocal(
  worldX: number,
  worldY: number,
  container: BaseNode & { absoluteTransform?: Transform },
): Point {
  if (container.type === "PAGE") return { x: worldX, y: worldY };
  const t = (container as SceneNode).absoluteTransform;
  const a = t[0][0],
    b = t[0][1],
    tx = t[0][2];
  const c = t[1][0],
    d = t[1][1],
    ty = t[1][2];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-10) return { x: worldX - tx, y: worldY - ty };
  const dx = worldX - tx,
    dy = worldY - ty;
  return {
    x: (d * dx - b * dy) / det,
    y: (-c * dx + a * dy) / det,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Place a clone/instance at a world position, converting to container-local
// coords so it works correctly even inside nested frames.
//
// Rotation is applied around the object's geometric center — not top-left.
// ─────────────────────────────────────────────────────────────────────────────
function placeClone(
  clone: SceneNode,
  cx: number,
  cy: number,
  angleDeg: number,
  rotate: boolean,
  container: BaseNode,
): void {
  const lt = worldToLocal(cx, cy, container as any);
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
      [sin, cos, ty],
    ];
  } else {
    clone.x = lt.x - clone.width / 2;
    clone.y = lt.y - clone.height / 2;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin state
// ─────────────────────────────────────────────────────────────────────────────
figma.showUI(__html__, { width: 300, height: 524 });

/** Tracks the current generated group so it can be removed on re-generate. */
let currentArrayGroup: GroupNode | null = null;

/** Session state — stores last generate params for auto-sync via documentchange. */
let lastGenParams: GenerateParams | null = null;

/** Flag to prevent re-entrant generate calls. */
let isGenerating = false;

// ─────────────────────────────────────────────────────────────────────────────
// Core generate function — extracted so both UI messages and documentchange
// can call it. Takes only serialisable params — never Figma node refs.
// ─────────────────────────────────────────────────────────────────────────────
async function runGenerate(params: GenerateParams): Promise<void> {
  if (isGenerating) return;
  isGenerating = true;

  try {
    const shapeNode = (await figma.getNodeByIdAsync(
      params.shapeId,
    )) as SceneNode | null;
    const pathNode = (await figma.getNodeByIdAsync(params.pathId)) as any;

    if (!shapeNode || !pathNode) {
      figma.notify("A referenced node no longer exists. Please re-assign.", {
        error: true,
      });
      figma.ui.postMessage({ type: "done" });
      return;
    }
    if (!pathNode.vectorNetwork) {
      figma.notify("Path node has no vector network.", { error: true });
      figma.ui.postMessage({ type: "done" });
      return;
    }

    // ── Build bezier segments with arc-length LUTs ─────────────────────────
    const network = pathNode.vectorNetwork;
    const segments: BezierSegment[] = [];

    for (const seg of network.segments) {
      const v0 = network.vertices[seg.start];
      const v1 = network.vertices[seg.end];
      const p0: Point = { x: v0.x, y: v0.y };
      const p3: Point = { x: v1.x, y: v1.y };
      const tStart = seg.tangentStart ?? { x: 0, y: 0 };
      const tEnd = seg.tangentEnd ?? { x: 0, y: 0 };
      const isLine =
        tStart.x === 0 && tStart.y === 0 && tEnd.x === 0 && tEnd.y === 0;
      const p1: Point = { x: p0.x + tStart.x, y: p0.y + tStart.y };
      const p2: Point = { x: p3.x + tEnd.x, y: p3.y + tEnd.y };
      const type: "CUBIC" | "LINE" = isLine ? "LINE" : "CUBIC";

      const tmp = {
        p0,
        p1,
        p2,
        p3,
        type,
        length: 0,
        lut: [] as ArcLUTEntry[],
      };
      const lut = BezierEngine.buildArcLUT(tmp);
      const length = lut[lut.length - 1].arcLen;
      segments.push({ p0, p1, p2, p3, type, length, lut });
    }

    if (segments.length === 0) {
      figma.notify("Path has no segments.", { error: true });
      figma.ui.postMessage({ type: "done" });
      return;
    }

    const totalLength = segments.reduce(
      (sum: number, s: BezierSegment) => sum + s.length,
      0,
    );

    // Cumulative distance table for binary search
    const cumLengths: number[] = [];
    let acc = 0;
    for (const seg of segments) {
      cumLengths.push(acc);
      acc += seg.length;
    }

    // Parse count/gap safely — HTML inputs can send strings via postMessage
    const mode: "even" | "fixed" =
      String(params.mode) === "fixed" ? "fixed" : "even";
    const rawCount = Math.max(
      2,
      parseInt(String(params.count), 10) || 2,
    );
    const rawGap = Math.max(1, parseFloat(String(params.gap)) || 1);

    const count =
      mode === "even" ? rawCount : Math.floor(totalLength / rawGap) + 1;
    const stepDist =
      mode === "even"
        ? count > 1
          ? totalLength / (count - 1)
          : 0
        : rawGap;

    // ── FIX: Use absoluteTransform for page-space path coords ──────────────
    // pathNode.x/y are frame-relative and give wrong results when nested.
    // absoluteTransform gives the full affine matrix in page space, which
    // also handles rotated and scaled frames correctly.
    const pathTransform = pathNode.absoluteTransform;
    const ptA = pathTransform[0][0],
      ptC = pathTransform[0][1],
      ptTx = pathTransform[0][2];
    const ptB = pathTransform[1][0],
      ptD = pathTransform[1][1],
      ptTy = pathTransform[1][2];

    // Output container = same parent as the path (frame or page)
    const outputContainer: BaseNode & ChildrenMixin =
      pathNode.parent && pathNode.parent.type !== "PAGE"
        ? pathNode.parent
        : figma.currentPage;

    const clones: SceneNode[] = [];

    for (let i = 0; i < count; i++) {
      const targetDist = i * stepDist;
      if (targetDist > totalLength + 0.5) break;

      // Binary search for the correct segment
      let lo = 0,
        hi = segments.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cumLengths[mid] <= targetDist) lo = mid;
        else hi = mid - 1;
      }
      const seg = segments[lo];
      const distInSeg = Math.min(seg.length, targetDist - cumLengths[lo]);
      const localT = BezierEngine.tFromArcLength(seg.lut, distInSeg);
      const pos = BezierEngine.evaluate(localT, seg);
      const deriv = BezierEngine.derivative(localT, seg);

      // Full affine transform: handles rotated/scaled frames correctly
      const worldX = ptA * pos.x + ptC * pos.y + ptTx;
      const worldY = ptB * pos.x + ptD * pos.y + ptTy;

      // Rotate the derivative by the linear part of the transform so that
      // "rotate to path" stays correct even when the path node itself is rotated
      const worldDx = ptA * deriv.x + ptC * deriv.y;
      const worldDy = ptB * deriv.x + ptD * deriv.y;
      const angleDeg = Math.atan2(worldDy, worldDx) * (180 / Math.PI);

      // Create real Figma instance (syncs visual props automatically)
      // or clone for non-component shapes
      const clone: SceneNode =
        shapeNode.type === "COMPONENT"
          ? (shapeNode as ComponentNode).createInstance()
          : shapeNode.clone();

      // Place into the correct container BEFORE setting position
      outputContainer.appendChild(clone);
      placeClone(
        clone,
        worldX,
        worldY,
        angleDeg,
        !!params.rotateToPath,
        outputContainer,
      );
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
        figma.notify(
          "No instances were placed. Check count / gap vs. path length.",
          { error: true },
        );
      }
    }

    figma.ui.postMessage({ type: "done" });
  } finally {
    isGenerating = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// documentchange listener — auto-re-generate when the source component
// or the path is modified (resize, color, shape edit, etc.)
//
// This is what makes instances "sync in real time" for ALL property changes,
// not just native instance overrides. When the master component's geometry
// changes (which affects clone width/height for positioning), this listener
// catches it and re-runs generate with the saved params.
// ─────────────────────────────────────────────────────────────────────────────
let syncDebounce: ReturnType<typeof setTimeout> | null = null;

// Must call loadAllPagesAsync() before registering documentchange in
// Figma's incremental loading mode — otherwise it throws:
// "Cannot register documentchange handler in incremental mode without
//  calling figma.loadAllPagesAsync first."
(async () => {
  await figma.loadAllPagesAsync();

  figma.on("documentchange", (event: DocumentChangeEvent) => {
  if (!lastGenParams || isGenerating) return;

  let needsRegenerate = false;
  for (const change of event.documentChanges) {
    if (change.type === "PROPERTY_CHANGE") {
      const nodeId = change.id;
      if (
        nodeId === lastGenParams.shapeId ||
        nodeId === lastGenParams.pathId
      ) {
        needsRegenerate = true;
        break;
      }
    }
  }

  if (needsRegenerate) {
    if (syncDebounce) clearTimeout(syncDebounce);
    syncDebounce = setTimeout(() => {
      runGenerate({ ...lastGenParams!, isRealTime: true });
    }, 100);
  }
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
// UI message handler
// ─────────────────────────────────────────────────────────────────────────────
figma.ui.onmessage = async (msg: any) => {
  // ── Set shape / path ───────────────────────────────────────────────────
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
      figma.notify(
        "Not a vector path — try Outline Stroke or use the Pen tool.",
        { error: true },
      );
      return;
    }

    // Auto-convert to component so instances sync visual props natively
    if (msg.target === "shape") {
      if (node.type !== "COMPONENT" && node.type !== "INSTANCE") {
        const component = figma.createComponentFromNode(node);
        component.name = `Array Source: ${node.name}`;
        node = component;
      }
    }

    figma.ui.postMessage({
      type: "node-confirmed",
      target: msg.target,
      id: node.id,
      name: node.name,
    });
    figma.notify(
      `${msg.target === "shape" ? "Shape" : "Path"} set: "${node.name}"`,
    );
  }

  // ── Generate ───────────────────────────────────────────────────────────
  if (msg.type === "generate") {
    figma.ui.postMessage({ type: "generating" });

    // Save params for auto-sync (plain values only — no node refs)
    lastGenParams = {
      shapeId: msg.shapeId,
      pathId: msg.pathId,
      mode: msg.mode,
      count: msg.count,
      gap: msg.gap,
      rotateToPath: msg.rotateToPath,
      isRealTime: !!msg.isRealTime,
    };

    await runGenerate(lastGenParams);
  }
};