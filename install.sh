#!/usr/bin/env bash
# Claudeman Universal Installer
# https://github.com/Ark0N/claudeman
#
# Usage: curl -fsSL https://raw.githubusercontent.com/Ark0N/claudeman/master/install.sh | bash
#
# Environment variables:
#   CLAUDEMAN_NONINTERACTIVE=1  - Skip all prompts (for CI/automation)
#   CLAUDEMAN_INSTALL_DIR       - Custom install directory (default: ~/.claudeman/app)
#   CLAUDEMAN_SKIP_SYSTEMD=1    - Skip systemd service setup prompt

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

INSTALL_DIR="${CLAUDEMAN_INSTALL_DIR:-$HOME/.claudeman/app}"
REPO_URL="https://github.com/Ark0N/claudeman.git"
MIN_NODE_VERSION=18
NONINTERACTIVE="${CLAUDEMAN_NONINTERACTIVE:-0}"
SKIP_SYSTEMD="${CLAUDEMAN_SKIP_SYSTEMD:-0}"

# Claude CLI search paths (from src/session.ts)
CLAUDE_SEARCH_PATHS=(
    "$HOME/.local/bin/claude"
    "$HOME/.claude/local/claude"
    "/usr/local/bin/claude"
    "$HOME/.npm-global/bin/claude"
    "$HOME/bin/claude"
)

# ============================================================================
# Color Output (from scripts/screen-manager.sh pattern)
# ============================================================================

# Check if terminal supports colors
if [[ -t 1 ]] && [[ -n "${TERM:-}" ]] && command -v tput &>/dev/null; then
    ncolors=$(tput colors 2>/dev/null || echo 0)
    if [[ "$ncolors" -ge 8 ]]; then
        RED='\033[0;31m'
        GREEN='\033[0;32m'
        YELLOW='\033[1;33m'
        BLUE='\033[0;34m'
        CYAN='\033[0;36m'
        MAGENTA='\033[0;35m'
        BOLD='\033[1m'
        DIM='\033[2m'
        NC='\033[0m'
    else
        RED='' GREEN='' YELLOW='' BLUE='' CYAN='' MAGENTA='' BOLD='' DIM='' NC=''
    fi
else
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' MAGENTA='' BOLD='' DIM='' NC=''
fi

# ============================================================================
# Output Helpers
# ============================================================================

info() {
    echo -e "${BLUE}==>${NC} ${BOLD}$1${NC}"
}

success() {
    echo -e "${GREEN}==>${NC} ${BOLD}$1${NC}"
}

warn() {
    echo -e "${YELLOW}Warning:${NC} $1"
}

error() {
    echo -e "${RED}Error:${NC} $1" >&2
}

die() {
    error "$1"
    exit 1
}

# ============================================================================
# System Detection
# ============================================================================

detect_os() {
    local os
    os="$(uname -s)"
    case "$os" in
        Darwin) echo "macos" ;;
        Linux)  echo "linux" ;;
        *)      die "Unsupported operating system: $os" ;;
    esac
}

detect_arch() {
    local arch
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64)   echo "x64" ;;
        aarch64|arm64)  echo "arm64" ;;
        *)              die "Unsupported architecture: $arch" ;;
    esac
}

detect_linux_distro() {
    if [[ ! -f /etc/os-release ]]; then
        echo "unknown"
        return
    fi

    # Source os-release to get ID
    # shellcheck source=/dev/null
    source /etc/os-release

    case "${ID:-}" in
        debian|ubuntu|linuxmint|pop|elementary|zorin|kali)
            echo "debian"
            ;;
        fedora|rhel|centos|rocky|alma|ol)
            echo "fedora"
            ;;
        arch|manjaro|endeavouros|garuda)
            echo "arch"
            ;;
        opensuse*|suse*)
            echo "suse"
            ;;
        alpine)
            echo "alpine"
            ;;
        *)
            # Try ID_LIKE as fallback
            case "${ID_LIKE:-}" in
                *debian*|*ubuntu*) echo "debian" ;;
                *fedora*|*rhel*)   echo "fedora" ;;
                *arch*)            echo "arch" ;;
                *suse*)            echo "suse" ;;
                *)                 echo "unknown" ;;
            esac
            ;;
    esac
}

# ============================================================================
# Dependency Checks
# ============================================================================

check_node() {
    if ! command -v node &>/dev/null; then
        return 1
    fi

    local version
    version=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [[ -z "$version" ]] || [[ "$version" -lt "$MIN_NODE_VERSION" ]]; then
        return 1
    fi

    return 0
}

check_npm() {
    command -v npm &>/dev/null
}

check_git() {
    command -v git &>/dev/null
}

check_screen() {
    command -v screen &>/dev/null
}

check_claude() {
    # Check PATH first
    if command -v claude &>/dev/null; then
        return 0
    fi

    # Check known install locations
    for path in "${CLAUDE_SEARCH_PATHS[@]}"; do
        if [[ -x "$path" ]]; then
            return 0
        fi
    done

    return 1
}

get_claude_path() {
    if command -v claude &>/dev/null; then
        command -v claude
        return
    fi

    for path in "${CLAUDE_SEARCH_PATHS[@]}"; do
        if [[ -x "$path" ]]; then
            echo "$path"
            return
        fi
    done
}

# ============================================================================
# Dependency Installation
# ============================================================================

install_node_macos() {
    info "Installing Node.js via Homebrew..."

    if ! command -v brew &>/dev/null; then
        info "Installing Homebrew first..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

        # Add Homebrew to PATH for Apple Silicon
        if [[ -f /opt/homebrew/bin/brew ]]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        fi
    fi

    brew install node
}

install_node_debian() {
    info "Installing Node.js via NodeSource..."

    # Check if we can use sudo
    if ! command -v sudo &>/dev/null; then
        die "sudo is required to install Node.js. Please install sudo or Node.js manually."
    fi

    # Install prerequisites
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl gnupg

    # Add NodeSource repository
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

    NODE_MAJOR=20
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list

    sudo apt-get update
    sudo apt-get install -y nodejs
}

install_node_fedora() {
    info "Installing Node.js via dnf..."

    if ! command -v sudo &>/dev/null; then
        die "sudo is required to install Node.js. Please install sudo or Node.js manually."
    fi

    sudo dnf install -y nodejs npm
}

install_node_arch() {
    info "Installing Node.js via pacman..."

    if ! command -v sudo &>/dev/null; then
        die "sudo is required to install Node.js. Please install sudo or Node.js manually."
    fi

    sudo pacman -Sy --noconfirm nodejs npm
}

install_node_alpine() {
    info "Installing Node.js via apk..."

    if [[ $EUID -eq 0 ]]; then
        apk add --no-cache nodejs npm
    else
        if ! command -v sudo &>/dev/null; then
            die "sudo is required to install Node.js. Please install sudo or Node.js manually."
        fi
        sudo apk add --no-cache nodejs npm
    fi
}

install_screen_macos() {
    info "Installing GNU Screen via Homebrew..."
    brew install screen
}

install_screen_debian() {
    info "Installing GNU Screen via apt..."
    sudo apt-get update
    sudo apt-get install -y screen
}

install_screen_fedora() {
    info "Installing GNU Screen via dnf..."
    sudo dnf install -y screen
}

install_screen_arch() {
    info "Installing GNU Screen via pacman..."
    sudo pacman -Sy --noconfirm screen
}

install_screen_alpine() {
    info "Installing GNU Screen via apk..."
    if [[ $EUID -eq 0 ]]; then
        apk add --no-cache screen
    else
        sudo apk add --no-cache screen
    fi
}

install_git_macos() {
    info "Installing Git via Homebrew..."
    brew install git
}

install_git_debian() {
    info "Installing Git via apt..."
    sudo apt-get update
    sudo apt-get install -y git
}

install_git_fedora() {
    info "Installing Git via dnf..."
    sudo dnf install -y git
}

install_git_arch() {
    info "Installing Git via pacman..."
    sudo pacman -Sy --noconfirm git
}

install_git_alpine() {
    info "Installing Git via apk..."
    if [[ $EUID -eq 0 ]]; then
        apk add --no-cache git
    else
        sudo apk add --no-cache git
    fi
}

# ============================================================================
# Interactive Prompts
# ============================================================================

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-y}"

    if [[ "$NONINTERACTIVE" == "1" ]]; then
        [[ "$default" == "y" ]]
        return
    fi

    local yn_hint
    if [[ "$default" == "y" ]]; then
        yn_hint="[Y/n]"
    else
        yn_hint="[y/N]"
    fi

    while true; do
        echo -en "${CYAN}$prompt${NC} $yn_hint "
        read -r answer
        answer="${answer:-$default}"
        case "$answer" in
            [Yy]|[Yy][Ee][Ss]) return 0 ;;
            [Nn]|[Nn][Oo])     return 1 ;;
            *)                 echo "Please answer yes or no." ;;
        esac
    done
}

# ============================================================================
# PATH Management
# ============================================================================

detect_shell_profile() {
    local shell_name
    shell_name="$(basename "${SHELL:-/bin/bash}")"

    case "$shell_name" in
        zsh)
            if [[ -f "$HOME/.zshrc" ]]; then
                echo "$HOME/.zshrc"
            else
                echo "$HOME/.zprofile"
            fi
            ;;
        bash)
            if [[ -f "$HOME/.bashrc" ]]; then
                echo "$HOME/.bashrc"
            elif [[ -f "$HOME/.bash_profile" ]]; then
                echo "$HOME/.bash_profile"
            else
                echo "$HOME/.profile"
            fi
            ;;
        fish)
            echo "$HOME/.config/fish/config.fish"
            ;;
        *)
            echo "$HOME/.profile"
            ;;
    esac
}

add_to_path() {
    local bin_dir="$1"
    local profile
    profile=$(detect_shell_profile)

    # Check if already in PATH
    if echo "$PATH" | tr ':' '\n' | grep -qx "$bin_dir"; then
        info "PATH already includes $bin_dir"
        return 0
    fi

    # Check if already in profile
    if [[ -f "$profile" ]] && grep -q "$bin_dir" "$profile" 2>/dev/null; then
        info "PATH export already in $profile"
        return 0
    fi

    info "Adding $bin_dir to PATH in $profile"

    # Create profile directory if needed (for fish)
    mkdir -p "$(dirname "$profile")"

    local shell_name
    shell_name="$(basename "${SHELL:-/bin/bash}")"

    if [[ "$shell_name" == "fish" ]]; then
        echo "fish_add_path $bin_dir" >> "$profile"
    else
        echo "" >> "$profile"
        echo "# Added by Claudeman installer" >> "$profile"
        echo "export PATH=\"$bin_dir:\$PATH\"" >> "$profile"
    fi

    success "Added to $profile - restart your shell or run: source $profile"
}

# ============================================================================
# Systemd Service Setup (Linux only)
# ============================================================================

setup_systemd_service() {
    local service_dir="$HOME/.config/systemd/user"
    local service_file="$service_dir/claudeman-web.service"

    info "Setting up systemd user service..."

    mkdir -p "$service_dir"

    # Create service file
    cat > "$service_file" << EOF
[Unit]
Description=Claudeman Web Server
After=network.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/dist/index.js web --https
WorkingDirectory=$HOME
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

    # Reload systemd
    systemctl --user daemon-reload

    # Enable service
    systemctl --user enable claudeman-web.service

    # Enable lingering (allows service to run after logout)
    if command -v loginctl &>/dev/null; then
        loginctl enable-linger "$USER" 2>/dev/null || true
    fi

    success "Systemd service installed at $service_file"
    info "Start with: systemctl --user start claudeman-web"
}

# ============================================================================
# Main Installation
# ============================================================================

print_banner() {
    echo -e "${CYAN}${BOLD}"
    echo "  ____  _                 _                             "
    echo " / ___|| | __ _ _   _  __| | ___ _ __ ___   __ _ _ __   "
    echo "| |    | |/ _\` | | | |/ _\` |/ _ \\ '_ \` _ \\ / _\` | '_ \\  "
    echo "| |____| | (_| | |_| | (_| |  __/ | | | | | (_| | | | | "
    echo " \\_____|_|\\__,_|\\__,_|\\__,_|\\___|_| |_| |_|\\__,_|_| |_| "
    echo ""
    echo -e "${NC}${DIM}  The missing control plane for Claude Code${NC}"
    echo ""
}

main() {
    print_banner

    # Detect system
    local os arch distro=""
    os=$(detect_os)
    arch=$(detect_arch)

    if [[ "$os" == "linux" ]]; then
        distro=$(detect_linux_distro)
    fi

    info "Detected: $os ($arch)${distro:+ - $distro}"
    echo ""

    # ========================================================================
    # Check/Install Dependencies
    # ========================================================================

    # Git
    info "Checking Git..."
    if ! check_git; then
        if prompt_yes_no "Git is not installed. Install it now?"; then
            case "$os-$distro" in
                macos-*)       install_git_macos ;;
                linux-debian)  install_git_debian ;;
                linux-fedora)  install_git_fedora ;;
                linux-arch)    install_git_arch ;;
                linux-alpine)  install_git_alpine ;;
                *)             die "Don't know how to install Git on this system. Please install it manually." ;;
            esac
        else
            die "Git is required to install Claudeman."
        fi
    else
        success "Git is installed"
    fi

    # Node.js
    info "Checking Node.js (v$MIN_NODE_VERSION+)..."
    if ! check_node; then
        local node_version=""
        if command -v node &>/dev/null; then
            node_version=$(node --version 2>/dev/null || echo "unknown")
            warn "Node.js $node_version is installed but version $MIN_NODE_VERSION+ is required."
        fi

        if prompt_yes_no "Install Node.js $MIN_NODE_VERSION+?"; then
            case "$os-$distro" in
                macos-*)       install_node_macos ;;
                linux-debian)  install_node_debian ;;
                linux-fedora)  install_node_fedora ;;
                linux-arch)    install_node_arch ;;
                linux-alpine)  install_node_alpine ;;
                *)             die "Don't know how to install Node.js on this system. Please install it manually." ;;
            esac
        else
            die "Node.js $MIN_NODE_VERSION+ is required to run Claudeman."
        fi
    else
        local node_ver
        node_ver=$(node --version 2>/dev/null)
        success "Node.js $node_ver is installed"
    fi

    # Verify npm (should come with Node.js)
    if ! check_npm; then
        die "npm is not available. Please reinstall Node.js."
    fi

    # GNU Screen
    info "Checking GNU Screen..."
    if ! check_screen; then
        if prompt_yes_no "GNU Screen is not installed. Install it now?"; then
            case "$os-$distro" in
                macos-*)       install_screen_macos ;;
                linux-debian)  install_screen_debian ;;
                linux-fedora)  install_screen_fedora ;;
                linux-arch)    install_screen_arch ;;
                linux-alpine)  install_screen_alpine ;;
                *)             die "Don't know how to install GNU Screen on this system. Please install it manually." ;;
            esac
        else
            die "GNU Screen is required for session persistence."
        fi
    else
        success "GNU Screen is installed"
    fi

    # Claude CLI (warning only)
    info "Checking Claude CLI..."
    if ! check_claude; then
        echo ""
        warn "Claude CLI is not installed!"
        echo -e "  ${DIM}Claudeman requires Claude CLI to manage AI sessions.${NC}"
        echo -e "  ${DIM}Install it with:${NC}"
        echo ""
        echo -e "    ${CYAN}npm install -g @anthropic-ai/claude-code${NC}"
        echo ""
        echo -e "  ${DIM}Or see: https://docs.anthropic.com/en/docs/claude-code${NC}"
        echo ""
    else
        local claude_path
        claude_path=$(get_claude_path)
        success "Claude CLI found at $claude_path"
    fi

    echo ""

    # ========================================================================
    # Clone/Update Repository
    # ========================================================================

    info "Installing Claudeman to $INSTALL_DIR..."

    if [[ -d "$INSTALL_DIR/.git" ]]; then
        info "Existing installation found, updating..."
        cd "$INSTALL_DIR"
        git fetch --quiet origin
        git reset --hard origin/master --quiet
    else
        # Create parent directory
        mkdir -p "$(dirname "$INSTALL_DIR")"

        # Clone repository
        git clone --quiet "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi

    success "Repository ready"

    # ========================================================================
    # Build
    # ========================================================================

    info "Installing dependencies..."
    npm install --quiet --no-fund --no-audit

    info "Building..."
    npm run build --quiet

    success "Build complete"

    # ========================================================================
    # Add to PATH
    # ========================================================================

    local bin_dir="$INSTALL_DIR/dist"
    add_to_path "$bin_dir"

    # Create symlink in a common PATH location if possible
    local symlink_dir="$HOME/.local/bin"
    if [[ -d "$symlink_dir" ]] || mkdir -p "$symlink_dir" 2>/dev/null; then
        ln -sf "$INSTALL_DIR/dist/index.js" "$symlink_dir/claudeman"
        info "Created symlink: $symlink_dir/claudeman"
    fi

    # ========================================================================
    # Systemd Service (Linux only)
    # ========================================================================

    if [[ "$os" == "linux" ]] && [[ "$SKIP_SYSTEMD" != "1" ]] && command -v systemctl &>/dev/null; then
        echo ""
        if prompt_yes_no "Set up systemd service for auto-start?"; then
            setup_systemd_service
        fi
    fi

    # ========================================================================
    # Success!
    # ========================================================================

    echo ""
    echo -e "${GREEN}${BOLD}============================================================${NC}"
    echo -e "${GREEN}${BOLD}  Claudeman installed successfully!${NC}"
    echo -e "${GREEN}${BOLD}============================================================${NC}"
    echo ""
    echo -e "  ${BOLD}Quick Start:${NC}"
    echo ""
    echo -e "    ${CYAN}# Start the web server${NC}"
    echo -e "    claudeman web"
    echo ""
    echo -e "    ${CYAN}# Start with HTTPS (enables browser notifications)${NC}"
    echo -e "    claudeman web --https"
    echo ""
    echo -e "    ${CYAN}# Open in browser${NC}"
    echo -e "    https://localhost:3000"
    echo ""

    if [[ "$os" == "linux" ]] && [[ -f "$HOME/.config/systemd/user/claudeman-web.service" ]]; then
        echo -e "  ${BOLD}Systemd Service:${NC}"
        echo ""
        echo -e "    ${CYAN}systemctl --user start claudeman-web${NC}   # Start"
        echo -e "    ${CYAN}systemctl --user status claudeman-web${NC}  # Check status"
        echo -e "    ${CYAN}journalctl --user -u claudeman-web -f${NC}  # View logs"
        echo ""
    fi

    echo -e "  ${BOLD}Documentation:${NC}"
    echo -e "    https://github.com/Ark0N/claudeman"
    echo ""

    if ! check_claude; then
        echo -e "  ${YELLOW}${BOLD}Reminder:${NC} Install Claude CLI to start using Claudeman:"
        echo -e "    ${CYAN}npm install -g @anthropic-ai/claude-code${NC}"
        echo ""
    fi

    # Remind to reload shell if PATH was modified
    local profile
    profile=$(detect_shell_profile)
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$bin_dir"; then
        echo -e "  ${DIM}Restart your shell or run: source $profile${NC}"
        echo ""
    fi
}

# Wrap in main to prevent partial execution on curl | bash
main "$@"
