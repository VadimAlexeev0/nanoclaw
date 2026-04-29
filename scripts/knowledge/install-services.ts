import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getSystemdUnit } from '../../src/install-slug.js';

const root = process.cwd();
const home = os.homedir();
const unitDir = path.join(home, '.config', 'systemd', 'user');
const vault = process.env.NANOCLAW_OBSIDIAN_VAULT || '/srv/obsidian';
const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
const nanoclawUnit = `${getSystemdUnit(root)}.service`;

fs.mkdirSync(unitDir, { recursive: true });

write('nanoclaw-obsidian-sync.service', `[Unit]
Description=NanoClaw Obsidian Headless Sync
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${vault}
ExecStart=/usr/bin/ob sync --path ${vault} --continuous
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`);

write('nanoclaw-knowledge-watch.service', `[Unit]
Description=NanoClaw Knowledge Inbox Watcher
After=${nanoclawUnit} nanoclaw-obsidian-sync.service

[Service]
Type=simple
WorkingDirectory=${root}
Environment=NANOCLAW_OBSIDIAN_VAULT=${vault}
ExecStart=${tsx} ${root}/scripts/knowledge/watch-inbox.ts
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`);

write('nanoclaw-knowledge-backup.service', `[Unit]
Description=NanoClaw Knowledge Backup

[Service]
Type=oneshot
WorkingDirectory=${root}
Environment=NANOCLAW_OBSIDIAN_VAULT=${vault}
ExecStart=${root}/scripts/knowledge/backup.sh
`);

write('nanoclaw-knowledge-backup.timer', `[Unit]
Description=Daily NanoClaw Knowledge Backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
`);

execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
execSync('systemctl --user enable --now nanoclaw-obsidian-sync.service', { stdio: 'inherit' });
execSync('systemctl --user enable --now nanoclaw-knowledge-watch.service', { stdio: 'inherit' });
execSync('systemctl --user enable --now nanoclaw-knowledge-backup.timer', { stdio: 'inherit' });

console.log('Installed knowledge systemd user services.');

function write(name: string, content: string): void {
  const file = path.join(unitDir, name);
  fs.writeFileSync(file, content);
  console.log(file);
}
