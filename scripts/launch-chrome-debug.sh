#!/bin/bash
# Launch Chrome/Chromium with remote debugging for NanoClaw browser automation
# Uses your default profile so the agent can access your logged-in sessions

# Check if Chrome with remote debugging is already running
if pgrep -f "remote-debugging-port=9222" > /dev/null; then
    echo "✓ Chrome with remote debugging already running"
    exit 0
fi

# Try to find Chrome/Chromium binary
if command -v chromium &> /dev/null; then
    CHROME_BIN="chromium"
elif command -v chromium-browser &> /dev/null; then
    CHROME_BIN="chromium-browser"
elif command -v google-chrome &> /dev/null; then
    CHROME_BIN="google-chrome"
elif command -v google-chrome-stable &> /dev/null; then
    CHROME_BIN="google-chrome-stable"
else
    echo "Error: Chrome/Chromium not found in PATH"
    exit 1
fi

echo "Starting $CHROME_BIN with remote debugging on port 9222..."
echo "Using your default Chrome profile (logged-in sessions available)"

# Launch Chrome with remote debugging using default profile
# Note: NOT using --user-data-dir so it uses the default profile
# Bind to all interfaces (0.0.0.0) so containers can access it
$CHROME_BIN \
    --remote-debugging-port=9222 \
    --remote-debugging-address=0.0.0.0 \
    --restore-last-session \
    > /dev/null 2>&1 &

CHROME_PID=$!

# Give Chrome a moment to start
sleep 1

# Verify it started
if pgrep -f "remote-debugging-port=9222" > /dev/null; then
    echo "✓ Chrome started with PID $CHROME_PID"
    echo "✓ Remote debugging available at: http://localhost:9222"
    echo "✓ Agent can now access your logged-in sessions"
    exit 0
else
    echo "✗ Failed to start Chrome with debugging"
    exit 1
fi
