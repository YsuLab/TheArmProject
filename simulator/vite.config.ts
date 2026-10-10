/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { fs: { allow: [".."] } }, // scenarios/ and ../shared/test_vectors.json
  test: { environment: "node", testTimeout: 60000 },
});
