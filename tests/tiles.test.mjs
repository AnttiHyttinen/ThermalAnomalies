import test from "node:test";
import assert from "node:assert/strict";
import { createTileRenderer } from "../public/tiles.js";

function fixture() {
  const children = new Set();
  let created = 0, requests = 0;
  const container = {
    ownerDocument: { createElement(name) {
      assert.equal(name, "img"); created++;
      const attributes = {};
      return {
        style: {}, attributes,
        setAttribute(key, value) { attributes[key] = value; },
        set src(value) {
          assert.equal(attributes.referrerpolicy, "strict-origin-when-cross-origin");
          assert.match(value, /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
          this.url = value; requests++;
        },
        remove() { children.delete(this); },
      };
    } },
    append(image) { children.add(image); },
  };
  return { render: createTileRenderer(container), children, get created() { return created; }, get requests() { return requests; } };
}
const view = { center: { x: 512, y: 512 }, zoom: 3, width: 512, height: 512 };

test("visible tiles send a referrer and are reused without assigning new requests", () => {
  const f = fixture(); f.render(view);
  assert.equal(f.created, 4); assert.equal(f.requests, 4);
  const images = [...f.children];
  f.render(view); assert.deepEqual([...f.children], images); assert.equal(f.requests, 4);
});

test("pan retains shared tiles and only requests newly visible tiles", () => {
  const f = fixture(); f.render(view); const before = new Set(f.children);
  f.render({ ...view, center: { x: 768, y: 512 } });
  assert.equal(f.children.size, 4); assert.equal(f.requests, 6);
  assert.equal([...f.children].filter((image) => before.has(image)).length, 2);
  f.render({ ...view, center: { x: 768, y: 512 } }); assert.equal(f.requests, 6);
});

test("zoom drops old DOM tiles and bounds active images to the current viewport", () => {
  const f = fixture(); f.render(view); const old = new Set(f.children);
  f.render({ ...view, zoom: 4, center: { x: 1024, y: 1024 } });
  assert.equal(f.children.size, 4);
  assert.ok([...f.children].every((image) => !old.has(image) && image.url.includes("/4/")));
  f.render({ ...view, width: 256, height: 256, center: { x: 384, y: 384 } });
  assert.equal(f.children.size, 1);
});

test("dateline wraps x and the top edge never requests an invalid y", () => {
  const f = fixture(); f.render({ ...view, center: { x: 0, y: 0 } });
  const urls = [...f.children].map((image) => image.url).sort();
  assert.deepEqual(urls, ["https://tile.openstreetmap.org/3/0/0.png", "https://tile.openstreetmap.org/3/7/0.png"]);
});
