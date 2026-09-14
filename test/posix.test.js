"use strict";
/**
 * Linux support for the PTY host.
 *
 * These tests run on whatever machine the suite is run on, which is usually
 * Windows — so they check the two things that can be checked from anywhere:
 * that the Windows behaviour did not move, and that the POSIX startup snippets
 * say what they have to say. The shell hooks themselves are text, and text with
 * a missing quote is a terminal that starts and then reports the wrong
 * directory forever, which is worse than one that refuses to start.
 */
const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const profiles = require("../server/profiles");

const WINDOWS = process.platform === "win32";

test("the Windows profiles did not move", { skip: !WINDOWS }, () => {
  const ids = Object.keys(profiles.PROFILES);
  assert.deepEqual(ids, ["powershell", "pwsh", "cmd", "bash"]);
  assert.equal(profiles.PROFILES.powershell.reportsCwd, true);
  assert.match(profiles.CMD_INIT, /chcp 65001/);
  // -EncodedCommand carries the init, so nothing is written to disk and
  // ExecutionPolicy has nothing to block.
  const args = profiles.profileArgs("powershell");
  assert.ok(args.includes("-EncodedCommand"));
  const decoded = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
  assert.match(decoded, /9;9;/, "the cwd hook is in there");
});

test("the POSIX profiles exist and hook the prompt", { skip: WINDOWS }, () => {
  const ids = Object.keys(profiles.PROFILES);
  assert.deepEqual(ids, ["bash", "zsh", "sh"]);
  assert.equal(profiles.PROFILES.bash.reportsCwd, true);
  assert.equal(profiles.PROFILES.zsh.reportsCwd, true);
  // sh has no PROMPT_COMMAND and no precmd; claiming otherwise would leave the
  // server waiting for a report that can never arrive.
  assert.equal(profiles.PROFILES.sh.reportsCwd, false);

  const bashArgs = profiles.profileArgs("bash");
  assert.equal(bashArgs[0], "--rcfile");
  assert.ok(fs.existsSync(bashArgs[1]), "the rc file is written before it is used");

  const env = profiles.profileEnv("zsh");
  assert.ok(env.ZDOTDIR, "zsh is hooked through ZDOTDIR, not arguments");
  assert.equal(env.__WT_HOME, os.homedir(), "and told where the real home is");
  assert.ok(fs.existsSync(path.join(env.ZDOTDIR, ".zshrc")));
});

test("the shell hooks are valid shell, and emit OSC 9;9", () => {
  // The snippets are strings on every platform, so they can be inspected here
  // whatever we are running on.
  for (const [name, script] of [
    ["bash", profiles.BASH_INIT],
    ["zsh", profiles.ZSH_INIT],
  ]) {
    assert.match(script, /\\033\]9;9;%s\\007/, `${name} must emit OSC 9;9`);
    assert.match(script, /\$PWD/, `${name} must report the working directory`);
  }

  // The user's own configuration has to survive: a terminal that silently drops
  // your .bashrc is not the terminal you use everywhere else.
  assert.match(profiles.BASH_INIT, /\.bashrc/);
  assert.match(profiles.ZSH_INIT, /\.zshrc/);
  // ZDOTDIR is handed back before anything is sourced, or a nested zsh inherits
  // our directory and loses the user's files too.
  assert.match(profiles.ZSH_INIT, /ZDOTDIR="\$\{__WT_HOME:-\$HOME\}"/);
  // Prepended, not replaced: a user who set PROMPT_COMMAND keeps it.
  assert.match(profiles.BASH_INIT, /__wt_report_cwd; '"\$PROMPT_COMMAND"/);

  // And the guard against hooking twice when a shell re-sources its rc.
  assert.match(profiles.BASH_INIT, /\*__wt_report_cwd\*\) ;;/);
});

test("a real bash runs the hook the way it is meant to", () => {
  // Git Bash on Windows is a real bash, so this runs on both platforms. Only a
  // machine with no bash at all skips it.
  const bash = profiles.resolveExe("bash");
  if (!bash) return;

  const file = path.join(os.tmpdir(), `wt-bashrc-check-${process.pid}`).replace(/\\/g, "/");
  fs.writeFileSync(file, profiles.BASH_INIT);
  const run = (script) =>
    execFileSync(bash, ["--norc", "-c", `HOME=/tmp; ${script}`], { encoding: "buffer" });

  try {
    // -n parses without running: a quoting mistake fails here rather than in a
    // terminal that comes up looking fine and reports the wrong folder forever.
    execFileSync(bash, ["-n", file], { stdio: "pipe" });

    // The exact bytes the server's OSC_CWD regex looks for: ESC ] 9 ; 9 ; <cwd> BEL.
    const emitted = run(`source '${file}'; cd /tmp; __wt_report_cwd`);
    assert.equal(emitted.toString("binary"), "]9;9;/tmp");

    const promptOf = (script) => run(script).toString().trim();
    assert.equal(
      promptOf(`PROMPT_COMMAND='echo mine'; source '${file}'; printf %s "$PROMPT_COMMAND"`),
      "__wt_report_cwd; echo mine",
      "a user who set PROMPT_COMMAND keeps it"
    );
    assert.equal(
      promptOf(`source '${file}'; source '${file}'; printf %s "$PROMPT_COMMAND"`),
      "__wt_report_cwd",
      "re-sourcing an rc must not hook twice"
    );
    assert.equal(
      promptOf(`unset PROMPT_COMMAND; source '${file}'; printf %s "$PROMPT_COMMAND"`),
      "__wt_report_cwd"
    );
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("the Claude launcher is written for the shell that will run it", () => {
  const command = profiles.claudeCommand();
  if (WINDOWS) {
    // PowerShell echoes a quoted path back unless the call operator precedes it.
    if (/[\\/]/.test(profiles.claudeBin())) assert.match(command, /^& "/);
  } else {
    // "&" backgrounds a command in a POSIX shell, so PowerShell's form would
    // run nothing at all.
    assert.equal(command.startsWith("&"), false);
    assert.equal(command.includes('"'), false);
  }
});

test("the Linux start script and unit are shipped and sane", () => {
  const root = path.join(__dirname, "..");
  const sh = fs.readFileSync(path.join(root, "scripts/start-remote-host.sh"), "utf8");
  assert.match(sh, /^#!\/usr\/bin\/env bash/, "it has to be runnable");
  assert.equal(sh.includes("\r\n"), false, "CRLF would make the shebang unusable on Linux");
  assert.match(sh, /set -euo pipefail/);
  // node-pty is native; a tree copied from another machine will not run.
  assert.match(sh, /native module/);
  assert.match(sh, /npm ci/);
  // The same rule the PowerShell script learned: never claim success because
  // something answers on the port.
  assert.match(sh, /already in use/);

  const unit = fs.readFileSync(path.join(root, "scripts/web-terminal-host.service"), "utf8");
  assert.equal(unit.includes("\r\n"), false, "systemd will not parse CRLF");
  assert.match(unit, /User=CHANGE_ME/, "it must not default to running as anyone real");
  assert.equal(/^User=root$/m.test(unit), false, "a root PTY host hands out root shells");
});

test("blocked directories follow the platform", () => {
  const { config } = require("../server/config");
  if (WINDOWS) {
    assert.ok(config.blockedDirs.some((d) => /Windows$/i.test(d)));
  } else {
    for (const d of ["/proc", "/sys", "/dev"]) {
      assert.ok(config.blockedDirs.includes(d), `${d} should not be a place to start a shell`);
    }
    assert.equal(config.blockedDirs.includes("/etc"), false, "this is about accidents, not containment");
  }
});
