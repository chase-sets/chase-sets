FROM node:24-bookworm-slim
WORKDIR /app
COPY dist/server.mjs ./server.mjs
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
