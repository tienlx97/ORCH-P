#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { LocalLoginError, loginWithLocalAccount } from './lib/browser-login.mjs';
try {
  if (process.argv.length !== 3) throw new Error('usage');
  const result = loginWithLocalAccount(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify(result));
} catch (error) {
  // No raw exception/child output: either may contain local account values.
  console.error(`Browser login blocked [${error instanceof LocalLoginError ? error.code : 'LOGIN_MANIFEST'}]: verify the local login file, dev API and login page. No credentials were logged.`);
  process.exitCode = 1;
}
