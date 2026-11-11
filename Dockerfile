FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production
# PORT Render स्वतः देतो (सर्व्हर तो वाचतो). DATA_DIR न दिल्यास ./data वापरतो.
# Render मोफत प्लॅनवर ही फोल्डर तात्पुरती असते (रीस्टार्टवर पुसली जाते) - ठीक आहे.
EXPOSE 10000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
