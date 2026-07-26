#!/usr/bin/env bash
###############################################################################
# GitHub Auto Push Tool
# Developed for Beginners
#
# Automates the complete Git workflow (init -> add -> commit -> remote ->
# push) for any local project folder, for both new and existing Git repos.
#
# ALSO includes a Repository Management mode: list your GitHub repos,
# select ones to delete, back them up locally FIRST, then delete them from
# GitHub with multiple confirmations.
#
# Tested on: Ubuntu / Zorin OS (Debian-based Linux)
# Requires : bash, git, curl (or ping)
#
# Author   : Senior DevOps Engineer (script generated for beginner use)
###############################################################################

set -u -o pipefail

###############################################################################
# SECTION 1: GLOBAL CONSTANTS, COLORS & LOG FILE
###############################################################################

readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly BOLD='\033[1m'
readonly NC='\033[0m'

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LOG_FILE="${SCRIPT_DIR}/github_push.log"

GITHUB_USERNAME=""
REPO_NAME=""
REPO_VISIBILITY="public"
AUTH_METHOD=""
PROJECT_PATH=""
FORCE_ROOT_PATH="no"   # "yes" if user explicitly chose to use the selected folder itself, without descending
COMMIT_MESSAGE=""
BRANCH_NAME=""
REMOTE_URL=""
PUSH_STATUS="NOT ATTEMPTED"
SSH_KEY_EXISTS="no"
GH_CLI_AVAILABLE="no"

# ---- Scheduling / task-queue variables --------------------------------------
readonly CONFIG_DIR="${HOME}/.github_auto_push"
readonly CONFIG_FILE="${CONFIG_DIR}/config.env"
readonly QUEUE_FILE="${CONFIG_DIR}/task_queue.txt"
readonly SCHEDULE_LOG="${CONFIG_DIR}/scheduled_runs.log"
readonly CRON_MARKER="# github_auto_push_scheduled_task"

# ---- Repository management variables (delete + backup flow) -----------------
REPO_LIST=()                  # each entry: "name|visibility|last_pushed"
SELECTED_INDICES=()           # indices (1-based) chosen for deletion
BACKUP_DIR=""
declare -A BACKED_UP          # repo_name -> yes/no
declare -A DELETE_STATUS      # repo_name -> deleted/failed
GITHUB_TOKEN=""               # Personal Access Token, used for private repo listing/deleting

TOTAL_PROGRESS_STEPS=0
CURRENT_PROGRESS_STEP=0

###############################################################################
# SECTION 2: LOGGING & PRINT HELPERS
###############################################################################

log() {
    local level="$1"
    local message="$2"
    echo "$(date '+%Y-%m-%d %H:%M:%S') [${level}] ${message}" >> "${LOG_FILE}"
}

print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; log "SUCCESS" "$1"; }
print_error()   { echo -e "${RED}[ERROR]${NC} $1";   log "ERROR" "$1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; log "WARNING" "$1"; }
print_info()    { echo -e "${BLUE}[INFO]${NC} $1";   log "INFO" "$1"; }

print_step() {
    echo ""
    echo -e "${CYAN}${BOLD}--------------------------------------------------------------${NC}"
    echo -e "${CYAN}${BOLD} STEP $1: $2${NC}"
    echo -e "${CYAN}${BOLD}--------------------------------------------------------------${NC}"
    log "STEP" "STEP $1: $2"
}

###############################################################################
# SECTION 2b: PROGRESS BAR HELPERS
###############################################################################

show_progress() {
    TOTAL_PROGRESS_STEPS="$1"
    CURRENT_PROGRESS_STEP=0
    update_progress "Starting..."
}

update_progress() {
    local label="${1:-Working...}"
    CURRENT_PROGRESS_STEP=$(( CURRENT_PROGRESS_STEP + 1 ))

    local percent=100
    if [[ "${TOTAL_PROGRESS_STEPS}" -gt 0 ]]; then
        percent=$(( CURRENT_PROGRESS_STEP * 100 / TOTAL_PROGRESS_STEPS ))
    fi
    (( percent > 100 )) && percent=100

    local width=30
    local filled=$(( percent * width / 100 ))
    local empty=$(( width - filled ))

    local bar_filled="" bar_empty=""
    if (( filled > 0 )); then
        bar_filled="$(printf '%*s' "${filled}" '' | tr ' ' '█')"
    fi
    if (( empty > 0 )); then
        bar_empty="$(printf '%*s' "${empty}" '' | tr ' ' '░')"
    fi

    printf "\r${CYAN}[%s%s] %3d%%${NC} %-45s" "${bar_filled}" "${bar_empty}" "${percent}" "${label}"

    if [[ "${CURRENT_PROGRESS_STEP}" -ge "${TOTAL_PROGRESS_STEPS}" ]]; then
        echo ""
    fi
}

###############################################################################
# SECTION 3: BANNER
###############################################################################

print_banner() {
    clear
    echo -e "${BLUE}${BOLD}"
    echo "==============================================================="
    echo "                                                               "
    echo "                 GitHub Auto Push Tool                        "
    echo "                 Developed for Beginners                      "
    echo "                                                               "
    echo "==============================================================="
    echo -e "${NC}"
    echo -e "${YELLOW}This tool will guide you step by step to push your local"
    echo -e "project to GitHub. You do NOT need to know any Git commands.${NC}"
    echo ""
    log "INFO" "===== New session started ====="
}

###############################################################################
# SECTION 3b: MAIN MENU
###############################################################################

show_main_menu() {
    echo -e "${BLUE}${BOLD}What would you like to do?${NC}"
    echo "  1) Push a local project to GitHub"
    echo "  2) Manage / Delete existing GitHub repositories (with local backup)"
    echo "  3) Schedule automatic daily push (task queue, e.g. one task every day at 6 PM)"
    echo "  4) Exit"
    echo ""

    while true; do
        read -rp "Choose 1, 2, 3 or 4: " menu_choice
        case "${menu_choice}" in
            1) run_push_flow; break ;;
            2) run_manage_repos_flow; break ;;
            3) run_schedule_menu; break ;;
            4) echo "Bye!"; exit 0 ;;
            *) print_error "Invalid choice. Please enter 1, 2, 3 or 4." ;;
        esac
    done
}

###############################################################################
# SECTION 4: COMPLETE GITHUB ENVIRONMENT VALIDATION
###############################################################################

validate_git_installed() {
    if command -v git >/dev/null 2>&1; then
        update_progress "Git installed"
    else
        echo ""
        print_error "Git is NOT installed on this system."
        echo -e "${YELLOW}Why this happened:${NC} Git is required to run this tool but was not found."
        echo -e "${YELLOW}How to fix it:${NC} Install Git using the command below, then run this script again."
        echo -e "${GREEN}  sudo apt update && sudo apt install git -y${NC}"
        exit 1
    fi
}

validate_internet() {
    if ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1 || curl -s --max-time 5 https://www.google.com >/dev/null 2>&1; then
        update_progress "Internet connection OK"
    else
        echo ""
        print_error "No internet connection detected."
        echo -e "${YELLOW}Why this happened:${NC} This tool needs internet access to reach GitHub."
        echo -e "${YELLOW}How to fix it:${NC} Connect to Wi-Fi/Ethernet and try again."
        exit 1
    fi
}

validate_github_reachable() {
    if curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://github.com | grep -qE "200|301|302"; then
        update_progress "GitHub.com reachable"
    else
        echo ""
        print_error "GitHub.com could not be reached."
        echo -e "${YELLOW}Why this happened:${NC} DNS issues, a firewall, or a GitHub outage."
        echo -e "${YELLOW}How to fix it:${NC} Check https://www.githubstatus.com or try a different network."
        exit 1
    fi
}

validate_git_username_config() {
    local name
    name="$(git config --global user.name 2>/dev/null || true)"
    if [[ -n "${name}" ]]; then
        update_progress "git user.name set"
    else
        echo ""
        print_error "Git username is not configured."
        echo -e "${YELLOW}Why:${NC} Git attaches this name to every commit you make."
        echo -e "${YELLOW}Fix:${NC} ${GREEN}git config --global user.name \"Your Name\"${NC}"
        echo ""
        echo "Would you like me to configure it now?"
        echo "  1) Yes"
        echo "  2) No"
        read -rp "Choose 1 or 2: " ans
        if [[ "${ans}" == "1" ]]; then
            read -rp "Enter the name to use for Git commits: " newname
            if [[ -n "${newname}" ]]; then
                git config --global user.name "${newname}"
                print_success "Git username set to: ${newname}"
            fi
        fi
        update_progress "git user.name checked"
    fi
}

validate_git_email_config() {
    local email
    email="$(git config --global user.email 2>/dev/null || true)"
    if [[ -n "${email}" ]]; then
        update_progress "git user.email set"
    else
        echo ""
        print_error "Git email is not configured."
        echo -e "${YELLOW}Why:${NC} Git attaches this email to every commit you make."
        echo -e "${YELLOW}Fix:${NC} ${GREEN}git config --global user.email \"you@example.com\"${NC}"
        echo ""
        echo "Would you like me to configure it now?"
        echo "  1) Yes"
        echo "  2) No"
        read -rp "Choose 1 or 2: " ans
        if [[ "${ans}" == "1" ]]; then
            read -rp "Enter the email to use for Git commits: " newemail
            if [[ -n "${newemail}" ]]; then
                git config --global user.email "${newemail}"
                print_success "Git email set to: ${newemail}"
            fi
        fi
        update_progress "git user.email checked"
    fi
}

validate_credential_helper() {
    local helper
    helper="$(git config --global credential.helper 2>/dev/null || true)"
    if [[ -n "${helper}" ]]; then
        update_progress "Credential helper: ${helper}"
    else
        echo ""
        print_warning "No Git credential helper is configured."
        echo -e "${YELLOW}Why:${NC} Without it, Git may ask for your token on every single push."
        echo -e "${YELLOW}Fix:${NC} A credential helper securely remembers your token/password."
        echo ""
        echo "Would you like me to configure it now?"
        echo "  1) Yes"
        echo "  2) No"
        read -rp "Choose 1 or 2: " ans
        if [[ "${ans}" == "1" ]]; then
            git config --global credential.helper store
            print_success "Credential helper set to 'store'."
        fi
        update_progress "Credential helper checked"
    fi
}

validate_ssh_installed() {
    if command -v ssh >/dev/null 2>&1; then
        update_progress "SSH client installed"
    else
        echo ""
        print_error "SSH is not installed."
        echo -e "${YELLOW}Why:${NC} SSH is required for SSH-based GitHub authentication."
        echo -e "${YELLOW}Fix:${NC} ${GREEN}sudo apt update && sudo apt install openssh-client -y${NC}"
        update_progress "SSH client checked"
    fi
}

validate_ssh_agent() {
    if pgrep -u "${USER}" ssh-agent >/dev/null 2>&1 || [[ -n "${SSH_AGENT_PID:-}" ]]; then
        update_progress "ssh-agent running"
    else
        echo ""
        print_warning "ssh-agent is not running."
        echo -e "${YELLOW}Why:${NC} ssh-agent holds your unlocked SSH key so you aren't asked for a passphrase repeatedly."
        echo -e "${YELLOW}Fix:${NC} ${GREEN}eval \"\$(ssh-agent -s)\"${NC}"
        echo ""
        read -rp "Start ssh-agent now? (Y/N): " ans
        if [[ "${ans}" =~ ^[Yy]$ ]]; then
            eval "$(ssh-agent -s)" >/dev/null
            print_success "ssh-agent started."
        fi
        update_progress "ssh-agent checked"
    fi
}

validate_ssh_keys() {
    if [[ -f "${HOME}/.ssh/id_ed25519.pub" || -f "${HOME}/.ssh/id_rsa.pub" ]]; then
        SSH_KEY_EXISTS="yes"
        update_progress "SSH key found"
    else
        echo ""
        print_warning "No SSH key found on this system."
        echo -e "${YELLOW}Why:${NC} SSH keys let you authenticate with GitHub without typing a token every time."
        echo ""
        read -rp "Generate SSH key automatically? (Y/N): " ans
        if [[ "${ans}" =~ ^[Yy]$ ]]; then
            read -rp "Enter the email to attach to the key: " key_email
            [[ -z "${key_email}" ]] && key_email="${GITHUB_USERNAME:-user}@users.noreply.github.com"

            ssh-keygen -t ed25519 -C "${key_email}" -f "${HOME}/.ssh/id_ed25519" -N ""
            eval "$(ssh-agent -s)" >/dev/null
            ssh-add "${HOME}/.ssh/id_ed25519" >/dev/null 2>&1

            print_success "SSH key generated and added to ssh-agent."
            echo -e "${YELLOW}Copy this PUBLIC key and paste it into:${NC} ${GREEN}https://github.com/settings/keys${NC}"
            echo -e "${GREEN}"
            cat "${HOME}/.ssh/id_ed25519.pub"
            echo -e "${NC}"
            read -rp "Press ENTER once you have added the key to GitHub..." _
            SSH_KEY_EXISTS="yes"
        else
            SSH_KEY_EXISTS="no"
        fi
        update_progress "SSH key checked"
    fi
}

validate_github_ssh_auth() {
    if [[ "${SSH_KEY_EXISTS}" != "yes" ]]; then
        update_progress "SSH auth test skipped"
        return
    fi
    local test_output
    test_output="$(ssh -T git@github.com -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=5 2>&1)"
    if echo "${test_output}" | grep -qi "successfully authenticated"; then
        update_progress "GitHub SSH auth OK"
    else
        echo ""
        print_warning "Could not confirm SSH authentication with GitHub."
        echo -e "${YELLOW}Why:${NC} Your public key may not be added to your GitHub account yet."
        echo -e "${YELLOW}Fix:${NC} Add it at ${GREEN}https://github.com/settings/keys${NC}"
        echo -e "${YELLOW}Raw response:${NC} ${test_output}"
        update_progress "GitHub SSH auth checked"
    fi
}

validate_default_branch() {
    local db
    db="$(git config --global init.defaultBranch 2>/dev/null || true)"
    if [[ -n "${db}" ]]; then
        update_progress "Default branch: ${db}"
    else
        git config --global init.defaultBranch main
        update_progress "Default branch set to 'main'"
    fi
}

validate_git_version() {
    local ver
    ver="$(git --version)"
    update_progress "${ver}"
}

validate_gh_cli() {
    if command -v gh >/dev/null 2>&1; then
        GH_CLI_AVAILABLE="yes"
        update_progress "GitHub CLI (gh) found"
        if ! gh auth status >/dev/null 2>&1; then
            echo ""
            print_warning "GitHub CLI is installed but not logged in."
            read -rp "Run 'gh auth login' now? (Y/N): " ans
            if [[ "${ans}" =~ ^[Yy]$ ]]; then
                gh auth login
            fi
        fi
    else
        GH_CLI_AVAILABLE="no"
        update_progress "GitHub CLI not installed (optional)"
    fi
}

validate_repo_path_permissions() {
    if [[ -r "${PROJECT_PATH}" && -w "${PROJECT_PATH}" && -x "${PROJECT_PATH}" ]]; then
        print_success "Folder permissions are OK (read/write/execute)."
    else
        print_error "Insufficient permissions on: ${PROJECT_PATH}"
        echo -e "${YELLOW}Fix:${NC} ${GREEN}sudo chmod u+rwx \"${PROJECT_PATH}\"${NC}"
    fi
}

run_full_environment_validation() {
    print_step "0" "GitHub Environment Validation"
    show_progress 13
    validate_git_installed
    validate_internet
    validate_github_reachable
    validate_git_username_config
    validate_git_email_config
    validate_credential_helper
    validate_ssh_installed
    validate_ssh_agent
    validate_ssh_keys
    validate_github_ssh_auth
    validate_default_branch
    validate_git_version
    validate_gh_cli
    print_success "Environment validation complete."
}

###############################################################################
# SECTION 5: STEP-BY-STEP USER INPUT
###############################################################################

get_username() {
    print_step "1" "GitHub Username"
    echo -e "${BLUE}Enter your GitHub USERNAME only (not your email).${NC}"
    echo -e "Example: ${GREEN}anujkumarjha798-akj${NC}"
    echo -e "${RED}Do NOT enter your email address.${NC}"
    echo ""

    while true; do
        read -rp "GitHub Username: " GITHUB_USERNAME
        if [[ -z "${GITHUB_USERNAME}" ]]; then
            print_error "Username cannot be empty. Please try again."
        elif [[ "${GITHUB_USERNAME}" == *"@"* ]]; then
            print_error "This looks like an email address, not a username. Please try again."
        elif [[ "${GITHUB_USERNAME}" =~ [[:space:]] ]]; then
            print_error "Username cannot contain spaces. Please try again."
        else
            print_success "Username accepted: ${GITHUB_USERNAME}"
            log "INFO" "GitHub username set to ${GITHUB_USERNAME}"
            break
        fi
    done
}

get_repo_name() {
    print_step "2" "Repository Name"
    echo -e "${BLUE}Enter ONLY the repository name (not the full GitHub URL).${NC}"
    echo -e "Example: ${GREEN}docker-projects${NC}"
    echo -e "${RED}Wrong:${NC}   https://github.com/user/repo"
    echo -e "${GREEN}Correct:${NC} docker-projects"
    echo ""

    while true; do
        read -rp "Repository Name: " REPO_NAME
        if [[ -z "${REPO_NAME}" ]]; then
            print_error "Repository name cannot be empty. Please try again."
        elif [[ "${REPO_NAME}" == http* || "${REPO_NAME}" == *"github.com"* || "${REPO_NAME}" == *"/"* ]]; then
            print_error "That looks like a URL, not a repository name. Please enter only the name."
        elif [[ "${REPO_NAME}" =~ [[:space:]] ]]; then
            print_error "Repository name cannot contain spaces. Please try again."
        else
            print_success "Repository name accepted: ${REPO_NAME}"
            log "INFO" "Repository name set to ${REPO_NAME}"
            break
        fi
    done
}

get_repo_visibility() {
    print_step "2b" "Repository Visibility"
    echo -e "${BLUE}Repository Type:${NC}"
    echo "  1) Public"
    echo "  2) Private"
    echo ""

    while true; do
        read -rp "Choose 1 or 2: " vis
        case "${vis}" in
            1)
                REPO_VISIBILITY="public"
                print_success "Public repository selected."
                break
                ;;
            2)
                REPO_VISIBILITY="private"
                print_success "Private repository selected."
                echo -e "${YELLOW}Make sure:${NC}"
                echo "  - The repository already exists (or you let this tool create it)."
                echo "  - Your account has access to it."
                echo "  - A Personal Access Token or SSH key is configured."
                break
                ;;
            *)
                print_error "Invalid choice. Please enter 1 or 2."
                ;;
        esac
    done
}

get_auth_method() {
    print_step "3" "Authentication Method"
    echo -e "${BLUE}GitHub passwords are no longer accepted for Git operations.${NC}"
    echo -e "${BLUE}How do you want to authenticate with GitHub?${NC}"
    echo "  1. HTTPS (Personal Access Token)"
    echo "  2. SSH"
    if [[ "${GH_CLI_AVAILABLE}" == "yes" ]]; then
        echo "  3. Use GitHub CLI (gh auth login)"
    fi
    echo ""

    while true; do
        read -rp "Choose an option: " choice
        case "${choice}" in
            1)
                AUTH_METHOD="https"
                print_success "HTTPS authentication selected."
                print_warning "During push, Git may ask for your GitHub username and a"
                print_warning "Personal Access Token (NOT your GitHub password)."
                print_info "Create a token at: https://github.com/settings/tokens"
                break
                ;;
            2)
                AUTH_METHOD="ssh"
                print_success "SSH authentication selected."
                if [[ "${SSH_KEY_EXISTS}" != "yes" ]]; then
                    print_error "No usable SSH key was set up during validation."
                    echo -e "${YELLOW}Fix:${NC} Re-run the script and choose to generate an SSH key, or run:"
                    echo -e "${GREEN}  ssh-keygen -t ed25519 -C \"your_email@example.com\"${NC}"
                    exit 1
                fi
                break
                ;;
            3)
                if [[ "${GH_CLI_AVAILABLE}" == "yes" ]]; then
                    gh auth login
                    AUTH_METHOD="https"
                    print_success "Authenticated via GitHub CLI. Using HTTPS for push."
                    break
                else
                    print_error "Invalid choice. Please enter 1 or 2."
                fi
                ;;
            *)
                print_error "Invalid choice. Please enter 1 or 2."
                ;;
        esac
    done
}

get_project_path() {
    print_step "4" "Local Project Folder"
    echo -e "${BLUE}Enter the FULL LOCAL PATH to your project folder (or a parent folder${NC}"
    echo -e "${BLUE}that contains it).${NC}"
    echo -e "Example: ${GREEN}/home/monarch/Documents/Docker/project${NC}"
    echo -e "${RED}Do NOT enter a GitHub URL here. This must be a folder on THIS computer.${NC}"
    echo ""

    local input_path
    while true; do
        read -rp "Local Path: " input_path
        input_path="${input_path/#\~/${HOME}}"

        if [[ -z "${input_path}" ]]; then
            print_error "Path cannot be empty. Please try again."
        elif [[ "${input_path}" == http* || "${input_path}" == *"github.com"* ]]; then
            print_error "That looks like a URL, not a local folder path. Please try again."
        elif [[ ! -d "${input_path}" ]]; then
            print_error "Directory does not exist: ${input_path}"
            echo -e "${YELLOW}How to fix it:${NC} Check the path and try again, or create the folder first:"
            echo -e "${GREEN}  mkdir -p \"${input_path}\"${NC}"
        elif [[ ! -r "${input_path}" || ! -x "${input_path}" ]]; then
            print_error "Directory exists but is not accessible (permission denied)."
            echo -e "${YELLOW}How to fix it:${NC} ${GREEN}sudo chmod u+rx \"${input_path}\"${NC}"
        else
            break
        fi
    done

    local subdirs=()
    while IFS= read -r d; do
        subdirs+=("${d}")
    done < <(find "${input_path}" -mindepth 1 -maxdepth 1 -type d ! -name ".git" 2>/dev/null | sort)

    if [[ ${#subdirs[@]} -eq 0 ]]; then
        PROJECT_PATH="${input_path}"
    else
        echo ""
        print_warning "This folder contains multiple items. Select ONE folder to push."
        echo ""
        local i=1
        for d in "${subdirs[@]}"; do
            echo "  ${i}) $(basename "${d}")"
            i=$((i+1))
        done
        echo "  0) Use \"${input_path}\" itself (do not descend into a subfolder)"
        echo ""
        echo -e "${YELLOW}Only ONE folder will be pushed. Nothing else will be touched.${NC}"

        while true; do
            read -rp "Select which folder to push: " sel
            if [[ "${sel}" == "0" ]]; then
                PROJECT_PATH="${input_path}"
                FORCE_ROOT_PATH="yes"
                break
            elif [[ "${sel}" =~ ^[0-9]+$ ]] && (( sel >= 1 && sel <= ${#subdirs[@]} )); then
                PROJECT_PATH="${subdirs[$((sel-1))]}"
                FORCE_ROOT_PATH="no"
                break
            else
                print_error "Invalid selection. Please enter a number from the list."
            fi
        done
    fi

    print_success "Project folder selected: ${PROJECT_PATH}"
    log "INFO" "Project path set to ${PROJECT_PATH}"

    validate_repo_path_permissions

    if [[ "${FORCE_ROOT_PATH}" == "yes" ]]; then
        print_info "You chose to use \"${PROJECT_PATH}\" itself — not descending into any subfolder."
        print_info "If a subfolder contains its own .git, it will be handled later as a nested"
        print_info "repository (Step 6 will offer to fix it so it's tracked as normal files)."
    else
        detect_and_select_nested_repo
    fi
}

detect_and_select_nested_repo() {
    print_info "Scanning for Git repositories inside: ${PROJECT_PATH}"
    local git_dirs=()
    while IFS= read -r d; do
        git_dirs+=("${d}")
    done < <(find "${PROJECT_PATH}" -mindepth 1 -maxdepth 6 -type d -name ".git" 2>/dev/null | sort)

    local root_is_repo="no"
    [[ -d "${PROJECT_PATH}/.git" ]] && root_is_repo="yes"

    if [[ ${#git_dirs[@]} -eq 0 ]]; then
        print_success "No existing Git repository found. A new one will be created in: ${PROJECT_PATH}"
        return
    fi

    if [[ ${#git_dirs[@]} -eq 1 && "${root_is_repo}" == "yes" ]]; then
        print_success ".git folder found at the root of the selected folder."
        return
    fi

    print_warning "Multiple/nested Git repositories detected. Choose ONE to push:"
    echo ""
    local i=1
    local repo_paths=()
    for gd in "${git_dirs[@]}"; do
        local repo_dir
        repo_dir="$(dirname "${gd}")"
        repo_paths+=("${repo_dir}")
        echo "  ${i}) ${repo_dir}"
        i=$((i+1))
    done
    echo ""

    while true; do
        read -rp "Select which repository should be pushed (1-${#repo_paths[@]}): " sel
        if [[ "${sel}" =~ ^[0-9]+$ ]] && (( sel >= 1 && sel <= ${#repo_paths[@]} )); then
            PROJECT_PATH="${repo_paths[$((sel-1))]}"
            print_success "Selected repository: ${PROJECT_PATH}"
            log "INFO" "Nested repo selected: ${PROJECT_PATH}"
            break
        else
            print_error "Invalid selection. Try again."
        fi
    done
}

get_commit_message() {
    print_step "5" "Commit Message"
    echo -e "${BLUE}Enter a commit message describing your changes.${NC}"
    echo -e "Example: ${GREEN}Added Java Docker Project${NC}"
    echo -e "${YELLOW}Leave blank to use the default message: \"Update Project\"${NC}"
    echo ""

    read -rp "Commit Message: " COMMIT_MESSAGE
    if [[ -z "${COMMIT_MESSAGE}" ]]; then
        COMMIT_MESSAGE="Update Project"
        print_warning "No message entered. Using default: \"${COMMIT_MESSAGE}\""
    else
        print_success "Commit message set: \"${COMMIT_MESSAGE}\""
    fi
    log "INFO" "Commit message set to: ${COMMIT_MESSAGE}"
}

###############################################################################
# SECTION 6: GIT REPOSITORY VALIDATION & OPERATIONS
###############################################################################

enter_project_directory() {
    if ! cd "${PROJECT_PATH}"; then
        print_error "Could not enter directory: ${PROJECT_PATH}"
        exit 1
    fi
}

check_nested_repos() {
    print_info "Checking for stray nested Git repositories or submodules..."
    local nested_dirs=()
    while IFS= read -r d; do
        [[ -n "${d}" ]] && nested_dirs+=("${d}")
    done < <(find . -mindepth 2 -maxdepth 6 -type d -name ".git" 2>/dev/null)

    if [[ ${#nested_dirs[@]} -eq 0 ]]; then
        print_success "No stray nested repositories found."
        return
    fi

    print_warning "Nested Git repository/submodule(s) detected inside your project:"
    for gd in "${nested_dirs[@]}"; do
        echo -e "  ${YELLOW}$(dirname "${gd}")${NC}"
    done
    echo -e "${YELLOW}Why this matters:${NC} If left as-is, Git will push these folders as a"
    echo -e "broken 'link' instead of real files. On GitHub they show up with an arrow (→)"
    echo -e "icon and CANNOT be opened, because there is no real submodule set up."
    echo ""
    echo "Would you like me to fix this automatically?"
    echo "  1) Yes — remove the inner .git folder(s) so these become normal tracked folders"
    echo "  2) No — leave as-is (folder will appear broken/unopenable on GitHub)"
    echo ""
    read -rp "Choose 1 or 2: " nested_choice

    if [[ "${nested_choice}" != "1" ]]; then
        print_warning "Skipped. These folder(s) will likely show a broken arrow icon on GitHub."
        return
    fi

    for gd in "${nested_dirs[@]}"; do
        local folder
        folder="$(dirname "${gd}")"
        rm -rf "${gd}"
        git rm -r --cached "${folder}" >/dev/null 2>&1
        print_success "Fixed: ${folder} will now be tracked as normal files."
        log "INFO" "Removed nested .git and re-tracked: ${folder}"
    done
}

init_repo_if_needed() {
    if [[ -d ".git" ]]; then
        print_success ".git folder found. This is an existing Git repository."
    else
        if git init -b main >/dev/null 2>&1; then
            :
        else
            git init >/dev/null 2>&1
            git checkout -b main >/dev/null 2>&1
        fi
        print_success "Initialized new Git repository with default branch 'main'."
        log "INFO" "git init executed in ${PROJECT_PATH}"
    fi
}

stage_and_commit() {
    git add .
    log "INFO" "git add . executed"

    if git diff --cached --quiet; then
        print_warning "Nothing to commit. Your working directory has no changes to save."
        echo -e "${YELLOW}Why this happened:${NC} All files are already committed, or the folder is empty."
        echo -e "${YELLOW}What happens next:${NC} The script will still try to push existing commits (if any)."
        return 1
    fi

    if git commit -m "${COMMIT_MESSAGE}" >/tmp/commit_output.log 2>&1; then
        print_success "Commit created successfully."
        log "SUCCESS" "git commit executed: ${COMMIT_MESSAGE}"
        return 0
    else
        print_error "Commit failed."
        cat /tmp/commit_output.log
        log "ERROR" "git commit failed: $(cat /tmp/commit_output.log)"
        return 1
    fi
}

detect_branch() {
    local current_branch
    current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"

    if [[ "${current_branch}" != "HEAD" && -n "${current_branch}" ]]; then
        BRANCH_NAME="${current_branch}"
    elif git show-ref --verify --quiet refs/heads/main; then
        BRANCH_NAME="main"
        git checkout main >/dev/null 2>&1
    elif git show-ref --verify --quiet refs/heads/master; then
        BRANCH_NAME="master"
        git checkout master >/dev/null 2>&1
    else
        BRANCH_NAME="main"
        git checkout -b main >/dev/null 2>&1
    fi
    log "INFO" "Branch set to ${BRANCH_NAME}"
}

###############################################################################
# SECTION 7: REMOTE HANDLING
###############################################################################

handle_remote() {
    if [[ "${AUTH_METHOD}" == "https" ]]; then
        REMOTE_URL="https://github.com/${GITHUB_USERNAME}/${REPO_NAME}.git"
    else
        REMOTE_URL="git@github.com:${GITHUB_USERNAME}/${REPO_NAME}.git"
    fi

    local existing_url
    existing_url="$(git remote get-url origin 2>/dev/null)"

    if [[ -n "${existing_url}" ]]; then
        echo ""
        print_warning "A remote named 'origin' already exists:"
        echo -e "${YELLOW}  ${existing_url}${NC}"
        echo ""
        echo "  1. Use existing remote"
        echo "  2. Replace it with: ${REMOTE_URL}"
        echo ""
        while true; do
            read -rp "Choose 1 or 2: " remote_choice
            case "${remote_choice}" in
                1)
                    REMOTE_URL="${existing_url}"
                    print_success "Using existing remote: ${REMOTE_URL}"
                    break
                    ;;
                2)
                    git remote remove origin
                    git remote add origin "${REMOTE_URL}"
                    print_success "Remote replaced with: ${REMOTE_URL}"
                    break
                    ;;
                *)
                    print_error "Invalid choice. Please enter 1 or 2."
                    ;;
            esac
        done
    else
        if git remote add origin "${REMOTE_URL}" 2>/tmp/remote_output.log; then
            print_success "Remote 'origin' added: ${REMOTE_URL}"
        else
            print_error "Failed to add remote origin."
            cat /tmp/remote_output.log
            log "ERROR" "git remote add failed: $(cat /tmp/remote_output.log)"
            exit 1
        fi
    fi
    log "INFO" "Remote origin set to ${REMOTE_URL}"
}

###############################################################################
# SECTION 7b: REPOSITORY EXISTENCE CHECK (with optional auto-create)
###############################################################################

check_repo_exists_remote() {
    print_step "6b" "Repository Existence Check"
    print_info "Checking if https://github.com/${GITHUB_USERNAME}/${REPO_NAME} exists..."

    local http_code
    http_code="$(curl -s -o /dev/null -w "%{http_code}" "https://github.com/${GITHUB_USERNAME}/${REPO_NAME}")"

    if [[ "${http_code}" == "200" ]]; then
        print_success "Repository exists on GitHub."
        return 0
    fi

    print_warning "Repository does not exist (or is private and inaccessible without login)."
    echo ""
    echo "Would you like me to create it?"
    echo "  1) Yes (using GitHub CLI if available)"
    echo "  2) No"
    read -rp "Choose 1 or 2: " ans

    if [[ "${ans}" == "1" ]]; then
        if [[ "${GH_CLI_AVAILABLE}" == "yes" ]]; then
            local vis_flag="--public"
            [[ "${REPO_VISIBILITY}" == "private" ]] && vis_flag="--private"
            if gh repo create "${GITHUB_USERNAME}/${REPO_NAME}" ${vis_flag} --confirm >/tmp/gh_create.log 2>&1; then
                print_success "Repository created using GitHub CLI."
            else
                print_error "gh repo create failed."
                cat /tmp/gh_create.log
                log "ERROR" "gh repo create failed: $(cat /tmp/gh_create.log)"
            fi
        else
            print_info "GitHub CLI is not installed, so please create the repository manually:"
            echo -e "${GREEN}  https://github.com/new${NC}"
            echo "  Repository name: ${REPO_NAME}"
            echo "  Visibility     : ${REPO_VISIBILITY}"
            read -rp "Press ENTER once you have created the repository..." _
        fi
    else
        print_warning "Continuing without confirming repository creation. The push may fail."
    fi
}

###############################################################################
# SECTION 8: PUSH & ERROR INTERPRETATION
###############################################################################

explain_push_error() {
    local output="$1"

    if echo "${output}" | grep -qi "repository not found"; then
        print_error "GitHub says: Repository not found."
        echo -e "${YELLOW}Why:${NC} The repository does not exist on GitHub, or the name/username is wrong."
        echo -e "${YELLOW}Fix:${NC} Create the repository at https://github.com/new or check the spelling."

    elif echo "${output}" | grep -qi "authentication failed"; then
        print_error "GitHub says: Authentication failed."
        echo -e "${YELLOW}Why:${NC} Wrong username/password, or you used your GitHub password instead of a token."
        echo -e "${YELLOW}Fix:${NC} Create a Personal Access Token at https://github.com/settings/tokens and use it as the password."

    elif echo "${output}" | grep -qi "permission denied (publickey)"; then
        print_error "SSH says: Permission denied (publickey)."
        echo -e "${YELLOW}Why:${NC} Your SSH key is not registered with your GitHub account."
        echo -e "${YELLOW}Fix:${NC} Run: ${GREEN}cat ~/.ssh/id_ed25519.pub${NC} and paste it into https://github.com/settings/keys"

    elif echo "${output}" | grep -qi "permission denied"; then
        print_error "Permission denied."
        echo -e "${YELLOW}Why:${NC} You don't have write access to this repository."
        echo -e "${YELLOW}Fix:${NC} Ask the repository owner to add you as a collaborator, or check your credentials."
        if [[ "${REPO_VISIBILITY}" == "private" ]]; then
            echo -e "${YELLOW}Note:${NC} This is a private repository, so make sure your account has access to it."
        fi

    elif echo "${output}" | grep -qi "could not resolve host"; then
        print_error "Could not resolve host (no internet / DNS issue)."
        echo -e "${YELLOW}Why:${NC} Your computer could not reach github.com."
        echo -e "${YELLOW}Fix:${NC} Check your internet connection and try again."

    elif echo "${output}" | grep -qi "non-fast-forward"; then
        print_error "Push rejected: non-fast-forward."
        echo -e "${YELLOW}Why:${NC} The remote repository has commits that you don't have locally."
        echo -e "${YELLOW}Fix:${NC} Run: ${GREEN}git pull origin ${BRANCH_NAME} --rebase${NC} then push again."

    elif echo "${output}" | grep -qi "rejected"; then
        print_error "Push was rejected by GitHub."
        echo -e "${YELLOW}Why:${NC} Usually caused by diverged history or branch protection rules."
        echo -e "${YELLOW}Fix:${NC} Run: ${GREEN}git pull origin ${BRANCH_NAME}${NC}, resolve any conflicts, then push again."

    elif echo "${output}" | grep -qi "everything up-to-date"; then
        print_success "Everything is already up-to-date. Nothing new to push."

    elif echo "${output}" | grep -qi "src refspec .* does not match any"; then
        print_error "No commits found to push (branch has no commits)."
        echo -e "${YELLOW}Why:${NC} You haven't made any commits yet on this branch."
        echo -e "${YELLOW}Fix:${NC} Make sure you have files in the folder, then let the script commit them."

    elif echo "${output}" | grep -qi "remote origin already exists"; then
        print_error "Remote 'origin' already exists."
        echo -e "${YELLOW}Fix:${NC} Run: ${GREEN}git remote remove origin${NC} then try again."

    elif echo "${output}" | grep -qi "not a git repository"; then
        print_error "This folder is not a Git repository."
        echo -e "${YELLOW}Fix:${NC} Run: ${GREEN}git init${NC} inside the folder first (this script does this automatically)."

    elif echo "${output}" | grep -qi "detached HEAD"; then
        print_error "You are in a detached HEAD state (not on any branch)."
        echo -e "${YELLOW}Fix:${NC} Run: ${GREEN}git checkout -b main${NC} to create and switch to a branch."

    elif echo "${output}" | grep -qi "no access to private"; then
        print_error "No access to private repository."
        echo -e "${YELLOW}Why:${NC} This repository is private and your account isn't a collaborator."
        echo -e "${YELLOW}Fix:${NC} Ask the owner for access, or double-check you're logged in as the right account."

    else
        print_error "Push failed with an unrecognized error."
        echo -e "${YELLOW}Raw Git output:${NC}"
        echo "${output}"
    fi
}

push_to_github() {
    print_info "Running: git push -u origin ${BRANCH_NAME}"

    local push_output
    push_output="$(git push -u origin "${BRANCH_NAME}" 2>&1)"
    local push_exit_code=$?

    echo "${push_output}"
    log "INFO" "git push output: ${push_output}"

    if [[ ${push_exit_code} -eq 0 ]]; then
        print_success "Project pushed to GitHub successfully!"
        PUSH_STATUS="SUCCESS"
        log "SUCCESS" "Push completed successfully."
        return
    fi

    explain_push_error "${push_output}"
    log "ERROR" "Push failed."

    if echo "${push_output}" | grep -qiE "non-fast-forward|\[rejected\]|fetch first"; then
        try_auto_fix_diverged_history "${push_output}"
    else
        PUSH_STATUS="FAILED"
    fi
}

try_auto_fix_diverged_history() {
    echo ""
    print_warning "This is NOT a configuration problem."
    echo -e "${YELLOW}Why this happened:${NC} The GitHub repository already contains commit(s)"
    echo -e "that your local folder does not have (for example, a README or .gitignore"
    echo -e "created automatically when the repository was made on GitHub.com)."
    echo ""
    echo "How would you like to fix this?"
    echo "  1) Pull the remote changes and merge them automatically, then push again (recommended)"
    echo "  2) Skip auto-fix (I will resolve it manually)"
    echo ""
    read -rp "Choose 1 or 2: " fix_choice

    if [[ "${fix_choice}" != "1" ]]; then
        print_warning "Skipped auto-fix. To resolve manually, run:"
        echo -e "${GREEN}  git pull origin ${BRANCH_NAME} --no-rebase${NC}"
        echo -e "${GREEN}  git push -u origin ${BRANCH_NAME}${NC}"
        PUSH_STATUS="FAILED"
        return
    fi

    print_info "Running: git pull origin ${BRANCH_NAME} --no-rebase --allow-unrelated-histories"
    local pull_output
    pull_output="$(git pull origin "${BRANCH_NAME}" --no-rebase --allow-unrelated-histories --no-edit 2>&1)"
    local pull_exit_code=$?
    echo "${pull_output}"
    log "INFO" "git pull output: ${pull_output}"

    if [[ ${pull_exit_code} -eq 0 ]]; then
        print_success "Remote changes merged successfully. Retrying push..."
        retry_push_after_merge
        return
    fi

    local conflicted_files=()
    while IFS= read -r f; do
        [[ -n "${f}" ]] && conflicted_files+=("${f}")
    done < <(git diff --name-only --diff-filter=U 2>/dev/null)

    if [[ ${#conflicted_files[@]} -eq 0 ]]; then
        print_error "Automatic merge failed for a reason other than a file conflict."
        echo -e "${YELLOW}Raw output is shown above. Merge has been left in progress.${NC}"
        echo -e "${YELLOW}To cancel and start over:${NC} ${GREEN}git merge --abort${NC}"
        PUSH_STATUS="FAILED"
        return
    fi

    echo ""
    print_warning "Git could not automatically combine the following file(s):"
    for f in "${conflicted_files[@]}"; do
        echo -e "  ${YELLOW}- ${f}${NC}"
    done
    echo ""
    echo -e "${YELLOW}Why:${NC} These files were changed both on your computer AND on GitHub,"
    echo -e "so Git doesn't know which version you want to keep."
    echo ""
    echo "How do you want to resolve this?"
    echo "  1) Keep MY LOCAL version for all conflicting files (GitHub's version is discarded)"
    echo "  2) Keep GITHUB's version for all conflicting files (your local changes to these files are discarded)"
    echo "  3) Cancel — I will resolve it manually"
    echo ""
    read -rp "Choose 1, 2 or 3: " conflict_choice

    case "${conflict_choice}" in
        1)
            for f in "${conflicted_files[@]}"; do
                git checkout --ours -- "${f}" 2>/dev/null
                git add -- "${f}"
            done
            print_success "Kept your local version for the conflicting file(s)."
            ;;
        2)
            for f in "${conflicted_files[@]}"; do
                git checkout --theirs -- "${f}" 2>/dev/null
                git add -- "${f}"
            done
            print_success "Kept GitHub's version for the conflicting file(s)."
            ;;
        *)
            git merge --abort 2>/dev/null
            print_warning "Merge cancelled. Nothing was pushed. To resolve manually, run:"
            echo -e "${GREEN}  git pull origin ${BRANCH_NAME} --no-rebase${NC}"
            echo -e "${YELLOW}Then edit the conflicting file(s), then:${NC}"
            echo -e "${GREEN}  git add .${NC}"
            echo -e "${GREEN}  git commit${NC}"
            echo -e "${GREEN}  git push -u origin ${BRANCH_NAME}${NC}"
            PUSH_STATUS="FAILED"
            return
            ;;
    esac

    if git commit --no-edit >/tmp/merge_commit.log 2>&1; then
        print_success "Merge commit created. Retrying push..."
        retry_push_after_merge
    else
        print_error "Could not finish the merge commit."
        cat /tmp/merge_commit.log
        log "ERROR" "merge commit failed: $(cat /tmp/merge_commit.log)"
        PUSH_STATUS="FAILED"
    fi
}

retry_push_after_merge() {
    local retry_output
    retry_output="$(git push -u origin "${BRANCH_NAME}" 2>&1)"
    local retry_exit_code=$?
    echo "${retry_output}"
    log "INFO" "git push retry output: ${retry_output}"

    if [[ ${retry_exit_code} -eq 0 ]]; then
        print_success "Project pushed to GitHub successfully!"
        PUSH_STATUS="SUCCESS"
        log "SUCCESS" "Push completed successfully after auto merge."
    else
        explain_push_error "${retry_output}"
        PUSH_STATUS="FAILED"
        log "ERROR" "Push still failed after auto merge."
    fi
}

###############################################################################
# SECTION 8b: GIT PIPELINE WITH PROGRESS BAR
###############################################################################

run_git_pipeline_with_progress() {
    print_step "6" "Preparing and Pushing Your Project"
    show_progress 6

    enter_project_directory
    update_progress "Entered project folder"

    check_nested_repos
    update_progress "Checked nested repos"

    init_repo_if_needed
    update_progress "git init"

    stage_and_commit
    update_progress "git add + commit"

    detect_branch
    handle_remote
    update_progress "Remote configured"

    check_repo_exists_remote
    push_to_github
    update_progress "git push"
}

###############################################################################
# SECTION 9: FINAL SUMMARY (push flow)
###############################################################################

print_summary() {
    echo ""
    echo -e "${CYAN}${BOLD}==============================================================="
    echo -e "                      FINAL SUMMARY"
    echo -e "===============================================================${NC}"
    echo -e "${BLUE}Project Path   :${NC} ${PROJECT_PATH}"
    echo -e "${BLUE}Repository     :${NC} ${REPO_NAME} (${REPO_VISIBILITY})"
    echo -e "${BLUE}Branch         :${NC} ${BRANCH_NAME}"
    echo -e "${BLUE}Remote URL     :${NC} ${REMOTE_URL}"
    echo -e "${BLUE}Auth Method    :${NC} ${AUTH_METHOD}"
    echo -e "${BLUE}Commit Message :${NC} ${COMMIT_MESSAGE}"

    if [[ "${PUSH_STATUS}" == "SUCCESS" ]]; then
        echo -e "${BLUE}Push Status    :${NC} ${GREEN}${BOLD}SUCCESS${NC}"
    else
        echo -e "${BLUE}Push Status    :${NC} ${RED}${BOLD}FAILED${NC}"
    fi
    echo -e "${CYAN}${BOLD}===============================================================${NC}"
    echo -e "${YELLOW}Full log saved at: ${LOG_FILE}${NC}"
    echo ""
    log "INFO" "===== Session ended. Push status: ${PUSH_STATUS} ====="
}

###############################################################################
# SECTION 10: PUSH FLOW WRAPPER
###############################################################################

run_push_flow() {
    run_full_environment_validation
    get_username
    get_repo_name
    get_repo_visibility
    get_auth_method
    get_project_path
    get_commit_message
    run_git_pipeline_with_progress
    print_summary

    if [[ "${PUSH_STATUS}" == "SUCCESS" ]]; then
        exit 0
    else
        exit 1
    fi
}

###############################################################################
# SECTION 11: REPOSITORY MANAGEMENT — LIST, BACKUP & DELETE
###############################################################################
# Lets the user see EVERY repository under their account (including PRIVATE
# ones, when authenticated), choose which ones to delete, ALWAYS shows a
# clear "will be deleted" vs "will remain" list, strongly recommends (and
# performs) a local git clone backup BEFORE any deletion, and requires the
# user to type the exact word DELETE as a final confirmation. Nothing is
# deleted without that explicit confirmation.
###############################################################################

# Ensures we have SOME way to see/act on PRIVATE repos: either an
# authenticated `gh` CLI session, or a Personal Access Token (PAT) with the
# 'repo' and 'delete_repo' scopes. Without one of these, GitHub's API will
# only ever return PUBLIC repositories — this is a GitHub API limitation,
# not a bug in this script.
ensure_private_repo_access() {
    if [[ "${GH_CLI_AVAILABLE}" == "yes" ]] && gh auth status >/dev/null 2>&1; then
        print_success "Authenticated GitHub CLI session detected — private repos will be visible."
        return
    fi

    if [[ -n "${GITHUB_TOKEN}" ]]; then
        print_success "Personal Access Token already provided — private repos will be visible."
        return
    fi

    echo ""
    print_warning "No authenticated session detected (gh CLI not logged in)."
    echo -e "${YELLOW}Why this matters:${NC} GitHub's public API only shows PUBLIC repositories."
    echo -e "To see and manage your PRIVATE repositories too, this tool needs either:"
    echo "  1) An authenticated GitHub CLI session (gh auth login), or"
    echo "  2) A Personal Access Token (PAT) with 'repo' and 'delete_repo' scopes"
    echo ""
    echo "How would you like to proceed?"
    echo "  1) Log in with GitHub CLI now (gh auth login)"
    echo "  2) Enter a Personal Access Token"
    echo "  3) Continue with PUBLIC repositories only"
    echo ""

    while true; do
        read -rp "Choose 1, 2 or 3: " ans
        case "${ans}" in
            1)
                if [[ "${GH_CLI_AVAILABLE}" != "yes" ]]; then
                    print_error "GitHub CLI (gh) is not installed on this system."
                    echo -e "${YELLOW}Fix:${NC} ${GREEN}sudo apt install gh -y${NC}  (then re-run this tool)"
                    continue
                fi
                gh auth login
                if gh auth status >/dev/null 2>&1; then
                    print_success "Logged in via GitHub CLI. Private repos will now be visible."
                else
                    print_warning "GitHub CLI login did not complete. Falling back to public repos only."
                fi
                break
                ;;
            2)
                echo -e "${YELLOW}Create a token at:${NC} ${GREEN}https://github.com/settings/tokens${NC}"
                echo -e "${YELLOW}Required scopes:${NC} repo (full control), delete_repo"
                read -rsp "Enter your Personal Access Token: " GITHUB_TOKEN
                echo ""
                if [[ -n "${GITHUB_TOKEN}" ]]; then
                    print_success "Token saved for this session. Private repos will now be visible."
                else
                    print_warning "No token entered. Falling back to public repos only."
                fi
                break
                ;;
            3)
                print_warning "Continuing with PUBLIC repositories only."
                break
                ;;
            *)
                print_error "Invalid choice. Please enter 1, 2 or 3."
                ;;
        esac
    done
}

fetch_repo_list() {
    print_step "M1" "Fetching Your Repositories"
    print_info "Looking up repositories for: ${GITHUB_USERNAME}"

    REPO_LIST=()

    # Path 1: authenticated gh CLI — sees public AND private repos.
    if [[ "${GH_CLI_AVAILABLE}" == "yes" ]] && gh auth status >/dev/null 2>&1; then
        local name desc vis pushed
        while IFS=$'\t' read -r name desc vis pushed; do
            [[ -z "${name}" ]] && continue
            name="${name#*/}"
            REPO_LIST+=("${name}|${vis}|${pushed}")
        done < <(gh repo list "${GITHUB_USERNAME}" --limit 300 --source 2>/dev/null)
    fi

    # Path 2: Personal Access Token via the AUTHENTICATED /user/repos endpoint —
    # this endpoint (unlike /users/{username}/repos) also returns PRIVATE repos
    # that belong to the token's owner.
    if [[ ${#REPO_LIST[@]} -eq 0 && -n "${GITHUB_TOKEN}" ]]; then
        print_info "Using the authenticated GitHub API with your Personal Access Token."
        local page=1 got_any=1
        : > /tmp/gh_repos_raw.json
        while [[ ${got_any} -eq 1 ]]; do
            local page_file="/tmp/gh_repos_page_${page}.json"
            curl -s \
                -H "Authorization: token ${GITHUB_TOKEN}" \
                -H "Accept: application/vnd.github+json" \
                "https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner" \
                -o "${page_file}"

            if command -v python3 >/dev/null 2>&1; then
                local count
                count="$(python3 -c "
import json
try:
    with open('${page_file}') as f:
        data = json.load(f)
    print(len(data) if isinstance(data, list) else 0)
except Exception:
    print(0)
")"
                if [[ "${count}" -eq 0 ]]; then
                    got_any=0
                else
                    cat "${page_file}" >> /tmp/gh_repos_raw.json
                    echo "," >> /tmp/gh_repos_raw.json  # placeholder, fixed by python merge below
                    page=$((page+1))
                fi
            else
                got_any=0
            fi
        done

        if command -v python3 >/dev/null 2>&1; then
            local name vis pushed
            while IFS=$'\t' read -r name vis pushed; do
                [[ -z "${name}" ]] && continue
                REPO_LIST+=("${name}|${vis}|${pushed}")
            done < <(python3 -c "
import json, glob
all_repos = []
for fn in sorted(glob.glob('/tmp/gh_repos_page_*.json')):
    try:
        with open(fn) as f:
            data = json.load(f)
        if isinstance(data, list):
            all_repos.extend(data)
    except Exception:
        pass
for r in all_repos:
    name = r.get('name', '')
    vis = 'private' if r.get('private') else 'public'
    pushed = r.get('pushed_at', 'unknown')
    print(f'{name}\t{vis}\t{pushed}')
" 2>/dev/null)
        fi
        rm -f /tmp/gh_repos_page_*.json
    fi

    # Path 3: fallback — unauthenticated public API. PUBLIC repos only.
    if [[ ${#REPO_LIST[@]} -eq 0 ]]; then
        print_info "Using the public GitHub API (no authenticated session or token available)."
        print_warning "Only PUBLIC repositories will be visible this way."
        print_warning "To also see/manage private repos, log in with 'gh auth login' or provide a PAT."

        curl -s "https://api.github.com/users/${GITHUB_USERNAME}/repos?per_page=100" > /tmp/gh_repos_raw.json

        if command -v python3 >/dev/null 2>&1; then
            local name vis pushed
            while IFS=$'\t' read -r name vis pushed; do
                [[ -z "${name}" ]] && continue
                REPO_LIST+=("${name}|${vis}|${pushed}")
            done < <(python3 -c "
import json
try:
    with open('/tmp/gh_repos_raw.json') as f:
        data = json.load(f)
    if not isinstance(data, list):
        data = []
except Exception:
    data = []
for r in data:
    name = r.get('name', '')
    vis = 'private' if r.get('private') else 'public'
    pushed = r.get('pushed_at', 'unknown')
    print(f'{name}\t{vis}\t{pushed}')
" 2>/dev/null)
        else
            local name
            while IFS= read -r name; do
                [[ -z "${name}" ]] && continue
                REPO_LIST+=("${name}|public|unknown")
            done < <(grep -oE '"name": *"[^"]+"' /tmp/gh_repos_raw.json | sed -E 's/"name": *"([^"]+)"/\1/')
        fi
    fi

    if [[ ${#REPO_LIST[@]} -eq 0 ]]; then
        print_error "No repositories found for '${GITHUB_USERNAME}', or they could not be fetched."
        echo -e "${YELLOW}Tip:${NC} If you have private repos, run ${GREEN}gh auth login${NC} or supply a Personal Access Token so this tool can see them."
        exit 1
    fi

    print_success "Found ${#REPO_LIST[@]} repositories."
}

display_repo_list() {
    echo ""
    echo -e "${CYAN}${BOLD}Your GitHub Repositories (${GITHUB_USERNAME}):${NC}"
    echo -e "${CYAN}------------------------------------------------------------${NC}"
    local i=1
    local entry rname rvis rpushed vis_color
    for entry in "${REPO_LIST[@]}"; do
        IFS='|' read -r rname rvis rpushed <<< "${entry}"
        vis_color="${GREEN}"
        [[ "${rvis}" == "private" ]] && vis_color="${YELLOW}"
        printf "  %2d) %-30s [%b%-7s%b]  last updated: %s\n" "${i}" "${rname}" "${vis_color}" "${rvis}" "${NC}" "${rpushed}"
        i=$((i+1))
    done
    echo -e "${CYAN}------------------------------------------------------------${NC}"
    echo -e "${BLUE}Total repositories: ${#REPO_LIST[@]}${NC}"
    echo ""
}

select_repos_for_deletion() {
    echo -e "${YELLOW}Enter the NUMBER(S) of the repositories you want to DELETE,"
    echo -e "separated by commas. Example: 1,3,4${NC}"
    echo -e "${YELLOW}(Leave blank to cancel and exit without changing anything)${NC}"
    echo ""

    while true; do
        read -rp "Repositories to delete: " sel_input
        if [[ -z "${sel_input}" ]]; then
            print_info "No selection made. Exiting without changes."
            exit 0
        fi

        SELECTED_INDICES=()
        local valid=true
        local parts=()
        IFS=',' read -ra parts <<< "${sel_input}"
        local p
        for p in "${parts[@]}"; do
            p="$(echo "${p}" | tr -d '[:space:]')"
            if [[ "${p}" =~ ^[0-9]+$ ]] && (( p >= 1 && p <= ${#REPO_LIST[@]} )); then
                SELECTED_INDICES+=("${p}")
            else
                print_error "Invalid entry: '${p}'. Please use numbers from the list above."
                valid=false
                break
            fi
        done

        if [[ "${valid}" == "true" && ${#SELECTED_INDICES[@]} -gt 0 ]]; then
            SELECTED_INDICES=($(printf "%s\n" "${SELECTED_INDICES[@]}" | sort -nu))
            break
        fi
    done
}

show_deletion_plan() {
    echo ""
    echo -e "${RED}${BOLD}================= REPOSITORIES TO BE DELETED =================${NC}"
    local idx rname rvis rpushed
    for idx in "${SELECTED_INDICES[@]}"; do
        IFS='|' read -r rname rvis rpushed <<< "${REPO_LIST[$((idx-1))]}"
        echo -e "  ${RED}✘ ${rname}${NC}  (${rvis})"
    done
    echo -e "${RED}${BOLD}================================================================${NC}"
    echo ""
    echo -e "${GREEN}${BOLD}================= REPOSITORIES THAT WILL REMAIN ===============${NC}"
    local i=1
    local kept_any=false
    local entry is_selected
    for entry in "${REPO_LIST[@]}"; do
        is_selected=false
        for idx in "${SELECTED_INDICES[@]}"; do
            [[ "${idx}" -eq "${i}" ]] && is_selected=true
        done
        if [[ "${is_selected}" == "false" ]]; then
            IFS='|' read -r rname rvis rpushed <<< "${entry}"
            echo -e "  ${GREEN}✔ ${rname}${NC}  (${rvis})"
            kept_any=true
        fi
        i=$((i+1))
    done
    [[ "${kept_any}" == "false" ]] && echo -e "  ${YELLOW}(none — every repository is selected for deletion)${NC}"
    echo -e "${GREEN}${BOLD}================================================================${NC}"
    echo ""
    print_warning "Deleting a GitHub repository is PERMANENT and CANNOT be undone."
    print_warning "This removes ALL code, issues, pull requests, wiki and release history."
}

confirm_and_backup() {
    echo ""
    echo -e "${YELLOW}It is STRONGLY recommended to back up these repositories locally"
    echo -e "before deleting them from GitHub.${NC}"
    read -rp "Create a local backup now before deleting? (Y/n): " backup_ans
    backup_ans="${backup_ans:-Y}"

    if [[ ! "${backup_ans}" =~ ^[Yy]$ ]]; then
        print_warning "You chose to skip the backup."
        read -rp "Are you SURE? Skipped repos cannot be recovered once deleted. (y/N): " skip_confirm
        if [[ ! "${skip_confirm}" =~ ^[Yy]$ ]]; then
            print_info "Okay, creating a backup after all — better safe than sorry."
            do_backup
        else
            print_warning "Proceeding WITHOUT a local backup."
        fi
    else
        do_backup
    fi
}

do_backup() {
    local default_dir="${HOME}/github_backups/$(date '+%Y-%m-%d_%H-%M-%S')"
    read -rp "Backup folder [default: ${default_dir}]: " custom_dir
    BACKUP_DIR="${custom_dir:-${default_dir}}"
    mkdir -p "${BACKUP_DIR}"
    print_info "Backing up to: ${BACKUP_DIR}"

    local backup_failed=()
    local idx rname rvis rpushed clone_url
    for idx in "${SELECTED_INDICES[@]}"; do
        IFS='|' read -r rname rvis rpushed <<< "${REPO_LIST[$((idx-1))]}"

        # Private repos can only be cloned over HTTPS using a token, or over
        # SSH if the key is registered. Build the clone URL accordingly.
        if [[ "${rvis}" == "private" && -n "${GITHUB_TOKEN}" && "${AUTH_METHOD:-https}" != "ssh" ]]; then
            clone_url="https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${rname}.git"
        elif [[ "${AUTH_METHOD:-https}" == "ssh" ]]; then
            clone_url="git@github.com:${GITHUB_USERNAME}/${rname}.git"
        else
            clone_url="https://github.com/${GITHUB_USERNAME}/${rname}.git"
        fi

        print_info "Cloning ${rname}..."
        if git clone --quiet "${clone_url}" "${BACKUP_DIR}/${rname}" >/tmp/backup_clone.log 2>&1; then
            print_success "Backed up: ${rname} -> ${BACKUP_DIR}/${rname}"
            BACKED_UP["${rname}"]="yes"
        else
            print_error "Failed to back up: ${rname}"
            if [[ "${rvis}" == "private" ]]; then
                echo -e "${YELLOW}Tip:${NC} Private repo backups need a PAT with 'repo' scope, or a registered SSH key."
            fi
            cat /tmp/backup_clone.log
            backup_failed+=("${rname}")
            BACKED_UP["${rname}"]="no"
        fi
    done

    if [[ ${#backup_failed[@]} -gt 0 ]]; then
        echo ""
        print_warning "The following repositories could NOT be backed up:"
        local f
        for f in "${backup_failed[@]}"; do
            echo -e "  ${RED}- ${f}${NC}"
        done
        read -rp "Continue with deleting these UN-backed-up repos anyway? (y/N): " force_del
        if [[ ! "${force_del}" =~ ^[Yy]$ ]]; then
            local new_indices=() skip
            for idx in "${SELECTED_INDICES[@]}"; do
                IFS='|' read -r rname rvis rpushed <<< "${REPO_LIST[$((idx-1))]}"
                skip=false
                for f in "${backup_failed[@]}"; do
                    [[ "${rname}" == "${f}" ]] && skip=true
                done
                [[ "${skip}" == "false" ]] && new_indices+=("${idx}")
            done
            SELECTED_INDICES=("${new_indices[@]}")
            print_info "Un-backed-up repositories were removed from the deletion list."
        fi
    fi
}

confirm_final_delete() {
    if [[ ${#SELECTED_INDICES[@]} -eq 0 ]]; then
        print_info "Nothing left to delete. Exiting."
        exit 0
    fi

    echo ""
    print_warning "FINAL CONFIRMATION REQUIRED."
    echo -e "${RED}${BOLD}The following repositories will be PERMANENTLY DELETED from GitHub:${NC}"
    local idx rname rvis rpushed status
    for idx in "${SELECTED_INDICES[@]}"; do
        IFS='|' read -r rname rvis rpushed <<< "${REPO_LIST[$((idx-1))]}"
        status="${BACKED_UP[${rname}]:-no}"
        if [[ "${status}" == "yes" ]]; then
            echo -e "  ${RED}✘ ${rname}${NC}  ${GREEN}(backed up)${NC}"
        else
            echo -e "  ${RED}✘ ${rname}${NC}  ${YELLOW}(NOT backed up)${NC}"
        fi
    done
    echo ""
    echo -e "${YELLOW}Type ${BOLD}DELETE${NC}${YELLOW} (capital letters) to confirm, or anything else to cancel:${NC}"
    read -rp "> " final_confirm

    if [[ "${final_confirm}" != "DELETE" ]]; then
        print_info "Deletion cancelled. No repositories were touched."
        exit 0
    fi
}

delete_selected_repos() {
    print_step "M2" "Deleting Selected Repositories"

    local use_gh="no"
    if [[ "${GH_CLI_AVAILABLE}" == "yes" ]] && gh auth status >/dev/null 2>&1; then
        use_gh="yes"
    fi

    # If we're not using gh, and don't already have a token from
    # ensure_private_repo_access, ask for one now (needed for private repos,
    # and for delete_repo scope in general).
    if [[ "${use_gh}" == "no" && -z "${GITHUB_TOKEN}" ]]; then
        echo -e "${YELLOW}To delete repositories without the GitHub CLI, a Personal Access${NC}"
        echo -e "${YELLOW}Token with 'delete_repo' permission is required.${NC}"
        echo -e "Create one at: ${GREEN}https://github.com/settings/tokens${NC}"
        read -rsp "Enter your Personal Access Token: " GITHUB_TOKEN
        echo ""
    fi

    local idx rname rvis rpushed http_code
    for idx in "${SELECTED_INDICES[@]}"; do
        IFS='|' read -r rname rvis rpushed <<< "${REPO_LIST[$((idx-1))]}"
        print_info "Deleting ${rname}..."

        if [[ "${use_gh}" == "yes" ]]; then
            if gh repo delete "${GITHUB_USERNAME}/${rname}" --yes >/tmp/gh_delete.log 2>&1; then
                print_success "Deleted: ${rname}"
                DELETE_STATUS["${rname}"]="deleted"
                log "SUCCESS" "Deleted repo ${rname} via gh CLI"
            else
                print_error "Failed to delete: ${rname}"
                cat /tmp/gh_delete.log
                DELETE_STATUS["${rname}"]="failed"
                log "ERROR" "Failed to delete repo ${rname}: $(cat /tmp/gh_delete.log)"
            fi
        else
            http_code="$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
                -H "Authorization: token ${GITHUB_TOKEN}" \
                -H "Accept: application/vnd.github+json" \
                "https://api.github.com/repos/${GITHUB_USERNAME}/${rname}")"
            if [[ "${http_code}" == "204" ]]; then
                print_success "Deleted: ${rname}"
                DELETE_STATUS["${rname}"]="deleted"
                log "SUCCESS" "Deleted repo ${rname} via API"
            elif [[ "${http_code}" == "404" ]]; then
                print_error "Failed to delete: ${rname} (HTTP 404 — Not Found)"
                echo -e "${YELLOW}Common cause for PRIVATE repos:${NC} the token doesn't have access to this repo"
                echo -e "(wrong account) or lacks the 'repo' scope needed to even see it."
                DELETE_STATUS["${rname}"]="failed"
                log "ERROR" "Failed to delete repo ${rname}: HTTP 404"
            elif [[ "${http_code}" == "403" ]]; then
                print_error "Failed to delete: ${rname} (HTTP 403 — Forbidden)"
                echo -e "${YELLOW}Common cause:${NC} token is missing the 'delete_repo' scope."
                echo -e "${YELLOW}Fix:${NC} Regenerate your token at https://github.com/settings/tokens and tick 'delete_repo'."
                DELETE_STATUS["${rname}"]="failed"
                log "ERROR" "Failed to delete repo ${rname}: HTTP 403"
            else
                print_error "Failed to delete: ${rname} (HTTP ${http_code})"
                echo -e "${YELLOW}Common cause:${NC} token missing 'delete_repo' scope, or insufficient permissions."
                DELETE_STATUS["${rname}"]="failed"
                log "ERROR" "Failed to delete repo ${rname}: HTTP ${http_code}"
            fi
        fi
    done
}

print_manage_summary() {
    echo ""
    echo -e "${CYAN}${BOLD}==============================================================="
    echo -e "                 REPOSITORY MANAGEMENT SUMMARY"
    echo -e "===============================================================${NC}"
    local idx rname rvis rpushed bstatus dstatus
    for idx in "${SELECTED_INDICES[@]}"; do
        IFS='|' read -r rname rvis rpushed <<< "${REPO_LIST[$((idx-1))]}"
        bstatus="${BACKED_UP[${rname}]:-no}"
        dstatus="${DELETE_STATUS[${rname}]:-unknown}"
        echo -e "${BLUE}${rname}${NC}  (${rvis})"
        if [[ "${bstatus}" == "yes" ]]; then
            echo -e "   Backup : ${GREEN}OK (${BACKUP_DIR}/${rname})${NC}"
        else
            echo -e "   Backup : ${YELLOW}Not backed up${NC}"
        fi
        if [[ "${dstatus}" == "deleted" ]]; then
            echo -e "   Delete : ${GREEN}Success${NC}"
        else
            echo -e "   Delete : ${RED}Failed${NC}"
        fi
    done
    echo -e "${CYAN}${BOLD}===============================================================${NC}"
    echo -e "${YELLOW}Full log saved at: ${LOG_FILE}${NC}"
    echo ""
    log "INFO" "===== Repository management session ended ====="
}

run_manage_repos_flow() {
    print_step "M0" "Repository Management Setup"
    show_progress 4
    validate_git_installed
    validate_internet
    validate_github_reachable
    validate_gh_cli

    get_username
    ensure_private_repo_access

    fetch_repo_list
    display_repo_list
    select_repos_for_deletion
    show_deletion_plan
    confirm_and_backup
    confirm_final_delete
    delete_selected_repos
    print_manage_summary
}

###############################################################################
# SECTION 13: SCHEDULING & TASK QUEUE (daily automatic push, e.g. 6 PM)
###############################################################################
# Lets the user add several project folders as a "queue". A cron job (set up
# once, interactively) runs this script with --run-scheduled at a chosen time
# every day. Each run picks the NEXT pending task from the queue and pushes
# it, completely non-interactively, using credentials saved during setup.
#
# Queue file format (${QUEUE_FILE}), one task per line, pipe-separated:
#   STATUS|PROJECT_PATH|REPO_NAME|VISIBILITY|COMMIT_MESSAGE
#   STATUS is "pending" or "done"
###############################################################################

init_config_dir() {
    mkdir -p "${CONFIG_DIR}"
    chmod 700 "${CONFIG_DIR}"
    touch "${QUEUE_FILE}" "${SCHEDULE_LOG}"
}

save_schedule_config() {
    # Writes username + auth details needed for a NON-interactive push.
    # File is chmod 600 since it may contain a Personal Access Token.
    {
        echo "GITHUB_USERNAME='${GITHUB_USERNAME}'"
        echo "AUTH_METHOD='${AUTH_METHOD}'"
        echo "GITHUB_TOKEN='${GITHUB_TOKEN}'"
    } > "${CONFIG_FILE}"
    chmod 600 "${CONFIG_FILE}"
    print_success "Saved credentials for scheduled runs at: ${CONFIG_FILE}"
}

load_schedule_config() {
    if [[ ! -f "${CONFIG_FILE}" ]]; then
        return 1
    fi
    # shellcheck disable=SC1090
    source "${CONFIG_FILE}"
    return 0
}

schedule_setup_credentials() {
    print_step "S1" "Credentials for Unattended Daily Push"
    echo -e "${YELLOW}Since the daily push happens automatically (nobody is typing),${NC}"
    echo -e "${YELLOW}this tool needs to store how to authenticate with GitHub.${NC}"
    echo ""
    echo "  1) HTTPS with a Personal Access Token (recommended for automation)"
    echo "  2) SSH (works if your SSH key has NO passphrase, or ssh-agent stays loaded)"
    echo ""
    while true; do
        read -rp "Choose 1 or 2: " ans
        case "${ans}" in
            1)
                AUTH_METHOD="https"
                echo -e "${YELLOW}Create a token at:${NC} ${GREEN}https://github.com/settings/tokens${NC}"
                echo -e "${YELLOW}Required scope:${NC} repo"
                read -rsp "Enter your Personal Access Token: " GITHUB_TOKEN
                echo ""
                if [[ -z "${GITHUB_TOKEN}" ]]; then
                    print_error "No token entered. Cannot set up unattended push without it."
                    return 1
                fi
                break
                ;;
            2)
                AUTH_METHOD="ssh"
                if [[ "${SSH_KEY_EXISTS}" != "yes" ]]; then
                    print_warning "No SSH key detected yet. Run option 1 (Push a project) once first"
                    print_warning "so the tool can help you set one up, then come back here."
                fi
                print_warning "Reminder: if your SSH key has a passphrase, the 6 PM run will fail"
                print_warning "unless ssh-agent is already running and unlocked at that time."
                break
                ;;
            *)
                print_error "Invalid choice. Please enter 1 or 2."
                ;;
        esac
    done
    save_schedule_config
}

queue_add_task() {
    print_step "S2" "Add a Task to the Queue"
    local path repo vis msg

    read -rp "Local project folder path: " path
    path="${path/#\~/${HOME}}"
    if [[ ! -d "${path}" ]]; then
        print_error "Folder does not exist: ${path}"
        return
    fi

    read -rp "GitHub repository name for this task: " repo
    if [[ -z "${repo}" ]]; then
        print_error "Repository name cannot be empty."
        return
    fi

    echo "Visibility: 1) Public  2) Private"
    read -rp "Choose 1 or 2 [1]: " visc
    vis="public"
    [[ "${visc}" == "2" ]] && vis="private"

    read -rp "Commit message [default: Update Project]: " msg
    [[ -z "${msg}" ]] && msg="Update Project"

    echo "pending|${path}|${repo}|${vis}|${msg}" >> "${QUEUE_FILE}"
    print_success "Task added: ${path} -> ${repo} (${vis})"
}

queue_list_tasks() {
    echo ""
    echo -e "${CYAN}${BOLD}Task Queue:${NC}"
    echo -e "${CYAN}------------------------------------------------------------${NC}"
    if [[ ! -s "${QUEUE_FILE}" ]]; then
        echo -e "  ${YELLOW}(empty — no tasks added yet)${NC}"
    else
        local i=1 status path repo vis msg color
        while IFS='|' read -r status path repo vis msg; do
            [[ -z "${status}" ]] && continue
            color="${YELLOW}"
            [[ "${status}" == "done" ]] && color="${GREEN}"
            printf "  %2d) [%b%-7s%b] %-25s -> %-20s (%s)\n" "${i}" "${color}" "${status}" "${NC}" "$(basename "${path}")" "${repo}" "${vis}"
            i=$((i+1))
        done < "${QUEUE_FILE}"
    fi
    echo -e "${CYAN}------------------------------------------------------------${NC}"
    echo ""
}

queue_remove_task() {
    queue_list_tasks
    if [[ ! -s "${QUEUE_FILE}" ]]; then
        return
    fi
    read -rp "Enter task number to remove (blank to cancel): " num
    [[ -z "${num}" ]] && return
    if ! [[ "${num}" =~ ^[0-9]+$ ]]; then
        print_error "Invalid number."
        return
    fi
    local total
    total="$(wc -l < "${QUEUE_FILE}")"
    if (( num < 1 || num > total )); then
        print_error "Out of range."
        return
    fi
    sed -i "${num}d" "${QUEUE_FILE}"
    print_success "Task ${num} removed from queue."
}

setup_cron_schedule() {
    print_step "S3" "Set Up Daily Automatic Push Time"
    echo -e "${BLUE}What time should the daily push run?${NC} (24-hour format, e.g. 18:00 for 6 PM)"
    read -rp "Time [default 18:00]: " sched_time
    sched_time="${sched_time:-18:00}"

    if ! [[ "${sched_time}" =~ ^([0-1][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
        print_error "Invalid time format. Use HH:MM, e.g. 18:00."
        return
    fi

    local hh mm
    hh="${sched_time%%:*}"
    mm="${sched_time##*:}"
    hh="${hh#0}"
    mm="${mm#0}"

    local script_path
    script_path="$(readlink -f "${BASH_SOURCE[0]}")"

    local cron_line="${mm} ${hh} * * * /bin/bash \"${script_path}\" --run-scheduled >> \"${SCHEDULE_LOG}\" 2>&1 ${CRON_MARKER}"

    ( crontab -l 2>/dev/null | grep -vF "${CRON_MARKER}" ; echo "${cron_line}" ) | crontab -

    if crontab -l 2>/dev/null | grep -qF "${CRON_MARKER}"; then
        print_success "Daily schedule set: every day at ${sched_time}, one pending task will be pushed."
        print_info "Cron uses this system's local time and only runs while the computer is ON."
        print_info "Scheduled-run logs: ${SCHEDULE_LOG}"
    else
        print_error "Failed to install the cron job. Is 'cron'/'crond' installed and running?"
        echo -e "${YELLOW}Fix:${NC} ${GREEN}sudo apt install cron -y && sudo systemctl enable --now cron${NC}"
    fi
}

remove_cron_schedule() {
    if crontab -l 2>/dev/null | grep -qF "${CRON_MARKER}"; then
        ( crontab -l 2>/dev/null | grep -vF "${CRON_MARKER}" ) | crontab -
        print_success "Daily schedule removed. No more automatic pushes will run."
    else
        print_info "No active schedule found."
    fi
}

show_cron_status() {
    echo ""
    if crontab -l 2>/dev/null | grep -qF "${CRON_MARKER}"; then
        echo -e "${GREEN}Schedule is ACTIVE:${NC}"
        crontab -l 2>/dev/null | grep -F "${CRON_MARKER}"
    else
        echo -e "${YELLOW}No schedule is currently active.${NC}"
    fi
    echo ""
}

# Non-interactive push used ONLY by the scheduled cron run. Mirrors the
# manual push flow, but never calls `read` and never exits the whole script
# on a recoverable error (it just marks this one task as failed and moves on
# so tomorrow's run of the NEXT task is not blocked).
run_one_scheduled_task() {
    local path="$1" repo="$2" vis="$3" msg="$4"

    echo "----- $(date '+%Y-%m-%d %H:%M:%S') : starting task '${repo}' -----"

    if [[ ! -d "${path}" ]]; then
        echo "ERROR: folder no longer exists: ${path}. Skipping this task (left as pending)."
        return 1
    fi

    if ! cd "${path}"; then
        echo "ERROR: could not enter ${path}. Skipping (left as pending)."
        return 1
    fi

    [[ -d ".git" ]] || { git init -b main >/dev/null 2>&1 || { git init >/dev/null 2>&1; git checkout -b main >/dev/null 2>&1; }; }

    git add .
    if git diff --cached --quiet; then
        echo "Nothing new to commit for '${repo}'. Will still attempt push of existing commits."
    else
        git commit -m "${msg}" >/tmp/sched_commit.log 2>&1 || echo "Commit step reported: $(cat /tmp/sched_commit.log)"
    fi

    local current_branch
    current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
    [[ "${current_branch}" == "HEAD" || -z "${current_branch}" ]] && current_branch="main"

    local remote_url
    if [[ "${AUTH_METHOD}" == "ssh" ]]; then
        remote_url="git@github.com:${GITHUB_USERNAME}/${repo}.git"
    else
        remote_url="https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${repo}.git"
    fi

    if ! git remote get-url origin >/dev/null 2>&1; then
        git remote add origin "${remote_url}"
    else
        git remote set-url origin "${remote_url}"
    fi

    # Auto-create the remote repo via API if it doesn't exist yet and we have a token.
    if [[ -n "${GITHUB_TOKEN}" ]]; then
        local exists_code
        exists_code="$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: token ${GITHUB_TOKEN}" \
            "https://api.github.com/repos/${GITHUB_USERNAME}/${repo}")"
        if [[ "${exists_code}" == "404" ]]; then
            local priv_flag="false"
            [[ "${vis}" == "private" ]] && priv_flag="true"
            curl -s -o /dev/null -X POST -H "Authorization: token ${GITHUB_TOKEN}" \
                -d "{\"name\":\"${repo}\",\"private\":${priv_flag}}" \
                "https://api.github.com/user/repos"
            echo "Repository '${repo}' did not exist — attempted to create it (${vis})."
        fi
    fi

    local push_output
    push_output="$(git push -u origin "${current_branch}" 2>&1)"
    if [[ $? -eq 0 ]]; then
        echo "SUCCESS: '${repo}' pushed."
        return 0
    else
        echo "FAILED to push '${repo}': ${push_output}"
        return 1
    fi
}

run_scheduled_task() {
    init_config_dir
    echo "===== Scheduled run started: $(date '+%Y-%m-%d %H:%M:%S') ====="

    if ! load_schedule_config; then
        echo "ERROR: no saved credentials found (${CONFIG_FILE}). Run the tool interactively"
        echo "and choose 'Schedule automatic daily push' to set this up first."
        exit 1
    fi

    if [[ ! -s "${QUEUE_FILE}" ]]; then
        echo "No tasks in the queue (${QUEUE_FILE}). Nothing to do today."
        exit 0
    fi

    local line_num=0 found=0
    local status path repo vis msg
    while IFS='|' read -r status path repo vis msg; do
        line_num=$((line_num+1))
        [[ -z "${status}" ]] && continue
        if [[ "${status}" == "pending" ]]; then
            found=1
            if run_one_scheduled_task "${path}" "${repo}" "${vis}" "${msg}"; then
                sed -i "${line_num}s/^pending/done/" "${QUEUE_FILE}"
            else
                echo "Task '${repo}' left as 'pending' — will retry on the next scheduled run."
            fi
            break
        fi
    done < "${QUEUE_FILE}"

    if [[ ${found} -eq 0 ]]; then
        echo "All tasks in the queue are already marked 'done'. Add more tasks if needed."
    fi

    echo "===== Scheduled run finished: $(date '+%Y-%m-%d %H:%M:%S') ====="
}

run_schedule_menu() {
    init_config_dir
    while true; do
        echo ""
        echo -e "${BLUE}${BOLD}Schedule / Task Queue Menu:${NC}"
        echo "  1) Add a task to the queue"
        echo "  2) List all tasks"
        echo "  3) Remove a task from the queue"
        echo "  4) Set up daily automatic push time (installs cron job)"
        echo "  5) Show current schedule status"
        echo "  6) Remove/disable the daily schedule"
        echo "  7) Run one pending task right now (test, without waiting for the schedule)"
        echo "  8) Back to main menu"
        echo ""
        read -rp "Choose 1-8: " sc
        case "${sc}" in
            1) queue_add_task ;;
            2) queue_list_tasks ;;
            3) queue_remove_task ;;
            4)
                get_username
                schedule_setup_credentials
                setup_cron_schedule
                ;;
            5) show_cron_status ;;
            6) remove_cron_schedule ;;
            7) run_scheduled_task ;;
            8) return ;;
            *) print_error "Invalid choice." ;;
        esac
    done
}

###############################################################################
# SECTION 12: MAIN EXECUTION FLOW
###############################################################################

main() {
    if [[ "${1:-}" == "--run-scheduled" ]]; then
        run_scheduled_task
        exit $?
    fi
    print_banner
    show_main_menu
}

main "$@"
