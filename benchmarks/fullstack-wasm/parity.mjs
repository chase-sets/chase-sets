// Compares the visible text of both apps' server-rendered item pages.
// Usage: node parity.mjs <reactBase> <leptosBase>
const [a, b] = process.argv.slice(2);
const ids = [1, 2, 3, 5, 17, 99, 250, 777, 1500, 1999, 2000, 2500, 3000, 12345, 49999].map((n) => `item_${n}`).concat(["does-not-exist"]);
const visible = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<template[\s\S]*?<\/template>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
let same = 0;
const diffs = [];
for (const id of ids) {
  const [ra, rb] = await Promise.all([fetch(`${a}/items/${id}`), fetch(`${b}/items/${id}`)]);
  const [ta, tb] = [visible(await ra.text()), visible(await rb.text())];
  if (ta === tb) same += 1;
  else {
    let i = 0;
    while (i < ta.length && ta[i] === tb[i]) i += 1;
    diffs.push({ id, status: [ra.status, rb.status], at: i, react: ta.slice(Math.max(0, i - 60), i + 80), leptos: tb.slice(Math.max(0, i - 60), i + 80) });
  }
}
console.log(JSON.stringify({ pages: ids.length, sameVisibleText: same, diffs: diffs.slice(0, 4) }, null, 1));
process.exit(diffs.length ? 1 : 0);
