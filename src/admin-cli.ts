#!/usr/bin/env node

import { adminHelp, parseAdminCommand, runAdminCommand } from "./admin/cli.js";

try {
  await runAdminCommand(parseAdminCommand(process.argv.slice(2)));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  console.error(`\n${adminHelp()}`);
  process.exitCode = 1;
}
