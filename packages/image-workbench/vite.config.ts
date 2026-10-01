import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json";

const externals = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)];
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    lib: { entry: "react/index.ts", formats: ["es"], fileName: "react", cssFileName: "styles" },
    rollupOptions: {
      external: (id) => !id.endsWith(".css") && externals.some((name) => id === name || id.startsWith(`${name}/`)),
    },
  },
});
