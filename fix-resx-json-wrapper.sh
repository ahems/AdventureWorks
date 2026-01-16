#!/bin/bash
# Fix malformed resx files by unwrapping JSON values

RESOURCES_DIR="/workspaces/AdventureWorks/api-mcp/AdventureWorks/Resources"

for resx_file in "$RESOURCES_DIR"/Strings.*.resx; do
    if [ -f "$resx_file" ]; then
        culture=$(basename "$resx_file" | sed 's/Strings\.\(.*\)\.resx/\1/')
        echo "Fixing $culture..."
        
        # Create temporary file
        temp_file=$(mktemp)
        
        # Process the file: unwrap {"":"..."} patterns in value elements
        sed -E 's|<value>\{"":"([^"]*(\\"[^"]*)*)?"\}</value>|<value>\1</value>|g' "$resx_file" > "$temp_file"
        
        # Replace original file
        mv "$temp_file" "$resx_file"
        
        echo "✓ Fixed $resx_file"
    fi
done

echo ""
echo "All files fixed!"
