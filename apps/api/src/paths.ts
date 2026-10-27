import { fileURLToPath } from "node:url";
declare const __COMPILED__: boolean;
const compiled = typeof __COMPILED__ !== "undefined" && __COMPILED__;
export const projectRoot = fileURLToPath(
  new URL(compiled ? "../../" : "../../../", import.meta.url),
);
export const frontendPath = fileURLToPath(
  new URL(compiled ? "../public/" : "../../web/dist/", import.meta.url),
);
export const migrationPath = fileURLToPath(
  new URL(
    compiled ? "../migrations/" : "../../../db/migrations/",
    import.meta.url,
  ),
);
