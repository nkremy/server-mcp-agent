FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN chmod +x start.sh

EXPOSE 3000

CMD ["/bin/sh", "start.sh"]
