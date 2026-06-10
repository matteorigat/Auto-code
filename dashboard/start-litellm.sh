#!/bin/bash
# Install litellm if missing
if ! command -v litellm &> /dev/null; then
    echo "LiteLLM not found. Installing..."
    pip3 install litellm[proxy]
fi

echo "Starting LiteLLM proxy on port 4000..."
litellm --config litellm-config.yaml --port 4000
