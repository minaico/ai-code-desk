#!/usr/bin/env node
"use strict";
/**
 * Account management from the command line.
 *
 * The UI can do all of this too, but not before the first account exists, and
 * not if the last admin locks themselves out. This is the way back in, and it
 * requires being able to write .data/users.json — that is, being on the machine.
 *
 *   node scripts/user.js list
 *   node scripts/user.js add lan.pt --admin            (prints a temp password)
 *   node scripts/user.js add an.nv --password "..."
 *   node scripts/user.js passwd lan.pt                 (prints a temp password)
 *   node scripts/user.js role lan.pt admin|user
 *   node scripts/user.js remove an.nv
 *
 * A password set here always lands with "must change on next login": a password
 * someone else chose is not yet a password.
 */
const { config, ensureDataDir } = require("../server/config");
const { Users } = require("../server/users");

function tempPassword() {
  const crypto = require("crypto");
  const letters = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const pick = (s) => s[crypto.randomInt(s.length)];
  const word = () => Array.from({ length: 4 }, () => pick(letters)).join("");
  return `${word()}-${word()}-${pick(digits)}${pick(digits)}${pick(digits)}`;
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  return args[i + 1] || "";
}

function main() {
  ensureDataDir();
  const users = new Users(config.dataDir, console);
  const [cmd, name, ...rest] = process.argv.slice(2);
  const args = [name, ...rest].filter((x) => x !== undefined);

  switch (cmd) {
    case "list": {
      const all = users.list();
      if (!all.length) {
        console.log("Chưa có tài khoản nào — server vẫn đang dùng mật khẩu chung.");
        return;
      }
      for (const u of all) {
        const bits = [u.role];
        if (u.mustChange) bits.push("phải đổi mật khẩu");
        bits.push(u.lastLoginAt ? `đăng nhập ${u.lastLoginAt}` : "chưa đăng nhập");
        console.log(`  ${u.name.padEnd(20)} ${bits.join(" · ")}`);
      }
      return;
    }

    case "add": {
      if (!name) throw new Error("Thiếu tên đăng nhập");
      const given = flag(args, "--password");
      const password = given || tempPassword();
      const u = users.create({
        name,
        password,
        role: args.includes("--admin") ? "admin" : "user",
        mustChange: true,
      });
      console.log(`Đã tạo ${u.name} (${u.role}).`);
      if (!given) console.log(`Mật khẩu tạm: ${password}`);
      console.log("Người dùng phải đổi mật khẩu ở lần đăng nhập đầu tiên.");
      return;
    }

    case "passwd": {
      if (!name) throw new Error("Thiếu tên đăng nhập");
      const given = flag(args, "--password");
      const password = given || tempPassword();
      users.setPassword(name, password, { mustChange: true });
      console.log(`Đã đặt lại mật khẩu cho ${name}.`);
      if (!given) console.log(`Mật khẩu tạm: ${password}`);
      return;
    }

    case "role": {
      const role = rest[0];
      if (!name || !role) throw new Error("Dùng: role <tên> <admin|user>");
      const u = users.setRole(name, role);
      console.log(`${u.name} -> ${u.role}`);
      return;
    }

    case "remove": {
      if (!name) throw new Error("Thiếu tên đăng nhập");
      console.log(`Đã xoá ${users.remove(name)}.`);
      return;
    }

    default:
      console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0].split("/**")[1].trim());
      process.exitCode = cmd ? 1 : 0;
  }
}

try {
  main();
} catch (err) {
  console.error("Lỗi: " + err.message);
  process.exitCode = 1;
}
