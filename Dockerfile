FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev
COPY web/ ./
EXPOSE 3000
CMD ["node", "server.js"]
