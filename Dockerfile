# Stage 1: Install dependencies
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev


# Stage 2: Minimal runtime image
FROM node:20-slim

# Create non-root user and pre-create config directory with correct ownership
RUN adduser --disabled-password --gecos '' appuser && \
    mkdir -p /home/appuser/.deepseek-cursor-proxy && \
    chown appuser:appuser /home/appuser/.deepseek-cursor-proxy

WORKDIR /app

# Copy installed modules and source
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ src/

# Switch to non-root user
USER appuser

# Default port
EXPOSE 9000

# Default command (ngrok disabled since RooCode supports localhost)
ENTRYPOINT ["node", "src/js/server.js"]
CMD ["--host", "0.0.0.0", "--port", "9000"]
