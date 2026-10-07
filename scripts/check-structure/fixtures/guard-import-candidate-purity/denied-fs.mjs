function denied() {
  throw new Error("DENIED:filesystem");
}

export const existsSync = denied;
export const readFileSync = denied;
export const readdirSync = denied;
export default new Proxy({}, { get: () => denied });
