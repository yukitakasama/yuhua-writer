
import { createMockBackend } from "./src/lib/mock-backend/index.ts";
const b = createMockBackend();
const r = b.search({ keyword: "雨" });
let n = 0;
for (const hit of r.hits) {
  for (const sn of hit.snippets) {
    for (const [s, e] of sn.ranges) {
      if (!(s < e)) {
        console.log("BAD RANGE", JSON.stringify({ s, e, text: sn.text, hitChapter: hit.title }));
        n++;
      }
    }
  }
}
console.log("bad count:", n, "hits:", r.hits.length);
console.log("first hit snippets:", JSON.stringify(r.hits[0]?.snippets, null, 2));
