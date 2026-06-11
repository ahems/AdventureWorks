#!/bin/bash
# Post-deployment script for Admin Container App
# The admin app is now a Container App; environment variables are configured
# via Bicep at provision time and injected at container startup.
# No post-deployment configuration is required.

set -euo pipefail

color_cyan() { echo -e "\033[36m$1\033[0m"; }
color_green() { echo -e "\033[32m$1\033[0m"; }

color_cyan "Admin app is deployed as a Container App."
color_green "✓ No post-deployment configuration needed — env vars are set in Bicep."
