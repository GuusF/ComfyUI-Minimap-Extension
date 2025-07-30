/*
 * Enhanced Minimap for ComfyUI with additional features
 *
 * This script implements a minimap overlay for the ComfyUI graph.  It
 * draws a scaled representation of the current graph in the bottom‑right
 * corner of the viewport, including the connections between nodes.  Error
 * nodes are highlighted in red, bypassed nodes are highlighted in the
 * same purple as the main UI, and the minimap fades out after a period
 * of inactivity (default 3 seconds).  Dragging on the minimap pans the
 * main graph accordingly.  When image preview nodes (e.g. Preview Image
 * or Load Image) are present, a tiny preview of the image is drawn in
 * the node box on the minimap.
 */

import { api } from "../../scripts/api.js";

console.log("Enhanced minimap extension with previews loaded");

// Height of the node title bar in pixels.  This value is used when
// calculating node geometry for the minimap.  It matches the value used in
// ComfyUI's LiteGraph implementation.
const NODE_TITLE_HEIGHT = 30;

// Keep track of the currently executing node (highlighted in green).
let currentExecutingNode = "0";

// Variables for fade behaviour.  When the user interacts with the graph
// (mouse move, zoom, drag), lastActivityTime is updated.  If no activity
// occurs for FADE_DELAY milliseconds the minimap will fade out.
let lastActivityTime = Date.now();
const FADE_DELAY = 3000; // milliseconds

// Cache for image previews so we don't reload the same image repeatedly.
const previewCache = new Map();

/**
 * Determine whether a node should be considered in an error state.
 * ComfyUI marks invalid nodes via a variety of flags; this helper
 * attempts to cover the most common ones.  If none are present, the node
 * is treated as non‑error.
 *
 * @param {Object} node - The node to check.
 * @returns {boolean} true if the node is in an error state.
 */
function isNodeError(node) {
    try {
        if (node == null) return false;
        // ComfyUI sets these flags when a node fails to execute.  Some
        // versions use has_error, others use has_errors (plural).  Check both.
        if (node.error === true || node.has_error === true || node.has_errors === true) return true;
        // Some versions expose an invalid flag directly on the node
        if (node.invalid === true || node.is_invalid === true || node.isInvalid === true) return true;
        // Some nodes contain a flags object with error information
        if (node.flags && (node.flags.error || node.flags.invalid)) return true;
        // widgets_invalid is an array of widgets that failed validation
        if (Array.isArray(node.widgets_invalid) && node.widgets_invalid.length > 0) return true;
        // If the node colour explicitly references red / error
        const c = String(node.color || "").toLowerCase();
        if (c.includes("error") || c.includes("ff0000") || c.includes("dc2626") || c.includes("e13")) return true;
    } catch (err) {
        // fallthrough
    }
    return false;
}

/**
 * Determine whether a node is bypassed.  The bypass state can be stored
 * on different properties depending on the version of ComfyUI.  We check
 * multiple possibilities for robustness.
 *
 * @param {Object} node - The node to check.
 * @returns {boolean} true if the node is bypassed.
 */
function isNodeBypassed(node) {
    try {
        if (!node) return false;
        // Common flags used in various versions of ComfyUI
        if (node.bypassed === true || node.is_bypassed === true) return true;
        if (node.bypass === true) return true;
        if (node.flags && (node.flags.bypassed === true || node.flags.bypass === true)) return true;
        // Some versions may use muted to skip execution entirely
        if (node.flags && node.flags.muted === true) return true;
        // Additional flags used in some versions to signal bypass/disabled state
        if (node.flags && (node.flags.disabled === true || node.flags.skip === true || node.flags.skipped === true)) return true;
        // Check if the node exposes an isBypassed() helper or boolean flag
        if (typeof node.isBypassed === "function") {
            try {
                if (node.isBypassed()) return true;
            } catch (_) {
                // ignore any errors
            }
        }
        if (node.isBypassed === true) return true;
        // New detection: some versions of ComfyUI use the LiteGraph event mode to
        // signal bypass.  When a node is set to BYPASS mode, its `mode`
        // property will equal the BYPASS constant defined in LGraphEventMode.
        // The enum value is 4 in current builds.  We fall back to checking
        // against the numeric value to avoid importing LiteGraph directly.
        try {
            if (typeof node.mode !== "undefined") {
                // Attempt to detect the BYPASS constant from LiteGraph if
                // available.  Otherwise assume 4.
                let bypassModeValue = 4;
                if (typeof LiteGraph !== "undefined" &&
                    LiteGraph.LGraphEventMode &&
                    typeof LiteGraph.LGraphEventMode.BYPASS !== "undefined") {
                    bypassModeValue = LiteGraph.LGraphEventMode.BYPASS;
                }
                // node.mode may be numeric or string (e.g. "BYPASS")
                if (node.mode === bypassModeValue ||
                    String(node.mode).toUpperCase() === "BYPASS") {
                    return true;
                }
            }
        } catch (_) {
            // ignore errors if LiteGraph is not defined
        }
        // Some nodes change their colour when bypassed.  If the colour
        // matches the default bypass purple (approx. #a855f7) we treat it as bypassed.
        const colourStr = String(node.color || "").toLowerCase();
        if (colourStr.includes("a855f7") || colourStr.includes("purple")) return true;
    } catch (err) {
        // ignore errors
    }
    return false;
}

/**
 * Attempt to obtain a preview image source from a node.  For image preview
 * nodes (such as Preview Image and Load Image), ComfyUI inserts an <img>
 * element into the node's DOM.  We first try to locate such an element.
 * Failing that, we inspect widget values for base64 image data.  If
 * successful, returns a data URI or URL that can be drawn onto a canvas.
 *
 * @param {Object} node - The node whose preview to retrieve.
 * @returns {string|null} A data URI/URL for the image, or null if none found.
 */
function getNodePreviewImage(node) {
    try {
        const idStr = node?.id != null ? String(node.id) : "";
        const container = document.getElementById(`node-${idStr}`);
        if (!container) return null;

        // First try <img>
        const imgEl = container.querySelector("img");
        if (imgEl && imgEl.src?.startsWith("data:image")) return imgEl.src;

        // Then try <canvas>
        const canvasEl = container.querySelector("canvas");
        if (canvasEl) {
            try {
                const dataUri = canvasEl.toDataURL();
                if (dataUri && dataUri.startsWith("data:image")) return dataUri;

                // If not ready yet, observe for changes and re-render
                const observer = new MutationObserver(() => {
                    const newUri = canvasEl.toDataURL();
                    if (newUri && newUri.startsWith("data:image")) {
                        previewCache.set(newUri, new Image());
                        renderMiniMap(window.app.graph, document.querySelector("#minimap canvas"));
                        observer.disconnect();
                    }
                });
                observer.observe(canvasEl, { attributes: true, childList: true, subtree: true });
            } catch (_) {
                // Canvas not ready yet
            }
        }

        // Final fallback: widget value
        if (node.widgets) {
            for (const w of node.widgets) {
                const val = w?.value?.data || w?.value;
                if (typeof val === "string" && val.startsWith("data:image")) return val;
            }
        }
    } catch (err) {
        // Silent fail
    }

    return null;
}




/**
 * Draw a tiny preview image inside a node rectangle on the minimap.  This
 * function caches images and scales them to fit within the node bounds
 * while preserving aspect ratio.  If the image is not yet loaded, it
 * registers an onload callback to trigger a re-render once loaded.
 *
 * @param {CanvasRenderingContext2D} ctx - The minimap canvas context.
 * @param {Object} node - The node being drawn.
 * @param {number} x - The x coordinate of the node on the minimap.
 * @param {number} y - The y coordinate of the node on the minimap.
 * @param {number} w - The width of the node on the minimap.
 * @param {number} h - The height of the node on the minimap.
 */
function drawNodePreview(ctx, node, x, y, w, h) {
    const src = getNodePreviewImage(node);
    // If no preview image is available just return.  We intentionally do not
    // draw a white square placeholder to avoid cluttering the minimap with
    // empty image boxes.
    if (!src) {
        return;
    }
    let img = previewCache.get(src);
    if (!img) {
        img = new Image();
        img.src = src;
        previewCache.set(src, img);
        img.onload = () => {
            // Once loaded, schedule a re-render of the minimap
            if (window.app && window.app.graph && ctx.canvas) {
                renderMiniMap(window.app.graph, ctx.canvas);
            }
        };
    }
    // Only draw if the image is loaded
    if (!img.complete || img.naturalWidth === 0) return;
    // Compute aspect ratio and fit within node bounds
    const aspect = img.width / img.height;
    let drawW = w;
    let drawH = h;
    if (drawH <= 0 || drawW <= 0) return;
    if (drawW / drawH > aspect) {
        // Canvas is wider relative to image
        drawW = drawH * aspect;
    } else {
        // Canvas is taller relative to image
        drawH = drawW / aspect;
    }
    const offsetX = x + (w - drawW) / 2;
    const offsetY = y + (h - drawH) / 2;
    try {
        ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
    } catch (err) {
        // ignore drawing errors
    }
}

// Create and insert the minimap container and canvas.  The minimap is
// positioned fixed in the bottom‑right corner and uses a CSS transition
// on its opacity so that it can fade in and out smoothly.  We deliberately
// omit any extra height padding so that the full minimap area is used.
function createMiniMapCanvas(settings) {
    const minimapDiv = document.createElement("div");
    minimapDiv.id = "minimap";
    minimapDiv.style.position = "fixed";
    // Move slightly left to avoid overlap with ComfyUI scrollbars
    minimapDiv.style.right = (settings.margin + 50) + "px";
    minimapDiv.style.bottom = settings.margin + "px";
    minimapDiv.style.width = settings.width + "px";
    minimapDiv.style.height = settings.height + "px"; // use full height, no padding
    minimapDiv.style.border = "1px solid var(--border-color)";
    minimapDiv.style.backgroundColor = "var(--bg-color)";
    minimapDiv.style.zIndex = 1000;
    minimapDiv.style.opacity = settings.opacity;
    minimapDiv.style.transition = "opacity 0.5s ease";
    minimapDiv.style.overflow = "hidden";
    minimapDiv.style.borderRadius = "6px";  // Slightly rounded corners

    document.body.appendChild(minimapDiv);

    const minimapCanvas = document.createElement("canvas");
    minimapCanvas.width = settings.width;
    minimapCanvas.height = settings.height;
    minimapDiv.appendChild(minimapCanvas);

    return { minimapDiv, minimapCanvas };
}

// Get a sensible default colour for a link based on its type.  If the link
// specifies its own colour it will take precedence; otherwise ComfyUI's
// default connection colour is used.  Fallbacks are provided for common
// primitive types.
function getLinkColor(link) {
    const type = link.type;
    let color = window.app?.canvas?.default_connection_color_byType?.[type];
    if (!color || color === "") {
        switch (type) {
            case "STRING":
            case "INT":
                color = "#77ff77";
                break;
            default:
                color = link.color || "#666";
                break;
        }
    }
    return color;
}

// Calculate the bounds of all nodes and groups in the graph.  These
// coordinates are used to scale and translate the graph into the minimap.
function getGraphBounds(graph) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    // Nodes
    graph._nodes.forEach(node => {
        if (node.pos[0] < minX) minX = node.pos[0];
        if (node.pos[1] < minY) minY = node.pos[1];
        if (node.pos[0] + node.size[0] > maxX) maxX = node.pos[0] + node.size[0];
        if (node.pos[1] + node.size[1] > maxY) maxY = node.pos[1] + node.size[1];
    });

    // Groups
    graph._groups.forEach(group => {
        if (group.pos[0] < minX) minX = group.pos[0];
        if (group.pos[1] < minY) minY = group.pos[1];
        if (group.pos[0] + group.size[0] > maxX) maxX = group.pos[0] + group.size[0];
        if (group.pos[1] + group.size[1] > maxY) maxY = group.pos[1] + group.size[1];
    });

    return {
        left: minX,
        top: minY,
        width: maxX - minX,
        height: maxY - minY
    };
}

// Render the scaled representation of the graph onto the minimap canvas.
function renderMiniMap(graph, canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Determine the background colour of the main canvas so that the minimap
    // visually matches the workflow area.  Fallback to transparent.
    const mainCanvas = document.querySelector("canvas");
    const bgColour = getComputedStyle(mainCanvas).backgroundColor || "transparent";

    // Clear and fill background
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = bgColour;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Compute scale factor so entire graph fits in the minimap; add a small
    // padding (200px) to avoid clipping at the edges.
    const bounds = getGraphBounds(graph);
    const scaleX = canvas.width / (bounds.width + 200);
    const scaleY = canvas.height / (bounds.height + 200);
    const scale = Math.min(scaleX, scaleY);

    // Draw links first so they appear underneath nodes
    graph.links.forEach(link => {
        const originNode = graph._nodes_by_id[link.origin_id];
        const targetNode = graph._nodes_by_id[link.target_id];
        if (!originNode || !targetNode) return;
        ctx.strokeStyle = getLinkColor(link);
        ctx.lineWidth = 0.5;
        // Compute positions along the edge of the origin and target nodes
        const [ox, oy, tx, ty] = getLinkPosition(originNode, targetNode, bounds, link, scale);
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        // Save positions for drawing connection dots later
        link._originPos = { x: ox, y: oy };
        link._targetPos = { x: tx, y: ty };
    });

    // Draw groups (semi‑transparent)
    ctx.globalAlpha = 0.35;
    graph._groups.forEach(group => {
        const x = (group.pos[0] - bounds.left) * scale;
        const y = (group.pos[1] - bounds.top) * scale;
        const width = group.size[0] * scale;
        const height = group.size[1] * scale;
        ctx.fillStyle = group.color || "#ccc";
        ctx.fillRect(x, y, width, height);
    });
    ctx.globalAlpha = 1.0;

    // Draw nodes on top
    graph._nodes.forEach(node => {
        // Determine base colour for node
        let nodeColour = node.color || getComputedStyle(document.documentElement).getPropertyValue("--comfy-menu-bg").trim();
        // If the node is collapsed adjust width/height accordingly
        let width = node.size[0];
        let height = node.size[1] + NODE_TITLE_HEIGHT;
        if (node.flags?.collapsed) {
            width = node._collapsed_width;
            height = NODE_TITLE_HEIGHT;
        }
        // Compute scaled coordinates
        const x = (node.pos[0] - bounds.left) * scale;
        const y = (node.pos[1] - bounds.top - (node.isVirtualNode ? 0 : NODE_TITLE_HEIGHT)) * scale;
        const w = width * scale;
        const h = height * scale;

        // Determine fill style based on state.  Errors take precedence over
        // bypassed nodes, followed by normal colouring.  The alpha values
        // provide a translucent overlay so that previews remain visible.
        if (isNodeError(node)) {
            ctx.fillStyle = "rgba(255, 0, 0, 0.7)"; // red for error
        } else if (isNodeBypassed(node)) {
            // Use a slightly more opaque purple so bypassed nodes are
            // distinguishable even at small scales
            ctx.fillStyle = "rgba(168, 85, 247, 0.8)"; // purple for bypass
        } else {
            ctx.fillStyle = nodeColour;
        }
        ctx.fillRect(x, y, w, h);

        // Draw preview image if available.  Only attempt to draw previews
        // when the node rectangle is sufficiently large; small nodes
        // (collapsed or tiny) won't fit a preview.
        if (w > 10 && h > 10) {
            drawNodePreview(ctx, node, x, y, w, h);
        }

        // Outline error nodes with a red border for better visibility.  Use a
        // slightly thicker stroke so the border remains visible even when
        // scaled down.  We don't scale line width by `scale` directly to
        // avoid extremely thin or thick lines when zooming.
        if (isNodeError(node)) {
            ctx.strokeStyle = "red";
            ctx.lineWidth = 3;
            ctx.strokeRect(x, y, w, h);
        }

        // Outline currently executing node in green.  This is drawn after
        // the error border so that the green frame appears on top.
        if (String(node.id) === String(currentExecutingNode)) {
            ctx.strokeStyle = "green";
            ctx.lineWidth = 1;
            ctx.strokeRect(x, y, w, h);
        }
    });

    // Draw connection dots on top of links when the scale is large enough
    if (scale > 0.15) {
        const drawn = new Set();
        graph.links.forEach(link => {
            if (link._originPos && link._targetPos) {
                const originKey = `${link._originPos.x},${link._originPos.y}`;
                const targetKey = `${link._targetPos.x},${link._targetPos.y}`;
                const dotColor = getLinkColor(link);
                if (!drawn.has(originKey)) {
                    drawDot(ctx, link._originPos.x, link._originPos.y, dotColor, scale);
                    drawn.add(originKey);
                }
                if (!drawn.has(targetKey)) {
                    drawDot(ctx, link._targetPos.x, link._targetPos.y, dotColor, scale);
                    drawn.add(targetKey);
                }
            }
        });
    }

    // Draw viewport rectangle to indicate current view
    drawViewportRectangle(ctx, bounds, scale);
    // Expose scale and bounds on the canvas for click/drag handling
    canvas.scale = scale;
    canvas.bounds = bounds;
}

// Compute a position for link endpoints along the node edges.  This logic
// mirrors the calculation used by ComfyUI to position link lines.  Origin
// links exit from the right of the node; target links enter from the left.
function getLinkPosition(originNode, targetNode, bounds, link, scale) {
    const xOffset = 10;
    const topPadding = 15 * scale;
    const linkPadding = 20 * scale;
    function calcX(node, isOrigin) {
        let w = node.size[0];
        if (node.flags?.collapsed) w = node._collapsed_width;
        const nodeX = node.pos[0] + (isOrigin ? w - xOffset : xOffset);
        return (nodeX - bounds.left) * scale;
    }
    function calcY(node, slot) {
        const baseY = (node.pos[1] - bounds.top) * scale;
        if (node.flags?.collapsed) return baseY - NODE_TITLE_HEIGHT * 0.5 * scale;
        if (node.isVirtualNode) return baseY + node.size[1] * 0.5 * scale;
        return baseY + topPadding + slot * linkPadding;
    }
    const ox = calcX(originNode, true);
    const tx = calcX(targetNode, false);
    const oy = calcY(originNode, link.origin_slot);
    const ty = calcY(targetNode, link.target_slot);
    return [ox, oy, tx, ty];
}

// Draw a small dot at the given coordinate on the minimap canvas.  The
// radius scales with the overall graph scale so that dots remain visible.
function drawDot(ctx, x, y, color, scale) {
    ctx.beginPath();
    ctx.arc(x, y, 3 * scale, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}

// Draw the current viewport rectangle on the minimap.  This rectangle
// represents the portion of the full graph visible in the main canvas.
function drawViewportRectangle(ctx, bounds, scale) {
    const canvasElement = document.querySelector("canvas");
    const ds = window.app?.canvas?.ds;
    if (!ds) return;
    const viewportWidth = canvasElement.clientWidth / ds.scale;
    const viewportHeight = canvasElement.clientHeight / ds.scale;
    const offsetX = -ds.offset[0];
    const offsetY = -ds.offset[1];
    const x = (offsetX - bounds.left) * scale;
    const y = (offsetY - bounds.top) * scale;
    const width = viewportWidth * scale;
    const height = viewportHeight * scale;
    ctx.strokeStyle = "rgba(168, 219, 235, 0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, height);
}

// Convert minimap drag motions into panning the main graph.  On mousedown
// we record the starting mouse position and the current graph offset.  As
// the mouse moves, we compute a delta in minimap coordinates and apply
// the inverse transformation to the graph offset.
function setupDrag(miniCanvas) {
    let dragging = false;
    let startMouse = { x: 0, y: 0 };
    let startOffset = [0, 0];

    miniCanvas.addEventListener("mousedown", (event) => {
        // Only start dragging if left button is pressed and Ctrl is not held
        if (event.button !== 0 || event.ctrlKey) return;
        dragging = true;
        const rect = miniCanvas.getBoundingClientRect();
        startMouse = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const ds = window.app.canvas.ds;
        startOffset = [ds.offset[0], ds.offset[1]];
        event.preventDefault();
    });

    miniCanvas.addEventListener("mousemove", (event) => {
        if (!dragging) return;
        const rect = miniCanvas.getBoundingClientRect();
        const currentX = event.clientX - rect.left;
        const currentY = event.clientY - rect.top;
        const dx = currentX - startMouse.x;
        const dy = currentY - startMouse.y;
        const scale = miniCanvas.scale;
        const graphDx = dx / scale;
        const graphDy = dy / scale;
        const ds = window.app.canvas.ds;
        ds.offset[0] = startOffset[0] - graphDx;
        ds.offset[1] = startOffset[1] - graphDy;
        window.app.canvas.setDirty(true, true);
        event.preventDefault();
    });

    const endDrag = () => { dragging = false; };
    miniCanvas.addEventListener("mouseup", endDrag);
    miniCanvas.addEventListener("mouseout", endDrag);
}

// Set up activity listeners on the main canvas so that the minimap shows
// whenever the user interacts with the graph.  This resets the
// lastActivityTime counter and restores full opacity.  A timer checks
// periodically whether the fade delay has elapsed and hides the minimap.
function setupFadeBehaviour(minimapDiv) {
    const show = () => {
        minimapDiv.style.opacity = 1;
        lastActivityTime = Date.now();
    };
    const hideIfInactive = () => {
        const elapsed = Date.now() - lastActivityTime;
        if (elapsed > FADE_DELAY) {
            minimapDiv.style.opacity = 0;
        }
    };
    const mainCanvas = document.querySelector("canvas");
    if (!mainCanvas) return;
    ["wheel", "mousedown", "mousemove", "mouseup", "mouseout"].forEach(evt => {
        mainCanvas.addEventListener(evt, show);
    });
    // Periodically check for inactivity
    setInterval(hideIfInactive, 500);
}

// Main initialization.  Wait until the global `app` and its graph are
// available before creating the minimap.  This mirrors ComfyUI's own
// extension loading logic; without waiting the graph may be undefined.
function waitForGraphReady() {
    const interval = setInterval(() => {
        const graph = window.app?.graph;
        if (graph && graph._nodes && graph._nodes.length > 0) {
            clearInterval(interval);
            initializeMinimap();
        }
    }, 500);
}

// Setup executing node highlight listener and instantiate the minimap
function initializeMinimap() {
    // Listen for execution events so we can highlight the current node
    api.addEventListener("executing", (e) => {
        const nodeId = e.detail;
        if (nodeId != null) {
            currentExecutingNode = nodeId;
        } else {
            currentExecutingNode = 0;
        }
    });
    // Build the DOM elements for the minimap
    const settings = {
        // Adjust minimap dimensions so it remains compact while still
        // providing enough room for previews.  These values were chosen
        // to better balance size against the surrounding UI elements.
        width: 300,
        height: 160,
        margin: 10,
        opacity: 1
    };
    const { minimapDiv, minimapCanvas } = createMiniMapCanvas(settings);
    // Render loop: redraw the minimap at a low frequency so it stays up
    // to date without consuming too many resources
    const render = () => {
        if (window.app && window.app.graph) {
            renderMiniMap(window.app.graph, minimapCanvas);
        }
    };
    render();
    setInterval(render, 250);
    // Enable panning via drag gestures on the minimap
    setupDrag(minimapCanvas);
    // Fade in/out based on user activity
    setupFadeBehaviour(minimapDiv);
}

// Kick off the initialization when this script is loaded
waitForGraphReady();
