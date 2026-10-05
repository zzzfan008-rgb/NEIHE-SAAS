# Official Portkey distribution, pinned by digest; use the project's supported Node runtime.
FROM portkeyai/gateway:1.15.2@sha256:97f094d9c8a764cbfaa2a7138c0017b247ca923bb06db1b4c13b7f8a33b5200d AS official
# Node 22.23.2, matching the project's supported major version.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /app
COPY --from=official --chown=node:node /app/build ./build
COPY --from=official --chown=node:node /app/node_modules ./node_modules
COPY --from=official --chown=node:node /app/package.json ./package.json
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "build/start-server.js", "--port=8787", "--headless"]
