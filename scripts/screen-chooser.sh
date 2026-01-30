#!/bin/bash
# ============================================================================
# Screen Chooser for iPhone/Termius
# Optimized for iPhone 17 Pro (portrait ~45 chars, landscape ~95 chars)
# ============================================================================
#
# Design principles:
#   - Single-digit selection (1-9) for fast thumb typing
#   - Compact display, no wasted space
#   - Color-coded status for quick scanning
#   - Names pulled from Claudeman state.json
#   - Minimal keystrokes to attach
#
# Usage:
#   ./screen-chooser.sh          # Interactive chooser
#   ./screen-chooser.sh 1        # Quick attach to session 1
#   ./screen-chooser.sh -l       # List only (no interactive)
#   ./screen-chooser.sh -h       # Help
#
# Alias: alias sc='path/to/screen-chooser.sh'
#   Then: sc      (interactive)
#         sc 2    (attach session 2)
#
# ============================================================================

set -e

# ============================================================================
# Configuration
# ============================================================================

CLAUDEMAN_STATE="$HOME/.claudeman/state.json"
CLAUDEMAN_SCREENS="$HOME/.claudeman/screens.json"

# iPhone 17 Pro portrait width (conservative)
MAX_WIDTH=44
MAX_NAME_LEN=28

# Page size for pagination (leave room for header/footer)
PAGE_SIZE=7

# Auto-refresh timeout (seconds) - 0 to disable
AUTO_REFRESH=60

# ============================================================================
# Icon Detection (Nerd Fonts vs ASCII)
# ============================================================================

# Detect if terminal likely supports nerd fonts
# Termius generally doesn't, so default to ASCII
detect_icons() {
    # Check TERM and common indicators
    if [[ "$TERM_PROGRAM" == "iTerm"* ]] || \
       [[ "$TERM" == "xterm-kitty" ]] || \
       [[ -n "$WEZTERM_PANE" ]] || \
       [[ "$LC_TERMINAL" == "iTerm2" ]]; then
        ICON_SCREEN="󰆍"
        ICON_ATTACHED="●"
        ICON_DETACHED="○"
        ICON_UNKNOWN="◌"
    else
        # ASCII fallback for Termius/basic terminals
        ICON_SCREEN="[S]"
        ICON_ATTACHED="*"
        ICON_DETACHED="-"
        ICON_UNKNOWN="?"
    fi
}

detect_icons

# ============================================================================
# Colors - ANSI 256 for better Termius compatibility
# ============================================================================

R='\033[0m'        # Reset
B='\033[1m'        # Bold
D='\033[2m'        # Dim
GREEN='\033[38;5;82m'
YELLOW='\033[38;5;220m'
BLUE='\033[38;5;75m'
CYAN='\033[38;5;87m'
RED='\033[38;5;203m'
GRAY='\033[38;5;245m'
WHITE='\033[38;5;255m'
BG_SEL='\033[48;5;236m'  # Selection background

# ============================================================================
# Utilities
# ============================================================================

# Truncate string with ellipsis, keeping end if it looks like a path
truncate() {
    local str="$1"
    local max="$2"
    local len=${#str}

    if [ "$len" -le "$max" ]; then
        echo "$str"
        return
    fi

    # If it's a path-like string, keep the end
    if [[ "$str" == *"/"* ]]; then
        echo "..${str: -$((max-2))}"
    else
        echo "${str:0:$((max-1))}…"
    fi
}

# Find full session ID from short ID (screen names use first 8 chars)
find_full_session_id() {
    local short_id="$1"

    # Try state.json first
    if [ -f "$CLAUDEMAN_STATE" ]; then
        local full_id
        full_id=$(jq -r --arg short "$short_id" '
            .sessions | keys[] | select(startswith($short))
        ' "$CLAUDEMAN_STATE" 2>/dev/null | head -1)
        if [ -n "$full_id" ]; then
            echo "$full_id"
            return
        fi
    fi

    # Try screens.json array
    if [ -f "$CLAUDEMAN_SCREENS" ]; then
        local full_id
        full_id=$(jq -r --arg short "$short_id" '
            .[] | select(.sessionId | startswith($short)) | .sessionId
        ' "$CLAUDEMAN_SCREENS" 2>/dev/null | head -1)
        if [ -n "$full_id" ]; then
            echo "$full_id"
            return
        fi
    fi

    echo "$short_id"
}

# Get session name from Claudeman state or screens.json
get_session_name() {
    local session_id="$1"

    # First, try screens.json (array format) - it has the name field
    if [ -f "$CLAUDEMAN_SCREENS" ]; then
        local name
        name=$(jq -r --arg id "$session_id" '
            .[] | select(.sessionId | startswith($id)) | .name // empty
        ' "$CLAUDEMAN_SCREENS" 2>/dev/null | head -1)
        if [ -n "$name" ] && [ "$name" != "null" ]; then
            echo "$name"
            return
        fi
    fi

    # Try state.json with full session ID lookup
    if [ -f "$CLAUDEMAN_STATE" ]; then
        local name
        name=$(jq -r --arg id "$session_id" '
            .sessions | to_entries[] | select(.key | startswith($id)) | .value.name // empty
        ' "$CLAUDEMAN_STATE" 2>/dev/null | head -1)
        if [ -n "$name" ] && [ "$name" != "null" ]; then
            echo "$name"
            return
        fi
    fi

    # Fallback: use short ID
    echo "${session_id:0:8}"
}

# Get working directory from state or screens.json
get_working_dir() {
    local session_id="$1"

    # Try screens.json first (array format)
    if [ -f "$CLAUDEMAN_SCREENS" ]; then
        local dir
        dir=$(jq -r --arg id "$session_id" '
            .[] | select(.sessionId | startswith($id)) | .workingDir // empty
        ' "$CLAUDEMAN_SCREENS" 2>/dev/null | head -1)
        if [ -n "$dir" ] && [ "$dir" != "null" ]; then
            echo "${dir/#$HOME/~}"
            return
        fi
    fi

    # Try state.json
    if [ -f "$CLAUDEMAN_STATE" ]; then
        local dir
        dir=$(jq -r --arg id "$session_id" '
            .sessions | to_entries[] | select(.key | startswith($id)) | .value.workingDir // empty
        ' "$CLAUDEMAN_STATE" 2>/dev/null | head -1)
        if [ -n "$dir" ] && [ "$dir" != "null" ]; then
            echo "${dir/#$HOME/~}"
            return
        fi
    fi
    echo ""
}

# Get token count from state
get_tokens() {
    local session_id="$1"

    if [ -f "$CLAUDEMAN_STATE" ]; then
        local tokens
        tokens=$(jq -r --arg id "$session_id" '
            .sessions | to_entries[] | select(.key | startswith($id)) |
            ((.value.inputTokens // 0) + (.value.outputTokens // 0))
        ' "$CLAUDEMAN_STATE" 2>/dev/null | head -1)

        if [ -n "$tokens" ] && [ "$tokens" != "null" ] && [ "$tokens" -gt 0 ] 2>/dev/null; then
            if [ "$tokens" -gt 1000 ]; then
                echo "$((tokens / 1000))k"
            else
                echo "${tokens}"
            fi
            return
        fi
    fi
    echo ""
}

# Get respawn status from screens.json (array format)
get_respawn_status() {
    local session_id="$1"

    if [ -f "$CLAUDEMAN_SCREENS" ]; then
        local respawn_enabled
        respawn_enabled=$(jq -r --arg id "$session_id" '
            .[] | select(.sessionId | startswith($id)) | .respawnConfig.enabled // false
        ' "$CLAUDEMAN_SCREENS" 2>/dev/null | head -1)

        if [ "$respawn_enabled" = "true" ]; then
            echo "R"  # Respawn active
            return
        fi
    fi
    echo ""
}

# Check if jq is available
check_deps() {
    if ! command -v jq &>/dev/null; then
        echo -e "${YELLOW}Note: Install jq for session names${R}"
        echo ""
    fi
}

# ============================================================================
# Screen List Parser
# ============================================================================

declare -a SCREEN_PIDS
declare -a SCREEN_NAMES
declare -a SCREEN_STATES
declare -a SESSION_IDS
declare -a DISPLAY_NAMES
declare -a WORKING_DIRS
declare -a TOKEN_COUNTS
declare -a RESPAWN_STATUS

parse_screens() {
    SCREEN_PIDS=()
    SCREEN_NAMES=()
    SCREEN_STATES=()
    SESSION_IDS=()
    DISPLAY_NAMES=()
    WORKING_DIRS=()
    TOKEN_COUNTS=()
    RESPAWN_STATUS=()

    local i=0

    # Regex for screen -ls lines: "	12345.claudeman-abc123	(date)	(Attached)"
    # We need to capture: PID, name, and the LAST parenthesized group (state)
    # Modern screen -ls shows: PID.name (date) (Attached|Detached)
    local screen_regex='^[[:space:]]*([0-9]+)\.([^[:space:]]+).*\((Attached|Detached|Multi)\)'

    # Parse screen -ls output
    while IFS= read -r line; do
        if [[ "$line" =~ $screen_regex ]]; then
            local pid="${BASH_REMATCH[1]}"
            local name="${BASH_REMATCH[2]}"
            local state="${BASH_REMATCH[3]}"

            SCREEN_PIDS+=("$pid")
            SCREEN_NAMES+=("$name")
            SCREEN_STATES+=("$state")

            # Extract session ID from claudeman screen name
            local session_id=""
            local cm_regex='^claudeman-(.+)$'
            if [[ "$name" =~ $cm_regex ]]; then
                session_id="${BASH_REMATCH[1]}"
            fi
            SESSION_IDS+=("$session_id")

            # Get display name and metadata
            if [ -n "$session_id" ]; then
                DISPLAY_NAMES+=("$(get_session_name "$session_id")")
                WORKING_DIRS+=("$(get_working_dir "$session_id")")
                TOKEN_COUNTS+=("$(get_tokens "$session_id")")
                RESPAWN_STATUS+=("$(get_respawn_status "$session_id")")
            else
                DISPLAY_NAMES+=("$name")
                WORKING_DIRS+=("")
                TOKEN_COUNTS+=("")
                RESPAWN_STATUS+=("")
            fi

            i=$((i + 1))
        fi
    done < <(screen -ls 2>/dev/null || true)
}

# ============================================================================
# Display Functions
# ============================================================================

clear_screen() {
    printf '\033[2J\033[H'
}

# Print header
print_header() {
    local count=${#SCREEN_PIDS[@]}
    echo -e "${B}${CYAN}${ICON_SCREEN} Screens${R} ${D}($count)${R}"
    echo -e "${D}$(printf '%.0s─' {1..32})${R}"
}

# Print a session entry
print_entry() {
    local idx="$1"
    local num=$((idx + 1))
    local name="${DISPLAY_NAMES[$idx]}"
    local state="${SCREEN_STATES[$idx]}"
    local dir="${WORKING_DIRS[$idx]}"
    local tokens="${TOKEN_COUNTS[$idx]}"
    local respawn="${RESPAWN_STATUS[$idx]}"

    # Truncate name (leave room for indicators)
    local name_max=$MAX_NAME_LEN
    [ -n "$respawn" ] && name_max=$((name_max - 2))
    [ -n "$tokens" ] && name_max=$((name_max - 4))
    name=$(truncate "$name" $name_max)

    # Status indicator and color
    local status_icon status_color
    if [[ "$state" == *"Attached"* ]]; then
        status_icon="$ICON_ATTACHED"
        status_color="$GREEN"
    elif [[ "$state" == *"Detached"* ]]; then
        status_icon="$ICON_DETACHED"
        status_color="$GRAY"
    else
        status_icon="$ICON_UNKNOWN"
        status_color="$YELLOW"
    fi

    # Build the line
    # Format: "1) name ○ R 45k"
    local num_str="${B}${WHITE}${num})${R}"
    local name_str="${B}${WHITE}${name}${R}"
    local status_str="${status_color}${status_icon}${R}"

    # Respawn indicator (green R if active)
    local respawn_str=""
    if [ -n "$respawn" ]; then
        respawn_str=" ${GREEN}${respawn}${R}"
    fi

    # Token display
    local token_str=""
    if [ -n "$tokens" ]; then
        token_str=" ${D}${tokens}${R}"
    fi

    echo -e " ${num_str} ${name_str} ${status_str}${respawn_str}${token_str}"

    # Show directory on second line if present (dimmed, indented)
    if [ -n "$dir" ]; then
        dir=$(truncate "$dir" $((MAX_NAME_LEN - 2)))
        echo -e "    ${D}${dir}${R}"
    fi
}

# Print footer with commands
print_footer() {
    local page="$1"
    local total_pages="$2"

    echo ""
    echo -e "${D}────────────────────────────────${R}"

    # Pagination indicator
    if [ "$total_pages" -gt 1 ]; then
        echo -e " ${D}Page $((page+1))/$total_pages${R}  ${GRAY}[${WHITE}n${GRAY}]ext [${WHITE}p${GRAY}]rev${R}"
    fi

    # Commands - most used first, thumb-friendly
    echo -e " ${GRAY}[${WHITE}1-9${GRAY}]attach [${WHITE}r${GRAY}]efresh [${WHITE}q${GRAY}]uit${R}"
}

# Print no screens message
print_no_screens() {
    clear_screen
    echo -e "${B}${CYAN}${ICON_SCREEN} Screens${R}"
    echo -e "${D}$(printf '%.0s─' {1..32})${R}"
    echo ""
    echo -e "  ${YELLOW}No screen sessions found${R}"
    echo ""
    echo -e "  ${D}Start one with:${R}"
    echo -e "  ${WHITE}claudeman web${R}"
    echo ""
    echo -e "${D}$(printf '%.0s─' {1..32})${R}"
    echo -e " ${GRAY}[${WHITE}r${GRAY}]efresh [${WHITE}q${GRAY}]uit${R}"
}

# ============================================================================
# Main Display Loop
# ============================================================================

current_page=0

render() {
    clear_screen
    parse_screens

    local count=${#SCREEN_PIDS[@]}

    if [ "$count" -eq 0 ]; then
        print_no_screens
        return
    fi

    local total_pages=$(( (count + PAGE_SIZE - 1) / PAGE_SIZE ))

    # Clamp page
    if [ "$current_page" -ge "$total_pages" ]; then
        current_page=$((total_pages - 1))
    fi
    if [ "$current_page" -lt 0 ]; then
        current_page=0
    fi

    local start=$((current_page * PAGE_SIZE))
    local end=$((start + PAGE_SIZE))
    if [ "$end" -gt "$count" ]; then
        end=$count
    fi

    print_header
    echo ""

    for ((i = start; i < end; i++)); do
        print_entry $i
    done

    print_footer $current_page $total_pages
}

# Attach to a screen
attach_screen() {
    local idx="$1"
    local pid="${SCREEN_PIDS[$idx]}"
    local name="${SCREEN_NAMES[$idx]}"

    if [ -z "$pid" ]; then
        return 1
    fi

    clear_screen
    echo -e "${GREEN}Attaching to ${B}${DISPLAY_NAMES[$idx]}${R}${GREEN}...${R}"
    echo -e "${D}(Ctrl+A D to detach)${R}"
    sleep 0.3

    # Attach
    screen -r "$pid.$name"

    # After detach, return to chooser
    return 0
}

# ============================================================================
# Input Handler
# ============================================================================

handle_input() {
    local key="$1"
    local count=${#SCREEN_PIDS[@]}
    local total_pages=$(( (count + PAGE_SIZE - 1) / PAGE_SIZE ))

    case "$key" in
        # Number selection (1-9)
        [1-9])
            local idx=$((key - 1))
            if [ "$idx" -lt "$count" ]; then
                attach_screen "$idx"
                return 0
            fi
            ;;

        # Escape sequence (arrow keys)
        $'\e')
            # Read the rest of the escape sequence
            read -rsn2 -t 0.1 seq 2>/dev/null || true
            case "$seq" in
                '[A'|'[D')  # Up or Left arrow
                    if [ "$total_pages" -gt 1 ]; then
                        current_page=$(( (current_page - 1 + total_pages) % total_pages ))
                    fi
                    ;;
                '[B'|'[C')  # Down or Right arrow
                    if [ "$total_pages" -gt 1 ]; then
                        current_page=$(( (current_page + 1) % total_pages ))
                    fi
                    ;;
            esac
            ;;

        # Navigation (vim-style and standard)
        n|N|j|J)
            if [ "$total_pages" -gt 1 ]; then
                current_page=$(( (current_page + 1) % total_pages ))
            fi
            ;;

        p|P|k|K)
            if [ "$total_pages" -gt 1 ]; then
                current_page=$(( (current_page - 1 + total_pages) % total_pages ))
            fi
            ;;

        # Refresh
        r|R)
            # Just re-render
            ;;

        # Quit
        q|Q)
            clear_screen
            exit 0
            ;;

        # Enter with no selection - attach first if only one
        '')
            if [ "$count" -eq 1 ]; then
                attach_screen 0
                return 0
            fi
            ;;
    esac

    return 0
}

# ============================================================================
# List Mode (non-interactive, for scripting)
# ============================================================================

list_mode() {
    parse_screens
    local count=${#SCREEN_PIDS[@]}

    if [ "$count" -eq 0 ]; then
        echo "No screen sessions"
        exit 0
    fi

    for ((i = 0; i < count; i++)); do
        local num=$((i + 1))
        local name="${DISPLAY_NAMES[$i]}"
        local state="${SCREEN_STATES[$i]}"
        local respawn="${RESPAWN_STATUS[$i]}"
        local indicator="-"
        [[ "$state" == *"Attached"* ]] && indicator="*"
        [ -n "$respawn" ] && indicator="${indicator}R"

        echo "$num) $name [$indicator]"
    done
}

# ============================================================================
# Quick Attach (by number)
# ============================================================================

quick_attach() {
    local num="$1"
    parse_screens

    local count=${#SCREEN_PIDS[@]}
    local idx=$((num - 1))

    if [ "$idx" -lt 0 ] || [ "$idx" -ge "$count" ]; then
        echo -e "${RED}Invalid session: $num${R}"
        echo "Available: 1-$count"
        exit 1
    fi

    attach_screen "$idx"
}

# ============================================================================
# Help
# ============================================================================

show_help() {
    cat << 'EOF'
Screen Chooser for iPhone/Termius

USAGE:
  sc              Interactive chooser
  sc <number>     Quick attach to session N
  sc -l           List sessions (non-interactive)
  sc -h           Show this help

INTERACTIVE KEYS:
  1-9      Attach to session
  n/j/↓    Next page
  p/k/↑    Previous page
  r        Refresh
  q        Quit

INDICATORS:
  * / ●    Attached (someone connected)
  - / ○    Detached (available)
  R        Respawn enabled
  45k      Token count

TIPS:
  - Alias: alias sc='path/to/screen-chooser.sh'
  - Detach: Ctrl+A D
  - Session names from Claudeman state

EOF
}

# ============================================================================
# Main
# ============================================================================

main() {
    # Argument parsing
    case "${1:-}" in
        -h|--help)
            show_help
            exit 0
            ;;
        -l|--list)
            list_mode
            exit 0
            ;;
        [1-9]|[1-9][0-9])
            # Quick attach by number
            quick_attach "$1"
            exit $?
            ;;
    esac

    # Check dependencies
    check_deps

    # Initial render
    render

    # Input loop
    while true; do
        # Read single character without enter
        # -s: silent, -n1: one char, -t: timeout for auto-refresh
        local timeout_opt=""
        if [ "$AUTO_REFRESH" -gt 0 ]; then
            timeout_opt="-t $AUTO_REFRESH"
        fi

        if read -rsn1 $timeout_opt key 2>/dev/null; then
            handle_input "$key"
        fi
        # Re-render after input or timeout (auto-refresh)
        render
    done
}

# Handle Ctrl+C gracefully
trap 'clear_screen; exit 0' INT

# Run
main "$@"
