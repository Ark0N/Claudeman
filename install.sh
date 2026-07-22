#!/usr/bin/env bash
# Codeman Universal Installer
# https://github.com/Ark0N/Codeman
#
# Usage: curl -fsSL https://raw.githubusercontent.com/Ark0N/Codeman/master/install.sh | bash
#
# Environment variables:
#   CODEMAN_NONINTERACTIVE=1  - Skip all prompts and accept their defaults
#                               (CI/automation). Required for headless runs
#                               that need system changes (sudo package
#                               installs, AI CLI download); without it those
#                               steps abort instead of running silently.
#   CODEMAN_INSTALL_DIR       - Custom install directory (default: ~/.codeman/app)
#   CODEMAN_SKIP_SYSTEMD=1    - Skip systemd/launchd service setup prompt
#   CODEMAN_NODE_VERSION      - Node.js major version to install (default: 22)
#   CODEMAN_REPO_URL          - Custom git repository URL (default: upstream Codeman)
#   CODEMAN_BRANCH            - Git branch to install (default: master)

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

INSTALL_DIR="${CODEMAN_INSTALL_DIR:-$HOME/.codeman/app}"
REPO_URL="${CODEMAN_REPO_URL:-https://github.com/Ark0N/Codeman.git}"
BRANCH="${CODEMAN_BRANCH:-master}"
MIN_NODE_VERSION=18
TARGET_NODE_VERSION="${CODEMAN_NODE_VERSION:-22}"
NONINTERACTIVE="${CODEMAN_NONINTERACTIVE:-0}"
SKIP_SYSTEMD="${CODEMAN_SKIP_SYSTEMD:-0}"

# puppeteer is a devDependency used only by scripts/browser-comparison.mjs — its
# ~150MB chrome-headless-shell download is never needed to build or run Codeman.
# Skipping it avoids a slow download and a fatal install failure when a prior
# download left a corrupt cache (folder present, executable missing). Respect an
# explicit caller override so contributors can still fetch the browser if needed.
export PUPPETEER_SKIP_DOWNLOAD="${PUPPETEER_SKIP_DOWNLOAD:-1}"

# Claude CLI search paths (from src/utils/claude-cli-resolver.ts)
CLAUDE_SEARCH_PATHS=(
    "$HOME/.local/bin/claude"
    "$HOME/.claude/local/claude"
    "/usr/local/bin/claude"
    "$HOME/.npm-global/bin/claude"
    "$HOME/bin/claude"
)

# OpenCode CLI search paths (from src/utils/opencode-cli-resolver.ts)
OPENCODE_SEARCH_PATHS=(
    "$HOME/.opencode/bin/opencode"
    "$HOME/.local/bin/opencode"
    "/usr/local/bin/opencode"
    "$HOME/go/bin/opencode"
    "$HOME/.bun/bin/opencode"
    "$HOME/.npm-global/bin/opencode"
    "$HOME/bin/opencode"
)

# Codex CLI search paths (from src/utils/codex-cli-resolver.ts)
CODEX_SEARCH_PATHS=(
    "$HOME/.codex/bin/codex"
    "$HOME/.local/bin/codex"
    "/usr/local/bin/codex"
    "$HOME/.bun/bin/codex"
    "$HOME/.npm-global/bin/codex"
    "$HOME/bin/codex"
)

# Gemini CLI search paths (from src/utils/gemini-cli-resolver.ts)
GEMINI_SEARCH_PATHS=(
    "$HOME/.gemini/bin/gemini"
    "$HOME/.local/bin/gemini"
    "/usr/local/bin/gemini"
    "$HOME/.bun/bin/gemini"
    "$HOME/.npm-global/bin/gemini"
    "$HOME/bin/gemini"
)

# ============================================================================
# Color Output
# ============================================================================

setup_colors() {
    # Check if terminal supports colors
    if [[ -t 1 ]] && [[ -n "${TERM:-}" ]] && command -v tput &>/dev/null; then
        local ncolors
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
            return
        fi
    fi
    # No color support
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' MAGENTA='' BOLD='' DIM='' NC=''
}

setup_colors

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
    echo -e "${YELLOW}Warning:${NC} $1" >&2
}

error() {
    echo -e "${RED}Error:${NC} $1" >&2
}

die() {
    error "$1"
    exit 1
}

# Security notice — printed at the very end of install/update so it is the last
# thing the user sees (the default loopback bind + how to expose it safely).
print_security_notice() {
    echo ""
    echo -e "  ${YELLOW}${BOLD}Security:${NC}"
    echo -e "    Codeman binds ${BOLD}127.0.0.1${NC} (this machine only) — no password needed by default."
    echo -e "    To reach it from another device, do ONE of:"
    echo -e "      ${CYAN}•${NC} tailscale serve / cloudflared tunnel   ${DIM}(recommended)${NC}, or"
    echo -e "      ${CYAN}•${NC} ${CYAN}codeman web --host 0.0.0.0${NC}  AND set ${CYAN}CODEMAN_PASSWORD${NC}"
    echo -e "    A non-loopback bind without a password still starts, but warns loudly."
    echo -e "    ${DIM}Details: docs/security-architecture.md${NC}"
    echo ""
}

# ============================================================================
# Cleanup on Failure
# ============================================================================

cleanup() {
    local exit_code=$?
    if [[ $exit_code -ne 0 ]]; then
        error "Installation failed. Partial installation may remain at $INSTALL_DIR"
        error "To retry, run the installer again or remove the directory manually."
    fi
}

trap cleanup EXIT

# ============================================================================
# System Detection
# ============================================================================

detect_os() {
    local os
    os="$(uname -s)"
    case "$os" in
        Darwin) echo "macos" ;;
        Linux)  echo "linux" ;;
        MINGW*|MSYS*|CYGWIN*)
            die "Windows is not supported directly. Please use WSL (Windows Subsystem for Linux)."
            ;;
        *)      die "Unsupported operating system: $os" ;;
    esac
}

detect_arch() {
    local arch
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64)   echo "x64" ;;
        aarch64|arm64)  echo "arm64" ;;
        armv7l)         echo "armv7" ;;
        *)              die "Unsupported architecture: $arch" ;;
    esac
}

detect_linux_distro() {
    if [[ ! -f /etc/os-release ]]; then
        # Fallback detection for older systems
        if [[ -f /etc/debian_version ]]; then
            echo "debian"
        elif [[ -f /etc/redhat-release ]]; then
            echo "fedora"
        elif [[ -f /etc/arch-release ]]; then
            echo "arch"
        elif [[ -f /etc/alpine-release ]]; then
            echo "alpine"
        else
            echo "unknown"
        fi
        return
    fi

    # Source os-release to get ID
    # shellcheck source=/dev/null
    source /etc/os-release

    case "${ID:-}" in
        debian|ubuntu|linuxmint|pop|elementary|zorin|kali|raspbian)
            echo "debian"
            ;;
        fedora|rhel|centos|rocky|alma|ol|amzn)
            echo "fedora"
            ;;
        arch|manjaro|endeavouros|garuda|artix)
            echo "arch"
            ;;
        opensuse*|sles|suse)
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
# Prerequisite Checks
# ============================================================================

check_curl_or_wget() {
    if command -v curl &>/dev/null; then
        DOWNLOADER="curl"
        return 0
    elif command -v wget &>/dev/null; then
        DOWNLOADER="wget"
        return 0
    fi
    return 1
}

download() {
    local url="$1"
    local output="$2"

    if [[ "$DOWNLOADER" == "curl" ]]; then
        curl -fsSL "$url" -o "$output"
    else
        wget -q "$url" -O "$output"
    fi
}

download_to_stdout() {
    local url="$1"

    if [[ "$DOWNLOADER" == "curl" ]]; then
        curl -fsSL "$url"
    else
        wget -qO- "$url"
    fi
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

check_tmux() {
    command -v tmux &>/dev/null
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

check_opencode() {
    if command -v opencode &>/dev/null; then
        return 0
    fi

    for path in "${OPENCODE_SEARCH_PATHS[@]}"; do
        if [[ -x "$path" ]]; then
            return 0
        fi
    done

    return 1
}

get_opencode_path() {
    if command -v opencode &>/dev/null; then
        command -v opencode
        return
    fi

    for path in "${OPENCODE_SEARCH_PATHS[@]}"; do
        if [[ -x "$path" ]]; then
            echo "$path"
            return
        fi
    done
}

check_codex() {
    if command -v codex &>/dev/null; then
        return 0
    fi

    for path in "${CODEX_SEARCH_PATHS[@]}"; do
        if [[ -x "$path" ]]; then
            return 0
        fi
    done

    return 1
}

get_codex_path() {
    if command -v codex &>/dev/null; then
        command -v codex
        return
    fi

    for path in "${CODEX_SEARCH_PATHS[@]}"; do
        if [[ -x "$path" ]]; then
            echo "$path"
            return
        fi
    done
}

check_gemini() {
    if command -v gemini &>/dev/null; then
        return 0
    fi

    for path in "${GEMINI_SEARCH_PATHS[@]}"; do
        if [[ -x "$path" ]]; then
            return 0
        fi
    done

    return 1
}

get_gemini_path() {
    if command -v gemini &>/dev/null; then
        command -v gemini
        return
    fi

    for path in "${GEMINI_SEARCH_PATHS[@]}"; do
        if [[ -x "$path" ]]; then
            echo "$path"
            return
        fi
    done
}

check_cloudflared() {
    # Check ~/.local/bin first (matches tunnel-manager.ts resolution order)
    if [[ -x "$HOME/.local/bin/cloudflared" ]]; then
        return 0
    fi
    if [[ -x "/usr/local/bin/cloudflared" ]]; then
        return 0
    fi
    if command -v cloudflared &>/dev/null; then
        return 0
    fi
    return 1
}

get_cloudflared_path() {
    if [[ -x "$HOME/.local/bin/cloudflared" ]]; then
        echo "$HOME/.local/bin/cloudflared"
        return
    fi
    if [[ -x "/usr/local/bin/cloudflared" ]]; then
        echo "/usr/local/bin/cloudflared"
        return
    fi
    command -v cloudflared 2>/dev/null
}

# ============================================================================
# Dependency Installation
# ============================================================================

ensure_sudo() {
    if [[ $EUID -eq 0 ]]; then
        return 0
    fi
    if ! command -v sudo &>/dev/null; then
        die "sudo is required but not installed. Please install packages manually or run as root."
    fi
    # Validate sudo access
    # When piped (curl | bash), stdin is the pipe — redirect from /dev/tty so sudo can prompt
    if [[ -e /dev/tty ]]; then
        if ! sudo -v 2>/dev/null < /dev/tty; then
            die "Failed to obtain sudo privileges."
        fi
    else
        if ! sudo -v 2>/dev/null; then
            die "Failed to obtain sudo privileges. Try running the script directly instead of piping."
        fi
    fi
}

run_as_root() {
    if [[ $EUID -eq 0 ]]; then
        "$@"
    else
        sudo "$@"
    fi
}

ensure_homebrew() {
    if command -v brew &>/dev/null; then
        return 0
    fi

    info "Installing Homebrew first..."
    # When piped (curl | bash), stdin is the pipe — Homebrew needs TTY for sudo password prompt
    if [[ -e /dev/tty ]]; then
        /bin/bash -c "$(download_to_stdout https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" < /dev/tty
    else
        NONINTERACTIVE=1 /bin/bash -c "$(download_to_stdout https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi

    # Add Homebrew to PATH for Apple Silicon
    if [[ -f /opt/homebrew/bin/brew ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -f /usr/local/bin/brew ]]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi
}

install_node_macos() {
    info "Installing Node.js via Homebrew..."
    ensure_homebrew
    brew install node
}

install_node_debian() {
    info "Installing Node.js v$TARGET_NODE_VERSION via NodeSource..."

    ensure_sudo

    # Install prerequisites
    run_as_root apt-get update -qq
    run_as_root apt-get install -y -qq ca-certificates curl gnupg

    # Setup NodeSource repository (new method)
    run_as_root mkdir -p /etc/apt/keyrings

    # Remove old key if exists to avoid conflicts
    run_as_root rm -f /etc/apt/keyrings/nodesource.gpg

    download_to_stdout https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | run_as_root gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$TARGET_NODE_VERSION.x nodistro main" | run_as_root tee /etc/apt/sources.list.d/nodesource.list > /dev/null

    run_as_root apt-get update -qq
    run_as_root apt-get install -y -qq nodejs
}

install_node_fedora() {
    info "Installing Node.js v$TARGET_NODE_VERSION via NodeSource..."

    ensure_sudo

    # Import NodeSource GPG key
    run_as_root rpm --import https://rpm.nodesource.com/gpgkey/nodesource-repo.gpg.key

    # Create repo file (replaces deprecated setup_XX.x bash script)
    cat << REPO_EOF | run_as_root tee /etc/yum.repos.d/nodesource.repo > /dev/null
[nodesource]
name=Node.js Packages for Linux RPM - nodesource
baseurl=https://rpm.nodesource.com/pub_${TARGET_NODE_VERSION}.x/nodistro/rpm/\$basearch
gpgcheck=1
gpgkey=https://rpm.nodesource.com/gpgkey/nodesource-repo.gpg.key
enabled=1
REPO_EOF

    # Use dnf if available (RHEL 8+, Fedora, AL2023), fall back to yum (RHEL 7, AL2)
    if command -v dnf &>/dev/null; then
        run_as_root dnf install -y nodejs
    else
        run_as_root yum install -y nodejs
    fi
}

install_node_arch() {
    info "Installing Node.js via pacman..."

    ensure_sudo
    run_as_root pacman -Sy --noconfirm nodejs npm

    # Verify version is sufficient
    local version
    version=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [[ "$version" -lt "$MIN_NODE_VERSION" ]]; then
        warn "Arch package nodejs is v$version, which is older than required v$MIN_NODE_VERSION"
        warn "Consider using nvm or the nodejs-lts-* package instead"
    fi
}

install_node_alpine() {
    info "Installing Node.js via apk..."

    ensure_sudo
    run_as_root apk add --no-cache nodejs npm

    # Verify version
    local version
    version=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [[ "$version" -lt "$MIN_NODE_VERSION" ]]; then
        warn "Alpine package nodejs is v$version, which is older than required v$MIN_NODE_VERSION"
        warn "Consider using a newer Alpine version or building from source"
    fi
}

install_node_suse() {
    info "Installing Node.js v$TARGET_NODE_VERSION via NodeSource..."

    ensure_sudo

    # Import NodeSource GPG key
    run_as_root rpm --import https://rpm.nodesource.com/gpgkey/nodesource-repo.gpg.key

    # Create repo file (replaces deprecated setup_XX.x bash script)
    cat << REPO_EOF | run_as_root tee /etc/zypp/repos.d/nodesource.repo > /dev/null
[nodesource]
name=Node.js Packages for Linux RPM - nodesource
baseurl=https://rpm.nodesource.com/pub_${TARGET_NODE_VERSION}.x/nodistro/rpm/\$basearch
gpgcheck=1
gpgkey=https://rpm.nodesource.com/gpgkey/nodesource-repo.gpg.key
enabled=1
REPO_EOF

    run_as_root zypper install -y nodejs
}

install_tmux_macos() {
    info "Installing tmux via Homebrew..."
    ensure_homebrew
    brew install tmux
}

install_tmux_debian() {
    info "Installing tmux via apt..."
    ensure_sudo
    run_as_root apt-get update -qq
    run_as_root apt-get install -y -qq tmux
}

install_tmux_fedora() {
    info "Installing tmux..."
    ensure_sudo
    if command -v dnf &>/dev/null; then
        run_as_root dnf install -y tmux
    else
        run_as_root yum install -y tmux
    fi
}

install_tmux_arch() {
    info "Installing tmux via pacman..."
    ensure_sudo
    run_as_root pacman -Sy --noconfirm tmux
}

install_tmux_alpine() {
    info "Installing tmux via apk..."
    ensure_sudo
    run_as_root apk add --no-cache tmux
}

install_tmux_suse() {
    info "Installing tmux via zypper..."
    ensure_sudo
    run_as_root zypper install -y tmux
}

install_git_macos() {
    info "Installing Git via Homebrew..."
    ensure_homebrew
    brew install git
}

install_git_debian() {
    info "Installing Git via apt..."
    ensure_sudo
    run_as_root apt-get update -qq
    run_as_root apt-get install -y -qq git
}

install_git_fedora() {
    info "Installing Git..."
    ensure_sudo
    if command -v dnf &>/dev/null; then
        run_as_root dnf install -y git
    else
        run_as_root yum install -y git
    fi
}

install_git_arch() {
    info "Installing Git via pacman..."
    ensure_sudo
    run_as_root pacman -Sy --noconfirm git
}

install_git_alpine() {
    info "Installing Git via apk..."
    ensure_sudo
    run_as_root apk add --no-cache git
}

install_git_suse() {
    info "Installing Git via zypper..."
    ensure_sudo
    run_as_root zypper install -y git
}

install_cloudflared_macos() {
    info "Installing cloudflared via Homebrew..."
    ensure_homebrew
    brew install cloudflared
}

install_cloudflared_debian() {
    info "Installing cloudflared..."
    ensure_sudo
    local arch
    arch="$(dpkg --print-architecture 2>/dev/null || echo "amd64")"
    local tmp
    tmp="$(mktemp)"
    download "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch.deb" "$tmp"
    run_as_root dpkg -i "$tmp"
    rm -f "$tmp"
}

install_cloudflared_fedora() {
    info "Installing cloudflared..."
    ensure_sudo
    local arch
    arch="$(uname -m)"
    local rpm_arch="$arch"
    [[ "$arch" == "x86_64" ]] && rpm_arch="x86_64"
    [[ "$arch" == "aarch64" ]] && rpm_arch="aarch64"
    local tmp
    tmp="$(mktemp)"
    download "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$rpm_arch.rpm" "$tmp"
    run_as_root rpm -i "$tmp" || run_as_root rpm -U "$tmp"
    rm -f "$tmp"
}

install_cloudflared_arch() {
    info "Installing cloudflared binary..."
    local arch
    arch="$(uname -m)"
    local cf_arch="amd64"
    [[ "$arch" == "aarch64" ]] && cf_arch="arm64"
    [[ "$arch" == "armv7l" ]] && cf_arch="arm"
    ensure_sudo
    local tmp
    tmp="$(mktemp)"
    download "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$cf_arch" "$tmp"
    run_as_root mv "$tmp" /usr/local/bin/cloudflared
    run_as_root chmod +x /usr/local/bin/cloudflared
}

install_cloudflared_alpine() {
    info "Installing cloudflared binary..."
    local arch
    arch="$(uname -m)"
    local cf_arch="amd64"
    [[ "$arch" == "aarch64" ]] && cf_arch="arm64"
    [[ "$arch" == "armv7l" ]] && cf_arch="arm"
    ensure_sudo
    local tmp
    tmp="$(mktemp)"
    download "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$cf_arch" "$tmp"
    run_as_root mv "$tmp" /usr/local/bin/cloudflared
    run_as_root chmod +x /usr/local/bin/cloudflared
}

install_cloudflared_suse() {
    info "Installing cloudflared..."
    ensure_sudo
    local arch
    arch="$(uname -m)"
    local rpm_arch="$arch"
    local tmp
    tmp="$(mktemp)"
    download "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$rpm_arch.rpm" "$tmp"
    run_as_root rpm -i "$tmp" || run_as_root rpm -U "$tmp"
    rm -f "$tmp"
}

# ============================================================================
# Interactive Prompts
# ============================================================================

# `curl | bash` leaves stdin attached to the pipe, so a plain `read` never sees
# the keyboard even though the user is sitting at a terminal. These helpers
# prompt via /dev/tty whenever a real terminal is available, and only fall back
# to defaults when there is genuinely none (CI, truly headless pipes).
has_tty() {
    [[ -t 0 ]] && return 0
    { : < /dev/tty; } 2>/dev/null
}

read_reply() {
    # read_reply <varname>: read one line from the user's real terminal
    if [[ -t 0 ]]; then
        read -r "$1"
    else
        read -r "$1" < /dev/tty
    fi
}

# headless_guard <action>: refuse consequential system changes (sudo package
# installs, third-party curl | bash installers) when nobody can consent, i.e.
# no terminal AND no explicit CODEMAN_NONINTERACTIVE=1 opt-in. Interactive
# runs fall through to their normal prompt; opted-in automation proceeds with
# the prompt defaults as before.
headless_guard() {
    local action="$1"
    if [[ "$NONINTERACTIVE" == "1" ]] || has_tty; then
        return 0
    fi
    error "No interactive terminal, but the installer would need to: $action."
    error "Re-run from a terminal to be prompted, or set CODEMAN_NONINTERACTIVE=1 to approve such steps in automation."
    exit 1
}

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-y}"

    if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
        # Non-interactive, use default
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
        echo -en "${CYAN}$prompt${NC} $yn_hint " >&2
        read_reply answer || answer="$default"
        answer="${answer:-$default}"
        case "$answer" in
            [Yy]|[Yy][Ee][Ss]) return 0 ;;
            [Nn]|[Nn][Oo])     return 1 ;;
            *)                 echo "Please answer yes or no." >&2 ;;
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
            # macOS uses .bash_profile, Linux typically uses .bashrc
            if [[ "$(uname -s)" == "Darwin" ]]; then
                if [[ -f "$HOME/.bash_profile" ]]; then
                    echo "$HOME/.bash_profile"
                else
                    echo "$HOME/.profile"
                fi
            else
                if [[ -f "$HOME/.bashrc" ]]; then
                    echo "$HOME/.bashrc"
                elif [[ -f "$HOME/.bash_profile" ]]; then
                    echo "$HOME/.bash_profile"
                else
                    echo "$HOME/.profile"
                fi
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
    if [[ ":$PATH:" == *":$bin_dir:"* ]]; then
        info "PATH already includes $bin_dir"
        return 0
    fi

    # Check if already in profile
    if [[ -f "$profile" ]] && grep -qF "$bin_dir" "$profile" 2>/dev/null; then
        info "PATH export already in $profile"
        return 0
    fi

    info "Adding $bin_dir to PATH in $profile"

    # Create profile directory if needed (for fish)
    mkdir -p "$(dirname "$profile")"

    local shell_name
    shell_name="$(basename "${SHELL:-/bin/bash}")"

    if [[ "$shell_name" == "fish" ]]; then
        echo "" >> "$profile"
        echo "# Added by Codeman installer" >> "$profile"
        echo "fish_add_path $bin_dir" >> "$profile"
    else
        echo "" >> "$profile"
        echo "# Added by Codeman installer" >> "$profile"
        echo "export PATH=\"$bin_dir:\$PATH\"" >> "$profile"
    fi

    # Also export for the current process so codeman works immediately
    export PATH="$bin_dir:$PATH"

    success "Added to $profile"
}

setup_sc_alias() {
    local profile
    profile=$(detect_shell_profile)

    # Check if alias already exists
    if [[ -f "$profile" ]] && grep -qE "^alias sc=" "$profile" 2>/dev/null; then
        info "Alias 'sc' already configured in $profile"
        return 0
    fi

    echo "" >> "$profile"
    echo "# Codeman tmux session shortcut" >> "$profile"
    echo "alias sc='tmux-chooser'" >> "$profile"

    info "Added 'sc' alias for tmux-chooser"
}

# ============================================================================
# Service Setup (Linux systemd / macOS launchd)
# ============================================================================

# Wait briefly for codeman-web.service to report active. A bad node path or a
# busy port makes the unit crash within the first seconds (then sit in
# activating/auto-restart), so a blind "started!" message would be a lie.
verify_systemd_active() {
    local attempt
    for attempt in 1 2 3; do
        sleep 2
        if systemctl --user is-active --quiet codeman-web.service 2>/dev/null; then
            return 0
        fi
    done
    return 1
}

setup_launchd_service() {
    local plist_label="com.codeman.web"
    local agent_dir="$HOME/Library/LaunchAgents"
    local agent_plist="$agent_dir/$plist_label.plist"
    local daemon_plist="/Library/LaunchDaemons/$plist_label.plist"

    info "Setting up macOS LaunchAgent..."

    # Remove any existing LaunchDaemon (system-level) to prevent duplicates.
    # We standardize on LaunchAgent (user-level) — it doesn't require sudo,
    # inherits the user's environment, and is the correct choice for user apps.
    if [[ -f "$daemon_plist" ]]; then
        warn "Found system-level LaunchDaemon at $daemon_plist — removing to prevent duplicate"
        sudo launchctl unload "$daemon_plist" 2>/dev/null || true
        sudo rm -f "$daemon_plist"
        success "Removed duplicate LaunchDaemon"
    fi

    # Unload existing agent before overwriting
    if [[ -f "$agent_plist" ]]; then
        launchctl unload "$agent_plist" 2>/dev/null || true
    fi

    mkdir -p "$agent_dir"

    # Build PATH: ensure /opt/homebrew/bin (Apple Silicon) and ~/.local/bin are included
    local svc_path="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

    # Find node binary path
    local node_path
    node_path=$(command -v node)

    cat > "$agent_plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$plist_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_path</string>
    <string>$INSTALL_DIR/dist/index.js</string>
    <string>web</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$svc_path</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$HOME</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/tmp/codeman.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/codeman.log</string>
</dict>
</plist>
EOF

    launchctl load "$agent_plist" 2>/dev/null || true

    # launchctl load is silent about many failures: confirm the agent is loaded
    sleep 2
    if launchctl list "$plist_label" &>/dev/null; then
        success "LaunchAgent installed and started"
        return 0
    fi
    warn "LaunchAgent did not load."
    warn "Inspect: launchctl list | grep codeman ; tail -20 /tmp/codeman.log"
    return 1
}

setup_systemd_service() {
    local service_dir="$HOME/.config/systemd/user"
    local service_file="$service_dir/codeman-web.service"

    info "Setting up systemd user service..."

    mkdir -p "$service_dir"

    # Find node binary path
    local node_path
    node_path=$(command -v node)

    # Create service file
    cat > "$service_file" << EOF
[Unit]
Description=Codeman Web Server
After=network.target

[Service]
Type=simple
ExecStart=$node_path $INSTALL_DIR/dist/index.js web
WorkingDirectory=$HOME
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PATH=$PATH

[Install]
WantedBy=default.target
EOF

    # Reload systemd. A user D-Bus session is required for systemctl --user
    # (missing under bare `ssh host 'curl | bash'` provisioning), so detect
    # that up front instead of dying mid-setup with a cryptic trap message.
    if ! systemctl --user daemon-reload 2>/dev/null; then
        warn "systemctl --user is unavailable (no user D-Bus session?); cannot manage user services here."
        warn "Unit written to $service_file. From a normal login shell, enable it with:"
        warn "  systemctl --user daemon-reload && systemctl --user enable --now codeman-web"
        return 1
    fi

    # Enable service
    systemctl --user enable codeman-web.service 2>/dev/null || true

    # Enable lingering (allows service to run after logout)
    if command -v loginctl &>/dev/null; then
        loginctl enable-linger "$USER" 2>/dev/null || true
    fi

    # (Re)start the service. restart, not start: on a re-run over an existing
    # running service, start would be a no-op and leave the OLD build running.
    systemctl --user restart codeman-web.service 2>/dev/null || true

    if verify_systemd_active; then
        success "Systemd service installed and started"
        return 0
    fi
    warn "codeman-web.service did not become active."
    warn "Inspect: systemctl --user status codeman-web ; journalctl --user -u codeman-web -e"
    return 1
}

setup_tunnel_service() {
    local service_dir="$HOME/.config/systemd/user"
    local service_file="$service_dir/codeman-tunnel.service"

    info "Setting up Cloudflare tunnel systemd service..."

    mkdir -p "$service_dir"
    cp "$INSTALL_DIR/scripts/codeman-tunnel.service" "$service_file"

    systemctl --user daemon-reload
    systemctl --user enable codeman-tunnel.service 2>/dev/null || true

    success "Tunnel service installed (start with: systemctl --user start codeman-tunnel)"
    echo -e "  ${DIM}Note: Set CODEMAN_PASSWORD env var before starting the tunnel for security.${NC}"
}

# ============================================================================
# Installation Helpers
# ============================================================================

install_dependency() {
    local dep_name="$1"
    local os="$2"
    local distro="$3"

    local install_func="install_${dep_name}_${distro:-$os}"

    # Try distro-specific first, then OS-level
    if [[ "$os" == "macos" ]]; then
        install_func="install_${dep_name}_macos"
    elif ! declare -f "$install_func" &>/dev/null; then
        die "Don't know how to install $dep_name on $distro. Please install it manually."
    fi

    "$install_func"
}

# ============================================================================
# Main Installation
# ============================================================================

print_banner() {
    echo -e "${CYAN}${BOLD}"
    cat << 'EOF'
   ____          _
  / ___|___   __| | ___ _ __ ___   __ _ _ __
 | |   / _ \ / _` |/ _ \ '_ ` _ \ / _` | '_ \
 | |__| (_) | (_| |  __/ | | | | | (_| | | | |
  \____\___/ \__,_|\___|_| |_| |_|\__,_|_| |_|
EOF
    echo -e "${NC}${DIM}  The missing control plane for Claude Code${NC}"
    echo ""
}

main() {
    print_banner

    # Check for curl/wget first
    if ! check_curl_or_wget; then
        die "curl or wget is required but neither is installed. Please install one first."
    fi

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
        headless_guard "install Git (system package via sudo)"
        if prompt_yes_no "Git is not installed. Install it now?"; then
            install_dependency "git" "$os" "$distro"
        else
            die "Git is required to install Codeman."
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

        headless_guard "install Node.js v$TARGET_NODE_VERSION (system package via sudo)"
        if prompt_yes_no "Install Node.js v$TARGET_NODE_VERSION?"; then
            install_dependency "node" "$os" "$distro"

            # Rehash to pick up new node
            hash -r 2>/dev/null || true
        else
            die "Node.js $MIN_NODE_VERSION+ is required to run Codeman."
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

    # Terminal multiplexer (tmux required)
    info "Checking tmux..."
    if check_tmux; then
        success "tmux is installed"
    else
        headless_guard "install tmux (system package via sudo)"
        if prompt_yes_no "tmux is not installed. Install it now?"; then
            install_dependency "tmux" "$os" "$distro"
        else
            die "tmux is required for session persistence."
        fi
    fi

    # AI CLI (Codeman drives one of: Claude Code, OpenCode, Codex, Gemini)
    local has_claude=false
    local has_opencode=false
    local has_codex=false
    local has_gemini=false

    info "Checking AI CLI tools..."
    if check_claude; then
        has_claude=true
        success "Claude Code found at $(get_claude_path)"
    fi
    if check_opencode; then
        has_opencode=true
        success "OpenCode found at $(get_opencode_path)"
    fi
    if check_codex; then
        has_codex=true
        success "Codex found at $(get_codex_path)"
    fi
    if check_gemini; then
        has_gemini=true
        success "Gemini CLI found at $(get_gemini_path)"
    fi

    if [[ "$has_claude" == "false" && "$has_opencode" == "false" && "$has_codex" == "false" && "$has_gemini" == "false" ]]; then
        echo ""
        warn "No AI CLI found. Codeman needs at least one: Claude Code, OpenCode, Codex, or Gemini."
        headless_guard "install an AI CLI (curl | bash from its vendor)"
        echo ""
        echo -e "  ${BOLD}Which AI CLI would you like to install?${NC}"
        echo -e "    ${CYAN}1)${NC} Claude Code  (Anthropic)"
        echo -e "    ${CYAN}2)${NC} OpenCode     (open-source)"
        echo -e "    ${CYAN}3)${NC} Both"
        echo -e "    ${CYAN}4)${NC} Skip         (I'll install one myself, e.g. Codex or Gemini)"
        echo ""

        local cli_choice=""
        if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
            # Explicit automation opt-in: default to Claude Code
            cli_choice="1"
            info "CODEMAN_NONINTERACTIVE=1: defaulting to Claude Code"
        else
            while true; do
                echo -en "${CYAN}Choose [1/2/3/4]:${NC} " >&2
                read_reply cli_choice || { cli_choice="1"; break; }
                case "$cli_choice" in
                    1|2|3|4) break ;;
                    *) echo "Please enter 1, 2, 3, or 4." >&2 ;;
                esac
            done
        fi

        if [[ "$cli_choice" == "1" ]] || [[ "$cli_choice" == "3" ]]; then
            info "Installing Claude Code CLI..."
            download_to_stdout https://claude.ai/install.sh | bash
            hash -r 2>/dev/null || true
            if check_claude; then
                has_claude=true
                success "Claude Code installed at $(get_claude_path)"
            else
                warn "Claude Code installation failed."
            fi
        fi

        if [[ "$cli_choice" == "2" ]] || [[ "$cli_choice" == "3" ]]; then
            info "Installing OpenCode CLI..."
            download_to_stdout https://opencode.ai/install | bash
            hash -r 2>/dev/null || true
            if check_opencode; then
                has_opencode=true
                success "OpenCode installed at $(get_opencode_path)"
            else
                warn "OpenCode installation failed."
            fi
        fi

        if [[ "$cli_choice" == "4" ]]; then
            warn "Skipping AI CLI install. Codeman will run, but sessions need a CLI to drive."
            info "Install one later, e.g.: npm install -g @openai/codex        (Codex)"
            info "                    or: npm install -g @google/gemini-cli   (Gemini)"
        elif [[ "$has_claude" == "false" ]] && [[ "$has_opencode" == "false" ]]; then
            die "The selected AI CLI failed to install. Install one manually and re-run the installer."
        fi
    fi

    # cloudflared (optional — for remote/mobile access via Cloudflare Tunnel)
    info "Checking cloudflared (optional, for remote access)..."
    if check_cloudflared; then
        success "cloudflared found at $(get_cloudflared_path)"
    else
        if prompt_yes_no "Install cloudflared? (enables remote/mobile access via Cloudflare Tunnel)" "n"; then
            install_dependency "cloudflared" "$os" "$distro"
            hash -r 2>/dev/null || true
            if check_cloudflared; then
                success "cloudflared installed at $(get_cloudflared_path)"
            else
                warn "cloudflared installation failed. You can install it manually later."
            fi
        else
            info "Skipped (you can install cloudflared later for remote access)"
        fi
    fi

    echo ""

    # ========================================================================
    # Clone/Update Repository
    # ========================================================================

    info "Installing Codeman to $INSTALL_DIR..."

    if [[ -d "$INSTALL_DIR/.git" ]]; then
        info "Existing installation found, updating..."
        cd "$INSTALL_DIR"
        git remote set-url origin "$REPO_URL" 2>/dev/null || true

        # Check for local changes
        if ! git diff --quiet 2>/dev/null || ! git diff --staged --quiet 2>/dev/null; then
            warn "Local changes detected in $INSTALL_DIR"
            if prompt_yes_no "Discard local changes and update?" "n"; then
                git fetch --quiet origin
                git reset --hard "origin/$BRANCH" --quiet
            else
                info "Keeping existing installation, skipping update"
            fi
        else
            git fetch --quiet origin
            git reset --hard "origin/$BRANCH" --quiet
        fi
    else
        # Create parent directory
        mkdir -p "$(dirname "$INSTALL_DIR")"

        # Clone repository (shallow for speed)
        git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi

    success "Repository ready"

    # ========================================================================
    # Build
    # ========================================================================

    info "Installing dependencies..."
    npm install --quiet --no-fund --no-audit 2>/dev/null || npm install --no-fund --no-audit

    info "Building..."
    npm run build --quiet 2>/dev/null || npm run build

    success "Build complete"

    # ========================================================================
    # Add to PATH
    # ========================================================================

    # Create symlink in a common PATH location
    local symlink_dir="$HOME/.local/bin"
    mkdir -p "$symlink_dir" 2>/dev/null || true
    if [[ -d "$symlink_dir" ]]; then
        ln -sf "$INSTALL_DIR/dist/index.js" "$symlink_dir/codeman"
        info "Created symlink: $symlink_dir/codeman"

        # Install tmux-chooser as 'tmux-chooser' command
        if [[ -f "$INSTALL_DIR/scripts/tmux-chooser.sh" ]]; then
            ln -sf "$INSTALL_DIR/scripts/tmux-chooser.sh" "$symlink_dir/tmux-chooser"
            info "Created symlink: $symlink_dir/tmux-chooser"
            # Add 'sc' alias for quick access
            setup_sc_alias
        fi

        # Add ~/.local/bin to PATH if not already there
        if [[ ":$PATH:" != *":$symlink_dir:"* ]]; then
            add_to_path "$symlink_dir"
        fi
    fi

    # ========================================================================
    # Mark install complete
    # ========================================================================

    # The dispatcher at the bottom only routes a bare re-run to the quiet
    # update path when this marker exists, so an aborted first install
    # (failed npm install/build, Ctrl+C) re-runs the full setup flow
    # (symlinks, PATH, launch menu) instead of silently "updating".
    date -u +%Y-%m-%dT%H:%M:%SZ > "$INSTALL_DIR/.install-complete"

    # ========================================================================
    # Launch Options
    # ========================================================================

    echo ""
    echo -e "${GREEN}${BOLD}============================================================${NC}"
    echo -e "${GREEN}${BOLD}  Codeman installed successfully!${NC}"
    echo -e "${GREEN}${BOLD}============================================================${NC}"
    echo ""

    local launch_choice=""
    local has_service=false
    local service_type=""

    if [[ "$os" == "linux" ]] && [[ "$SKIP_SYSTEMD" != "1" ]] && command -v systemctl &>/dev/null; then
        has_service=true
        service_type="systemd"
    elif [[ "$os" == "macos" ]] && [[ "$SKIP_SYSTEMD" != "1" ]]; then
        has_service=true
        service_type="launchd"
    fi

    if [[ "$has_service" == "true" ]]; then
        local service_label="systemd service"
        [[ "$service_type" == "launchd" ]] && service_label="LaunchAgent"

        echo -e "  ${BOLD}How would you like to run Codeman?${NC}"
        echo ""
        echo -e "    ${CYAN}1)${NC} Run now in this terminal"
        echo -e "    ${CYAN}2)${NC} Install as $service_label (auto-start on boot)"
        echo -e "    ${CYAN}3)${NC} Don't start — I'll run it later"
        echo ""

        if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
            launch_choice="3"
            info "No interactive terminal detected: not starting (run 'codeman web' when ready)"
        else
            while true; do
                echo -en "${CYAN}Choose [1/2/3]:${NC} " >&2
                read_reply launch_choice || { launch_choice="3"; break; }
                case "$launch_choice" in
                    1|2|3) break ;;
                    *) echo "Please enter 1, 2, or 3." >&2 ;;
                esac
            done
        fi
    else
        # No service manager available — only offer run now or skip
        echo -e "  ${BOLD}Would you like to start Codeman now?${NC}"
        echo ""
        echo -e "    ${CYAN}1)${NC} Run now in this terminal"
        echo -e "    ${CYAN}2)${NC} Don't start — I'll run it later"
        echo ""

        if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
            launch_choice="2"
            info "No interactive terminal detected: not starting (run 'codeman web' when ready)"
        else
            while true; do
                echo -en "${CYAN}Choose [1/2]:${NC} " >&2
                read_reply launch_choice || { launch_choice="2"; break; }
                case "$launch_choice" in
                    1) break ;;
                    2) break ;;
                    *) echo "Please enter 1 or 2." >&2 ;;
                esac
            done
        fi
        # Remap: no-systemd choice "2" (skip) → internal "3"
        [[ "$launch_choice" == "2" ]] && launch_choice="3"
    fi

    echo ""

    # Handle service setup
    if [[ "$launch_choice" == "2" ]]; then
        local service_ok=true
        if [[ "$service_type" == "launchd" ]]; then
            setup_launchd_service || service_ok=false
        else
            setup_systemd_service || service_ok=false
        fi

        # Offer tunnel service if cloudflared is available (Linux only: systemd tunnel service).
        # Skipped when service setup failed: it needs the same systemctl --user access.
        if [[ "$service_ok" == "true" ]] && [[ "$service_type" == "systemd" ]] && check_cloudflared && [[ -f "$INSTALL_DIR/scripts/codeman-tunnel.service" ]]; then
            echo ""
            if prompt_yes_no "Also set up Cloudflare tunnel service? (requires CODEMAN_PASSWORD)" "n"; then
                setup_tunnel_service
            fi
        fi

        echo ""
        if [[ "$service_ok" == "true" ]]; then
            echo -e "  ${GREEN}${BOLD}Codeman is running now!${NC}"
            echo ""
            echo -e "    ${CYAN}# Open in browser${NC}"
            echo -e "    http://localhost:3000"
        else
            echo -e "  ${YELLOW}${BOLD}The service was set up but is not running yet${NC} (see warnings above)."
            echo -e "  ${DIM}You can always run it directly:${NC} ${CYAN}codeman web${NC}"
        fi
        echo ""
        echo -e "  ${BOLD}Manage the service:${NC}"
        echo ""
        if [[ "$service_type" == "launchd" ]]; then
            echo -e "    ${CYAN}launchctl unload ~/Library/LaunchAgents/com.codeman.web.plist${NC}   # Stop"
            echo -e "    ${CYAN}launchctl load ~/Library/LaunchAgents/com.codeman.web.plist${NC}     # Start"
            echo -e "    ${CYAN}tail -f /tmp/codeman.log${NC}                                        # View logs"
        else
            echo -e "    ${CYAN}systemctl --user stop codeman-web${NC}    # Stop"
            echo -e "    ${CYAN}systemctl --user restart codeman-web${NC} # Restart"
            echo -e "    ${CYAN}systemctl --user status codeman-web${NC}  # Check status"
            echo -e "    ${CYAN}journalctl --user -u codeman-web -f${NC}  # View logs"
        fi
        echo ""
    fi

    # Show quick-start help for non-service paths
    if [[ "$launch_choice" != "2" ]]; then
        echo -e "  ${BOLD}Quick Start:${NC}"
        echo ""
        echo -e "    ${CYAN}codeman web${NC}            # Start the web server"
        echo -e "    ${CYAN}codeman web --https${NC}    # With HTTPS (for remote access)"
        echo ""
        echo -e "    ${CYAN}# Open in browser${NC}"
        echo -e "    http://localhost:3000"
        echo ""
    fi

    if check_cloudflared; then
        echo -e "  ${BOLD}Remote Access (Cloudflare Tunnel):${NC}"
        echo ""
        echo -e "    ${CYAN}./scripts/tunnel.sh start${NC}   # Start tunnel"
        echo -e "    ${CYAN}./scripts/tunnel.sh url${NC}     # Show tunnel URL"
        echo -e "    ${CYAN}./scripts/tunnel.sh stop${NC}    # Stop tunnel"
        echo ""
    fi

    echo -e "  ${BOLD}Mobile Access (Termius/SSH):${NC}"
    echo ""
    echo -e "    ${CYAN}sc${NC}              # Interactive tmux session chooser"
    echo -e "    ${CYAN}sc 2${NC}            # Quick attach to session 2"
    echo -e "    ${CYAN}sc -h${NC}           # Help"
    echo ""

    echo -e "  ${BOLD}Documentation:${NC}"
    echo -e "    https://github.com/Ark0N/Codeman"
    echo ""

    if ! check_claude && ! check_opencode && ! check_codex && ! check_gemini; then
        echo -e "  ${YELLOW}${BOLD}Reminder:${NC} Install at least one AI CLI to start using Codeman:"
        echo -e "    ${CYAN}curl -fsSL https://claude.ai/install.sh | bash${NC}  # Claude Code"
        echo -e "    ${CYAN}curl -fsSL https://opencode.ai/install | bash${NC}   # OpenCode"
        echo -e "    ${CYAN}npm install -g @openai/codex${NC}                    # Codex"
        echo -e "    ${CYAN}npm install -g @google/gemini-cli${NC}               # Gemini"
        echo ""
    fi

    # Security notice — last informational block so it stays visible (when not
    # auto-launching below; if we exec, the server prints the same notice anyway).
    print_security_notice

    # Run now in foreground (must be last — exec replaces the shell)
    if [[ "$launch_choice" == "1" ]]; then
        local profile
        profile=$(detect_shell_profile)

        echo -e "  ${GREEN}${BOLD}Starting Codeman...${NC}"
        echo -e "  ${DIM}Press Ctrl+C to stop${NC}"
        echo ""

        # Source profile to pick up PATH changes, then exec codeman
        # shellcheck disable=SC1090
        source "$profile" 2>/dev/null || true
        exec node "$INSTALL_DIR/dist/index.js" web
    fi
}

update() {
    if [[ ! -d "$INSTALL_DIR/.git" ]]; then
        die "Codeman is not installed at $INSTALL_DIR. Run the installer first."
    fi

    info "Updating Codeman..."
    cd "$INSTALL_DIR"
    git remote set-url origin "$REPO_URL" 2>/dev/null || true

    # Never blow away local changes silently (this used to be an unconditional
    # reset --hard). Interactive users get a choice; headless runs auto-stash
    # so the changes stay recoverable, the same policy as scripts/self-update.sh.
    if ! git diff --quiet 2>/dev/null || ! git diff --staged --quiet 2>/dev/null; then
        warn "Local changes detected in $INSTALL_DIR"
        if prompt_yes_no "Stash local changes and update? (recover with: git stash pop)"; then
            git stash push --quiet -m "codeman-installer auto-stash $(date -u +%Y-%m-%dT%H:%M:%SZ)"
            info "Local changes stashed (see 'git stash list' in $INSTALL_DIR)"
        else
            info "Keeping local changes; update skipped."
            return 0
        fi
    fi

    git fetch --quiet origin
    git reset --hard "origin/$BRANCH" --quiet
    npm install --quiet --no-fund --no-audit 2>/dev/null || npm install --no-fund --no-audit
    npm run build --quiet 2>/dev/null || npm run build
    date -u +%Y-%m-%dT%H:%M:%SZ > "$INSTALL_DIR/.install-complete"
    success "Updated to $(node -e "console.log(require('./package.json').version)")"
    echo ""

    # Auto-restart service if running, otherwise tell the user
    local agent_plist="$HOME/Library/LaunchAgents/com.codeman.web.plist"
    if systemctl --user is-active codeman-web.service &>/dev/null 2>&1; then
        info "Restarting codeman-web service..."
        systemctl --user restart codeman-web.service 2>/dev/null || true
        if verify_systemd_active; then
            success "codeman-web service restarted"
        else
            warn "codeman-web.service did not come back up."
            warn "Inspect: systemctl --user status codeman-web ; journalctl --user -u codeman-web -e"
        fi
    elif [[ -f "$agent_plist" ]]; then
        info "Restarting LaunchAgent..."
        launchctl unload "$agent_plist" 2>/dev/null || true
        launchctl load "$agent_plist" 2>/dev/null || true
        success "LaunchAgent restarted"
    else
        echo -e "  ${DIM}Restart codeman web to use the new version:${NC}"
        echo -e "    ${CYAN}pkill -f 'codeman.*web'; codeman web &${NC}"
    fi
    echo ""

    print_security_notice
}

uninstall() {
    print_banner
    info "Uninstalling Codeman..."
    echo ""

    # Stop and remove systemd services (Linux)
    for svc in codeman-web codeman-tunnel; do
        if systemctl --user is-active "${svc}.service" &>/dev/null 2>&1; then
            info "Stopping ${svc} service..."
            systemctl --user stop "${svc}.service"
        fi
        if systemctl --user is-enabled "${svc}.service" &>/dev/null 2>&1; then
            info "Disabling ${svc} service..."
            systemctl --user disable "${svc}.service" 2>/dev/null || true
        fi
        local svc_file="$HOME/.config/systemd/user/${svc}.service"
        if [[ -f "$svc_file" ]]; then
            rm -f "$svc_file"
            success "Removed ${svc} service"
        fi
    done
    systemctl --user daemon-reload 2>/dev/null || true

    # Stop and remove launchd services (macOS)
    local agent_plist="$HOME/Library/LaunchAgents/com.codeman.web.plist"
    local daemon_plist="/Library/LaunchDaemons/com.codeman.web.plist"
    if [[ -f "$agent_plist" ]]; then
        launchctl unload "$agent_plist" 2>/dev/null || true
        rm -f "$agent_plist"
        success "Removed LaunchAgent"
    fi
    if [[ -f "$daemon_plist" ]]; then
        sudo launchctl unload "$daemon_plist" 2>/dev/null || true
        sudo rm -f "$daemon_plist"
        success "Removed LaunchDaemon"
    fi

    # Remove symlinks
    local symlink_dir="$HOME/.local/bin"
    if [[ -L "$symlink_dir/codeman" ]]; then
        rm -f "$symlink_dir/codeman"
        success "Removed symlink: $symlink_dir/codeman"
    fi
    if [[ -L "$symlink_dir/tmux-chooser" ]]; then
        rm -f "$symlink_dir/tmux-chooser"
        success "Removed symlink: $symlink_dir/tmux-chooser"
    fi

    # Remove install directory
    if [[ -d "$INSTALL_DIR" ]]; then
        if prompt_yes_no "Remove installation directory ($INSTALL_DIR)?"; then
            rm -rf "$INSTALL_DIR"
            success "Removed $INSTALL_DIR"
        else
            # Clear the marker so a future installer run does full setup again
            # (the symlinks and services being removed here need recreating).
            rm -f "$INSTALL_DIR/.install-complete"
            info "Kept $INSTALL_DIR"
        fi
    fi

    # Ask about data directory
    local data_dir="$HOME/.codeman"
    if [[ -d "$data_dir" ]]; then
        warn "Data directory exists at $data_dir (contains sessions, settings, state)"
        if prompt_yes_no "Remove data directory ($data_dir)?" "n"; then
            rm -rf "$data_dir"
            success "Removed $data_dir"
        else
            info "Kept $data_dir"
        fi
    fi

    echo ""
    success "Codeman uninstalled."
    echo ""
    echo -e "  ${DIM}Note: Shell profile entries (PATH, sc alias) were not removed.${NC}"
    echo -e "  ${DIM}You can remove them manually from $(detect_shell_profile)${NC}"
    echo ""
}

# Wrap in main to prevent partial execution on curl | bash
case "${1:-}" in
    update)    update ;;
    uninstall) uninstall ;;
    *)
        # Only a COMPLETED install re-runs as a quiet update. A partial one
        # (clone succeeded but build/menu never finished) lacks the marker and
        # re-runs the full flow, so a failed first attempt can actually finish.
        if [[ -z "${1:-}" && -d "$INSTALL_DIR/.git" && -f "$INSTALL_DIR/.install-complete" ]]; then
            print_banner
            update
        else
            main "$@"
        fi
        ;;
esac
