#!/usr/bin/env bash
# SAFE: download script, verify checksum, then execute
curl -sSL -o install.sh https://example.com/install.sh
sha256sum -c install.sh.sha256
bash ./install.sh
