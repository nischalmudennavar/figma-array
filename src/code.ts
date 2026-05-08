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
 * Represents a segment of a vector path, which can be either a cubic Bezier curve or a straight line.
 */
interface BezierSegment {
  /** Start point of the segment. */
  p0: Point;
  /** First control point for cubic segments. */
  p1: Point;
  /** Second control point for cubic segments. */
  p2: Point;
  /** End point of the segment. */
  p3: Point;
  /** The total physical length of the segment. */
  length: number;
  /** The type of the segment: CUBIC for curves, LINE for straight paths. */
  type: "CUBIC" | "LINE";
  /** Arc-length lookup table for accurate parameterization. */
  lut: ArcLUTEntry[];
}

/**
 * Mathematical utilities for evaluating and analyzing Bezier curves and lines.
 */
class BezierEngine {
  /**
   * Evaluates the position on a segment at a given parameter t.
   * @param t - The parameter value between 0 and 1.
   * @param seg - The segment to evaluate.
   * @returns The 2D coordinates at parameter t.
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
   * Computes the tangent vector (derivative) of a segment at parameter t.
   * @param t - The parameter value between 0 and 1.
   * @param seg - The segment to analyze.
   * @returns The tangent vector at parameter t.
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
   * Builds an arc-length Look-Up Table (LUT) for a segment.
   * Maps physical distance along the curve to the mathematical parameter t.
   * @param seg - The segment to build the LUT for.
   * @param steps - The number of subdivisions for the numerical integration.
   * @returns An array of ArcLUTEntry mapping t to arc length.
   */
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

  /**
   * Finds the curve parameter t corresponding to a specific physical distance using the LUT.
   * Uses binary search and linear interpolation for high performance and precision.
   * @param lut - The arc-length lookup table.
   * @param targetLen - The target physical distance along the segment.
   * @returns The parameter t ∈ [0, 1].
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

  /**
   * Calculates the total physical length of a segment using numerical integration.
   * @param p0 - Start point.
   * @param p1 - First control point.
   * @param p2 - Second control point.
   * @param p3 - End point.
   * @param type - Segment type.
   * @param steps - Integration precision steps.
   * @returns The total arc length.
   */
  static calculateLength(
    p0: Point,
    p1: Point,
    p2: Point,
    p3: Point,
    type: "CUBIC" | "LINE",
    steps = 200,
  ): number {
    if (type === "LINE") {
      return Math.hypot(p3.x - p0.x, p3.y - p0.y);
    }
    let length = 0;
    let prev = p0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      const curr = {
        x:
          mt * mt * mt * p0.x +
          3 * mt * mt * t * p1.x +
          3 * mt * t * t * p2.x +
          t * t * t * p3.x,
        y:
          mt * mt * mt * p0.y +
          3 * mt * mt * t * p1.y +
          3 * mt * t * t * p2.y +
          t * t * t * p3.y,
      };
      length += Math.hypot(curr.x - prev.x, curr.y - prev.y);
      prev = curr;
    }
    return length;
  }
}

// --- Placement Helper ---

/**
 * Place a clone at a world position (cx, cy) with optional rotation.
 * Uses relativeTransform so that rotation is applied around the object's
 * geometric center — not its top-left corner.
 * @param clone - The cloned SceneNode to place.
 * @param cx - Target center x-coordinate.
 * @param cy - Target center y-coordinate.
 * @param angleDeg - Rotation angle in degrees.
 * @param rotate - Whether to apply rotation.
 */
function placeClone(
  clone: SceneNode,
  cx: number,
  cy: number,
  angleDeg: number,
  rotate: boolean,
): void {
  if (rotate) {
    const angle = angleDeg * (Math.PI / 180);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const w = clone.width;
    const h = clone.height;
    // Translate so that the center (w/2, h/2) lands at (cx, cy)
    const tx = cx - cos * (w / 2) + sin * (h / 2);
    const ty = cy - sin * (w / 2) - cos * (h / 2);
    clone.relativeTransform = [
      [cos, -sin, tx],
      [sin, cos, ty],
    ];
  } else {
    clone.x = cx - clone.width / 2;
    clone.y = cy - clone.height / 2;
  }
}

// --- Figma Logic ---

figma.showUI(__html__, { width: 300, height: 524 });

/**
 * Tracks the current generated array group to allow for real-time updates.
 */
let currentArrayGroup: GroupNode | null = null;

/**
 * Main message handler for the plugin.
 * Handles node selection assignment and array generation logic.
 */
figma.ui.onmessage = async (msg) => {
  // ── Assign a node role (shape or path) ──────────────────────────────────
  if (msg.type === "set-node") {
    // Reset the current group when targets change to avoid confusion
    currentArrayGroup = null;
    const selection = figma.currentPage.selection;
    if (selection.length !== 1) {
      figma.notify("Select exactly one object first.", { error: true });
      return;
    }

    let node = selection[0] as any;

    if (msg.target === "path" && !("vectorNetwork" in node)) {
      figma.notify(
        "Not a vector path — try Outline Stroke or use the Pen tool.",
        { error: true },
      );
      return;
    }

    // Convert to component if it's the shape target and not already a component or instance
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

  // ── Generate the array ──────────────────────────────────────────────────
  if (msg.type === "generate") {
    figma.ui.postMessage({ type: "generating" });

    const shapeNode = (await figma.getNodeByIdAsync(msg.shapeId)) as SceneNode;
    const pathNode = (await figma.getNodeByIdAsync(msg.pathId)) as any;

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

    // Build segments with per-segment arc-length LUTs
    const network = pathNode.vectorNetwork;
    const segments: BezierSegment[] = [];

    for (const seg of network.segments) {
      const v0 = network.vertices[seg.start];
      const v1 = network.vertices[seg.end];
      const p0 = { x: v0.x, y: v0.y };
      const p3 = { x: v1.x, y: v1.y };
      const tStart = seg.tangentStart ?? { x: 0, y: 0 };
      const tEnd = seg.tangentEnd ?? { x: 0, y: 0 };
      const isLine =
        tStart.x === 0 && tStart.y === 0 && tEnd.x === 0 && tEnd.y === 0;
      const p1 = { x: p0.x + tStart.x, y: p0.y + tStart.y };
      const p2 = { x: p3.x + tEnd.x, y: p3.y + tEnd.y };
      const type: "CUBIC" | "LINE" = isLine ? "LINE" : "CUBIC";

      // Temporary segment (without lut) to build lut
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

    const totalLength = segments.reduce((sum, s) => sum + s.length, 0);

    // Build a cumulative distance table so we can binary-search for the target segment
    const cumLengths: number[] = [];
    let acc = 0;
    for (const seg of segments) {
      cumLengths.push(acc);
      acc += seg.length;
    }

    // Determine sample distances
    const count =
      msg.mode === "even"
        ? Math.max(2, msg.count)
        : Math.floor(totalLength / Math.max(1, msg.gap)) + 1;

    const stepDist =
      msg.mode === "even"
        ? count > 1
          ? totalLength / (count - 1)
          : 0
        : msg.gap;

    // Use absoluteTransform so coordinates are always in page (world) space,
    // even when the path node lives inside a frame or a nested group.
    const pathTransform = pathNode.absoluteTransform;
    const ptA = pathTransform[0][0], ptC = pathTransform[0][1], ptTx = pathTransform[0][2];
    const ptB = pathTransform[1][0], ptD = pathTransform[1][1], ptTy = pathTransform[1][2];

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

      // Use the LUT for accurate arc-length → t mapping
      const localT = BezierEngine.tFromArcLength(seg.lut, distInSeg);
      const pos = BezierEngine.evaluate(localT, seg);
      const deriv = BezierEngine.derivative(localT, seg);

      // Map local path coordinates → page world coordinates via absoluteTransform.
      // This is the fix for paths inside frames: pathNode.x/y would only be
      // frame-relative, but absoluteTransform gives the true page position.
      const worldX = ptA * pos.x + ptC * pos.y + ptTx;
      const worldY = ptB * pos.x + ptD * pos.y + ptTy;

      // Also rotate the derivative by the linear part of the transform so that
      // "rotate to path" stays correct even when the path node itself is rotated.
      const worldDx = ptA * deriv.x + ptC * deriv.y;
      const worldDy = ptB * deriv.x + ptD * deriv.y;
      const angleDeg = Math.atan2(worldDy, worldDx) * (180 / Math.PI);

      const clone = (shapeNode.type === "COMPONENT") 
        ? (shapeNode as ComponentNode).createInstance() 
        : shapeNode.clone();
        
      placeClone(clone, worldX, worldY, angleDeg, msg.rotateToPath);
      clones.push(clone);
    }

    if (currentArrayGroup && !currentArrayGroup.removed) {
      currentArrayGroup.remove();
    }

    if (clones.length > 0) {
      const group = figma.group(clones, figma.currentPage);
      group.name = `Array along ${pathNode.name}`;
      currentArrayGroup = group;
      figma.currentPage.selection = [group];
      
      // Only notify when manually triggered (not real-time sliders)
      if (!msg.isRealTime) {
        figma.notify(`✓ Created ${clones.length} instances`);
      }
    } else {
      if (!msg.isRealTime) {
        figma.notify(
          "No instances were placed. Check count / gap vs. path length.",
          { error: true },
        );
      }
    }

    figma.ui.postMessage({ type: "done" });
  }
};
