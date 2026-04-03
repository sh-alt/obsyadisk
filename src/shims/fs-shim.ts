// isomorphic-git imports 'fs' but we pass our own fs adapter at call sites.
// This shim prevents esbuild from failing on the fs import.
export default {};
export const promises = {};
export const readFileSync = () => {
	throw new Error("fs.readFileSync is not available on mobile");
};
export const writeFileSync = () => {
	throw new Error("fs.writeFileSync is not available on mobile");
};
