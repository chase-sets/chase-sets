// Public-browse traffic mix against one target. Item popularity uses the same
// power-law skew as the seeded listings, so hot items are hot in both data and traffic.
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE;
const MODE = __ENV.MODE || "closed";
const VUS = Number(__ENV.VUS || 64);
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || "60s";

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
  scenarios: MODE === "closed"
    ? { load: { executor: "constant-vus", vus: VUS, duration: DURATION } }
    : { load: { executor: "constant-arrival-rate", rate: RATE, timeUnit: "1s", duration: DURATION, preAllocatedVUs: 200, maxVUs: 1000 } },
};

function itemIndex() {
  return 1 + Math.floor(49999 * Math.pow(Math.random(), 3));
}

export default function () {
  const r = Math.random();
  let path;
  if (r < 0.80) path = `/api/discovery/items/item_${itemIndex()}`;
  else if (r < 0.88) { const i = itemIndex(); path = `/api/discovery/items/card-name-${i}-set-${i % 400}`; }
  else if (r < 0.90) path = `/api/discovery/items/old-card-slug-${1 + Math.floor(Math.random() * 5000)}`;
  else if (r < 0.95) path = "/api/discovery/categories";
  else path = `/api/discovery/categories/category-${1 + Math.floor(Math.random() * 300)}`;
  const res = http.get(BASE + path);
  check(res, { "status 200/404": (x) => x.status === 200 || x.status === 404 });
}
