# GitHub Auto Push Tool 🚀

A beginner-friendly **GitHub automation tool written in Bash** that automates the complete Git workflow:

```
Local Project
      |
      ↓
Git Initialization
      |
      ↓
Add Files
      |
      ↓
Commit Changes
      |
      ↓
Configure Remote
      |
      ↓
Push to GitHub
```

The tool removes repetitive Git commands and provides a guided workflow for developers, DevOps learners, and Linux users.

It supports both **new and existing Git repositories** and provides detailed explanations for common Git/GitHub errors.

---

# Features

## GitHub Push Automation

Automatically performs:

- Git repository initialization
- File staging
- Commit creation
- Remote configuration
- Branch detection
- GitHub push


No need to manually run:

```bash
git init
git add .
git commit
git remote add
git push
```

---

# Environment Validation

Before pushing, the tool checks:

- Git installation
- Internet connectivity
- GitHub availability
- Git username configuration
- Git email configuration
- Git credential helper
- SSH client
- SSH agent
- SSH keys
- GitHub SSH authentication
- Default Git branch
- Git version
- GitHub CLI availability


This helps beginners identify configuration problems before pushing.

---

# Authentication Support

Supports multiple GitHub authentication methods:

## HTTPS Authentication

Using:

- GitHub Personal Access Token (PAT)

Example:

```
https://github.com/username/repository.git
```

---

## SSH Authentication

Using:

- SSH keys
- ssh-agent


Example:

```
git@github.com:username/repository.git
```

---

## GitHub CLI Authentication

Supports:

```bash
gh auth login
```

when GitHub CLI is installed.

---

# Repository Support

Supports:

- Public repositories
- Private repositories


The tool can:

- Check repository existence
- Create repository using GitHub CLI
- Configure remote automatically


---

# Smart Project Selection

The tool detects project folders and helps select the correct directory.

Example:

```
Projects/

├── docker-project
├── python-project
└── terraform-project
```

User can choose which project to push.

---

# Nested Git Repository Detection

Detects accidental nested repositories.

Example:

```
project/

├── .git
│
└── another-project/
        └── .git
```


The tool can fix nested repositories by removing inner `.git` folders and tracking them as normal files.

---

# Git Error Explanation System

The tool provides beginner-friendly explanations for common Git errors.

Supported errors:

- Repository not found
- Authentication failed
- Permission denied (publickey)
- Permission denied
- Non-fast-forward rejection
- Push rejected
- No commits found
- Remote already exists
- Not a Git repository
- Detached HEAD
- Private repository access issues


Each error includes:

- Reason
- Explanation
- Fix suggestion

---

# Automatic Merge Conflict Handling

When local and GitHub repositories have different histories, the tool can automatically handle:

- Pull remote changes
- Merge histories
- Detect conflicts
- Resolve conflicts using user choice


Conflict options:

```
1) Keep local version

2) Keep GitHub version

3) Cancel and resolve manually
```

---

# Repository Management

The tool also provides GitHub repository management.

Features:

- List repositories
- View public/private repositories
- Select repositories
- Backup repositories
- Delete repositories safely


Deletion workflow:

```
Select Repository

        ↓

Show Delete Plan

        ↓

Create Local Backup

        ↓

Final Confirmation

        ↓

Delete Repository
```

---

# Repository Backup System

Before deleting repositories, the tool can create local backups.

Backup uses:

```bash
git clone
```


Example:

```
github_backups/

└── 2026-07-26_18-00-00/

        ├── project-one
        └── project-two
```

---

# Automatic Daily Push Scheduler

The tool includes a task queue and cron-based scheduler.

You can add multiple projects:

Example:

```
pending|docker-project|docker-projects
pending|python-app|python-project
pending|terraform|infra-project
```

The scheduler pushes one pending task automatically every day.

Example:

```
Every day at 6 PM
```

---

# Scheduler Features

Available options:

- Add push task
- View task queue
- Remove task
- Setup daily schedule
- Check schedule status
- Remove schedule
- Run scheduled task manually


---

# Logging System

The tool maintains logs for troubleshooting.

Main log:

```
github_push.log
```


Scheduled execution log:

```
~/.github_auto_push/scheduled_runs.log
```

---

# Installation

Clone the repository:

```bash
git clone <repository-url>
```

Move into directory:

```bash
cd github-auto-push-tool
```

Make script executable:

```bash
chmod +x github_auto_push.sh
```

Run:

```bash
./github_auto_push.sh
```

---

# Requirements

Required:

- Bash
- Git
- Curl

Optional:

- GitHub CLI (`gh`)
- SSH client
- Python3 (for repository parsing)
- Cron (for scheduler)


---

# Tested On

Linux distributions:

- Ubuntu
- Zorin OS
- Debian-based Linux distributions


---

# Usage

Start the tool:

```bash
./github_auto_push.sh
```

Main menu:

```
1) Push a local project to GitHub

2) Manage / Delete GitHub repositories

3) Schedule automatic daily push

4) Exit
```

---

# Example Workflow

## Push Project

```
Choose:
1) Push project

Enter GitHub username

Enter repository name

Select authentication

Select project folder

Enter commit message

Tool pushes project
```

---

## Delete Repository Safely

```
Choose:
2) Repository Management

Select repositories

Create backup

Confirm DELETE

Repository removed
```

---

## Automatic Daily Push

```
Choose:
3) Schedule

Add project

Set time

Cron job created

Automatic push starts
```

---

# Project Structure

Example:

```
github-auto-push-tool/

├── github_auto_push.sh
├── github_push.log
└── README.md
```

---

# Security Notes

- GitHub passwords are not supported for Git operations.
- Use Personal Access Tokens for HTTPS authentication.
- Keep tokens private.
- Scheduled automation stores credentials with restricted permissions.


---

# License

This project is licensed under the MIT License.

---

# Author

**Anuj Kumar Jha**

Aspiring DevOps Engineer | Linux | Bash Scripting | Git & GitHub
