import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const DEFAULT_API_PORT = 3001;

export function resolveApiProxyTarget(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const explicitTarget = env.API_PROXY_TARGET?.trim();
  if (explicitTarget) {
    let url: URL;
    try {
      url = new URL(explicitTarget);
    } catch {
      throw new Error("API_PROXY_TARGET must be an absolute HTTP(S) URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("API_PROXY_TARGET must use http:// or https://");
    }
    return explicitTarget.replace(/\/+$/, "");
  }

  const rawPort = env.PORT?.trim() || String(DEFAULT_API_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return `http://localhost:${port}`;
}

export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, process.cwd(), ""),
    ...process.env,
  };

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@server": path.resolve(__dirname, "server"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: resolveApiProxyTarget(env),
          changeOrigin: true,
        },
      },
    },
    build: {
      manifest: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
              return "vendor-react";
            }
            if (/[\\/]node_modules[\\/](@xyflow|d3-|internmap|delaunator|robust-predicates)/.test(id)) {
              return "vendor-flow";
            }
            if (/[\\/]node_modules[\\/](@base-ui|@floating-ui)[\\/]/.test(id)) {
              return "vendor-ui";
            }
            if (/[\\/]node_modules[\\/](zustand|zundo|nanoid)[\\/]/.test(id)) {
              return "vendor-state";
            }
            if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) {
              return "vendor-icons";
            }
            return undefined;
          },
        },
      },
    },
  };
});
