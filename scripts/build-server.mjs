import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist");
if (dirname(output) !== resolve(root))
  throw Error("Build output must be a direct workspace child");
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "server"), { recursive: true });
await build({
  entryPoints: {
    index: resolve(root, "apps/api/src/index.ts"),
    seed: resolve(root, "apps/api/src/seed.ts"),
    migrate: resolve(root, "apps/api/src/migrate.ts"),
  },
  outdir: resolve(output, "server"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  alias: {
    "@hospitality/contracts": resolve(root, "packages/contracts/src/index.ts"),
  },
  define: { __COMPILED__: "true" },
  sourcemap: true,
});
await cp(resolve(root, "apps/web/dist"), resolve(output, "public"), {
  recursive: true,
});
await cp(resolve(root, "db/migrations"), resolve(output, "migrations"), {
  recursive: true,
});
console.log("Built Fastify JavaScript, React assets and migrations in dist/");
