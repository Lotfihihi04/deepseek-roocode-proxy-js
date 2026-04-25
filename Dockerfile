# Stage 1: Build wheel
FROM python:3.12-slim AS builder

WORKDIR /build

# Install build dependencies
RUN pip install --no-cache-dir build

# Copy project files
COPY pyproject.toml .
COPY src/ src/

# Build wheel
RUN python -m build --wheel


# Stage 2: Minimal runtime image
FROM python:3.12-slim

# Create non-root user and pre-create config directory with correct ownership
RUN adduser --disabled-password --gecos '' appuser && \
    mkdir -p /home/appuser/.deepseek-cursor-proxy && \
    chown appuser:appuser /home/appuser/.deepseek-cursor-proxy

# Install the built wheel
COPY --from=builder /build/dist/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/*.whl && \
    rm -rf /tmp/*.whl /root/.cache

# Switch to non-root user
USER appuser

# Default port
EXPOSE 9000

# Default command not using ngrok (works with RooCode which allows localhost)
# Pass API key via Authorization header from Cursor
ENTRYPOINT ["deepseek-cursor-proxy"]
CMD ["--host", "0.0.0.0", "--port", "9000"]
