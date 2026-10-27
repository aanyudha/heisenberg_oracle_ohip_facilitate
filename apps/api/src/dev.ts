// Development alone uses Vite's origin. The compiled production entry never imports this file.
process.env.APP_ORIGIN ||= "http://localhost:5173";
await import("./index.js");
export {};
