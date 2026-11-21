FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/index.js"]
