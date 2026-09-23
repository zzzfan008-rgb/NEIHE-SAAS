import net from "node:net";

/**
 * 容器侧 TCP 转发：把容器内 loopback 端口转发到宿主机服务。
 * DWPose 服务运行在宿主机（Mac）上；Docker 容器内的 127.0.0.1 是容器自身，
 * 通过 Docker Desktop 的 host.docker.internal 访问宿主机，并让
 * dwposeAnalysis 的 loopback 地址校验继续生效（URL 保持 http://127.0.0.1）。
 *
 * 环境变量：
 *   POSE_TUNNEL_LISTEN  容器内监听地址，默认 127.0.0.1:8767
 *   POSE_TUNNEL_TARGET  宿主机目标地址，默认 host.docker.internal:8767
 */
const [listenHost, listenPort] = (process.env.POSE_TUNNEL_LISTEN ?? "127.0.0.1:8767").split(":");
const [targetHost, targetPort] = (process.env.POSE_TUNNEL_TARGET ?? "host.docker.internal:8767").split(":");

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

server.on("error", (error) => {
  console.error("[pose-tunnel] failed", error.message);
});

server.listen(Number(listenPort), listenHost, () => {
  console.log(`[pose-tunnel] ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`);
});
