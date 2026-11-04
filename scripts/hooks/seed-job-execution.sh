#!/bin/bash

# Source from postprovision; Azure runs the seed independently of azd.
start_seed_job() {
    local job_name="$1" resource_group="$2"
    local execution
    if ! execution=$(az containerapp job start \
        --name "$job_name" --resource-group "$resource_group" \
        --query name --output tsv); then
        echo "ERROR: Could not start the database seed job." >&2
        return 1
    fi
    execution="${execution//$'\r'/}"
    if [[ -z "$execution" || "$execution" == "None" || "$execution" == "null" ]]; then
        echo "ERROR: Seed-job start did not return an execution name; startup cannot be confirmed." >&2
        return 1
    fi
    echo "  Started seed-job execution $execution; deployment continues without waiting for completion."
    echo "  Database readiness is separate from deployment success. Check /health or the execution logs for completion or failure."
}
