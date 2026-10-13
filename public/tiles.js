const TILE_SIZE = 256;

// Keep visible image elements mounted so a pan does not restart their requests.
// The browser manages HTTP caching; no proxy, cache bypass or background preload.
export function createTileRenderer(container) {
  const images = new Map();
  return ({ center, zoom, width, height }) => {
    const count = 2 ** zoom;
    const left = center.x - width / 2, top = center.y - height / 2;
    const minX = Math.floor(left / TILE_SIZE);
    const maxX = Math.ceil((left + width) / TILE_SIZE) - 1;
    const minY = Math.max(0, Math.floor(top / TILE_SIZE));
    const maxY = Math.min(count - 1, Math.ceil((top + height) / TILE_SIZE) - 1);
    const visible = new Set();
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const key = `${zoom}/${x}/${y}`;
        visible.add(key);
        let image = images.get(key);
        if (!image) {
          image = container.ownerDocument.createElement("img");
          image.alt = "";
          image.draggable = false;
          image.decoding = "async";
          // Use the real site's origin, including if an older server response
          // still has a restrictive document-level Referrer-Policy.
          image.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
          const wrappedX = ((x % count) + count) % count;
          image.src = `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`;
          images.set(key, image);
          container.append(image);
        }
        image.style.left = `${Math.round(x * TILE_SIZE - left)}px`;
        image.style.top = `${Math.round(y * TILE_SIZE - top)}px`;
      }
    }
    for (const [key, image] of images) {
      if (!visible.has(key)) { image.remove(); images.delete(key); }
    }
  };
}
