import fs from "node:fs";
const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const a = r.testResults.flatMap((x) => x.assertionResults);
const selected = a.filter((x) => x.fullName.includes("host-attributed hermetic Chromium"));
const names = ["qualified", "canceled", "expired"];
if (
  r.success !== true ||
  selected.length !== 3 ||
  selected.some((x) => x.status !== "passed") ||
  names.some(
    (n) =>
      selected.filter((x) => x.fullName.includes("terminal " + n + " with synthetic install/removal")).length !== 1,
  ) ||
  a.some((x) => x.status === "passed" && !selected.includes(x))
) {
  throw new Error("AC4 requires exactly the three named Chromium cases to pass");
}
console.log("AC4: qualified/canceled/expired passed; synthetic only");
