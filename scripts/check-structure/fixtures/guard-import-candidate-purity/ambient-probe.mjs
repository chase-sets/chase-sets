import fs from "node:fs";

export const probes = {
  filesystem: () => fs["read" + "FileSync"]("synthetic-file"),
  environment: () => process.env.GUARD_IMPORT_SYNTHETIC_PROBE,
  dateNow: () => Date.now(),
  dateConstruction: () => new Date(),
  dateApplication: () => Date(),
  randomness: () => Math.random(),
  performance: () => performance.now(),
  locale: () => new Intl.DateTimeFormat(),
  cwd: () => process.cwd(),
};
