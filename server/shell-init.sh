# Nook Console interactive bash initialization (loaded via --rcfile)
# Preserves user's ~/.profile & ~/.bashrc while enabling rich ANSI colors and a clean modern prompt.

if [ -f /etc/profile ]; then
  . /etc/profile
fi
if [ -f "$HOME/.profile" ]; then
  . "$HOME/.profile"
elif [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

# Enable colorized coreutils & CLI tools
export TERM="xterm-256color"
export COLORTERM="truecolor"
export CLICOLOR=1
export GCC_COLORS='error=01;31:warning=01;35:note=01;36:caret=01;32:locus=01:quote=01'

if command -v dircolors >/dev/null 2>&1; then
  eval "$(dircolors -b 2>/dev/null || true)"
fi

alias ls='ls --color=auto'
alias ll='ls --color=auto -lh'
alias la='ls --color=auto -lhA'
alias l='ls --color=auto -CF'
alias grep='grep --color=auto'
alias egrep='egrep --color=auto'
alias fgrep='fgrep --color=auto'
alias diff='diff --color=auto'
alias ip='ip -color=auto'

# Better readline completion colors & UX
bind 'set colored-stats on' 2>/dev/null || true
bind 'set colored-completion-prefix on' 2>/dev/null || true
bind 'set completion-ignore-case on' 2>/dev/null || true
bind 'set show-all-if-ambiguous on' 2>/dev/null || true

__nook_git_segment() {
  local branch dirty
  branch="$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)" || return 0
  if ! git diff --no-ext-diff --quiet 2>/dev/null || ! git diff --cached --no-ext-diff --quiet 2>/dev/null; then
    dirty="*"
  else
    dirty=""
  fi
  printf ' \033[38;5;141m%s\033[38;5;214m%s\033[0m' "$branch" "$dirty"
}

__nook_build_prompt() {
  local last_code=$?
  local c_reset='\[\e[0m\]'
  local c_dim='\[\e[90m\]'
  local c_path='\[\e[1;36m\]'
  local c_ok='\[\e[1;32m\]'
  local c_err='\[\e[1;31m\]'
  local git_part
  git_part="$(__nook_git_segment)"

  local status_part=""
  local arrow="${c_ok}❯${c_reset}"
  if [ "$last_code" -ne 0 ]; then
    status_part=" ${c_err}✘ ${last_code}${c_reset}"
    arrow="${c_err}❯${c_reset}"
  fi

  PS1="${c_dim}\u@\h${c_reset} ${c_path}\w${c_reset}${git_part}${status_part}\n${arrow} "
}

PROMPT_COMMAND="__nook_build_prompt"
