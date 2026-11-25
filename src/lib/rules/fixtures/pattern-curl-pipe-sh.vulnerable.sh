#!/usr/bin/env bash
# INSECURE: piping remote download directly to shell execution
curl -sSL https://example.com/install.sh | bash
wget -qO- https://example.com/setup.sh | sh
