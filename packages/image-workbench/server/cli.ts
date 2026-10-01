import { startImageWorkbenchServer } from "./app";

const { server } = await startImageWorkbenchServer(undefined, process.env.HOST?.trim() || "127.0.0.1");
const address = server.address();
console.log(`[image-workbench] API listening on ${typeof address === "object" && address ? address.port : address}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 30_000).unref();
  });
}
