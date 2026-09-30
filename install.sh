#!/usr/bin/env bash
# =====================================================================
# CLOUD WA TOOLS - installer
# Works on: Termux (Android), Linux, Ubuntu/Debian VPS, macOS.
#
# Termux/Android note:
#   Android SHARED storage (/storage/emulated/0, /sdcard, Download folder)
#   does NOT support symlinks -> `npm install` dies with
#   "EACCES: permission denied, symlink ... node_modules/.bin/...".
#   This installer detects that situation and:
#     1. offers to move the project to Termux home ($HOME) - recommended,
#     2. or continues in place with `npm install --no-bin-links`.
# Usage:
#   bash install.sh
#   curl -fsSL https://your-host/install.sh -o install.sh && bash install.sh
# Override/automation:
#   CLOUD_WA_DEST=/path/to/dir   destination when auto-moving (Termux)
#   CLOUD_WA_NO_MOVE=1           never move, always install in place
# =====================================================================
set -u

APP_NAME="CLOUD WA TOOLS"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

say()  { printf "%b\n" "${CYAN}==>${NC} $1"; }
ok()   { printf "%b\n" " ${GREEN}✓${NC} $1"; }
warn() { printf "%b\n" " ${YELLOW}⚠${NC} $1"; }
die()  { printf "%b\n" " ${RED}✗ $1${NC}"; exit 1; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"

# Set to 1 when we must avoid npm bin symlinks (shared storage fallback)
NO_BIN_LINKS="${NO_BIN_LINKS:-0}"

detect_termux() {
  [ -n "${TERMUX_VERSION:-}" ] || [ -n "${TERMUX_APP__PACKAGE_NAME:-}" ] || case "${PREFIX:-}" in
    *com.termux*) return 0 ;;
    *) return 1 ;;
  esac
}

# Android shared storage (sdcardfs/FUSE) does not support symlinks.
# NOTE: the CLOUD_WA_ASSUME_SHARED=1 test override is handled by the caller
# (main), never inside this function, so destination paths are judged purely
# by their real path.
is_shared_storage() {
  case "$1" in
    /storage/emulated/*|/sdcard/*|/storage/*|/mnt/sdcard/*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_os() {
  say "Detecting OS..."
  if detect_termux; then
    OS="termux"; ok "Termux (Android) detected"
  elif [ "$(uname -s)" = "Darwin" ]; then
    OS="macos"; ok "macOS detected"
  elif [ "$(uname -s)" = "Linux" ]; then
    OS="linux"; ok "Linux detected ($(uname -o 2>/dev/null || uname -s))"
  elif command -v uname >/dev/null 2>&1 && uname -s | grep -qi mingw\|msys\|cygwin; then
    OS="windows"; ok "Windows (Git Bash/MSYS) detected"
  else
    OS="unknown"; warn "Unknown OS - continuing anyway"
  fi
}

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

check_node() {
  say "Checking Node.js..."
  local major
  major="$(node_major)"
  if [ "$major" -eq 0 ]; then
    printf "%b\n" " ${RED}✗ Node.js not found${NC}"
    printf "  Please install Node.js first:\n"
    case "$OS" in
      termux)  printf "    Termux : pkg install nodejs\n" ;;
      linux)   printf "    Debian/Ubuntu VPS:\n" ;;
      *)       printf "    See https://nodejs.org\n" ;;
    esac
    if [ "$OS" = "linux" ]; then
      printf "      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -\n      sudo apt-get install -y nodejs\n"
    fi
    exit 1
  fi
  if [ "$major" -lt 20 ]; then
    warn "Node.js $(node -v) found - Node.js 20+ is recommended"
  else
    ok "Node.js $(node -v)"
  fi
}

check_npm() {
  say "Checking npm..."
  if command -v npm >/dev/null 2>&1; then
    ok "npm $(npm -v 2>/dev/null)"
  else
    die "npm not found. Please install Node.js first."
  fi
}

# Copy project source to another directory (no node_modules / .git copied).
copy_project() { # $1=src $2=dest
  local src="$1" dest="$2"
  mkdir -p "$dest" || return 1
  if command -v tar >/dev/null 2>&1; then
    tar -C "$src" --exclude='./node_modules' --exclude='./.git' -cf - . 2>/dev/null \
      | tar -C "$dest" -xf - 2>/dev/null
  else
    cp -a "$src/." "$dest/" 2>/dev/null
    rm -rf "$dest/node_modules" 2>/dev/null
  fi
  [ -f "$dest/package.json" ] || return 1
  return 0
}

# Termux + shared storage: move project into $HOME (recommended) or
# fall back to installing in place without bin symlinks.
handle_shared_storage() {
  if [ "${CLOUD_WA_NO_MOVE:-0}" = "1" ]; then
    warn "Installing in place on Android shared storage (bin symlinks disabled)"
    NO_BIN_LINKS=1
    return 0
  fi
  local dest base dest_dir
  base="${CLOUD_WA_DEST:-$HOME/cloud-wa-tools}"
  case "$base" in /*) ;; *) base="$PWD/$base" ;; esac
  dest_dir="$(dirname "$base")"
  if [ ! -d "$dest_dir" ]; then
    if mkdir -p "$dest_dir" 2>/dev/null; then :; else
      base="$HOME/cloud-wa-tools"; dest_dir="$(dirname "$base")"
    fi
  fi
  dest="$(cd "$dest_dir" 2>/dev/null && pwd)/$(basename "$base")" || dest="$HOME/cloud-wa-tools"
  if [ "$dest" = "$script_dir" ]; then
    NO_BIN_LINKS=1; return 0
  fi
  if is_shared_storage "$dest"; then
    warn "CLOUD_WA_DEST is also on shared storage - installing in place instead"
    NO_BIN_LINKS=1; return 0
  fi
  printf "%b\n" ""
  printf "%b\n" " ${YELLOW}Android shared storage detected (/storage/emulated/0).${NC}"
  printf "%b\n" " Shared storage does not support symlinks, so 'npm install'"
  printf "%b\n" " fails here with EACCES (this is an Android limitation)."
  printf "%b\n" ""
  printf " Recommended: install to Termux home: ${CYAN}%s${NC}\n" "$dest"
  printf "%b\n" " (faster, fully supported; your original folder stays untouched)"
  printf "%b\n" ""
  local answer=""
  if [ -r /dev/stdin ]; then
    printf " ${CYAN}?${NC} Move this project to %s and install there? [Y/n] " "$dest"
    read -r answer 2>/dev/null || answer="Y"
  fi
  case "$answer" in
    n*|N*)
      warn "Staying on shared storage - using --no-bin-links mode"
      NO_BIN_LINKS=1
      return 0
      ;;
    *)
      say "Copying project to $dest ..."
      if ! copy_project "$script_dir" "$dest"; then
        warn "Copy failed - falling back to in-place install (--no-bin-links)"
        NO_BIN_LINKS=1
        return 0
      fi
      ok "Project copied to $dest"
      printf "%b\n" ""
      printf "%b\n" " ${GREEN}Continuing installation from $dest ...${NC}"
      printf "%b\n" " ${YELLOW}Note:${NC} run 'cloud-wa' from anywhere, but 'npm start' needs:"
      printf "   cd %s\n" "$dest"
      printf "%b\n" ""
      cd "$dest" || { NO_BIN_LINKS=1; return 0; }
      # re-run installer from the new location; drop the shared-storage test
      # override so the new run treats its real (non-shared) location correctly
      exec env -u CLOUD_WA_ASSUME_SHARED bash "$dest/install.sh"
      ;;
  esac
}

install_dependencies() {
  say "Installing dependencies (this may take a few minutes on Termux)..."
  cd "$script_dir" || die "Cannot enter $script_dir"
  local flags="--no-audit --no-fund"
  [ "$NO_BIN_LINKS" = "1" ] && flags="$flags --no-bin-links"
  if ! npm install $flags; then
    printf "%b\n" ""
    if is_shared_storage "$script_dir" && [ "$NO_BIN_LINKS" != "1" ]; then
      printf "%b\n" " ${YELLOW}Hint:${NC} you are on Android shared storage (symlinks unsupported)."
      printf "%b\n" " Fix: re-run this installer and answer Y to move the project to \$HOME,"
      printf "%b\n" " or run:  ${CYAN}printf 'bin-links=false\\n' >> .npmrc${NC}  then re-run install.sh"
    fi
    printf "%b\n" " Otherwise check your internet connection and try again."
    exit 1
  fi
  ok "Dependencies installed"
}

create_dirs_and_config() {
  say "Creating directories..."
  mkdir -p data/sessions data/messages data/media data/backups data/exports logs config
  ok "data/, logs/, config/ ready"
  say "Creating configuration..."
  if [ ! -f config/config.json ]; then
    cp config/config.example.json config/config.json
    ok "config/config.json created from example"
  else
    ok "config/config.json already exists (kept)"
  fi
}

init_database() {
  say "Initializing database..."
  if node bin/cloud-wa.js init --quiet >/dev/null 2>&1 || node bin/cloud-wa.js init >/dev/null 2>&1; then
    ok "SQLite database initialized"
  else
    die "Database initialization failed. Run manually: node bin/cloud-wa.js init"
  fi
}

set_permissions() {
  say "Setting executable permissions..."
  # chmod may be ignored (but harmless) on Android shared storage
  chmod +x bin/cloud-wa.js install.sh 2>/dev/null || true
  ok "Permissions set"
}

# Write a small launcher script instead of a symlink: works everywhere,
# including filesystems without symlink support.
write_wrapper() { # $1 = output path
  local out="$1" shebang
  if [ "$OS" = "termux" ]; then
    shebang="${PREFIX:-/data/data/com.termux/files/usr}/bin/sh"
    [ -e "$shebang" ] || shebang="${PREFIX:-/data/data/com.termux/files/usr}/bin/bash"
  else
    shebang="/bin/sh"
  fi
  {
    printf '#!%s\n' "$shebang"
    printf '# cloud-wa launcher (generated by install.sh)\n'
    printf 'exec "%s" "%s" "$@"\n' "$(command -v node)" "$script_dir/bin/cloud-wa.js"
  } > "$out" || return 1
  chmod 0755 "$out" 2>/dev/null || true
  return 0
}

install_command() {
  say "Installing 'cloud-wa' command..."
  local tmp
  tmp="$(mktemp 2>/dev/null)" || tmp="${TMPDIR:-/tmp}/cloud-wa-cmd.$$"
  write_wrapper "$tmp" || die "Cannot create launcher script"

  # 1. Termux: $PREFIX/bin is always writable
  if [ "$OS" = "termux" ] && [ -n "${PREFIX:-}" ]; then
    if mv "$tmp" "$PREFIX/bin/cloud-wa" 2>/dev/null; then
      ok "Installed: $PREFIX/bin/cloud-wa"; return 0
    fi
  fi
  # 2. Writable /usr/local/bin (root VPS or user-writable)
  if [ -w /usr/local/bin ] 2>/dev/null; then
    if mv "$tmp" /usr/local/bin/cloud-wa 2>/dev/null; then
      ok "Installed: /usr/local/bin/cloud-wa"; return 0
    fi
  fi
  # 3. Passwordless sudo
  if command -v sudo >/dev/null 2>&1; then
    if sudo -n install -m 0755 "$tmp" /usr/local/bin/cloud-wa 2>/dev/null; then
      rm -f "$tmp"; ok "Installed: /usr/local/bin/cloud-wa"; return 0
    fi
  fi
  # 4. User-local bin
  mkdir -p "$HOME/.local/bin"
  mv "$tmp" "$HOME/.local/bin/cloud-wa" 2>/dev/null || cp "$tmp" "$HOME/.local/bin/cloud-wa"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) warn "'$HOME/.local/bin' is not in PATH."
       printf "   Add this to your shell profile:\n     export PATH=\"\$HOME/.local/bin:\$PATH\"\n" ;;
  esac
  ok "Installed: $HOME/.local/bin/cloud-wa"
}

test_application() {
  say "Testing application..."
  if node bin/cloud-wa.js check >/dev/null 2>&1; then
    ok "Environment check passed"
  else
    node bin/cloud-wa.js check || true
    die "Environment check failed"
  fi
  if command -v cloud-wa >/dev/null 2>&1; then
    cloud-wa version >/dev/null 2>&1 && ok "cloud-wa command works"
  fi
}

main() {
  printf "%b\n" ""
  printf "%b\n" "${CYAN}╔══════════════════════════════════════╗${NC}"
  printf "%b\n" "${CYAN}║${NC}        Installing ${CYAN}CLOUD WA TOOLS${NC}       ${CYAN}║${NC}"
  printf "%b\n" "${CYAN}╚══════════════════════════════════════╝${NC}"
  printf "%b\n" ""
  detect_os
  # Termux on shared storage (Download/, /sdcard, ...): move or fall back.
  # CLOUD_WA_ASSUME_SHARED=1 is a test override that forces this branch.
  if [ "$OS" = "termux" ] && { [ "${CLOUD_WA_ASSUME_SHARED:-0}" = "1" ] || is_shared_storage "$script_dir"; }; then
    handle_shared_storage
  fi
  check_node
  check_npm
  install_dependencies
  create_dirs_and_config
  init_database
  set_permissions
  install_command
  test_application
  printf "%b\n" ""
  printf "%b\n" " ${GREEN}✓ $APP_NAME installed${NC}"
  printf "  Location: %s\n" "$script_dir"
  printf "%b\n" ""
  printf "%b\n" "  Run: ${CYAN}cloud-wa${NC}"
  if [ "$NO_BIN_LINKS" = "1" ]; then
    printf "%b\n" "  (npm scripts also work from the project folder: ${CYAN}cd $script_dir && npm start${NC})"
  else
    printf "%b\n" "  (from the project folder you can also use: ${CYAN}npm start${NC})"
  fi
  printf "%b\n" ""
  printf "%b\n" "  Next: choose [1] Connect WhatsApp and enter your number to"
  printf "%b\n" "  receive your pairing code (WhatsApp → Linked Devices)."
  printf "%b\n" ""
}

main "$@"
