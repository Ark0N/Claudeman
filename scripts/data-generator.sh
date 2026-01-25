#!/bin/bash
# Generates timestamped data to a file for testing
# Usage: ./scripts/data-generator.sh [output_file] [interval_seconds]
# Then: tail -f /tmp/test-data.log

OUTPUT="${1:-/tmp/test-data.log}"
INTERVAL="${2:-1}"

echo "Writing to $OUTPUT every ${INTERVAL}s (Ctrl+C to stop)"
echo "Run: tail -f $OUTPUT"

i=0
while true; do
    ((i++))
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Line $i - Random: $RANDOM" >> "$OUTPUT"
    sleep "$INTERVAL"
done
