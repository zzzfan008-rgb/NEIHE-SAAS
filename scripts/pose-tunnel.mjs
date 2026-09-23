import net from "node:net";

/**
 * Docker Desktop 容器侧 loopback 转发：仅容器内可访问，宿主机本地服务仍保持令牌校验。
 * POSE_SERVICE_URL 和 DEPTH_SERVICE_URL 分别指向 127.0.0.1:8767 / 8766。
 */
function startBridge(label, listen, target) {
  const [listenHost, listenPort] = listen.split(":");
  const [targetHost, targetPort] = target.split(":");
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(targetPort), targetHost);
    upstream.on("connect", () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  server.on("error", (error) =>
    console.error(`[${label}-tunnel] failed`, error.message),
  );
  server.listen(Number(listenPort), listenHost, () => {
    console.log(
      `[${label}-tunnel] ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`,
    );
  });
}

startBridge(
  "pose",
  process.env.POSE_TUNNEL_LISTEN ?? "127.0.0.1:8767",
  process.env.POSE_TUNNEL_TARGET ?? "host.docker.internal:8767",
);
startBridge(
  "depth",
  process.env.DEPTH_TUNNEL_LISTEN ?? "127.0.0.1:8766",
  process.env.DEPTH_TUNNEL_TARGET ?? "host.docker.internal:8766",
);
