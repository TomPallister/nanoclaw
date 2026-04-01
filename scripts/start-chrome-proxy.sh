#!/bin/bash
# Forward Chrome DevTools Protocol from docker0 bridge to localhost
# This allows containers to reach Chrome on the host

# Kill any existing socat process forwarding port 9222
sudo pkill -f "socat.*9222"

# Start socat to forward 172.17.0.1:9222 to 127.0.0.1:9222
sudo socat TCP-LISTEN:9222,bind=172.17.0.1,fork,reuseaddr TCP:127.0.0.1:9222 > /dev/null 2>&1 &

echo "✓ Chrome CDP proxy started on 172.17.0.1:9222 -> 127.0.0.1:9222"
