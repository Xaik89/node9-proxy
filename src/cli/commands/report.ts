// src/cli/commands/report.ts
// Registered as `node9 report` by cli.ts.
// Reads ~/.node9/audit.log and renders a summary dashboard for a chosen period.

import type { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Period = 'today' | '7d' | '30d' | 'month';

interface AuditEntry {
  ts: string;
  tool: string;
  decision: string;
  checkedBy?: string;
  agent?: string;
  source?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDateRange(period: Period): { start: Date; end: Date } {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  switch (period) {
    case 'today':
      return { start: todayStart, end };
    case '7d': {
      const s = new Date(todayStart);
      s.setDate(s.getDate() - 6);
      return { start: s, end };
    }
    case '30d': {
      const s = new Date(todayStart);
      s.setDate(s.getDate() - 29);
      return { start: s, end };
    }
    case 'month':
      return { start: new Date(now.getFullYear(), now.getMonth(), 1), end };
  }
}

function parseAuditLog(logPath: string): AuditEntry[] {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf-8');
  return raw.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as AuditEntry];
    } catch {
      return [];
    }
  });
}

function isAllow(decision: string): boolean {
  return decision.startsWith('allow');
}

function isDlp(checkedBy: string | undefined): boolean {
  return !!checkedBy?.includes('dlp');
}

/** Plain bar string — no chalk so padEnd works on the raw string. */
function barStr(value: number, max: number, width: number): string {
  if (max === 0 || width <= 0) return '░'.repeat(width);
  const filled = Math.max(1, Math.round((value / max) * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function colorBar(value: number, max: number, width: number): string {
  const s = barStr(value, max, width);
  const filled = Math.max(1, Math.round(max > 0 ? (value / max) * width : 0));
  return chalk.cyan(s.slice(0, filled)) + chalk.dim(s.slice(filled));
}

function pct(num: number, total: number): string {
  if (total === 0) return '–';
  return Math.round((num / total) * 100) + '%';
}

function fmtDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d + 'T12:00:00') : d;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function num(n: number): string {
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description('Activity and security report — what Claude did, what was blocked')
    .option('--period <period>', 'today | 7d | 30d | month', '7d')
    .action((options: { period: string }) => {
      const period: Period = (['today', '7d', '30d', 'month'] as const).includes(
        options.period as Period
      )
        ? (options.period as Period)
        : '7d';

      const logPath = path.join(os.homedir(), '.node9', 'audit.log');
      const allEntries = parseAuditLog(logPath);

      if (allEntries.length === 0) {
        console.log(
          chalk.yellow('\n  No audit data found. Run node9 with Claude Code to generate entries.\n')
        );
        return;
      }

      const { start, end } = getDateRange(period);

      // Only count PreToolUse entries (skip PostToolUse source: post-hook duplicates)
      const entries = allEntries.filter((e) => {
        if (e.source === 'post-hook') return false;
        const ts = new Date(e.ts);
        return ts >= start && ts <= end;
      });

      if (entries.length === 0) {
        console.log(chalk.yellow(`\n  No activity for period "${period}".\n`));
        return;
      }

      // --- Aggregate ---
      let allowed = 0;
      let blocked = 0;
      let dlpHits = 0;
      const toolMap = new Map<string, { calls: number; blocked: number }>();
      const blockMap = new Map<string, number>();
      const agentMap = new Map<string, number>();
      const dailyMap = new Map<string, { calls: number; blocked: number }>();

      for (const e of entries) {
        const allow = isAllow(e.decision);
        const dateKey = e.ts.slice(0, 10); // YYYY-MM-DD

        if (allow) allowed++;
        else blocked++;
        if (isDlp(e.checkedBy)) dlpHits++;

        const t = toolMap.get(e.tool) ?? { calls: 0, blocked: 0 };
        t.calls++;
        if (!allow) t.blocked++;
        toolMap.set(e.tool, t);

        if (!allow && e.checkedBy) {
          blockMap.set(e.checkedBy, (blockMap.get(e.checkedBy) ?? 0) + 1);
        }

        if (e.agent) agentMap.set(e.agent, (agentMap.get(e.agent) ?? 0) + 1);

        const d = dailyMap.get(dateKey) ?? { calls: 0, blocked: 0 };
        d.calls++;
        if (!allow) d.blocked++;
        dailyMap.set(dateKey, d);
      }

      const total = entries.length;
      const topTools = [...toolMap.entries()]
        .sort((a, b) => b[1].calls - a[1].calls)
        .slice(0, 8);
      const topBlocks = [...blockMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      const dailyList = [...dailyMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-14);

      const maxTool = Math.max(...topTools.map(([, v]) => v.calls), 1);
      const maxBlock = Math.max(...topBlocks.map(([, v]) => v), 1);
      const maxDaily = Math.max(...dailyList.map(([, v]) => v.calls), 1);

      // --- Layout ---
      const W = Math.min(process.stdout.columns || 80, 100);
      const INNER = W - 4; // 2 chars indent each side
      const COL = Math.floor(INNER / 2) - 1;
      const LABEL = 24;
      const BAR = Math.max(6, Math.min(14, COL - LABEL - 8));

      const line = chalk.dim('─'.repeat(W - 2));

      // ── Header ──
      const periodLabel: Record<Period, string> = {
        today: 'Today',
        '7d': 'Last 7 Days',
        '30d': 'Last 30 Days',
        month: 'This Month',
      };
      console.log('');
      console.log(
        '  ' +
          chalk.bold.cyan('🛡 node9 Report') +
          chalk.dim('  ·  ') +
          chalk.white(periodLabel[period]) +
          chalk.dim(`  ${fmtDate(start)} – ${fmtDate(end)}`) +
          chalk.dim(`  ${num(total)} events`)
      );
      console.log('  ' + line);

      // ── Overview ──
      console.log('');
      const blockLabel =
        blocked > 0 ? chalk.red(`🛑 ${num(blocked)} blocked`) : chalk.dim('🛑 0 blocked');
      const dlpLabel =
        dlpHits > 0 ? chalk.yellow(`🚨 ${dlpHits} DLP hits`) : chalk.dim('🚨 0 DLP hits');
      console.log(
        '  ' +
          chalk.green(`✅ ${num(allowed)} allowed`) +
          '   ' +
          blockLabel +
          '   ' +
          dlpLabel +
          '   ' +
          chalk.dim(`${pct(blocked, total)} block rate`)
      );
      console.log('');

      // ── Top Tools | Top Blocks ──
      const toolHeader = chalk.bold('Top Tools');
      const blockHeader = chalk.bold('Top Blocks');
      // Fixed-width column headers (no chalk on the spacer)
      console.log('  ' + toolHeader.padEnd(COL + 10) + '  ' + blockHeader);
      console.log('  ' + chalk.dim('─'.repeat(COL)) + '  ' + chalk.dim('─'.repeat(COL)));

      const rows = Math.max(topTools.length, topBlocks.length, 1);
      for (let i = 0; i < rows; i++) {
        // Left: tool
        let leftRaw = ' '.repeat(COL);
        let leftStyled = ' '.repeat(COL);
        if (i < topTools.length) {
          const [tool, { calls, blocked: tb }] = topTools[i];
          const label = tool.length > LABEL - 1 ? tool.slice(0, LABEL - 2) + '…' : tool;
          const b = colorBar(calls, maxTool, BAR);
          const count = chalk.white(num(calls));
          const note = tb > 0 ? chalk.red(` ${tb}✗`) : '';
          leftRaw = label.padEnd(LABEL) + barStr(calls, maxTool, BAR) + ' ' + num(calls);
          leftStyled = chalk.white(label.padEnd(LABEL)) + b + ' ' + count + note;
          // Pad to column width using raw length
          const pad = Math.max(0, COL - leftRaw.length);
          leftStyled += ' '.repeat(pad);
        }

        // Right: block reason
        let rightStyled = '';
        if (i < topBlocks.length) {
          const [reason, count] = topBlocks[i];
          const label = reason.length > LABEL - 1 ? reason.slice(0, LABEL - 2) + '…' : reason;
          const b = colorBar(count, maxBlock, BAR);
          rightStyled = chalk.white(label.padEnd(LABEL)) + b + ' ' + chalk.red(num(count));
        }

        console.log('  ' + leftStyled + '  ' + rightStyled);
      }

      if (topBlocks.length === 0) {
        // overwrite the last line with a "nothing blocked" note in the right col
        // (already handled by rows loop printing empty right side)
        console.log('  ' + ' '.repeat(COL) + '  ' + chalk.dim('nothing blocked ✓'));
      }

      // ── Agent breakdown (if more than one agent) ──
      if (agentMap.size > 1) {
        console.log('');
        console.log('  ' + chalk.bold('Agents'));
        console.log('  ' + chalk.dim('─'.repeat(Math.min(50, W - 4))));
        const maxAgent = Math.max(...agentMap.values(), 1);
        for (const [agent, count] of [...agentMap.entries()].sort((a, b) => b[1] - a[1])) {
          const label = agent.slice(0, LABEL - 1);
          const b = colorBar(count, maxAgent, BAR);
          console.log(
            '  ' + chalk.white(label.padEnd(LABEL)) + b + ' ' + chalk.white(num(count))
          );
        }
      }

      // ── Daily Activity ──
      if (dailyList.length > 1) {
        console.log('');
        console.log('  ' + chalk.bold('Daily Activity'));
        console.log('  ' + chalk.dim('─'.repeat(W - 2)));
        const DAY_BAR = Math.max(8, Math.min(30, W - 30));
        for (const [dateKey, { calls, blocked: db }] of dailyList) {
          const label = fmtDate(dateKey).padEnd(10);
          const b = colorBar(calls, maxDaily, DAY_BAR);
          const note = db > 0 ? chalk.red(`  ${db} blocked`) : '';
          console.log(
            '  ' + chalk.dim(label) + '  ' + b + '  ' + chalk.white(num(calls)) + note
          );
        }
      }

      // ── Footer ──
      console.log('');
      console.log(
        '  ' +
          chalk.dim('node9 audit --deny') +
          chalk.dim('  ·  ') +
          chalk.dim('node9 report --period today|7d|30d|month')
      );
      console.log('');
    });
}
