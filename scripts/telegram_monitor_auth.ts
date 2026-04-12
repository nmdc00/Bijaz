/**
 * One-time Telegram user auth for the channel monitor.
 *
 * Run once: pnpm exec tsx scripts/telegram_monitor_auth.ts
 *
 * You will be prompted for:
 *   - API ID   (from https://my.telegram.org → API development tools)
 *   - API hash (same page)
 *   - Phone number (E.164 format, e.g. +44...)
 *   - The verification code Telegram sends to your phone
 *
 * On success, prints the session string.
 * Copy it into config/default.yaml → channels.telegram.monitor.sessionString
 * (or set TELEGRAM_MONITOR_SESSION env var).
 *
 * You only need to run this once.  The session stays valid indefinitely
 * unless you explicitly sign out of Telegram from that session.
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const rl = readline.createInterface({ input, output });

async function prompt(question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

async function main(): Promise<void> {
  console.log('\n=== Thufir Telegram Channel Monitor — One-time Auth ===\n');
  console.log('Get your API credentials at https://my.telegram.org → API development tools\n');

  const apiIdStr = await prompt('API ID (number): ');
  const apiId = parseInt(apiIdStr, 10);
  if (!apiId || isNaN(apiId)) {
    console.error('Invalid API ID');
    process.exit(1);
  }

  const apiHash = await prompt('API hash: ');
  if (!apiHash) {
    console.error('API hash is required');
    process.exit(1);
  }

  const phone = await prompt('Phone number (E.164, e.g. +44...): ');
  if (!phone.startsWith('+')) {
    console.error('Phone must be in E.164 format (e.g. +447...)');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
  });

  let sentCode = false;

  await client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => {
      if (!sentCode) {
        sentCode = true;
        console.log('\nTelegram sent a code to your phone / Telegram app.');
      }
      return prompt('Enter the code: ');
    },
    password: async () => prompt('2FA password (leave blank if none): '),
    onError: (err) => {
      console.error('Auth error:', err.message);
    },
  });

  const sessionString = client.session.save() as unknown as string;
  await client.disconnect();
  rl.close();

  console.log('\n✅ Authenticated successfully!\n');
  console.log('Session string (copy into config):');
  console.log('─'.repeat(60));
  console.log(sessionString);
  console.log('─'.repeat(60));
  console.log('\nAdd to config/default.yaml:');
  console.log('  channels:');
  console.log('    telegram:');
  console.log('      monitor:');
  console.log('        sessionString: "' + sessionString.slice(0, 20) + '..."  # full string above');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
