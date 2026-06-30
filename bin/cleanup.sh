#!/usr/bin/env bash

# Exit on error
set -e

# Target ports to check and clean up
PORTS=(8081 4000 9090 4096)

echo "=== Stopping systemd service (if running) ==="
if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet opencode-bridge.service 2>/dev/null || systemctl --user is-active --quiet opencode-bridge.service 2>/dev/null; then
        echo "Stopping opencode-bridge.service..."
        sudo systemctl stop opencode-bridge.service || true
    else
        echo "opencode-bridge.service is not running."
    fi
else
    echo "systemctl not available, skipping systemd service stop."
fi

echo -e "\n=== Checking and terminating dangling processes on ports ${PORTS[*]} ==="
for port in "${PORTS[@]}"; do
    # Find PIDs using the port
    pids=$(lsof -t -i :"$port" || true)
    if [ -n "$pids" ]; then
        # Filter out Docker Desktop helper processes to avoid killing Docker itself on macOS
        filtered_pids=""
        for pid in $pids; do
            comm=$(ps -p "$pid" -o comm= 2>/dev/null || true)
            if [[ "$comm" != *"com.docker"* && "$comm" != *"Docker"* ]]; then
                filtered_pids="$filtered_pids $pid"
            fi
        done
        pids=$(echo $filtered_pids | xargs)
    fi

    if [ -n "$pids" ]; then
        echo "Port $port is in use by PID(s):"
        ps -p $pids -o pid,comm,args || true
        echo "Terminating PID(s)..."
        # Try gentle SIGTERM first, then SIGKILL if still alive
        kill -15 $pids 2>/dev/null || true
        sleep 1
        # Check if they are still alive
        still_alive=$(lsof -t -i :"$port" || true)
        filtered_still_alive=""
        for pid in $still_alive; do
            comm=$(ps -p "$pid" -o comm= 2>/dev/null || true)
            if [[ "$comm" != *"com.docker"* && "$comm" != *"Docker"* ]]; then
                filtered_still_alive="$filtered_still_alive $pid"
            fi
        done
        still_alive=$(echo $filtered_still_alive | xargs)
        if [ -n "$still_alive" ]; then
            echo "PID(s) didn't terminate, sending SIGKILL..."
            kill -9 $still_alive 2>/dev/null || true
        fi
    else
        echo "Port $port is free (or only used by Docker)."
    fi
done

# Check if there are other orphaned opencode processes running
echo -e "\n=== Checking for other orphaned opencode processes ==="
orphans=$(ps aux | grep -E "opencode serve" | grep -v grep | awk '{print $2}' || true)
if [ -n "$orphans" ]; then
    echo "Found other opencode processes with PID(s): $orphans"
    ps -p $orphans -o pid,comm,args || true
    echo "Terminating them..."
    kill -9 $orphans 2>/dev/null || true
else
    echo "No other orphaned opencode processes found."
fi

echo -e "\n=== Port Status after cleanup ==="
lsof -n -P -i :8081 -i :20128 -i :9090 -i :4096 || echo "All targeted ports are free!"
