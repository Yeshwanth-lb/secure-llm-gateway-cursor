#!/usr/bin/env node
// ===== ADMIN SEED (Phase U) =================================================
// Create the first admin user for the gateway dashboard. Zero-dep: opens the
// same node:sqlite store and uses the same scrypt hash as the running gateway,
// so there is no schema/format drift.
//
// Usage:
//   ADMIN_USER=admin ADMIN_PASS='…' npm run admin:seed
//   npm run admin:seed            # prompts for username + password (hidden)
//
// The DB path follows the gateway config (GATEWAY_ADMIN_DB or the default
// ~/.secure-llm-gateway/admin.db). Refuses to duplicate an existing username.

import { createInterface } from "node:readline";
import { loadConfig } from "../src/config.ts";
import { openAdminStore } from "../src/admin-store.ts";
import { hashPassword } from "../src/admin-auth.ts";

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (hidden) {
      // Mute echo while typing the password.
      const out = process.stdout;
      const write = out.write.bind(out);
      (rl as any)._writeToOutput = (s: string) => {
        if (s.includes("\n") || s.includes(question)) write(s.includes(question) ? question : "\n");
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = openAdminStore(config.adminDbPath);

  let username = process.env.ADMIN_USER ?? "";
  let password = process.env.ADMIN_PASS ?? "";
  if (!username) username = await ask("admin username: ");
  if (!password) password = await ask("admin password: ", true);

  if (!username || !password) {
    process.stderr.write("error: username and password are required\n");
    process.exit(1);
  }
  if (password.length < 8) {
    process.stderr.write("error: password must be at least 8 characters\n");
    process.exit(1);
  }
  if (store.getUser(username)) {
    process.stderr.write(`error: user "${username}" already exists (${config.adminDbPath})\n`);
    process.exit(1);
  }

  store.createUser(username, hashPassword(password));
  process.stdout.write(`created admin "${username}" in ${config.adminDbPath}\n`);
  process.stdout.write("open the dashboard at http://127.0.0.1:" + config.port + "/admin\n");
  store.close();
}

main().catch((e) => {
  process.stderr.write("seed failed: " + (e as Error).message + "\n");
  process.exit(1);
});
