FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
USER 10001:10001
CMD ["node", "server.js"]
