Minimap vibe coding project  for Comfyui for my own experimentation feel free to try out!


Features
Graph overview – The minimap displays a miniature version of the current graph including nodes, groups and connections. Node size, position and group colours are preserved so you can quickly see the overall structure of your workflow.

Link colouring – Connection lines are drawn with the same colours used in ComfyUI’s main canvas. Primitive types fall back to sensible defaults, ensuring the minimap remains consistent with your graph.

Error highlighting – Nodes that have an error or invalid state (e.g. missing inputs or failed execution) are filled with a semi‑transparent red and outlined with a thicker red border so they stand out even when scaled down.

Bypass highlighting – Nodes in bypass mode are filled with a translucent purple. The bypass detection supports multiple ComfyUI versions by checking flags and the node’s mode property. You can adjust the transparency of the purple overlay in renderMiniMap() by modifying the RGBA alpha value.

Active node indicator – The node currently executing is outlined with a thin green border. This makes it easy to see which node is running when executing long workflows.

Image previews – Nodes that contain a preview image (such as Load Image and Preview Image nodes) display a miniature version of the image inside the node’s rectangle on the minimap. Images are cached to avoid unnecessary reloads. If no preview is available, the node rectangle remains empty.

Collapsible nodes and groups – Collapsed nodes and grouped nodes are handled gracefully. Collapsed nodes shrink in height, and group backgrounds are drawn semi‑transparently so you can distinguish between grouped and ungrouped areas.

Viewport indicator – A rectangle on the minimap shows the current viewport of the main canvas. This lets you see which part of the graph you are currently viewing and how it relates to the entire workflow.

Drag to pan – Clicking and dragging on the minimap will pan the main graph. This allows you to quickly jump to different areas of the workflow without scrolling the main canvas.

Fade in/out behaviour – The minimap fades out after a period of inactivity (default 3 seconds) and fades back in when you interact with the graph. This keeps it unobtrusive while still available when needed.
