"use strict";
/**
 * Shell discovery + the startup snippets that make a session usable:
 *  - UTF-8 in and out (Vietnamese / Unicode / emoji),
 *  - OSC 9;9 current-directory reporting so the server knows the real cwd
 *    without regex-scraping the prompt.
 *
 * Two platforms, deliberately kept apart. On Windows the snippets are passed as
 * arguments to the shell and never written to disk as .ps1, so PowerShell
 * ExecutionPolicy cannot block a terminal from starting. POSIX shells have no
 * such constraint but also no way to take an init script as an argument, so
 * bash and zsh get a small rc file under the data directory - one that *sources
 * the user's own* startup files first and then adds the hook, rather than
 * replacing them.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDataDir } = require("./config");

const POSIX = process.platform !== "win32";

function firstExisting(list) {
  for (const p of list) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return "";
}

const WIN = process.env.SystemRoot || "C:\\Windows";
const PF = process.env.ProgramFiles || "C:\\Program Files";
const PF86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
const LOCALAPPDATA = process.env.LOCALAPPDATA || "";

const WIN_CANDIDATES = {
  powershell: [
    process.env.POWERSHELL_EXE,
    path.join(WIN, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ],
  pwsh: [
    process.env.PWSH_EXE,
    path.join(PF, "PowerShell", "7", "pwsh.exe"),
    path.join(PF, "PowerShell", "7-preview", "pwsh.exe"),
    LOCALAPPDATA && path.join(LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe"),
  ],
  cmd: [process.env.ComSpec, path.join(WIN, "System32", "cmd.exe")],
  bash: [
    process.env.GIT_BASH_EXE,
    path.join(PF, "Git", "bin", "bash.exe"),
    path.join(PF86, "Git", "bin", "bash.exe"),
  ],
};

/**
 * The login shell first: someone who set $SHELL to /usr/local/bin/bash meant it,
 * and the copy in /bin may be an older one.
 */
const loginShell = (kind) => {
  const sh = String(process.env.SHELL || "");
  return sh && path.basename(sh) === kind ? sh : "";
};

const POSIX_CANDIDATES = {
  bash: [process.env.BASH_EXE, loginShell("bash"), "/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"],
  zsh: [process.env.ZSH_EXE, loginShell("zsh"), "/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"],
  sh: [process.env.SH_EXE, "/bin/sh", "/usr/bin/sh"],
};

const CANDIDATES = POSIX ? POSIX_CANDIDATES : WIN_CANDIDATES;

/* ------------------------------------------------------------------ *
 * Startup snippets
 * ------------------------------------------------------------------ */

// Wrap (not replace) the user's prompt so a customised profile keeps working,
// and report the current directory as OSC 9;9 (the sequence Windows Terminal
// uses) so the server never has to scrape the prompt with a regex.
const PS_PROMPT_HOOK = [
  "$global:__wtInnerPrompt=$function:prompt",
  "function global:prompt{",
  "$p='';try{$p=$ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath}catch{}",
  "if($p){[Console]::Write(([char]27)+']9;9;'+$p+([char]7))}",
  "if($global:__wtInnerPrompt){& $global:__wtInnerPrompt}else{\"PS $p> \"}",
  "}",
];

/**
 * Name the Remote Control session after the tab.
 *
 * Claude Code names a Remote Control session after the hostname plus a random
 * word, which on claude.ai is a wall of near-identical long names with nothing
 * to tell them apart. The tab already carries the name the work is known by -
 * usually the folder - so `claude` typed with no arguments carries it over.
 *
 * Both flags, because they do different jobs and only one of them names
 * anything. Measured on v2.1.268: after `claude --remote-control "<name>"`,
 * /status still reports `Session name: /rename to add a name` - the name went
 * nowhere. With `--name "<name>"` /status reports the name. So
 * --remote-control turns the feature on and --name is what the session is
 * called. Passing the name to both is redundant by a word and correct under
 * either reading, which beats guessing which one the next version keeps.
 *
 * Read from a file, not from an environment variable, because the tab can be
 * renamed and follows the working directory: the environment a shell was
 * spawned with is a snapshot, and the file is current.
 *
 * Only bare `claude` is touched. Any argument at all - `claude -p`,
 * `--resume`, a prompt - runs exactly as typed: those are not sessions to
 * name, and guessing which of them would tolerate an extra flag is how a
 * convenience becomes a trap.
 */
const PS_CLAUDE_WRAPPER = [
  "function global:claude{",
  // -CommandType Application skips this very function, so the lookup cannot
  // find itself; and it resolves .exe, .cmd or a shim through PATHEXT rather
  // than assuming the shape claude happens to have on one machine.
  "$e=(Get-Command claude -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1).Source",
  "if(-not $e){Write-Error 'claude khong co tren PATH';return}",
  "if($args.Count -eq 0 -and $env:WT_TITLE_FILE -and (Test-Path -LiteralPath $env:WT_TITLE_FILE)){",
  "$n='';try{$n=(Get-Content -LiteralPath $env:WT_TITLE_FILE -Raw -Encoding UTF8).Trim()}catch{}",
  "if($n){& $e --remote-control $n --name $n;return}}",
  "& $e @args}",
];

const POSIX_CLAUDE_WRAPPER = `claude() {
  if [ $# -eq 0 ] && [ -n "$WT_TITLE_FILE" ] && [ -f "$WT_TITLE_FILE" ]; then
    __wt_name=$(cat "$WT_TITLE_FILE" 2>/dev/null)
    if [ -n "$__wt_name" ]; then command claude --remote-control "$__wt_name" --name "$__wt_name"; return; fi
  fi
  command claude "$@"
}`;

/**
 * Encoding, measured on this stack (ConPTY + node-pty + xterm):
 *
 * Windows PowerShell 5.1 needs the console output encoding forced to UTF-8 or
 * PSReadLine redraws typed Vietnamese as "?" while you type. UTF8Encoding must
 * be constructed with throwOnInvalidBytes = $false; the ::new($false) overload
 * ends up with an exception fallback.
 *
 * Known upstream limitation that this cannot fix: once 5.1 really is in UTF-8,
 * typing an astral character (an emoji) makes PSReadLine's history writer throw
 * EncoderFallbackException on the surrogate. The command still runs and the
 * session survives, but PSReadLine prints a bug report banner. Vietnamese - the
 * thing this project actually needs - is unaffected, so UTF-8 stays on.
 *
 * PowerShell 7 is UTF-8 natively and has no such bug, so it gets no override
 * and handles Vietnamese and emoji correctly.
 */
const PS5_INIT = [
  "try{[Console]::OutputEncoding=(New-Object System.Text.UTF8Encoding($false,$false))}catch{}",
  "try{$OutputEncoding=(New-Object System.Text.UTF8Encoding($false,$false))}catch{}",
  ...PS_PROMPT_HOOK,
  ...PS_CLAUDE_WRAPPER,
].join("\n");

const PS7_INIT = [...PS_PROMPT_HOOK, ...PS_CLAUDE_WRAPPER].join("\n");

// Kept for tests and for anything that wants to inspect the injected snippet.
const PS_INIT = PS5_INIT;

function encodedPowerShellCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

// $e = ESC, $P = cwd, $G = '>'. "$e" followed by a backslash is the OSC
// string terminator (ESC \), so the sequence is  ESC ]9;9;<cwd> ESC \
const CMD_INIT = "chcp 65001>nul & prompt $e]9;9;$P$e\\$P$G";

/* ------------------------------------------------------------------ *
 * POSIX startup files
 * ------------------------------------------------------------------ */

/**
 * bash reads --rcfile *instead of* ~/.bashrc, so the first thing this does is
 * read it, and the hook is prepended to whatever PROMPT_COMMAND the user's own
 * files ended up with. A terminal that quietly drops your shell configuration
 * is not the same terminal you use everywhere else.
 */
const BASH_INIT = `# Generated by Web Terminal. Safe to delete; it is rewritten on demand.
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
__wt_report_cwd() { printf '\\033]9;9;%s\\007' "$PWD"; }
case "$PROMPT_COMMAND" in
  *__wt_report_cwd*) ;;
  "") PROMPT_COMMAND='__wt_report_cwd' ;;
  *) PROMPT_COMMAND='__wt_report_cwd; '"$PROMPT_COMMAND" ;;
esac
${POSIX_CLAUDE_WRAPPER}
`;

/**
 * zsh has no --rcfile, only ZDOTDIR, which moves *all* of its startup lookups.
 * So this file is what ZDOTDIR points at, and it hands the directory straight
 * back before sourcing the user's real files - otherwise a nested zsh would
 * inherit our directory and lose their configuration too.
 */
const ZSH_INIT = `# Generated by Web Terminal. Safe to delete; it is rewritten on demand.
ZDOTDIR="\${__WT_HOME:-$HOME}"
[ -f "$ZDOTDIR/.zshenv" ] && source "$ZDOTDIR/.zshenv"
[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"
__wt_report_cwd() { printf '\\033]9;9;%s\\007' "$PWD" }
autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __wt_report_cwd
${POSIX_CLAUDE_WRAPPER}
`;

/**
 * Write the rc files and return the directory holding them. Rewritten every
 * time rather than checked: the cost is a few hundred bytes, and the failure
 * mode of a stale hook is a terminal whose directory silently stops updating.
 */
let initDirCache = "";
function posixInitDir() {
  if (initDirCache) return initDirCache;
  const dir = path.join(ensureDataDir(), "shell-init");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bashrc"), BASH_INIT);
  fs.writeFileSync(path.join(dir, ".zshrc"), ZSH_INIT);
  initDirCache = dir;
  return dir;
}

/** Definitions advertised to the UI and consumed by the PTY host. */
const POSIX_PROFILES = {
  bash: {
    label: "Bash",
    icon: "$",
    args: () => ["--rcfile", path.join(posixInitDir(), "bashrc"), "-i"],
    reportsCwd: true,
  },
  zsh: {
    label: "Zsh",
    icon: "%",
    args: () => ["-i"],
    env: () => ({ ZDOTDIR: posixInitDir(), __WT_HOME: os.homedir() }),
    reportsCwd: true,
  },
  /**
   * A POSIX sh has neither PROMPT_COMMAND nor precmd, and its prompt carries no
   * path to scrape, so the working directory cannot be followed. The tab keeps
   * the name it was given. Prefer bash or zsh.
   */
  sh: {
    label: "sh",
    icon: "sh",
    args: () => ["-i"],
    reportsCwd: false,
  },
};

const WIN_PROFILES = {
  powershell: {
    label: "Windows PowerShell",
    icon: "PS",
    args: () => ["-NoLogo", "-NoExit", "-EncodedCommand", encodedPowerShellCommand(PS5_INIT)],
    reportsCwd: true,
  },
  pwsh: {
    label: "PowerShell 7",
    icon: "7",
    args: () => ["-NoLogo", "-NoExit", "-EncodedCommand", encodedPowerShellCommand(PS7_INIT)],
    reportsCwd: true,
  },
  cmd: {
    label: "Command Prompt",
    icon: ">",
    args: () => ["/K", CMD_INIT],
    reportsCwd: true,
  },
  bash: {
    label: "Git Bash",
    icon: "$",
    args: () => ["--login", "-i"],
    reportsCwd: false,
  },
};

const PROFILES = POSIX ? POSIX_PROFILES : WIN_PROFILES;

function resolveExe(kind) {
  return firstExisting(CANDIDATES[kind] || []);
}

function profileArgs(kind) {
  const def = PROFILES[kind];
  if (!def) return [];
  try {
    return def.args();
  } catch {
    return [];
  }
}

/** Extra environment a profile needs; zsh is hooked through ZDOTDIR, not args. */
function profileEnv(kind) {
  const def = PROFILES[kind];
  if (!def || !def.env) return {};
  try {
    return def.env() || {};
  } catch {
    return {};
  }
}

/** Which shells actually exist on this machine. */
function availableProfiles() {
  const out = [];
  for (const [id, def] of Object.entries(PROFILES)) {
    const exe = resolveExe(id);
    if (exe) out.push({ id, label: def.label, icon: def.icon, exe });
  }
  return out;
}

function claudeBin() {
  const explicit = process.env.CLAUDE_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const home = os.homedir();
  const guesses = POSIX
    ? [
        home && path.join(home, ".local", "bin", "claude"),
        "/usr/local/bin/claude",
        "/usr/bin/claude",
      ]
    : [
        process.env.USERPROFILE && path.join(process.env.USERPROFILE, ".local", "bin", "claude.exe"),
        process.env.USERPROFILE && path.join(process.env.USERPROFILE, ".local", "bin", "claude.cmd"),
        LOCALAPPDATA && path.join(LOCALAPPDATA, "Programs", "claude", "claude.exe"),
      ];
  return firstExisting(guesses) || explicit || "claude";
}

/**
 * Ready to be typed at the shell that will run it.
 *
 * PowerShell needs the call operator before a quoted path or it echoes the
 * string back instead of running it. A POSIX shell needs the opposite: "&" is
 * how you background a command, so borrowing PowerShell's form there runs
 * nothing at all.
 */
function claudeCommand() {
  const bin = claudeBin();
  if (POSIX) return /\s/.test(bin) ? `'${bin}'` : bin;
  return /[\\/]/.test(bin) ? `& "${bin}"` : bin;
}

/**
 * Would a shell on this machine find this command? Only used to decide which
 * agent launchers to offer: a button that types a command the machine does not
 * have is a button that prints an error.
 */
function onPath(name) {
  const dirs = String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  const exts = POSIX
    ? [""]
    : String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, name + ext)).isFile()) return true;
      } catch {}
    }
  }
  return false;
}

/**
 * Coding agents other than Claude Code, offered only where installed. Each is
 * typed into a real shell like any other command, so nothing here depends on
 * how the agent works inside.
 */
const AGENT_LAUNCHERS = [
  { id: "codex", commands: ["codex"], label: "New Codex", icon: "CX", title: "Codex" },
  { id: "antigravity", commands: ["agy", "antigravity"], label: "New Antigravity", icon: "AG", title: "Antigravity" },
  { id: "gemini", commands: ["gemini"], label: "New Gemini CLI", icon: "GM", title: "Gemini" },
];

/**
 * Launchers are shell + an initial command typed into the real PTY.
 * Claude Code therefore runs inside ConPTY exactly as if a human typed it.
 */
function launchers() {
  const shells = availableProfiles();
  const mine = POSIX && process.env.SHELL ? path.basename(process.env.SHELL) : "";
  const preferred = POSIX
    ? shells.find((s) => s.id === mine) || shells.find((s) => s.id === "bash") || shells[0]
    : shells.find((s) => s.id === "pwsh") || shells.find((s) => s.id === "powershell") || shells[0];
  const list = shells.map((s) => ({
    id: s.id,
    label: `New ${s.label}`,
    shell: s.id,
    autoRun: "",
    icon: s.icon,
  }));
  if (preferred) {
    list.push({
      id: "claude",
      label: "New Claude Code",
      shell: preferred.id,
      autoRun: claudeCommand(),
      icon: "AI",
      title: "Claude",
    });
    for (const agent of AGENT_LAUNCHERS) {
      const command = agent.commands.find(onPath);
      if (!command) continue;
      list.push({
        id: agent.id,
        label: agent.label,
        shell: preferred.id,
        autoRun: command,
        icon: agent.icon,
        title: agent.title,
      });
    }
    list.push({
      id: "python",
      label: "New Python",
      shell: preferred.id,
      autoRun: "python",
      icon: "PY",
      title: "Python",
    });
    list.push({
      id: "node",
      label: "New Node",
      shell: preferred.id,
      autoRun: "node",
      icon: "JS",
      title: "Node",
    });
  }
  return list;
}

module.exports = {
  PROFILES,
  resolveExe,
  profileArgs,
  profileEnv,
  availableProfiles,
  launchers,
  claudeBin,
  claudeCommand,
  PS_INIT,
  PS5_INIT,
  PS7_INIT,
  CMD_INIT,
  BASH_INIT,
  ZSH_INIT,
};
