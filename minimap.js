/*
 * Cleaned Minimap for ComfyUI
 *
 * This script draws a minimap overlay in the bottom‑right corner of ComfyUI.
 * Active nodes are outlined in green, bypassed nodes in purple, and error
 * nodes in red. It supports dragging to pan the main graph and fades out
 * after inactivity. Image previews are removed for stability and performance.
 */

import { api } from "../../scripts/api.js";

console.log("Cleaned minimap extension loaded");

const NODE_TITLE_HEIGHT = 30;
let currentExecutingNode = "0";
let lastActivityTime = Date.now();
const FADE_DELAY = 3000;

function isNodeError(node) {
    try {
        if (!node) return false;
        if (node.error || node.has_error || node.has_errors) return true;
        if (node.invalid || node.is_invalid || node.isInvalid) return true;
        if (node.flags && (node.flags.error || node.flags.invalid)) return true;
        if (Array.isArray(node.widgets_invalid) && node.widgets_invalid.length > 0) return true;
        const c = String(node.color || "").toLowerCase();
        if (c.includes("error") || c.includes("ff0000") || c.includes("dc2626") || c.includes("e13")) return true;
    } catch {}
    return false;
}

function isNodeBypassed(node) {
    try {
        if (!node) return false;
        if (node.bypassed || node.is_bypassed || node.bypass) return true;
        if (node.flags && (node.flags.bypassed || node.flags.bypass || node.flags.muted || node.flags.disabled || node.flags.skip || node.flags.skipped)) return true;
        if (typeof node.isBypassed === "function" && node.isBypassed()) return true;
        if (node.isBypassed) return true;
        let bypassMode = 4;
        if (typeof LiteGraph !== "undefined" && LiteGraph.LGraphEventMode?.BYPASS !== undefined) {
            bypassMode = LiteGraph.LGraphEventMode.BYPASS;
        }
        if (node.mode === bypassMode || String(node.mode).toUpperCase() === "BYPASS") return true;
        const color = String(node.color || "").toLowerCase();
        if (color.includes("a855f7") || color.includes("purple")) return true;
    } catch {}
    return false;
}

function createMiniMapCanvas(settings) {
    const minimapDiv = document.createElement("div");
    minimapDiv.id = "minimap";
    minimapDiv.style.position = "fixed";
    minimapDiv.style.right = (settings.margin + 50) + "px";
    minimapDiv.style.bottom = settings.margin + "px";
    minimapDiv.style.width = settings.width + "px";
    minimapDiv.style.height = settings.height + "px";
    minimapDiv.style.border = "1px solid var(--border-color)";
    minimapDiv.style.backgroundColor = "var(--bg-color)";
    minimapDiv.style.zIndex = 1000;
    minimapDiv.style.opacity = settings.opacity;
    minimapDiv.style.transition = "opacity 0.5s ease";
    minimapDiv.style.overflow = "hidden";
    minimapDiv.style.borderRadius = "6px";
    document.body.appendChild(minimapDiv);

    const minimapCanvas = document.createElement("canvas");
    minimapCanvas.width = settings.width;
    minimapCanvas.height = settings.height;
    minimapDiv.appendChild(minimapCanvas);
    return { minimapDiv, minimapCanvas };
}

function getGraphBounds(graph) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    graph._nodes.forEach(node => {
        if (node.pos[0] < minX) minX = node.pos[0];
        if (node.pos[1] < minY) minY = node.pos[1];
        if (node.pos[0] + node.size[0] > maxX) maxX = node.pos[0] + node.size[0];
        if (node.pos[1] + node.size[1] > maxY) maxY = node.pos[1] + node.size[1];
    });
    graph._groups.forEach(group => {
        if (group.pos[0] < minX) minX = group.pos[0];
        if (group.pos[1] < minY) minY = group.pos[1];
        if (group.pos[0] + group.size[0] > maxX) maxX = group.pos[0] + group.size[0];
        if (group.pos[1] + group.size[1] > maxY) maxY = group.pos[1] + group.size[1];
    });
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

function renderMiniMap(graph, canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mainCanvas = document.querySelector("canvas");
    const bgColour = getComputedStyle(mainCanvas).backgroundColor || "transparent";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = bgColour;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const bounds = getGraphBounds(graph);
    const scale = Math.min(canvas.width / (bounds.width + 200), canvas.height / (bounds.height + 200));

    graph._nodes.forEach(node => {
        let nodeColour = node.color || getComputedStyle(document.documentElement).getPropertyValue("--comfy-menu-bg").trim();
        let width = node.size[0];
        let height = node.size[1] + NODE_TITLE_HEIGHT;
        if (node.flags?.collapsed) {
            width = node._collapsed_width;
            height = NODE_TITLE_HEIGHT;
        }
        const x = (node.pos[0] - bounds.left) * scale;
        const y = (node.pos[1] - bounds.top - (node.isVirtualNode ? 0 : NODE_TITLE_HEIGHT)) * scale;
        const w = width * scale;
        const h = height * scale;

        if (isNodeError(node)) {
            ctx.fillStyle = "rgba(255, 0, 0, 0.7)";
        } else if (isNodeBypassed(node)) {
            ctx.fillStyle = "rgba(168, 85, 247, 0.8)";
        } else {
            ctx.fillStyle = nodeColour;
        }
        ctx.fillRect(x, y, w, h);

        if (isNodeError(node)) {
            ctx.strokeStyle = "red";
            ctx.lineWidth = 3;
            ctx.strokeRect(x, y, w, h);
        }
        if (String(node.id) === String(currentExecutingNode)) {
            ctx.strokeStyle = "green";
            ctx.lineWidth = 1;
            ctx.strokeRect(x, y, w, h);
        }
    });
}

function setupDrag(canvas) {
    let dragging = false, startMouse = { x: 0, y: 0 }, startOffset = [0, 0];
    canvas.addEventListener("mousedown", e => {
        if (e.button !== 0 || e.ctrlKey) return;
        dragging = true;
        const rect = canvas.getBoundingClientRect();
        startMouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        startOffset = [...window.app.canvas.ds.offset];
        e.preventDefault();
    });
    canvas.addEventListener("mousemove", e => {
        if (!dragging) return;
        const rect = canvas.getBoundingClientRect();
        const dx = (e.clientX - rect.left - startMouse.x) / canvas.scale;
        const dy = (e.clientY - rect.top - startMouse.y) / canvas.scale;
        const ds = window.app.canvas.ds;
        ds.offset[0] = startOffset[0] - dx;
        ds.offset[1] = startOffset[1] - dy;
        window.app.canvas.setDirty(true, true);
        e.preventDefault();
    });
    canvas.addEventListener("mouseup", () => dragging = false);
    canvas.addEventListener("mouseout", () => dragging = false);
}

function setupFade(minimapDiv) {
    const show = () => {
        minimapDiv.style.opacity = 1;
        lastActivityTime = Date.now();
    };
    const hide = () => {
        if (Date.now() - lastActivityTime > FADE_DELAY) minimapDiv.style.opacity = 0;
    };
    const canvas = document.querySelector("canvas");
    ["wheel", "mousedown", "mousemove", "mouseup", "mouseout"].forEach(evt => {
        canvas.addEventListener(evt, show);
    });
    setInterval(hide, 500);
}

function initializeMinimap() {
    api.addEventListener("executing", (e) => {
        currentExecutingNode = e.detail || "0";
    });
    const settings = { width: 300, height: 160, margin: 10, opacity: 1 };
    const { minimapDiv, minimapCanvas } = createMiniMapCanvas(settings);
    const render = () => {
        if (window.app && window.app.graph) {
            renderMiniMap(window.app.graph, minimapCanvas);
        }
    };
    render();
    setInterval(render, 250);
    setupDrag(minimapCanvas);
    setupFade(minimapDiv);
}

function waitForGraphReady() {
    const interval = setInterval(() => {
        const graph = window.app?.graph;
        if (graph && graph._nodes?.length > 0) {
            clearInterval(interval);
            initializeMinimap();
        }
    }, 500);
}

waitForGraphReady();
