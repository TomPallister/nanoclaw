#!/bin/bash
# Stop Chrome/Chromium debug instance

echo "Stopping Chrome debug instance..."
pkill -f "remote-debugging-port=9222"

if [ $? -eq 0 ]; then
    echo "Chrome debug instance stopped"
else
    echo "No Chrome debug instance found"
fi
