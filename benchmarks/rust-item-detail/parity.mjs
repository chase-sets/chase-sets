// Compares Node (production code) and Rust responses for the same requests.
import { isDeepStrictEqual } from "node:util";
const [nodeBase, rustBase] = [process.argv[2] ?? "http://localhost:18301", process.argv[3] ?? "http://localhost:18302"];
const paths = [];
for (let i = 1; i <= 2000; i += 37) paths.push(`/api/discovery/items/item_${i}`); // sealed (contents)
for (let i = 2000; i <= 50000; i += 431) paths.push(`/api/discovery/items/item_${i}`); // singles (included_in)
for (let i = 1; i <= 50; i++) paths.push(`/api/discovery/items/item_${i}`); // most listings
for (let i = 3; i <= 5000; i += 997) paths.push(`/api/discovery/items/card-name-${i}-set-${i % 400}`); // slug
for (let i = 7; i <= 5000; i += 1013) paths.push(`/api/discovery/items/old-card-slug-${i}`); // redirect
paths.push("/api/discovery/items/does-not-exist", "/api/discovery/categories", "/api/discovery/categories?parentCategoryId=cat_3",
  "/api/discovery/categories?status=archived", "/api/discovery/categories/category-42", "/api/discovery/categories/cat_17", "/api/discovery/categories/nope");
let bytesEqual = 0, deepEqual = 0, failures = [];
for (const path of paths) {
  const [a, b] = await Promise.all([fetch(nodeBase + path), fetch(rustBase + path)]);
  const [ta, tb] = await Promise.all([a.text(), b.text()]);
  if (a.status !== b.status) { failures.push(`${path} status ${a.status} vs ${b.status}`); continue; }
  if (ta === tb) bytesEqual++;
  if (isDeepStrictEqual(JSON.parse(ta), JSON.parse(tb))) deepEqual++; else failures.push(`${path} body differs (${ta.length} vs ${tb.length} bytes)`);
}
console.log(JSON.stringify({ requests: paths.length, bytesEqual, deepEqual, failures: failures.slice(0, 10) }, null, 1));
process.exit(failures.length ? 1 : 0);
