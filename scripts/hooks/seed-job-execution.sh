#!/bin/bash

# Source from postprovision; keep exact-execution monitoring independently testable.
start_and_wait_for_seed_job() {
    local job_name="$1" resource_group="$2"
    local execution status output
    local timeout="${SEED_JOB_WAIT_TIMEOUT_SECONDS:-2400}"
    if [[ ! "$timeout" =~ ^[1-9][0-9]*$ ]]; then
        echo "ERROR: SEED_JOB_WAIT_TIMEOUT_SECONDS must be a positive integer." >&2
        return 1
    fi
    if ! execution=$(az containerapp job start \
        --name "$job_name" --resource-group "$resource_group" \
        --query name --output tsv); then
        echo "ERROR: Could not start the database seed job." >&2
        return 1
    fi
    execution="${execution//$'\r'/}"
    if [[ -z "$execution" || "$execution" == "None" || "$execution" == "null" ]]; then
        echo "ERROR: Seed-job start did not return an execution name; completion cannot be verified." >&2
        return 1
    fi
    echo "  Waiting for seed-job execution $execution (timeout ${timeout}s)..."
    local started=$SECONDS
    while (( SECONDS - started < timeout )); do
        if ! output=$(az containerapp job execution show \
            --name "$job_name" --resource-group "$resource_group" \
            --job-execution-name "$execution" \
            --query properties.status --output tsv); then
            echo "ERROR: Could not observe seed-job execution $execution; refusing to assume success." >&2
            return 1
        fi
        status="${output//$'\r'/}"
        case "$status" in
            Succeeded)
                echo "  Seed-job execution $execution succeeded; base seed and manufacturing overlays are ready."
                return 0
                ;;
            Failed|Stopped|Canceled|Cancelled|Degraded)
                echo "ERROR: Seed-job execution $execution ended with status $status. Inspect its container logs and /logs/seed-*.log." >&2
                return 1
                ;;
            Running|Processing|Pending|Unknown|"")
                sleep 10
                ;;
            *)
                echo "ERROR: Unexpected seed-job status '$status' for $execution." >&2
                return 1
                ;;
        esac
    done
    echo "ERROR: Timed out waiting for seed-job execution $execution; it may still be running. Inspect execution status/logs before retrying." >&2
    return 1
}
