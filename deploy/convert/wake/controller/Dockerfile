FROM node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
