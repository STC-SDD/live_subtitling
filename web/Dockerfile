## ROLE — Container image for the STC web server
##
## Provides:
## - Node.js runtime to run the Express/WebSocket server
## - FFmpeg to generate HLS segments/playlists from uploaded video files

FROM node:18-alpine
WORKDIR /app

# Install ffmpeg for HLS generation
RUN apk add --no-cache ffmpeg bash

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src ./src
COPY public ./public
RUN mkdir -p /app/public/hls /app/media

ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]