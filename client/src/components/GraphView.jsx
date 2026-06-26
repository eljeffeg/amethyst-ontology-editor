import fcose from "cytoscape-fcose";
import elk from "cytoscape-elk";
import cytoscape from "cytoscape";
import {
  ChevronDown,
  Download,
  Edit,
  Filter,
  Link,
  Maximize,
  MoreVertical,
  Plus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  allowedCharacteristics,
  api,
  getCurrentProject,
  predicateLabel,
  resourceLabel,
  SKOS_PREF_LABEL,
  shortLabel,
  term,
} from "../lib/api.js";
import { LINKED_PALETTE, stableSlot } from "../lib/ontologyColors.js";
import { Field, Modal } from "./ClassesView.jsx";
import EntityDetail from "./EntityDetail.jsx";
import { useProject } from "./OntologyPicker.jsx";

cytoscape.use(elk);
cytoscape.use(fcose);

// Returns the node itself plus the directly-connected edges and their endpoint
// nodes that are currently VISIBLE (display !== "none").
// Using this instead of closedNeighborhood() ensures that edges hidden by the
// active edge-filter (e.g. objectProperty edges in hierarchy-only mode) do not
// silently pull extra nodes into the selection highlight.
function visibleHood(node) {
  const visEdges = node.connectedEdges().filter((e) => e.visible());
  return node.union(visEdges).union(visEdges.connectedNodes());
}

// Size node width from its label. Replaces the deprecated
// `width: 'label'` style. Clamped so short names don't get tiny pills and
// long IRIs don't stretch across the canvas (they ellipsise via
// `text-max-width` + `text-wrap: ellipsis`).
function nodeWidthForLabel(label) {
  const len = (label || "").length;
  return Math.max(80, Math.min(220, 16 + len * 7.5));
}

// Palette tuned to match the bluish-purple Tailwind `brand` and `ink` scales.
const PALETTE = {
  bg: "#0c0920", // ink.950
  panelBorder: "#221a42", // ink.700
  textLight: "#e7e3f3", // ink.100
  textDim: "#958ab9", // ink.300

  classFill1: "#3b2aa0", // brand mid-deep
  classFill2: "#6645dc", // brand.600
  classBorder: "#ae9cff", // brand.300
  classText: "#f2efff", // brand.50

  indFill1: "#3a1f63",
  indFill2: "#7a3dd2",
  indBorder: "#d8c3ff",
  indText: "#f5eaff",

  propFill1: "#1d3660",
  propFill2: "#3a6bb8",
  propBorder: "#8ab5ff",

  selected: "#ffffff",

  edgeDefault: "#6b5fa5",
  edgeMuted: "#4e4680",
  edgeSub: "#9278ff", // brand.400  (subClassOf — brand accent)
  edgeType: "#f5b464", // softer amber
  edgeObj: "#6ee7b7", // relationship — emerald
  edgeInherited: "#2dd4bf", // inherited relationship
  edgeLabelBg: "#140e2e", // slightly tinted panel bg for edge labels
};

// LINKED_PALETTE, stableSlot imported from ../lib/ontologyColors.js above.
// The palette is the single source of truth shared with the UI swatches.

const STYLES = [
  // ── base node ────────────────────────────────────────────────────────────
  //
  // `width: 'label'` was deprecated in Cytoscape, so we size nodes from the
  // label text with a function. Clamps keep short labels from getting tiny
  // and long labels from stretching the whole canvas (long labels are
  // ellipsised via `text-max-width` + `text-wrap`).
  {
    selector: "node",
    style: {
      shape: "round-rectangle",
      label: "data(label)",
      width: (ele) => nodeWidthForLabel(ele.data("label")),
      height: 36,
      padding: "14px",
      "font-family": "Inter, system-ui, sans-serif",
      "font-size": 12,
      "font-weight": 600,
      color: PALETTE.textLight,
      "text-valign": "center",
      "text-halign": "center",
      "text-wrap": "ellipsis",
      "text-max-width": "160px",
      "text-outline-color": PALETTE.bg,
      "text-outline-width": 0,

      "background-fill": "linear-gradient",
      "background-gradient-direction": "to-bottom-right",
      // Style functions read per-ontology colors written into node data.
      // Falls back to kind-aware PALETTE colors when no fill data is present.
      "background-gradient-stop-colors": (ele) => {
        const f1 = ele.data("fill1");
        const f2 = ele.data("fill2");
        if (f1 && f2) return `${f1} ${f2}`;
        const kind = ele.data("kind");
        if (kind === "individual") return `${PALETTE.indFill1} ${PALETTE.indFill2}`;
        if (kind === "property") return `${PALETTE.propFill1} ${PALETTE.propFill2}`;
        return `${PALETTE.classFill1} ${PALETTE.classFill2}`;
      },
      "background-gradient-stop-positions": "0% 100%",
      "border-color": (ele) => ele.data("borderColor") || PALETTE.classBorder,
      "border-width": 1.5,
      "border-opacity": 0.85,

      // soft glow to give depth against the dark canvas
      "underlay-color": (ele) => ele.data("fill2") || PALETTE.classFill2,
      "underlay-opacity": 0.35,
      "underlay-padding": 6,
      "underlay-shape": "round-rectangle",
    },
  },

  // ── class: text color only — gradient/border come from node data via base style ──
  {
    selector: 'node[kind = "class"]',
    style: {
      color: PALETTE.classText,
    },
  },

  // ── individual: ellipse shape so it's visually distinct from class rectangles ──
  {
    selector: 'node[kind = "individual"]',
    style: {
      shape: "ellipse",
      color: PALETTE.indText,
      "underlay-shape": "ellipse",
      "underlay-opacity": 0.4,
    },
  },

  // ── property-as-node: gradient/border from node data ────────────────────
  {
    selector: 'node[kind = "property"]',
    style: {
      shape: "round-rectangle",
      color: PALETTE.textLight,
    },
  },

  // ── linked context node: dimmed opacity only — gradient/border are already
  // written into node data and picked up by the base node style functions.
  {
    selector: "node[linked]",
    style: {
      opacity: 0.82,
    },
  },

  // ── selected node: brighter border + stronger glow, no white flash ──────
  {
    selector: "node:selected",
    style: {
      "border-width": 2.5,
      "border-color": PALETTE.selected,
      "underlay-color": PALETTE.classBorder,
      "underlay-opacity": 0.55,
      "underlay-padding": 10,
    },
  },

  // ── base edge: plain bezier — picks its own control points and tolerates
  // the transient overlap that happens during layout (unbundled-bezier with
  // fixed control-point-distances prints an "invalid endpoints" warning when
  // the source and target share the same position, which is common before
  // the first layout settles).
  {
    selector: "edge",
    style: {
      width: 1.75,
      "edge-distances": "node-position",
      //'curve-style': 'unbundled-bezier',
      //'control-point-distances': [32],
      //'control-point-weights': [0.5],
      "curve-style": "bezier",
      "line-color": PALETTE.edgeDefault,
      "target-arrow-color": PALETTE.edgeDefault,
      "target-arrow-shape": "triangle",
      "arrow-scale": 1.1,
      label: "data(label)",
      "font-size": 10,
      "font-family": "Inter, system-ui, sans-serif",
      color: PALETTE.textDim,
      "text-background-color": PALETTE.edgeLabelBg,
      "text-background-opacity": 0.9,
      "text-background-padding": 3,
      "text-background-shape": "round-rectangle",
      "text-border-color": PALETTE.panelBorder,
      "text-border-width": 1,
      "text-border-opacity": 0.8,
      "text-rotation": "autorotate",
      "line-opacity": 0.95,
    },
  },

  // Multi-edges between the same pair: spread them so labels don't stack.
  // Cytoscape handles the geometry automatically with these hints.
  {
    selector: "edge[kind]",
    style: {
      "control-point-step-size": 40,
    },
  },

  // ── self-loop edges: bezier has built-in support for source === target
  // and draws a proper loop arc using loop-direction / loop-sweep.
  // unbundled-bezier does NOT support self-loops (it requires a non-degenerate
  // source→target line to place control points and silently fails when
  // source === target).  A larger control-point-step-size pushes the arc
  // further from the node for a cleaner, more visible loop.
  {
    selector: "edge[?selfLoop]",
    style: {
      "curve-style": "bezier",
      "loop-direction": "-45deg",
      "loop-sweep": "45deg",
      "control-point-step-size": 90,
      "text-rotation": "0deg",
    },
  },

  // ── subClassOf: brand dashed line, upright triangle ─────────────────────
  {
    selector: 'edge[kind = "subClassOf"]',
    style: {
      "line-color": PALETTE.edgeSub,
      "line-style": "dashed",
      "line-dash-pattern": [6, 4],
      "target-arrow-color": PALETTE.edgeSub,
      "target-arrow-shape": "triangle",
      label: "subClassOf",
      color: PALETTE.classBorder,
      width: 1.5,
    },
  },

  // ── rdf:type: dotted amber ──────────────────────────────────────────────
  {
    selector: 'edge[kind = "type"]',
    style: {
      "line-color": PALETTE.edgeType,
      "line-style": "dotted",
      "target-arrow-color": PALETTE.edgeType,
      color: PALETTE.edgeType,
      width: 1.4,
    },
  },

  // ── object property: solid emerald ──────────────────────────────────────
  {
    selector: 'edge[kind = "objectProperty"]',
    style: {
      "line-color": PALETTE.edgeObj,
      "target-arrow-color": PALETTE.edgeObj,
      "source-arrow-color": PALETTE.edgeObj,
      color: PALETTE.edgeObj,
      width: 1.8,
    },
  },

  // ── bidirectional edge: add source arrow ─────────────────────────────────
  {
    selector: "edge[bidirectional]",
    style: {
      "source-arrow-shape": "triangle",
      "arrow-scale": 1.1,
    },
  },

  // ── inherited relationship: faint dashed teal — distinct from the solid
  // emerald of directly-declared object properties and the brand-dashed subClassOf.
  {
    selector: "edge[inherited]",
    style: {
      "line-style": "dashed",
      "line-dash-pattern": [3, 6],
      opacity: 0.6,
      "line-color": PALETTE.edgeInherited,
      "target-arrow-color": PALETTE.edgeInherited,
      "source-arrow-color": PALETTE.edgeInherited,
      color: PALETTE.edgeInherited,
      width: 1.3,
    },
  },

  // ── selected edge: glow + thicken ───────────────────────────────────────
  {
    selector: "edge:selected",
    style: {
      width: 3,
      "line-color": PALETTE.selected,
      "target-arrow-color": PALETTE.selected,
      "source-arrow-color": PALETTE.selected,
      color: PALETTE.selected,
      "underlay-color": PALETTE.classBorder,
      "underlay-opacity": 0.35,
      "underlay-padding": 4,
    },
  },

  // ── dimming on neighborhood hover (wired up below) ──────────────────────
  {
    selector: ".faded",
    style: { opacity: 0.18, "text-opacity": 0.5 },
  },

];

// Mulberry32 — fast, 32-bit seeded PRNG. Returns a function that yields
// floats in [0, 1) deterministically from the given integer seed.
function seededRng(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LAYOUTS = {
  verticalTree: {
    name: "elk",
    elk: {
      algorithm: "layered",
      "elk.direction": "UP",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.nodeNode": "55",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.separateConnectedComponents": "true",
    },
    nodeDimensionsIncludeLabels: true,
    animate: true,
    animationDuration: 450,
    fit: true,
    padding: 50,
  },
  horizontalTree: {
    name: "elk",
    elk: {
      algorithm: "layered",
      "elk.direction": "LEFT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "150",
      "elk.spacing.nodeNode": "50",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.separateConnectedComponents": "true",
    },
    nodeDimensionsIncludeLabels: true,
    animate: true,
    animationDuration: 450,
    fit: true,
    padding: 50,
  },
  force: {
    name: "fcose",
    animate: true,
    animationDuration: 400,
    fit: true,
    padding: 50,
    randomize: true,
    nodeRepulsion: 150000,
    idealEdgeLength: 250,
    edgeElasticity: 0.6,
    nodeSeparation: 200,
    numIter: 2500,
  },
  grid: {
    name: "grid",
    fit: true,
    padding: 50,
    animate: true,
    animationDuration: 300,
    spacingFactor: 1.2,
  },
  concentric: {
    name: "concentric",
    fit: true,
    padding: 50,
    animate: true,
    animationDuration: 400,
    minNodeSpacing: 40,
  },
};

/**
 * Build an fcose layout config with relativePlacementConstraints so that
 * subClassOf parent nodes are always placed above their children.
 * Base settings come from LAYOUTS.force; only the constraints are computed here.
 *
 * @param {import('cytoscape').Core} cy
 */
function getForceLayout(cy) {
  const relativePlacementConstraint = [];
  cy.edges(":visible[kind = \"subClassOf\"]").forEach((e) => {
    const childId = e.data("source");
    const parentId = e.data("target");
    if (childId !== parentId) {
      // top = parent (sits above), bottom = child.
      relativePlacementConstraint.push({ top: parentId, bottom: childId, gap: 80 });
    }
  });
  return { ...LAYOUTS.force, relativePlacementConstraint };
}

/**
 * Return the layout config for the given layout name.
 * For "force", constraints are built from the current visible subClassOf edges.
 */
function getLayout(layoutName, cy) {
  if (layoutName === "force") return getForceLayout(cy);
  return LAYOUTS[layoutName];
}

// Valid values for each option param — used when reading from the hash.
const VALID_MODES = ["classes", "individuals", "full"];
const VALID_LAYOUTS = ["verticalTree", "horizontalTree", "force", "grid", "concentric"];
const VALID_EDGE_FILTERS = ["hierarchy", "relationships", "both"];
const _VALID_BOOLS = ["0", "1"];

export default function GraphView() {
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  // ── Parse initial option values from the URL hash on first render ────────
  // We do this once (not reactively) so the hash is the source of truth for
  // initial state; option changes then push back into the hash via effects.
  const initialHash = new URLSearchParams(
    typeof window !== "undefined" ? window.location.hash.slice(1) : "",
  );
  const initialMode = VALID_MODES.includes(initialHash.get("mode"))
    ? initialHash.get("mode")
    : "classes";
  const initialLayout = VALID_LAYOUTS.includes(initialHash.get("layout"))
    ? initialHash.get("layout")
    : "verticalTree";
  const initialEdgeFilter = VALID_EDGE_FILTERS.includes(initialHash.get("edgeFilter"))
    ? initialHash.get("edgeFilter")
    : "hierarchy";
  const initialQuery = initialHash.get("query") || "";
  // All three toggles default to ON (true).
  // We store "0" in the hash only when the user explicitly turns one OFF so
  // the absence of the key always means "use the default (true)".
  // Reading with !== "0" means: true unless the user deliberately stored "0".
  const initialHideInverseOf = initialHash.get("hideInverseOf") !== "0";
  const initialHideEquivImports = initialHash.get("hideEquivImports") !== "0";
  const initialHideInherited = initialHash.get("hideInherited") !== "0";

  const [mode, setMode] = useState(initialMode);
  const [layout, setLayout] = useState(initialLayout);
  const [selected, setSelected] = useState(null);
  const [selectedKind, setSelectedKind] = useState(null); // 'class' | 'individual' | 'property'
  const [selectedEdge, setSelectedEdge] = useState(null); // edge data object when an edge is clicked
  const [edgeEntity, setEdgeEntity] = useState(null); // entity details for objectProperty edges
  const [_reloadKey, setReloadKey] = useState(0); // bump to force graph reload after entity deletion / creation
  const [createModal, setCreateModal] = useState(null); // 'class' | 'property' | 'individual'
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // queryInput: what the user is currently typing (drives the input display).
  // query: debounced version that actually triggers visibility/layout effects.
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [edgeFilter, setEdgeFilter] = useState(initialEdgeFilter); // 'hierarchy' | 'relationships' | 'both'
  const [hideInverseOf, setHideInverseOf] = useState(initialHideInverseOf);
  const [hideEquivImports, setHideEquivImports] = useState(initialHideEquivImports);
  const [hideInherited, setHideInherited] = useState(initialHideInherited);
  const [counts, setCounts] = useState({ n: 0, e: 0 });
  const [linkedNodesData, setLinkedNodesData] = useState(new Map());

  // ── Linked context — project-level ontology state ─────────────────────────
  const { writeOntologyId, linkedOntologyIds, visibleOntologyIds, ontologies } = useProject();
  const writeOntologyIdRef = useRef(writeOntologyId);
  const linkedOntologyIdsRef = useRef(linkedOntologyIds);
  const visibleOntologyIdsRef = useRef(visibleOntologyIds);
  const ontologiesRef = useRef(ontologies);
  useEffect(() => {
    writeOntologyIdRef.current = writeOntologyId;
  }, [writeOntologyId]);
  useEffect(() => {
    linkedOntologyIdsRef.current = linkedOntologyIds;
  }, [linkedOntologyIds]);
  useEffect(() => {
    visibleOntologyIdsRef.current = visibleOntologyIds;
  }, [visibleOntologyIds]);
  useEffect(() => {
    ontologiesRef.current = ontologies;
  }, [ontologies]);
  // Stable string keys: graph reloads whenever linked or visible set changes.
  const _linkedIdsKey = linkedOntologyIds.join(",");
  const _visibleIdsKey = visibleOntologyIds.join(",");

  // ── Hash helpers ──────────────────────────────────────────────────────────

  // Read the current hash params, merge in `patch`, and navigate with
  // replace:true (option changes should not pollute the history stack).
  // Pass `{ iri: null }` to remove the iri key entirely.
  const updateHash = useCallback(
    (patch) => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined || value === "") {
          params.delete(key);
        } else {
          params.set(key, String(value));
        }
      }
      const hash = params.toString();
      navigate(hash ? `/#${hash}` : location.pathname, { replace: true });
    },
    [navigate, location.pathname],
  );

  // selectNode: update state + push a history entry so back/forward works.
  // Merges options already in the hash so they are preserved.
  const selectNode = useCallback(
    (iri, kind) => {
      setSelected(iri);
      setSelectedKind(kind || null);
      setSelectedEdge(null);
      const params = new URLSearchParams(window.location.hash.slice(1));
      params.set("iri", encodeURIComponent(iri));
      if (kind) params.set("kind", kind);
      else params.delete("kind");
      navigate(`/#${params.toString()}`, { replace: false });
    },
    [navigate],
  );

  // Deselect everything and clear the iri from the hash.
  const clearSelection = useCallback(() => {
    setSelected(null);
    setSelectedKind(null);
    setSelectedEdge(null);
    updateHash({ iri: null });
  }, [updateHash]);

  // Ref so cytoscape tap handlers (registered once with []) always call the latest selectNode.
  const selectNodeRef = useRef(selectNode);
  useEffect(() => {
    selectNodeRef.current = selectNode;
  }, [selectNode]);

  const clearSelectionRef = useRef(clearSelection);
  useEffect(() => {
    clearSelectionRef.current = clearSelection;
  }, [clearSelection]);

  // Tracks the last IRI that received the neighborhood-highlight treatment so
  // the hash effect below only applies fading when the IRI itself changes.
  // This prevents the effect from re-firing (and re-fading the graph) whenever
  // *other* hash params (layout, edgeFilter, etc.) mutate while a node is selected.
  const prevHighlightIriRef = useRef(null);

  // On mount and whenever the hash changes, restore the selected node from URL.
  useEffect(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    const iri = params.get("iri");
    if (iri) {
      const decodedIri = decodeURIComponent(iri);
      setSelected(decodedIri);
      setSelectedEdge(null);
      // kind is persisted in the hash by selectNode; for deep-links without it,
      // fall back to the Cytoscape node's data("kind") if present, else null
      // (EntityDetail will treat null as "class" by current convention).
      const hashKind = params.get("kind");
      if (hashKind) {
        setSelectedKind(hashKind);
      } else {
        const cyKind = cyRef.current?.getElementById(decodedIri)?.data?.("kind") || null;
        setSelectedKind(cyKind);
      }
      // Only re-apply the neighborhood highlight when the selected IRI actually
      // changed (deep-link, back/forward navigation).  Skip when the hash changed
      // only because another option (layout, edgeFilter, …) was updated — in that
      // case the tap handler already applied fading and we must not overwrite it.
      if (decodedIri !== prevHighlightIriRef.current) {
        prevHighlightIriRef.current = decodedIri;
        const cy = cyRef.current;
        if (cy) {
          const node = cy.getElementById(decodedIri);
          if (node.length) {
            const hood = visibleHood(node);
            cy.batch(() => {
              cy.elements().addClass("faded");
              hood.removeClass("faded");
            });
            // Zoom in to center on the selected node rather than fitting the whole graph.
            cy.animate({ center: { eles: node }, zoom: 1.5, duration: 400 });
          }
        }
      }
    } else {
      // iri was cleared from the hash — clear selection state too
      prevHighlightIriRef.current = null;
      setSelected(null);
      setSelectedEdge(null);
      setSelectedKind(null);
    }
  }, [location.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync options → hash (replace: true so no history entries) ───────────
  // Each option gets its own effect so a change to one doesn't fire the others.
  useEffect(() => {
    updateHash({ mode });
  }, [mode, updateHash]);

  useEffect(() => {
    updateHash({ layout });
  }, [layout, updateHash]);

  useEffect(() => {
    updateHash({ edgeFilter });
  }, [edgeFilter, updateHash]);

  useEffect(() => {
    // Only encode query when non-empty to keep the hash tidy.
    updateHash({ query: query || null });
  }, [query, updateHash]);

  // Debounce raw input → the query state that drives visibility/layout.
  // Clears the pending timer whenever the user types again so intermediate
  // values never trigger a layout run.
  useEffect(() => {
    const id = setTimeout(() => setQuery(queryInput), 250);
    return () => clearTimeout(id);
  }, [queryInput]);

  // For true-default booleans we store "0" when OFF (non-default) and remove
  // the key entirely when ON (default) so URLs stay clean.
  // On refresh: absent key → default true; key="0" → false.
  useEffect(() => {
    updateHash({ hideInverseOf: hideInverseOf ? null : "0" });
  }, [hideInverseOf, updateHash]);

  useEffect(() => {
    updateHash({ hideEquivImports: hideEquivImports ? null : "0" });
  }, [hideEquivImports, updateHash]);

  useEffect(() => {
    updateHash({ hideInherited: hideInherited ? null : "0" });
  }, [hideInherited, updateHash]);

  // Init cytoscape once
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: STYLES,
      // wheelSensitivity: 0.2,
      // Cytoscape warns against non-default wheel sensitivity because it
      // behaves inconsistently across mice/OSes — accept the default.
      minZoom: 0.1,
      maxZoom: 3,
    });
    cyRef.current = cy;

    cy.on("tap", "node", (e) => {
      const iri = e.target.id();
      const kind = e.target.data("kind") || null;
      // Use the ref so the stale-closure handler always calls the latest selectNode.
      selectNodeRef.current(iri, kind);
      // Focus on clicked node's VISIBLE neighborhood: dim everything else.
      // visibleHood() only follows edges currently shown on screen so that
      // hidden edges (e.g. relationship edges in hierarchy mode) don't pull
      // in extra nodes.
      const hood = visibleHood(e.target);
      cy.batch(() => {
        cy.elements().addClass("faded");
        hood.removeClass("faded");
      });
    });

    cy.on("tap", "edge", (e) => {
      const kind = e.target.data("kind");
      const inherited = e.target.data("inherited") === true;
      // Allow subClassOf, objectProperty, and inherited edges (explicit safety net).
      if (!inherited && kind !== "subClassOf" && kind !== "objectProperty") return;
      // Selecting an edge clears node selection WITHOUT updating the hash —
      // calling clearSelectionRef would navigate/update the hash, which triggers
      // the location.hash effect and immediately nulls out selectedEdge again.
      setSelected(null);
      setSelectedKind(null);
      setSelectedEdge({
        id: e.target.id(),
        kind,
        source: e.target.data("source"),
        target: e.target.data("target"),
        label: e.target.data("label"),
        iri: e.target.data("iri") || null,
        inherited,
      });
      // Highlight edge and its two endpoint nodes; dim everything else.
      cy.batch(() => {
        cy.elements().addClass("faded");
        e.target.removeClass("faded");
        e.target.source().removeClass("faded");
        e.target.target().removeClass("faded");
      });
    });
    cy.on("mouseover", "node", (e) => {
      e.target.style("border-width", 2.25);
    });
    cy.on("mouseout", "node", (e) => {
      if (!e.target.selected()) e.target.removeStyle("border-width");
    });
    cy.on("tap", (e) => {
      if (e.target === cy) {
        // Tapped the background — deselect everything and clear the hash iri.
        clearSelectionRef.current();
        cy.elements().removeClass("faded");
      }
    });


    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Tracks the currently-running Cytoscape layout instance so we can stop it
  // before starting a replacement (prevents overlapping animated transitions).
  const layoutRunRef = useRef(null);

  // Keep refs so data-load and post-filter effects can read the latest values
  // without listing them as dependencies (which would cause unnecessary reloads).
  const layoutRef = useRef(layout);
  const edgeFilterRef = useRef(edgeFilter);
  const queryRef = useRef(query);
  const hideInverseOfRef = useRef(hideInverseOf);
  const hideEquivImportsRef = useRef(hideEquivImports);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  useEffect(() => {
    edgeFilterRef.current = edgeFilter;
  }, [edgeFilter]);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  useEffect(() => {
    hideInverseOfRef.current = hideInverseOf;
  }, [hideInverseOf]);
  useEffect(() => {
    hideEquivImportsRef.current = hideEquivImports;
  }, [hideEquivImports]);

  const hideInheritedRef = useRef(hideInherited);
  useEffect(() => {
    hideInheritedRef.current = hideInherited;
  }, [hideInherited]);

  // Helper: apply the current node-query + edge-kind visibility in one batch.
  // useCallback with [] makes its reference stable so effects can list it safely.
  // hideInv  — when true, edges with kind "inverseOf" or a label matching "inverse" are hidden.
  // hideEquiv — when true, owl:equivalentClass edges and the linked nodes they connect to are hidden.
  const applyVisibility = useCallback(
    (cy, q, ef, hideInv = false, hideEquiv = false, hideInherited = false) => {
      const ql = (q || "").trim().toLowerCase();
      cy.batch(() => {
        // ── Node visibility (query filter) ────────────────────────────────────
        cy.nodes().forEach((n) => {
          const match =
            !ql || n.data("label").toLowerCase().includes(ql) || n.id().toLowerCase().includes(ql);
          n.style("display", match ? "element" : "none");
        });

        // ── Hide nodes from hidden ontologies ────────────────────────────────
        // The server only tags a node with sourceOntologyId when its owning
        // ontology is in the active visible scope.  Nodes that are referenced
        // across an ontology boundary (e.g. a class that is the subClassOf
        // target of a write-ontology class, but is declared only in a hidden
        // ontology) arrive with sourceOntologyId = null.  The linked-context
        // data-load pass marks nodes from linked ontologies with linked: true.
        // Therefore: if sourceOntologyId is null AND linked is not set, the
        // node belongs to a hidden ontology and must not be shown.
        cy.nodes().forEach((n) => {
          if (n.style("display") === "none") return; // already hidden
          if (n.data("sourceOntologyId") === null && !n.data("linked")) {
            n.style("display", "none");
          }
        });

        // ── Hide equivalent-import linked nodes ───────────────────────────────
        // When hideEquiv is ON, hide a linked node if it has an equivalentClass
        // edge to a local (non-linked) node.  This always hides the imported
        // twin regardless of whether it has children — the equiv-proxy subClassOf
        // edges built at load time ensure those children remain visible and
        // connected to the local equivalent instead.
        // For linked nodes with NO local equivalent, fall back to the original
        // rule: hide only when every connection is an equiv or inverse edge.
        if (hideEquiv) {
          cy.nodes("[linked]").forEach((n) => {
            // Primary rule: hide if connected to a local class via equivalentClass.
            const hasLocalEquiv = n.connectedEdges().some((e) => {
              const k = e.data("kind");
              const lbl = (e.data("label") || "").toLowerCase();
              const isEquiv =
                k === "equivalentClass" ||
                lbl === "equivalentclass" ||
                lbl === "equivalent class" ||
                lbl.includes("equivalent");
              if (!isEquiv) return false;
              const other = e.source().id() === n.id() ? e.target() : e.source();
              return !other.data("linked");
            });
            if (hasLocalEquiv) {
              n.style("display", "none");
              return;
            }
            // Fallback: hide if all visible structural edges are equiv/inverse.
            const hasVisibleStructuralEdge = n.connectedEdges().some((e) => {
              const k = e.data("kind");
              const lbl = (e.data("label") || "").toLowerCase();
              const kindOk =
                ef === "both" ||
                (ef === "hierarchy" && (k === "subClassOf" || k === "type")) ||
                (ef === "relationships" && (k === "objectProperty" || k === "relation" || k === "type"));
              if (!kindOk) return false;
              const isEquiv =
                k === "equivalentClass" ||
                lbl === "equivalentclass" ||
                lbl === "equivalent class" ||
                lbl.includes("equivalent");
              if (isEquiv) return false;
              const isInv =
                hideInv &&
                (k === "inverseOf" ||
                  e.data("isInverse") === true ||
                  lbl === "inverseof" ||
                  lbl === "inverse of" ||
                  lbl.includes("inverseof") ||
                  lbl.includes("inverse_of"));
              if (isInv) return false;
              return true;
            });
            if (!hasVisibleStructuralEdge) {
              n.style("display", "none");
            }
          });
        }

        // ── Edge visibility ────────────────────────────────────────────────────
        cy.edges().forEach((e) => {
          // equiv-proxy subClassOf edges: shown whenever both endpoints are visible
          // (subject to the hierarchy edge-filter).  This propagates OWL equivalence
          // semantics — children of B appear as children of A when A ≡ B — and
          // naturally keeps those children connected to A when B is hidden by the
          // "Hide equivalent imports" toggle.
          if (e.data("equivProxy")) {
            const kindOk = ef === "both" || ef === "hierarchy";
            e.style(
              "display",
              kindOk && e.source().visible() && e.target().visible() ? "element" : "none",
            );
            return;
          }
          const kind = e.data("kind");
          const lbl = (e.data("label") || "").toLowerCase();
          // Edge categorization:
          //   hierarchy     → subClassOf (class↔class) + type (individual→class rdf:type)
          //   relationships → objectProperty (class↔class) + relation (individual↔individual) + type
          const kindOk =
            ef === "both" ||
            (ef === "hierarchy" && (kind === "subClassOf" || kind === "type")) ||
            (ef === "relationships" && (kind === "objectProperty" || kind === "relation" || kind === "type"));
          const isInverseEdge =
            hideInv &&
            (kind === "inverseOf" ||
              e.data("isInverse") === true ||
              lbl === "inverseof" ||
              lbl === "inverse of" ||
              lbl.includes("inverseof") ||
              lbl.includes("inverse_of"));
          const isEquivEdge =
            hideEquiv &&
            (kind === "equivalentClass" ||
              lbl === "equivalentclass" ||
              lbl === "equivalent class" ||
              lbl.includes("equivalent"));
          const isInheritedHidden = hideInherited && e.data("inherited") === true;
          const s = e.source().visible();
          const t = e.target().visible();
          e.style(
            "display",
            kindOk && s && t && !isInverseEdge && !isEquivEdge && !isInheritedHidden
              ? "element"
              : "none",
          );
        });
      });
    },
    [],
  );

  // Load data whenever mode changes (NOT layout — layout changes should not
  // trigger a server round-trip; they just need a layout re-run).
  // _linkedIdsKey and writeOntologyId are intentional re-render triggers so the
  // effect re-fires when the linked-context set changes.  The effect body reads
  // the latest values via refs to avoid stale closures — Biome thinks those
  // values are "unused" inside the body, but they ARE the dependency signals.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger deps, consumed via refs inside effect
  useEffect(() => {
    let cancelled = false;

    // If no project is selected yet, clear the canvas and show the empty
    // state instead of firing a request that will always return an error.
    if (!getCurrentProject()) {
      setLoading(false);
      setError(null);
      cyRef.current?.elements().remove();
      setCounts({ n: 0, e: 0 });
      return;
    }

    setLoading(true);
    setError(null);
    const writeId = writeOntologyIdRef.current;
    const linkedIds = linkedOntologyIdsRef.current;

    Promise.all([
      api.graph(mode, 1000, linkedIds),
      // Linked context only makes sense for class/full views — in individuals
      // mode there are no class hierarchy nodes to anchor context edges to,
      // and injecting them would show class nodes in an instances-only graph.
      writeId && linkedIds?.length && mode !== "individuals"
        ? api.linkedContext(writeId, linkedIds).catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([g, ctx]) => {
        if (cancelled) return;
        setCounts({ n: g.nodes.length, e: g.edges.length });
        const cy = cyRef.current;
        if (!cy) return;
        cy.elements().remove();

        // ── Build per-node Cytoscape data, coloring nodes that come from a
        // visible-mode ontology (a non-write ontology in the current scope).
        // The server returns `sourceOntologyId` when the scope spans multiple
        // ontologies and the per-graph query is used.
        // `writeId` is already captured from the outer effect scope above.
        // Build a branch→parent lookup so branch ontologies always get the
        // same OKLCH color slot as their parent.  Using the parent's stable ID
        // for the hash also means adding or removing a branch never shifts any
        // other ontology's color (every ID hashes independently).
        const branchParentId = new Map(
          (ontologiesRef.current || [])
            .filter((o) => o.branch_of)
            .map((o) => [String(o.id), String(o.branch_of)]),
        );
        const colorId = (id) => (id ? branchParentId.get(String(id)) || String(id) : id);

        // ── Build a deterministic ontology → palette-slot map ─────────────
        // Slots are assigned purely by position in the project's ontology list:
        //   Ontology_0 → slot 0 (brand purple), Ontology_1 → slot 1, etc.
        // The write target gets whatever slot its list position gives it —
        // switching the write target NEVER changes any ontology's color.
        // Branch ontologies are skipped (inherit parent color, no slot).
        const _writeCid = writeId ? colorId(String(writeId)) : null;
        const ontologySlotMap = new Map();
        const linkedIdSet = new Set((linkedIds || []).map((id) => String(id)));
        // Visible ontology IDs (excluding write target): nodes from these ontologies
        // are in the full-scope read set and must NOT be treated as linked context.
        const visibleIdSet = new Set((visibleOntologyIdsRef.current || []).map((id) => String(id)));

        let slotIdx = 0;
        (ontologiesRef.current || []).forEach((o) => {
          const rawCid = String(o.id);
          const cid = colorId(rawCid);
          const isBranch = cid !== rawCid;
          if (isBranch) {
            const _modeStr = linkedIdSet.has(rawCid)
              ? "linked"
              : rawCid === String(writeId)
                ? "write"
                : "view";
            return; // branches don't consume a slot
          }
          if (!ontologySlotMap.has(cid)) {
            const slot =
              slotIdx < LINKED_PALETTE.length ? slotIdx : stableSlot(cid, LINKED_PALETTE.length);
            ontologySlotMap.set(cid, slot);
            const _pal = LINKED_PALETTE[slot];
            const _modeStr =
              rawCid === String(writeId) ? "write" : linkedIdSet.has(rawCid) ? "linked" : "view";
            slotIdx++;
          }
        });

        // Returns the LINKED_PALETTE entry for any ontology ID (or name string
        // as a fallback when the DB id is unavailable).
        const palForOntology = (oid) => {
          const cid = colorId(String(oid ?? writeId ?? ""));
          const slot = ontologySlotMap.has(cid)
            ? ontologySlotMap.get(cid)
            : stableSlot(cid, LINKED_PALETTE.length);
          return LINKED_PALETTE[slot];
        };

        cy.add([
          ...g.nodes.map((n) => {
            const oid = n.sourceOntologyId || writeId;
            const pal = palForOntology(oid);
            // Nodes from ontologies in the visible scope are fully shown — NOT
            // treated as linked context. Only nodes from ontologies outside
            // the visible set (i.e., truly linked-context ontologies) get the
            // linked:true flag that triggers dimming and hideEquiv filtering.
            const isLinked =
              n.sourceOntologyId &&
              String(n.sourceOntologyId) !== String(writeId) &&
              !visibleIdSet.has(String(n.sourceOntologyId));
            return {
              data: {
                id: n.id,
                label: n.label,
                kind: n.kind,
                fill1: pal.fill1,
                fill2: pal.fill2,
                borderColor: pal.border,
                // Preserve the raw sourceOntologyId (null for orphan cross-ontology
                // parent nodes) so the linked-context pass can distinguish them
                // from explicitly write-graph nodes when applying linked colors.
                sourceOntologyId: n.sourceOntologyId || null,
                ...(isLinked ? { linked: true } : {}),
              },
            };
          }),
          ...g.edges.map((e) => ({
            data: {
              id: e.id,
              source: e.source,
              target: e.target,
              label: e.label,
              kind: e.kind,
              iri: e.iri || null,
              ...(e.source === e.target ? { selfLoop: true } : {}),
              ...(e.isInverse ? { isInverse: true } : {}),
            },
          })),
        ]);

        // ── Inject linked context nodes with OKLCH per-ontology colors ──────
        //
        // Nodes already present in the graph (added by the main subClassOf query
        // as plain-class nodes when the parent lives in a linked named graph)
        // are NOT skipped — instead we update their data so the Cytoscape
        // `node[linked]` style selector picks them up (dashed border, per-ontology
        // color).  Truly new nodes are bulk-added at the end.
        const newLinkedMap = new Map();
        if (ctx) {
          const existingIds = new Set(cy.nodes().map((n) => n.id()));
          const newNodes = [];
          for (const c of ctx.classes || []) {
            const iri = c.iri?.value;
            if (!iri) continue;
            // Linked-context nodes carry a DB ontology ID so palForOntology
            // hits the ontologySlotMap and returns the same stable color as
            // the sidebar swatch.
            const oid = c.sourceOntologyId ?? c.sourceOntologyName ?? "default";
            const label = c.prefLabel?.value || c.label?.value || shortLabel(iri);

            if (existingIds.has(iri)) {
              const node = cy.getElementById(iri);
              if (node.length) {
                // Color is always determined by the node's definitive source
                // ontology ID.  The main graph pass tags declared classes with
                // their scope ID; orphan cross-ontology parents have no tag
                // (sourceOntologyId = null).  Use the linked-context ID to fill
                // the gap for orphans — but never override a write-graph tag.
                const storedOid = node.data("sourceOntologyId");
                const effectiveOid = storedOid || oid;
                const pal = palForOntology(effectiveOid);
                node.data("fill1", pal.fill1);
                node.data("fill2", pal.fill2);
                node.data("borderColor", pal.border);
                node.data("sourceOntologyId", effectiveOid);
                // linked flag: drives opacity dimming and "Hide equivalent
                // imports" filter only — not color selection.
                if (String(effectiveOid) !== String(writeId)) node.data("linked", true);
                // Update label for orphan parents (no stored ID → no label
                // from the main pass); leave write-graph labels untouched.
                if (label && !storedOid) node.data("label", label);
              }
            } else {
              const pal = palForOntology(oid);
              newNodes.push({
                data: {
                  id: iri,
                  label,
                  kind: "class",
                  linked: true,
                  sourceOntologyId: oid,
                  fill1: pal.fill1,
                  fill2: pal.fill2,
                  borderColor: pal.border,
                },
              });
              existingIds.add(iri);
            }

            newLinkedMap.set(iri, {
              iri,
              label,
              sourceOntologyName: c.sourceOntologyName,
              parents: c.parents || [],
            });
          }
          if (newNodes.length) cy.add(newNodes);

          // Add subClassOf edges for the full ancestor chain.
          // Deduplicates against both edge-id and (source, target) pairs so
          // edges already drawn by the main graph don't get doubled.
          const existingEdgeIds = new Set(cy.edges().map((e) => e.id()));
          const existingSubPairs = new Set(
            cy.edges('[kind = "subClassOf"]').map((e) => `${e.data("source")}→${e.data("target")}`),
          );
          const linkedEdges = [];
          for (const c of ctx.classes || []) {
            const childIri = c.iri?.value;
            if (!childIri) continue;
            for (const parentIri of c.parents || []) {
              if (!cy.getElementById(parentIri).length) continue;
              const pairKey = `${childIri}→${parentIri}`;
              if (existingSubPairs.has(pairKey)) continue;
              const edgeId = `lk:${pairKey}`;
              if (existingEdgeIds.has(edgeId)) continue;
              linkedEdges.push({
                data: {
                  id: edgeId,
                  source: childIri,
                  target: parentIri,
                  kind: "subClassOf",
                  label: "subClassOf",
                },
              });
              existingEdgeIds.add(edgeId);
              existingSubPairs.add(pairKey);
            }
          }
          // ── Also add any explicit subEdges from the server (Step 2d) ────────
          // These are (child, parent) pairs found by constraining both VALUES
          // ?child and ?parent to allLinkedIris and searching both the linked
          // and write ontology graphs.  They catch subClassOf edges that the
          // parentMap (c.parents loop above) misses when the triple is stored
          // in the write ontology's named graph rather than the linked graph.
          for (const se of ctx.subEdges || []) {
            const { child: childIri, parent: parentIri } = se;
            if (!childIri || !parentIri) continue;
            if (!cy.getElementById(childIri).length) continue;
            if (!cy.getElementById(parentIri).length) continue;
            const pairKey = `${childIri}→${parentIri}`;
            if (existingSubPairs.has(pairKey)) continue;
            const edgeId = `lk:${pairKey}`;
            if (existingEdgeIds.has(edgeId)) continue;
            linkedEdges.push({
              data: {
                id: edgeId,
                source: childIri,
                target: parentIri,
                kind: "subClassOf",
                label: "subClassOf",
              },
            });
            existingEdgeIds.add(edgeId);
            existingSubPairs.add(pairKey);
          }

          if (linkedEdges.length) cy.add(linkedEdges);

          // ── Add object property edges between linked nodes ──────────────────
          // ctx.propEdges lists (property, domain, range) triples that are
          // internal to a linked ontology.  The main graph query only covers
          // the write ontology's named graph, so these edges are never found
          // there.  We add them here after all linked nodes are in the graph.
          if (ctx.propEdges?.length) {
            const linkedPropEdges = [];
            for (const pe of ctx.propEdges) {
              const { iri: propIri, domain: domainIri, range: rangeIri, label: propLabel } = pe;
              if (!propIri || !domainIri || !rangeIri) continue;
              // Skip if either endpoint is not yet in the graph.
              if (!cy.getElementById(domainIri).length) continue;
              if (!cy.getElementById(rangeIri).length) continue;
              // Use the same edge-id format as the main graph so the
              // existingEdgeIds dedup check catches any overlap.
              const edgeId = `${domainIri}->${rangeIri}:${propIri}`;
              if (existingEdgeIds.has(edgeId)) continue;
              linkedPropEdges.push({
                data: {
                  id: edgeId,
                  source: domainIri,
                  target: rangeIri,
                  kind: "objectProperty",
                  label: propLabel || shortLabel(propIri),
                  iri: propIri,
                  ...(domainIri === rangeIri ? { selfLoop: true } : {}),
                },
              });
              existingEdgeIds.add(edgeId);
            }
            if (linkedPropEdges.length) cy.add(linkedPropEdges);
          }
        }
        setLinkedNodesData(newLinkedMap);

        // ── Compute transitive inherited relationships ────────────────────────
        // For every direct objectProperty edge A→B, find all transitive
        // subclasses of A (via subClassOf) and add a virtual edge subclass→B
        // marked `inherited: true`.  These edges are always in the graph but
        // hidden unless "Show inherited relationships" is checked; this lets
        // the toggle respond instantly without reloading from the server.
        {
          // Build parent → [children] map from subClassOf AND equivalentClass edges.
          // equivalentClass is symmetric (A ≡ B), so both directions are added —
          // each class inherits the other's object-property relationships.
          const childrenOf = new Map();
          const addChild = (parent, child) => {
            if (!childrenOf.has(parent)) childrenOf.set(parent, []);
            childrenOf.get(parent).push(child);
          };
          cy.edges().forEach((e) => {
            const kind = e.data("kind");
            const lbl = (e.data("label") || "").toLowerCase();
            if (kind === "subClassOf") {
              // subClassOf: source=child, target=parent
              addChild(e.data("target"), e.data("source"));
            } else {
              const isEquiv =
                kind === "equivalentClass" ||
                lbl === "equivalentclass" ||
                lbl === "equivalent class" ||
                lbl.includes("equivalent");
              if (isEquiv) {
                // Symmetric: each is a "child" of the other
                addChild(e.data("target"), e.data("source"));
                addChild(e.data("source"), e.data("target"));
              }
            }
          });

          // BFS: collect all transitive descendants of a node.
          const getDescendants = (iri) => {
            const desc = new Set();
            const queue = [iri];
            while (queue.length) {
              const cur = queue.shift();
              for (const child of childrenOf.get(cur) || []) {
                if (!desc.has(child)) {
                  desc.add(child);
                  queue.push(child);
                }
              }
            }
            return desc;
          };

          const existingInhIds = new Set(cy.edges().map((e) => e.id()));
          const inheritedEdges = [];

          const directEdges = cy
            .edges('[kind = "objectProperty"]')
            .filter((e) => !e.data("inherited"));

          directEdges.forEach((e) => {
            const domainIri = e.data("source");
            const rangeIri = e.data("target");
            const label = e.data("label");
            const iri = e.data("iri");
            const isInv = e.data("isInverse") ? { isInverse: true } : {};

            const addInherited = (src, tgt) => {
              if (src === tgt) return; // skip self-loops
              const edgeId = `inh:${src}->${tgt}:${iri || label}`;
              if (existingInhIds.has(edgeId)) return;
              // Skip if a direct non-inherited edge already exists for this pair + property.
              const directId = `${src}->${tgt}:${iri}`;
              if (iri && existingInhIds.has(directId)) return;
              inheritedEdges.push({
                data: {
                  id: edgeId,
                  source: src,
                  target: tgt,
                  label,
                  kind: "objectProperty",
                  iri: iri || null,
                  inherited: true,
                  ...isInv,
                  ...(src === tgt ? { selfLoop: true } : {}),
                },
              });
              existingInhIds.add(edgeId);
            };

            const subDomains = getDescendants(domainIri);
            const subRanges = getDescendants(rangeIri);

            // ── Outgoing inheritance: subclasses of the domain inherit the
            // outgoing arrow to the same range.
            //   C subClassOf A, A →[P]→ B  ⟹  C →[P]→ B
            for (const subDomain of subDomains) {
              addInherited(subDomain, rangeIri);
            }

            // ── Incoming inheritance: subclasses of the range inherit the
            // incoming arrow from the same domain.
            //   C subClassOf B, A →[P]→ B  ⟹  A →[P]→ C
            for (const subRange of subRanges) {
              addInherited(domainIri, subRange);
            }

            // NOTE: The "combined" case (subclasses of BOTH domain AND range)
            // is intentionally omitted — it is O(D×R) and causes severe
            // performance issues with larger ontologies.  The outgoing and
            // incoming passes above handle the two individual directions.
          });

          if (inheritedEdges.length) cy.add(inheritedEdges);

          // ── Merge bidirectional inherited pairs ─────────────────────────────
          // Same logic as the direct-edge bidi merge below, but scoped to the
          // virtual inherited edges just added.  When the same property label
          // is inherited in both directions between a pair of subclasses
          // (e.g. SubA →[rel]→ SubB and SubB →[rel]→ SubA), collapse them
          // into a single dual-arrow edge instead of showing two overlapping lines.
          if (inheritedEdges.length) {
            const inhBidiMap = new Map();
            const inhToRemove = [];
            cy.edges('[kind = "objectProperty"][?inherited]').forEach((e) => {
              if (e.data("selfLoop") || e.data("isInverse")) return;
              const src = e.data("source");
              const tgt = e.data("target");
              const lbl = (e.data("label") || "").toLowerCase();
              const [a, b] = src < tgt ? [src, tgt] : [tgt, src];
              const key = `${a}↔${b}:${lbl}`;
              if (inhBidiMap.has(key)) {
                const first = inhBidiMap.get(key);
                if (first.data("source") !== src || first.data("target") !== tgt) {
                  first.data("bidirectional", true);
                  inhToRemove.push(e.id());
                }
              } else {
                inhBidiMap.set(key, e);
              }
            });
            for (const id of inhToRemove) {
              const el = cy.getElementById(id);
              if (el.length) el.remove();
            }
          }
        }

        // ── Merge bidirectional objectProperty pairs ────────────────────────
        // When the same relationship label (e.g. "downloads") exists as two
        // separate edges going in opposite directions between the same node pair,
        // collapse them into a single edge with arrows on both ends rather than
        // showing two overlapping one-way arrows.  Edges already flagged as
        // isInverse are excluded — those are handled by the "hide inverse
        // relationships" filter instead.
        {
          const bidiMap = new Map(); // canonical-key → first edge
          const toRemove = []; // ids of duplicate reverse edges to delete
          cy.edges('[kind = "objectProperty"]').forEach((e) => {
            // Skip self-loops, edges already flagged as OWL inverses (handled by
            // the "hide inverse relationships" toggle), and virtual inherited edges
            // (those are computed locally and should never collapse with direct ones).
            if (e.data("selfLoop") || e.data("isInverse") || e.data("inherited")) return;
            const src = e.data("source");
            const tgt = e.data("target");
            const lbl = (e.data("label") || "").toLowerCase();
            // Canonical key uses sorted node pair so A↔B and B↔A share the same key.
            const [a, b] = src < tgt ? [src, tgt] : [tgt, src];
            const key = `${a}↔${b}:${lbl}`;
            if (bidiMap.has(key)) {
              const first = bidiMap.get(key);
              // Only merge when the two edges truly run in opposite directions.
              if (first.data("source") !== src || first.data("target") !== tgt) {
                first.data("bidirectional", true);
                toRemove.push(e.id());
              }
            } else {
              bidiMap.set(key, e);
            }
          });
          for (const id of toRemove) {
            const el = cy.getElementById(id);
            if (el.length) el.remove();
          }
        }

        // ── Re-apply inverse marking across ALL edge sources ──────────────────
        // The server marks isInverse on edges from its main propEdges query, but
        // linked-context propEdges (added above by the client) bypass that step.
        // Using the server-provided inversePairs list here ensures every edge in
        // the assembled graph gets the correct isInverse flag before visibility
        // is applied — regardless of which source added it.
        if (g.inversePairs?.length) {
          // Reconstruct the same symmetric/one-sided logic used by the server.
          const inversePairSet = new Set(g.inversePairs.map(({ p, inv }) => `${p} ${inv}`));
          const inverseIriSet = new Set();
          for (const { p, inv } of g.inversePairs) {
            const isSymmetric = inversePairSet.has(`${inv} ${p}`);
            if (isSymmetric) {
              // Symmetric declaration — suppress only the alphabetically-later IRI.
              if (p > inv) inverseIriSet.add(p);
            } else {
              // One-sided declaration — suppress the declaring property (?p).
              inverseIriSet.add(p);
            }
          }
          cy.edges('[kind = "objectProperty"]').forEach((e) => {
            const iri = e.data("iri");
            if (iri && inverseIriSet.has(iri)) {
              e.data("isInverse", true);
            }
          });
        }

        // ── Build equiv-proxy subClassOf edges ────────────────────────────────
        // For every owl:equivalentClass pair (A ≡ B), find children of B
        // (subClassOf edges whose target is B) and add virtual subClassOf edges
        // child → A.  Marked equivProxy: true so applyVisibility hides them by
        // default and shows them only when hideEquiv is ON and B is hidden —
        // keeping child nodes connected to the visible equivalent class.
        {
          const existingEdgeIds = new Set(cy.edges().map((e) => e.id()));
          const proxyEdges = [];

          cy.edges().forEach((equivEdge) => {
            const kind = equivEdge.data("kind");
            const lbl = (equivEdge.data("label") || "").toLowerCase();
            const isEquiv =
              kind === "equivalentClass" ||
              lbl === "equivalentclass" ||
              lbl === "equivalent class" ||
              lbl.includes("equivalent");
            if (!isEquiv) return;

            const nodeA = equivEdge.data("source");
            const nodeB = equivEdge.data("target");

            // Both directions: children of B get a proxy to A and vice versa.
            for (const [local, equiv] of [
              [nodeA, nodeB],
              [nodeB, nodeA],
            ]) {
              cy.edges('[kind = "subClassOf"]').forEach((sub) => {
                if (sub.data("equivProxy")) return;
                if (sub.data("target") !== equiv) return;
                const child = sub.data("source");
                if (child === local || child === equiv) return;
                const edgeId = `equiv-proxy:${child}→${local}:through:${equiv}`;
                if (existingEdgeIds.has(edgeId)) return;
                proxyEdges.push({
                  data: {
                    id: edgeId,
                    source: child,
                    target: local,
                    kind: "subClassOf",
                    label: "subClassOf",
                    equivProxy: true,
                    equivProxyThrough: equiv,
                  },
                });
                existingEdgeIds.add(edgeId);
              });
            }
          });

          if (proxyEdges.length) cy.add(proxyEdges);
        }

        const nodeCount = cy.nodes().length;
        cy.nodes().forEach((n, i) => {
          const angle = (i / (nodeCount || 1)) * 2 * Math.PI;
          n.position({ x: Math.cos(angle) * 300, y: Math.sin(angle) * 300 });
        });

        applyVisibility(
          cy,
          queryRef.current,
          edgeFilterRef.current,
          hideInverseOfRef.current,
          hideEquivImportsRef.current,
          hideInheritedRef.current,
        );
        // Deep-link focus: after the initial layout, zoom to the hash-linked node (if any).
        const _pendingIri = new URLSearchParams(window.location.hash.slice(1)).get("iri");
        if (_pendingIri) {
          cy.one("layoutstop", () => {
            const _node = cy.getElementById(decodeURIComponent(_pendingIri));
            if (!_node.length) return;
            cy.batch(() => {
              cy.elements().addClass("faded");
              visibleHood(_node).removeClass("faded");
            });
            cy.animate({ center: { eles: _node }, zoom: 1.5, duration: 400 });
          });
        }
        cy.elements(":visible").layout(getLayout(layoutRef.current, cy)).run();
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, _linkedIdsKey, _visibleIdsKey, writeOntologyId, applyVisibility, _reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run layout when the user picks a different algorithm.
  // fcose (force) uses animate: true and handles smooth interpolation natively
  // like ELK/grid/concentric — no custom batching needed.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy?.nodes().length) return;
    layoutRunRef.current?.stop();
    layoutRunRef.current = cy.elements(":visible").layout(getLayout(layout, cy));
    layoutRunRef.current.run();
  }, [layout]);

  // Load entity details for subClassOf edges (EdgeDetailPanel triples).
  // Object property edges with an IRI are handled by EntityDetail directly.
  useEffect(() => {
    const needsEntity = selectedEdge?.iri && selectedEdge.kind !== "objectProperty";
    if (!needsEntity) {
      setEdgeEntity(null);
      return;
    }
    api
      .entity(selectedEdge.iri)
      .then(setEdgeEntity)
      .catch(() => setEdgeEntity(null));
  }, [selectedEdge]);

  // Update visibility AND re-run layout whenever the search query, edge
  // filter, or graph settings change.  A single effect guarantees the layout
  // always sees the correct set of visible elements.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    applyVisibility(cy, query, edgeFilter, hideInverseOf, hideEquivImports, hideInherited);
    if (cy.nodes().length) {
      // Cancel any in-progress animated layout before starting a fresh one so
      // nodes don't flash or animate to multiple intermediate positions when
      // the user types quickly in the filter box.
      layoutRunRef.current?.stop();
      layoutRunRef.current = cy.elements(":visible").layout(getLayout(layoutRef.current, cy));
      layoutRunRef.current.run();
    }
  }, [query, edgeFilter, hideInverseOf, hideEquivImports, hideInherited, applyVisibility]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a label / prefLabel edit in the side panel, patch just the affected
  // node in Cytoscape so the graph label updates instantly without a full
  // reload (which would re-run the layout and scramble the user's view).
  const refreshNodeLabel = useCallback((iri) => {
    if (!iri) return;
    api
      .entity(iri)
      .then((entity) => {
        const cy = cyRef.current;
        if (!cy) return;
        const node = cy.$id(iri);
        if (!node.length) return;
        const outgoing = entity?.outgoing ?? [];
        const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
        const prefRow = outgoing.find(
          (t) => t.p?.value === SKOS_PREF_LABEL && t.o?.type === "literal",
        );
        const labelRow = outgoing.find((t) => t.p?.value === RDFS_LABEL && t.o?.type === "literal");
        const newLabel = prefRow?.o?.value || labelRow?.o?.value || shortLabel(iri);
        node.data("label", newLabel);
        node.style("width", nodeWidthForLabel(newLabel));
      })
      .catch(() => {});
  }, []);

  const fit = () => cyRef.current?.fit(undefined, 40);

  const exportGraph = async (format) => {
    const cy = cyRef.current;
    if (!cy) return;
    if (format === "png" || format === "jpg") {
      // Compute a safe scale so the output canvas stays within browser limits.
      // Some browsers cap canvas dimensions at ~4096–16384 px; exceeding that
      // causes toDataURL() to return "" and the downloaded file is 0 bytes.
      const bb = cy.elements(":visible").boundingBox();
      const MAX_PX = 6144; // conservative safe limit across all browsers
      const safeScale = bb.w > 0 && bb.h > 0 ? Math.min(2, MAX_PX / Math.max(bb.w, bb.h)) : 1;
      const scale = Math.max(0.5, safeScale);

      const data =
        format === "png"
          ? cy.png({ bg: PALETTE.bg, full: true, scale })
          : cy.jpg({ bg: PALETTE.bg, full: true, scale, quality: 0.95 });

      if (!data || data === "data:,") return; // canvas too large even at reduced scale
      const a = document.createElement("a");
      a.href = data;
      a.download = `ontology-graph.${format}`;
      a.click();
    } else if (format === "json") {
      const data = JSON.stringify(cy.json(), null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ontology-graph.json";
      a.click();
      URL.revokeObjectURL(url);
    } else if (format === "markdown") {
      // Generate markdown from the current Cytoscape graph data.
      // This naturally includes linked-ontology nodes since they're
      // already merged into the graph by the time we export.
      const classNodes = cy.nodes('[kind = "class"]');
      const subEdges = cy.edges('[kind = "subClassOf"]');
      const propEdges = cy.edges('[kind = "objectProperty"]');

      // Build parent→children map from visible subClassOf edges.
      const childToParents = new Map();
      const parentToChildren = new Map();
      subEdges.forEach((e) => {
        const child = e.data("source");
        const parent = e.data("target");
        if (!childToParents.has(child)) childToParents.set(child, []);
        childToParents.get(child).push(parent);
        if (!parentToChildren.has(parent)) parentToChildren.set(parent, []);
        parentToChildren.get(parent).push(child);
      });

      // Build label map from class nodes.
      const labelMap = new Map();
      classNodes.forEach((n) => {
        labelMap.set(n.id(), n.data("label") || shortLabel(n.id()));
      });

      // Roots = class nodes with no subClassOf parent in the visible graph.
      const roots = [];
      classNodes.forEach((n) => {
        if (!childToParents.has(n.id())) roots.push(n.id());
      });
      roots.sort((a, b) => (labelMap.get(a) || "").localeCompare(labelMap.get(b) || ""));

      // DFS walk → indented list.
      const hierarchyLines = [];
      const visited = new Set();
      const walk = (iri, depth) => {
        if (visited.has(iri)) return;
        visited.add(iri);
        const indent = "  ".repeat(depth);
        const lbl = labelMap.get(iri) || shortLabel(iri);
        hierarchyLines.push(`${indent}- **${lbl}** \`${shortLabel(iri)}\``);
        const children = (parentToChildren.get(iri) || [])
          .slice()
          .sort((a, b) => (labelMap.get(a) || "").localeCompare(labelMap.get(b) || ""));
        for (const c of children) walk(c, depth + 1);
      };
      for (const r of roots) walk(r, 0);
      // Catch any cycle/orphan nodes not yet visited.
      classNodes.forEach((n) => {
        if (!visited.has(n.id())) walk(n.id(), 0);
      });

      // Fetch property metadata (characteristics, inverseOf) from the server.
      let propsData = [];
      try {
        const resp = await api.propertiesAll();
        propsData = resp.properties || [];
      } catch (_) {
        /* non-fatal; fall back to graph-only data */
      }

      // Build IRI → { label, characteristics[], explicitInvOf[] } from the API response.
      // Server returns `explicitInvOf: string[]` (one-directional owl:inverseOf triples,
      // subject side only) — same field PropertiesView uses for parent/child ordering.
      const propMetaMap = new Map();
      for (const p of propsData) {
        const iri = p.iri?.value ?? p.iri;
        if (!iri) continue;
        propMetaMap.set(iri, {
          label: p.prefLabel?.value ?? p.label?.value ?? shortLabel(iri),
          characteristics: Array.isArray(p.characteristics) ? p.characteristics : [],
          explicitInvOf: Array.isArray(p.explicitInvOf) ? p.explicitInvOf : [],
        });
      }

      // Collect direct (non-inherited) objectProperty edges per IRI.
      const relMap = new Map(); // iri → { label, sources: Set, targets: Set }
      propEdges.forEach((e) => {
        if (e.data("inherited")) return;
        const iri = e.data("iri") || e.id();
        const lbl = e.data("label") || shortLabel(iri);
        const src = e.data("source");
        const tgt = e.data("target");
        if (!relMap.has(iri))
          relMap.set(iri, { label: lbl, sources: new Set(), targets: new Set() });
        relMap.get(iri).sources.add(src);
        relMap.get(iri).targets.add(tgt);
      });

      // Mirror PropertiesView's parent/child ordering:
      // A property that declares explicitInvOf[0] = parentIri is the "inverse child".
      // Mutual declarations (both sides declare the other) are treated as siblings.
      const relIriSet = new Set(relMap.keys());
      const isInverseChild = new Set();
      const childrenOf = new Map(); // parentIri → childIri[]
      for (const [iri, meta] of propMetaMap) {
        if (!relIriSet.has(iri)) continue;
        const parentIri = meta.explicitInvOf[0];
        if (!parentIri || !relIriSet.has(parentIri)) continue;
        // Skip mutual: if parent also declares this as its inverse, treat as siblings.
        const parentMeta = propMetaMap.get(parentIri);
        if (parentMeta?.explicitInvOf?.[0] === iri) continue;
        isInverseChild.add(iri);
        if (!childrenOf.has(parentIri)) childrenOf.set(parentIri, []);
        childrenOf.get(parentIri).push(iri);
      }

      // Build ordered list: parents sorted alpha, each followed by their inverse child.
      const sortedIris = [...relMap.keys()]
        .filter((iri) => !isInverseChild.has(iri))
        .sort((a, b) => {
          const la = propMetaMap.get(a)?.label || relMap.get(a)?.label || shortLabel(a);
          const lb = propMetaMap.get(b)?.label || relMap.get(b)?.label || shortLabel(b);
          return la.localeCompare(lb);
        });

      const orderedRows = []; // { iri, label, chars, sources, targets, isInverse }
      for (const iri of sortedIris) {
        const meta = propMetaMap.get(iri);
        const ge = relMap.get(iri);
        orderedRows.push({
          iri,
          label: meta?.label || ge?.label || shortLabel(iri),
          chars: meta?.characteristics || [],
          sources: ge?.sources || new Set(),
          targets: ge?.targets || new Set(),
          isInverse: false,
        });
        for (const childIri of childrenOf.get(iri) || []) {
          const cm = propMetaMap.get(childIri);
          const cge = relMap.get(childIri);
          orderedRows.push({
            iri: childIri,
            label: cm?.label || cge?.label || shortLabel(childIri),
            chars: cm?.characteristics || [],
            sources: cge?.sources || new Set(),
            targets: cge?.targets || new Set(),
            isInverse: true,
          });
        }
      }

      const lines = [];
      lines.push("# Ontology Export");
      lines.push("");
      lines.push(`_Exported ${new Date().toISOString()}_`);
      lines.push("");
      lines.push("## Entities (Hierarchical)");
      lines.push("");
      if (hierarchyLines.length) {
        lines.push(...hierarchyLines);
      } else {
        lines.push("_No entities found._");
      }
      lines.push("");
      lines.push("## Relationships");
      lines.push("");
      if (orderedRows.length) {
        lines.push("| Relationship | Domain | Range | Characteristics |");
        lines.push("|---|---|---|---|");
        for (const row of orderedRows) {
          const prefix = row.isInverse ? "↩ " : "";
          const name = `${prefix}**${row.label}** \`${shortLabel(row.iri)}\``;
          const srcs =
            [...row.sources]
              .map((s) => labelMap.get(s) || shortLabel(s))
              .sort()
              .join(", ") || "_any_";
          const tgts =
            [...row.targets]
              .map((t) => labelMap.get(t) || shortLabel(t))
              .sort()
              .join(", ") || "_any_";
          const chars = row.chars.join(", ");
          lines.push(`| ${name} | ${srcs} | ${tgts} | ${chars} |`);
        }
      } else {
        lines.push("_No relationships found._");
      }
      lines.push("");

      const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ontology.md";
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="flex-1 min-h-0 h-full flex flex-col">
      <Toolbar
        mode={mode}
        setMode={setMode}
        layout={layout}
        setLayout={setLayout}
        edgeFilter={edgeFilter}
        setEdgeFilter={setEdgeFilter}
        query={queryInput}
        setQuery={setQueryInput}
        counts={counts}
        loading={loading}
        onFit={fit}
        onExport={exportGraph}
        onCreateClick={setCreateModal}
        hideInverseOf={hideInverseOf}
        setHideInverseOf={setHideInverseOf}
        hideEquivImports={hideEquivImports}
        setHideEquivImports={setHideEquivImports}
        hideInherited={hideInherited}
        setHideInherited={setHideInherited}
      />
      {/* The graph canvas always takes the full available space. The detail panel
          floats above the canvas on the right rather than consuming horizontal
          real estate, so the graph stays fully horizontal when opened. */}
      <div className="flex-1 relative min-h-0">
        <div ref={containerRef} className="absolute inset-0 w-full h-full graph-canvas" />

        {error && (
          <div className="absolute top-3 left-3 panel px-3 py-2 text-sm text-red-300 border-red-500/60 z-10">
            {error}
          </div>
        )}
        {loading && (
          <div className="absolute top-3 right-3 panel px-3 py-2 text-xs text-slate-300 z-10">
            Loading graph…
          </div>
        )}
        {counts.n === 0 && !loading && (
          <div className="absolute inset-0 grid place-items-center text-slate-500 pointer-events-none">
            <div className="text-center">
              <div className="text-lg mb-2">No ontology data yet</div>
              <div className="text-sm">
                Import a Turtle file or create classes to see the graph.
              </div>
            </div>
          </div>
        )}

        <aside
          className={`absolute top-0 right-0 bottom-0 w-100 max-w-[90vw] border-l border-ink-700
                      bg-ink-950/95 backdrop-blur-md overflow-auto shadow-2xl shadow-black/60
                      transition-transform duration-200 ease-out z-20
                      ${selected || selectedEdge ? "translate-x-0" : "translate-x-full pointer-events-none"}`}
        >
          {selected && linkedNodesData.has(selected) ? (
            <LinkedGraphNodePanel
              data={linkedNodesData.get(selected)}
              kind={selectedKind || "class"}
              onClose={() => {
                clearSelection();
                cyRef.current?.elements().removeClass("faded");
              }}
              onUpdate={() => setReloadKey((k) => k + 1)}
            />
          ) : selected ? (
            <EntityDetail
              iri={selected}
              kind={selectedKind || "class"}
              compact
              onClose={() => {
                clearSelection();
                cyRef.current?.elements().removeClass("faded");
              }}
              onDelete={() => {
                clearSelection();
                cyRef.current?.elements().removeClass("faded");
                setReloadKey((k) => k + 1);
              }}
              onUpdate={() => {
                refreshNodeLabel(selected);
                setReloadKey((k) => k + 1);
              }}
            />
          ) : null}
          {selectedEdge && selectedEdge.kind === "objectProperty" && selectedEdge.iri ? (
            /* Object property edge — render the full entity editor for the property */
            <EntityDetail
              iri={selectedEdge.iri}
              kind="object"
              compact
              onClose={() => {
                setSelectedEdge(null);
                cyRef.current?.elements().removeClass("faded");
              }}
              onDelete={() => {
                setSelectedEdge(null);
                cyRef.current?.elements().removeClass("faded");
                setReloadKey((k) => k + 1);
              }}
              onUpdate={() => {
                refreshNodeLabel(selectedEdge.iri);
                setReloadKey((k) => k + 1);
              }}
            />
          ) : selectedEdge ? (
            /* Hierarchy / other edges — summary panel */
            <EdgeDetailPanel
              edge={selectedEdge}
              entity={edgeEntity}
              cyRef={cyRef}
              onClose={() => setSelectedEdge(null)}
              onDeleted={() => {
                setSelectedEdge(null);
                cyRef.current?.elements().removeClass("faded");
                setReloadKey((k) => k + 1);
              }}
              onNavigate={(route, iri) => navigate(`${route}#iri=${encodeURIComponent(iri)}`)}
              onSelectNode={(nodeIri, nodeKind) => {
                setSelectedEdge(null);
                selectNode(nodeIri, nodeKind);
                // Re-focus the graph on the newly selected node.
                const cy = cyRef.current;
                if (cy) {
                  const node = cy.getElementById(nodeIri);
                  cy.batch(() => {
                    cy.elements().addClass("faded");
                    visibleHood(node).removeClass("faded");
                  });
                }
              }}
            />
          ) : null}
        </aside>
      </div>

      {createModal === "class" && (
        <GraphNewClassModal
          onClose={() => setCreateModal(null)}
          onCreated={() => {
            setCreateModal(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
      {createModal === "property" && (
        <GraphNewPropertyModal
          onClose={() => setCreateModal(null)}
          onCreated={() => {
            setCreateModal(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
      {createModal === "individual" && (
        <GraphNewIndividualModal
          onClose={() => setCreateModal(null)}
          onCreated={() => {
            setCreateModal(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function Toolbar({
  mode,
  setMode,
  layout,
  setLayout,
  edgeFilter,
  setEdgeFilter,
  query,
  setQuery,
  counts,
  loading,
  onFit,
  onExport,
  onCreateClick,
  hideInverseOf,
  setHideInverseOf,
  hideEquivImports,
  setHideEquivImports,
  hideInherited,
  setHideInherited,
}) {
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const createBtnRef = useRef(null);
  const createMenuRef = useRef(null);

  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportMenuPos, setExportMenuPos] = useState({ top: 0, left: 0 });
  const exportBtnRef = useRef(null);
  const exportMenuRef = useRef(null);

  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [settingsMenuPos, setSettingsMenuPos] = useState({ top: 0, left: 0 });
  const settingsBtnRef = useRef(null);
  const settingsMenuRef = useRef(null);

  // Open menu: capture button position so the portal can be placed under it.
  const openMenu = useCallback(() => {
    const rect = createBtnRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left });
    setShowCreateMenu(true);
  }, []);

  const openExportMenu = useCallback(() => {
    const rect = exportBtnRef.current?.getBoundingClientRect();
    // Right-align the menu to the button's right edge (w-44 = 176 px) so it
    // doesn't overflow off-screen when the button is near the right edge.
    if (rect) setExportMenuPos({ top: rect.bottom + 4, left: rect.right - 176 });
    setShowExportMenu(true);
  }, []);

  const openSettingsMenu = useCallback(() => {
    const rect = settingsBtnRef.current?.getBoundingClientRect();
    if (rect) setSettingsMenuPos({ top: rect.bottom + 4, left: rect.right - 240 });
    setShowSettingsMenu(true);
  }, []);

  // Close the Create dropdown when the user clicks outside both the button and menu.
  // The menu is rendered in a portal so we must check both refs.
  useEffect(() => {
    if (!showCreateMenu) return;
    const handler = (e) => {
      if (!createBtnRef.current?.contains(e.target) && !createMenuRef.current?.contains(e.target)) {
        setShowCreateMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showCreateMenu]);

  // Close the Export dropdown when the user clicks outside.
  useEffect(() => {
    if (!showExportMenu) return;
    const handler = (e) => {
      if (!exportBtnRef.current?.contains(e.target) && !exportMenuRef.current?.contains(e.target)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showExportMenu]);

  // Close the Settings dropdown when the user clicks outside.
  useEffect(() => {
    if (!showSettingsMenu) return;
    const handler = (e) => {
      if (
        !settingsBtnRef.current?.contains(e.target) &&
        !settingsMenuRef.current?.contains(e.target)
      ) {
        setShowSettingsMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSettingsMenu]);

  // Labels respect the terminology setting (friendly vs. RDF).
  const EDGE_FILTER_OPTIONS = [
    { value: "hierarchy", label: "Hierarchy" },
    { value: "relationships", label: term("ObjectPropertyPlural") },
    { value: "both", label: "Both" },
  ];

  return (
    <div className="border-b border-ink-700 bg-ink-900/70 backdrop-blur-sm px-4 py-2 flex items-center gap-3 flex-wrap">
      {/* ── Data mode ── */}
      <div className="flex items-center gap-1 p-1.25 bg-ink-800 rounded-md border border-ink-600">
        {["classes", "individuals", "full"].map((m) => (
          <button
            type="button"
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1 text-xs rounded-sm ${mode === m ? "bg-brand-600 text-white" : "text-slate-300 hover:bg-ink-700"}`}
          >
            {m === "classes"
              ? term("ClassPlural")
              : m === "individuals"
                ? term("IndividualPlural")
                : "Full"}
          </button>
        ))}
      </div>

      {/* ── Edge-type filter ── */}
      <div className="flex items-center gap-1 p-1.25 bg-ink-800 rounded-md border border-ink-600">
        {EDGE_FILTER_OPTIONS.map(({ value, label }) => (
          <button
            type="button"
            key={value}
            onClick={() => setEdgeFilter(value)}
            title={
              value === "hierarchy"
                ? "Show only subClassOf edges"
                : value === "relationships"
                  ? `Show only ${term("ObjectProperty")} edges`
                  : "Show all edge types"
            }
            className={`px-3 py-1 text-xs rounded-sm ${edgeFilter === value ? "bg-brand-600 text-white" : "text-slate-300 hover:bg-ink-700"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Layout algorithm ── */}
      <div className="flex items-center gap-1 p-1.25 bg-ink-800 rounded-md border border-ink-600">
        <LayoutBtn
          name="verticalTree"
          active={layout}
          setActive={setLayout}
          title="Vertical tree"
          icon="vert"
        />
        <LayoutBtn
          name="horizontalTree"
          active={layout}
          setActive={setLayout}
          title="Horizontal tree"
          icon="horiz"
        />
        <LayoutBtn
          name="force"
          active={layout}
          setActive={setLayout}
          title="Force-directed"
          icon="force"
        />
        <LayoutBtn
          name="concentric"
          active={layout}
          setActive={setLayout}
          title="Concentric"
          icon="conc"
        />
        <LayoutBtn name="grid" active={layout} setActive={setLayout} title="Grid" icon="grid" />
      </div>

      {/* ── Settings dropdown ── */}
      <div className="flex items-center gap-1 p-1.25 bg-ink-800 rounded-md border border-ink-600">
        <button
          ref={settingsBtnRef}
          type="button"
          className={"px-2 py-1 rounded-sm text-slate-300 hover:bg-ink-700 flex items-center gap-1"}
          onClick={() => (showSettingsMenu ? setShowSettingsMenu(false) : openSettingsMenu())}
          title="Graph display settings"
          aria-label="Graph display settings"
        >
          <Filter size={14} aria-hidden="true" />
          {(hideInverseOf || hideEquivImports || hideInherited) && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-brand-400 shrink-0"
              title="Some filters active"
              aria-hidden="true"
            />
          )}
        </button>
        {showSettingsMenu &&
          createPortal(
            <div
              ref={settingsMenuRef}
              style={{
                position: "fixed",
                top: settingsMenuPos.top + 5,
                left: settingsMenuPos.left,
                zIndex: 9999,
              }}
              className="w-64 panel shadow-xl border border-ink-600 overflow-hidden"
            >
              <div className="px-4 py-2 text-[10px] text-slate-500 uppercase tracking-wider border-b border-ink-700/60">
                Graph display
              </div>
              <label className="flex items-start gap-3 px-4 py-3 hover:bg-ink-700/40 cursor-pointer border-b border-ink-700/30">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-brand-500 mt-0.5 shrink-0"
                  checked={hideInverseOf}
                  onChange={(e) => setHideInverseOf(e.target.checked)}
                />
                <div>
                  <div className="text-sm text-slate-200">Hide inverse relationships</div>
                  <div className="text-[11px] text-slate-500 leading-relaxed">
                    Filter out <span className="font-mono">owl:inverseOf</span> edges from the graph
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-3 px-4 py-3 hover:bg-ink-700/40 cursor-pointer border-b border-ink-700/30">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-brand-500 mt-0.5 shrink-0"
                  checked={hideEquivImports}
                  onChange={(e) => setHideEquivImports(e.target.checked)}
                />
                <div>
                  <div className="text-sm text-slate-200">Hide equivalent imports</div>
                  <div className="text-[11px] text-slate-500 leading-relaxed">
                    Show only the writable class; hide linked{" "}
                    <span className="font-mono">owl:equivalentClass</span> nodes
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-3 px-4 py-3 hover:bg-ink-700/40 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-brand-500 mt-0.5 shrink-0"
                  checked={hideInherited}
                  onChange={(e) => setHideInherited(e.target.checked)}
                />
                <div>
                  <div className="text-sm text-slate-200">Hide inherited relationships</div>
                  <div className="text-[11px] text-slate-500 leading-relaxed">
                    Hide object property edges inherited by child classes from their parents (teal
                    dashed lines)
                  </div>
                </div>
              </label>
            </div>,
            document.body,
          )}
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="input max-w-xs"
        placeholder="Filter nodes…"
        name="graph-node-filter"
        id="graph-node-filter"
      />

      {/* ── Create dropdown ── */}
      {/* The menu is rendered via a portal on document.body so it escapes the
          toolbar's backdrop-blur stacking context and always sits above the canvas. */}
      <button
        ref={createBtnRef}
        type="button"
        className="btn-primary text-xs px-3 py-1.5"
        onClick={() => (showCreateMenu ? setShowCreateMenu(false) : openMenu())}
      >
        <Plus size={12} aria-hidden="true" className="flex md:hidden" />
        <span className="hidden md:flex items-center gap-1.5">
          Create
          <ChevronDown
            size={11}
            className={`transition-transform ${showCreateMenu ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </span>
      </button>
      {showCreateMenu &&
        createPortal(
          <div
            ref={createMenuRef}
            style={{ position: "fixed", top: menuPos.top, left: menuPos.left, zIndex: 9999 }}
            className="w-52 panel shadow-xl border border-ink-600 py-1 overflow-hidden"
          >
            {[
              { key: "class", label: term("Class") },
              { key: "property", label: term("ObjectProperty") },
              { key: "individual", label: term("Individual") },
            ].map(({ key, label }) => (
              <button
                type="button"
                key={key}
                className="w-full text-left px-4 py-2 text-sm text-slate-200 hover:bg-ink-700 hover:text-white transition-colors"
                onClick={() => {
                  onCreateClick(key);
                  setShowCreateMenu(false);
                }}
              >
                <span className="text-slate-500 text-xs mr-1.5">+</span>
                {label}
              </button>
            ))}
          </div>,
          document.body,
        )}

      <div className="ml-auto flex items-center gap-2 text-xs text-slate-400">
        <span>
          {counts.n} nodes · {counts.e} edges
        </span>
        <button
          type="button"
          className="btn-ghost p-1.5"
          onClick={onFit}
          title="Fit to view"
          aria-label="Fit to view"
        >
          <Maximize size={14} aria-hidden="true" />
        </button>
        {/* ── Export dropdown ── */}
        <button
          ref={exportBtnRef}
          type="button"
          className="btn-ghost p-1.5 flex items-center gap-1"
          onClick={() => (showExportMenu ? setShowExportMenu(false) : openExportMenu())}
          title="Export graph"
          aria-label="Export graph"
        >
          <Download size={14} aria-hidden="true" />
          <ChevronDown
            size={11}
            className={`transition-transform ${showExportMenu ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
        {showExportMenu &&
          createPortal(
            <div
              ref={exportMenuRef}
              style={{
                position: "fixed",
                top: exportMenuPos.top,
                left: exportMenuPos.left,
                zIndex: 9999,
              }}
              className="w-44 panel shadow-xl border border-ink-600 py-1 overflow-hidden"
            >
              {[
                { format: "png", label: "PNG Image", desc: "High-res raster image" },
                { format: "jpg", label: "JPEG Image", desc: "Compressed raster image" },
                { format: "json", label: "JSON Data", desc: "Cytoscape graph data" },
                {
                  format: "markdown",
                  label: "Markdown",
                  desc: "Hierarchical entity list + relationships",
                },
              ].map(({ format, label, desc }) => (
                <button
                  type="button"
                  key={format}
                  className="w-full text-left px-4 py-2 text-sm text-slate-200 hover:bg-ink-700 hover:text-white transition-colors"
                  onClick={() => {
                    onExport(format);
                    setShowExportMenu(false);
                  }}
                >
                  <div>{label}</div>
                  <div className="text-xs text-slate-500">{desc}</div>
                </button>
              ))}
            </div>,
            document.body,
          )}
        {loading && <span className="text-brand-300">…</span>}
      </div>
    </div>
  );
}

function LayoutBtn({ name, active, setActive, title, icon }) {
  const is = active === name;
  return (
    <button
      type="button"
      onClick={() => setActive(name)}
      title={title}
      className={`px-2 py-1 rounded-sm ${is ? "bg-brand-600 text-white" : "text-slate-300 hover:bg-ink-700"}`}
    >
      <LayoutIcon name={icon} />
    </button>
  );
}

function LayoutIcon({ name }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    "aria-hidden": "true",
  };
  switch (name) {
    case "vert":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="9" y="2" width="6" height="6" />
          <rect x="3" y="16" width="6" height="6" />
          <rect x="15" y="16" width="6" height="6" />
          <path d="M12 8v4" />
          <path d="M12 12L6 16" />
          <path d="M12 12l6 4" />
        </svg>
      );
    case "horiz":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="2" y="9" width="6" height="6" />
          <rect x="16" y="3" width="6" height="6" />
          <rect x="16" y="15" width="6" height="6" />
          <path d="M8 12h4" />
          <path d="M12 12l4-6" />
          <path d="M12 12l4 6" />
        </svg>
      );
    case "force":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="6" cy="18" r="2" />
          <circle cx="18" cy="18" r="2" />
          <circle cx="12" cy="12" r="2" />
          <path d="M7 7l4 4M17 7l-4 4M7 17l4-4M17 17l-4-4" />
        </svg>
      );
    case "conc":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1" />
        </svg>
      );
    case "grid":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
      );
    default:
      return null;
  }
}

function TripleTable({ title, rows, iri, direction }) {
  if (!rows?.length)
    return (
      <div className="panel p-3">
        <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">{title}</div>
        <div className="text-xs text-slate-500">None</div>
      </div>
    );
  return (
    <div className="panel p-3">
      <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">
        {title} ({rows.length})
      </div>
      <div className="space-y-1 text-xs font-mono">
        {rows.map((r) => (
          <div
            key={`${r.p?.value || r.s?.value}`}
            className="py-1 border-b border-ink-700 last:border-0"
          >
            <div className="text-brand-300">{predicateLabel((r.p || r.s)?.value)}</div>
            <div className="text-slate-300 break-all pl-2">
              {direction === "out" ? termText(r.o) : termText(r.s)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function termText(t) {
  if (!t) return "";
  if (t.type === "literal")
    return `"${t.value}"${t.language ? `@${t.language}` : ""}${t.datatype && !t.datatype.endsWith("string") ? `^^${shortLabel(t.datatype)}` : ""}`;
  return resourceLabel(t.value);
}

// ── EdgeDetailPanel ──────────────────────────────────────────────────────────
// Shown when the user clicks a subClassOf edge (objectProperty edges with an
// IRI are handled by EntityDetail in the parent component).
// ── LinkedGraphNodePanel ─────────────────────────────────────────────────────
// Panel for a node that originates from a linked context ontology.
// Shows a violet read-only banner above the full EntityDetail so the user
// can inspect all entity details even though the entity is not editable.
function LinkedGraphNodePanel({ data, kind, onClose, onUpdate }) {
  return (
    <>
      {/* Violet linked-context banner */}
      <div className="px-3 pt-3 pb-2.5 flex items-start gap-1.5 border-b border-violet-500/20 bg-violet-500/5">
        <Link size={13} className="shrink-0 mt-0.5 text-violet-400" aria-hidden="true" />
        <p className="text-xs text-violet-300/80 leading-relaxed">
          <strong className="text-violet-200">Linked context</strong> ontology
          {data.sourceOntologyName ? ` (${data.sourceOntologyName})` : ""} — read-only. Switch that
          ontology to full visibility to edit it.
        </p>
      </div>
      {/* Full entity detail — EntityDetail supplies the header and close button */}
      <EntityDetail
        iri={data.iri}
        kind={kind || "class"}
        compact
        onClose={onClose}
        onDelete={() => {}}
        onUpdate={onUpdate ?? (() => {})}
      />
    </>
  );
}

// BFS traversal over subClassOf edges in the Cytoscape graph.
// direction "up"   → follow edge targets (child → parent direction)
// direction "down" → follow edge sources (parent → child direction)
function bfsSubClassOf(cy, startIri, direction) {
  if (!cy) return [];
  const visited = new Set();
  const queue = [startIri];
  const result = [];
  while (queue.length) {
    const cur = queue.shift();
    const node = cy.getElementById(cur);
    if (!node.length) continue;
    const edges = cy.edges('[kind = "subClassOf"]');
    edges.forEach((e) => {
      const src = e.data("source");
      const tgt = e.data("target");
      const neighbor = direction === "up" ? (src === cur ? tgt : null) : tgt === cur ? src : null;
      if (neighbor && !visited.has(neighbor) && neighbor !== startIri) {
        visited.add(neighbor);
        result.push(neighbor);
        queue.push(neighbor);
      }
    });
  }
  return result;
}

function EdgeDetailPanel({ edge, entity, cyRef, onClose, onDeleted, onNavigate, onSelectNode }) {
  const isObjectProp = edge.kind === "objectProperty";
  const parentIri = edge.target;
  const childIri = edge.source;
  const heading = isObjectProp ? term("ObjectProperty") : "Hierarchy Relationship";

  const [kebabOpen, setKebabOpen] = useState(false);
  const kebabRef = useRef(null);
  useEffect(() => {
    if (!kebabOpen) return;
    const handler = (e) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target)) setKebabOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [kebabOpen]);

  const deleteRelationship = async () => {
    setKebabOpen(false);
    if (
      !confirm(
        `Remove subClassOf relationship between ${shortLabel(childIri)} and ${shortLabel(parentIri)}?`,
      )
    )
      return;
    const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
    try {
      await api.deleteTriple({
        s: childIri,
        p: RDFS_SUB_CLASS_OF,
        o: parentIri,
        objectKind: "uri",
      });
      onDeleted?.();
    } catch (e) {
      alert(e.message);
    }
  };

  const ancestors = useMemo(
    () => (!isObjectProp && cyRef?.current ? bfsSubClassOf(cyRef.current, parentIri, "up") : []),
    [isObjectProp, cyRef, parentIri],
  );
  const descendants = useMemo(
    () => (!isObjectProp && cyRef?.current ? bfsSubClassOf(cyRef.current, childIri, "down") : []),
    [isObjectProp, cyRef, childIri],
  );

  const nodeLabel = (iri) => {
    const n = cyRef?.current?.getElementById(iri);
    return (n?.length && n.data("label")) || shortLabel(iri);
  };

  const editIcon = <Edit size={12} aria-hidden="true" />;

  return (
    <div className="p-4 space-y-3">
      {/* ── Header ── */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-slate-500 uppercase tracking-wider">{heading}</div>
          {edge.iri && (
            <div className="text-[11px] text-slate-500 break-all mt-0.5">{edge.iri}</div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Kebab menu */}
          {!isObjectProp && (
            <div ref={kebabRef} className="relative">
              <button
                type="button"
                className="btn-ghost p-1"
                onClick={() => setKebabOpen((o) => !o)}
                title="Actions"
                aria-label="Actions menu"
              >
                <MoreVertical size={16} aria-hidden="true" />
              </button>
              {kebabOpen && (
                <div className="absolute right-0 top-full mt-1 w-52 bg-ink-800 border border-ink-600 rounded-md shadow-2xl shadow-black/60 z-30 overflow-hidden">
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-ink-700/60 transition-colors"
                    onClick={() => {
                      setKebabOpen(false);
                      onSelectNode?.(parentIri, "class");
                    }}
                  >
                    Open parent: {shortLabel(parentIri)}
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-ink-700/60 transition-colors"
                    onClick={() => {
                      setKebabOpen(false);
                      onSelectNode?.(childIri, "class");
                    }}
                  >
                    Open child: {shortLabel(childIri)}
                  </button>
                  <div className="border-t border-ink-700/60" />
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm text-red-300 hover:bg-ink-700/60 transition-colors"
                    onClick={deleteRelationship}
                  >
                    Delete relationship…
                  </button>
                </div>
              )}
            </div>
          )}
          <button type="button" className="btn-ghost p-1" onClick={onClose} title="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* ── Relationship summary — clickable node chips ── */}
      <div className="panel divide-y divide-ink-700/60 text-xs">
        {/* Parent first */}
        <div className="px-3 py-2.5 flex items-center gap-2">
          <span className="text-slate-500 shrink-0 w-12">Parent:</span>
          <button
            type="button"
            title={parentIri}
            className="flex-1 min-w-0 text-left text-brand-300 font-mono break-all hover:text-brand-100 hover:underline transition-colors"
            onClick={() => onSelectNode?.(parentIri, "class")}
          >
            {shortLabel(parentIri)}
          </button>
        </div>
        <div className="px-3 py-2 flex items-center gap-2">
          <span className="text-slate-500 shrink-0 w-12">Via:</span>
          <span className="text-emerald-300 font-mono">{edge.label || edge.kind}</span>
        </div>
        {/* Child second */}
        <div className="px-3 py-2.5 flex items-center gap-2">
          <span className="text-slate-500 shrink-0 w-12">Child:</span>
          <button
            type="button"
            title={childIri}
            className="flex-1 min-w-0 text-left text-brand-300 font-mono break-all hover:text-brand-100 hover:underline transition-colors"
            onClick={() => onSelectNode?.(childIri, "class")}
          >
            {shortLabel(childIri)}
          </button>
        </div>
      </div>

      {/* ── Ancestors of parent ── */}
      {!isObjectProp && (
        <AncestorDescendantList
          title={`Ancestors (${ancestors.length})`}
          items={ancestors}
          nodeLabel={nodeLabel}
          onSelectNode={onSelectNode}
          emptyText="No further ancestors"
        />
      )}

      {/* ── Descendants of child ── */}
      {!isObjectProp && (
        <AncestorDescendantList
          title={`Descendants (${descendants.length})`}
          items={descendants}
          nodeLabel={nodeLabel}
          onSelectNode={onSelectNode}
          emptyText="No descendants"
        />
      )}

      {/* ── Action buttons (objectProperty only) ── */}
      {isObjectProp && edge.iri && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="btn-primary text-xs inline-flex items-center gap-1.5"
            onClick={() => onNavigate("/properties/relationships", edge.iri)}
          >
            {editIcon}
            Edit in {term("ObjectPropertyPlural")}
          </button>
        </div>
      )}

      {/* ── Property triples (objectProperty only — fallback, normally handled by EntityDetail) ── */}
      {isObjectProp &&
        edge.iri &&
        (entity ? (
          <>
            <TripleTable title="Outgoing" rows={entity.outgoing} iri={edge.iri} direction="out" />
            <TripleTable title="Incoming" rows={entity.incoming} iri={edge.iri} direction="in" />
          </>
        ) : (
          <div className="text-xs text-slate-500">Loading…</div>
        ))}
    </div>
  );
}

function AncestorDescendantList({ title, items, nodeLabel, onSelectNode, emptyText }) {
  return (
    <div className="panel overflow-hidden">
      <div className="px-3 py-2 border-b border-ink-700/60">
        <span className="text-xs font-medium text-slate-300">{title}</span>
      </div>
      <div className="divide-y divide-ink-700/30">
        {items.length === 0 ? (
          <div className="px-3 py-2 text-xs text-slate-500">{emptyText}</div>
        ) : (
          items.map((iri) => (
            <button
              key={iri}
              type="button"
              title={iri}
              className="w-full text-left px-3 py-2 text-xs text-brand-300 font-mono hover:bg-ink-800/50 hover:text-brand-100 transition-colors truncate"
              onClick={() => onSelectNode?.(iri, "class")}
            >
              {nodeLabel(iri)}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── Graph creation modals ─────────────────────────────────────────────────────
// Self-contained modals for creating new entities directly from the graph view.
// Each modal loads its own data so GraphView has no extra pre-fetch dependencies.

function _iriBase(ontologyIri) {
  const raw = ontologyIri || "http://example.org/ontology";
  return raw.endsWith("#") || raw.endsWith("/") ? raw : `${raw}#`;
}

function toPascalCase(str) {
  return str
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function toCamelCase(str) {
  const words = str
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  return (
    words[0].toLowerCase() +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("")
  );
}

function GraphNewClassModal({ onClose, onCreated }) {
  const { currentOntology } = useProject();
  const [iri, setIri] = useState(() => `${_iriBase(currentOntology?.iri)}NewClass`);
  const [iriUserEdited, setIriUserEdited] = useState(false);
  const [label, setLabel] = useState("");
  const [definition, setDefinition] = useState("");
  const [parent, setParent] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [allClasses, setAllClasses] = useState([]);

  useEffect(() => {
    if (iriUserEdited) return;
    const base = _iriBase(currentOntology?.iri);
    const slug = label.trim() ? toPascalCase(label) || "NewClass" : "NewClass";
    setIri(`${base}${slug}`);
  }, [label, iriUserEdited, currentOntology?.iri]);

  useEffect(() => {
    api
      .classes()
      .then((r) => setAllClasses(r.classes || []))
      .catch(() => {});
  }, []);

  const parentOptions = useMemo(() => {
    const list = allClasses.map((c) => ({
      iri: c.iri.value,
      label: c.prefLabel?.value || c.label?.value || shortLabel(c.iri.value),
    }));
    list.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    return list;
  }, [allClasses]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createClass({
        iri,
        label: label || undefined,
        definition: definition || undefined,
        subClassOf: parent ? [parent] : undefined,
      });
      onCreated(iri);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`New ${term("Class")}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Label">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="IRI">
          <input
            className="input"
            value={iri}
            onChange={(e) => {
              setIriUserEdited(true);
              setIri(e.target.value);
            }}
            required
          />
        </Field>
        <Field label="Definition">
          <textarea
            className="input min-h-15"
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
          />
        </Field>
        <Field label={`Parent ${term("Class").toLowerCase()} (subClassOf)`}>
          <select className="input" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">(none)</option>
            {parentOptions.map((c) => (
              <option key={c.iri} value={c.iri}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        {err && <div className="text-sm text-red-300">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function GraphNewPropertyModal({ onClose, onCreated }) {
  const { currentOntology } = useProject();
  const [iri, setIri] = useState(() => `${_iriBase(currentOntology?.iri)}newObjectProperty`);
  const [iriUserEdited, setIriUserEdited] = useState(false);
  const [label, setLabel] = useState("");
  const [definition, setDefinition] = useState("");
  const [domain, setDomain] = useState("");
  const [range, setRange] = useState("");
  const [characteristics, setCharacteristics] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [allClasses, setAllClasses] = useState([]);

  useEffect(() => {
    if (iriUserEdited) return;
    const base = _iriBase(currentOntology?.iri);
    const slug = label.trim() ? toCamelCase(label) || "newObjectProperty" : "newObjectProperty";
    setIri(`${base}${slug}`);
  }, [label, iriUserEdited, currentOntology?.iri]);

  useEffect(() => {
    api
      .classes()
      .then((r) => setAllClasses(r.classes || []))
      .catch(() => {});
  }, []);

  const classOptions = useMemo(() => {
    const list = allClasses.map((c) => ({
      iri: c.iri.value,
      label: c.prefLabel?.value || c.label?.value || shortLabel(c.iri.value),
    }));
    list.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    return list;
  }, [allClasses]);

  const toggleChar = (name) =>
    setCharacteristics((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );

  const advancedOptions = allowedCharacteristics("object");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createProperty({
        iri,
        kind: "object",
        label: label || undefined,
        definition: definition || undefined,
        domain: domain || undefined,
        range: range || undefined,
        characteristics: characteristics.length ? characteristics : undefined,
      });
      onCreated(iri);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`New ${term("ObjectProperty")}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Label">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="IRI">
          <input
            className="input"
            value={iri}
            onChange={(e) => {
              setIriUserEdited(true);
              setIri(e.target.value);
            }}
            required
          />
        </Field>
        <Field label="Definition">
          <textarea
            className="input min-h-15"
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
          />
        </Field>
        <Field label={`${term("domain")} (${term("Class").toLowerCase()})`}>
          <select className="input" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">(none)</option>
            {classOptions.map((c) => (
              <option key={c.iri} value={c.iri}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`${term("range")} (${term("Class").toLowerCase()})`}>
          <select className="input" value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="">(none)</option>
            {classOptions.map((c) => (
              <option key={c.iri} value={c.iri}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        {advancedOptions.length > 0 && (
          <div className="border-t border-ink-700/80 pt-2">
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="w-full flex items-center justify-between text-xs text-slate-400 hover:text-slate-200"
            >
              <span className="uppercase tracking-wider">
                Advanced · characteristics
                {characteristics.length ? ` (${characteristics.length})` : ""}
              </span>
              <ChevronDown
                size={12}
                className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
            {showAdvanced && (
              <div className="mt-2 flex flex-wrap gap-2">
                {advancedOptions.map((c) => {
                  const on = characteristics.includes(c.name);
                  return (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => toggleChar(c.name)}
                      title={c.tip}
                      className={`px-2.5 py-1 rounded-full border text-xs transition ${
                        on
                          ? "bg-brand-600 border-brand-400 text-white"
                          : "bg-ink-800 border-ink-600 text-slate-300 hover:bg-ink-700"
                      }`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {err && <div className="text-sm text-red-300">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function GraphNewIndividualModal({ onClose, onCreated }) {
  const { currentOntology } = useProject();
  const [iri, setIri] = useState(() => `${_iriBase(currentOntology?.iri)}newIndividual`);
  const [iriUserEdited, setIriUserEdited] = useState(false);
  const [label, setLabel] = useState("");
  const [type, setType] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [allClasses, setAllClasses] = useState([]);

  useEffect(() => {
    if (iriUserEdited) return;
    const base = _iriBase(currentOntology?.iri);
    const slug = label.trim() ? toCamelCase(label) || "newIndividual" : "newIndividual";
    setIri(`${base}${slug}`);
  }, [label, iriUserEdited, currentOntology?.iri]);

  useEffect(() => {
    api
      .classes()
      .then((r) => setAllClasses(r.classes || []))
      .catch(() => {});
  }, []);

  const classOptions = useMemo(() => {
    const list = allClasses.map((c) => ({
      iri: c.iri.value,
      label: c.prefLabel?.value || c.label?.value || shortLabel(c.iri.value),
    }));
    list.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    return list;
  }, [allClasses]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createIndividual({
        iri,
        label: label || undefined,
        types: type ? [type] : undefined,
      });
      onCreated(iri);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`New ${term("Individual")}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Label">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="IRI">
          <input
            className="input"
            value={iri}
            onChange={(e) => {
              setIriUserEdited(true);
              setIri(e.target.value);
            }}
            required
          />
        </Field>
        <Field label={`Type (${term("Class").toLowerCase()})`}>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">(none)</option>
            {classOptions.map((c) => (
              <option key={c.iri} value={c.iri}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        {err && <div className="text-sm text-red-300">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
