#!/usr/bin/env node
"use strict";
/**
 * Prints a scrypt hash for WEB_TERMINAL_PASSWORD_HASH so the plaintext password
 * never has to be stored in the registry or a script.
 *
 *   node scripts/hash-password.js "MyStrongPassword"
 *   node scripts/hash-password.js            (prompts, input hidden)
 */
const readline = require("readline");
const { hashPassword } = require("../server/auth");

function fromArgs() {
  const arg = process.argv.slice(2).join(" ").trim();
  return arg || null;
}

function prompt() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hide the typed characters.
    const write = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl._writeToOutput = function (s) {
      if (/\r?\n/.test(s)) return write ? write(s) : undefined;
      rl.output.write("*");
    };
    rl.question("Password: ", (answer) => {
      rl.output.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

(async () => {
  const password = fromArgs() || (await prompt());
  if (!password || password.length < 8) {
    console.error("Refusing: use at least 8 characters.");
    process.exit(1);
  }
  const hash = hashPassword(password);
  if (process.stdout.isTTY) {
    console.log("");
    console.log("WEB_TERMINAL_PASSWORD_HASH:");
    console.log(hash);
    console.log("");
    console.log("Store it machine-wide:");
    console.log(`  [Environment]::SetEnvironmentVariable("WEB_TERMINAL_PASSWORD_HASH","${hash}","Machine")`);
    console.log("");
    console.log("Then remove any WEB_TERMINAL_PASSWORD plaintext variable.");
  } else {
    process.stdout.write(hash);
  }
})();
