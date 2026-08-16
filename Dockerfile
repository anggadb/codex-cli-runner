FROM node:24-slim

RUN npm install --global @openai/codex

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node index.js ./
COPY --chown=node:node src ./src

ENV HOST=0.0.0.0 \
    PORT=3001

USER node

EXPOSE 3001

CMD ["node", "index.js"]
