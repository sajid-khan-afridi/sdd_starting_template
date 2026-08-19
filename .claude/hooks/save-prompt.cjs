#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit hook: archives every prompt submitted in this repo.
 *
 * One file per SESSION, at docs/prompts/<sequence>-<session-slug>-<date>.md.
 * Every prompt submitted in that session is appended to the same file, in
 * order. Slash commands (/clear, /code-review high, ...) are not archived,
 * except ARCHIVED_SLASH_COMMANDS below, which kick off a recorded interview
 * (see save-question.cjs, which appends the AskUserQuestion Q&A from that
 * interview to this same file).
 *
 * Reads the hook payload as JSON on stdin. Prints nothing: stdout from a
 * UserPromptSubmit hook is injected into Claude's context, and this hook is
 * meant to be invisible. Never throws - a logging failure must not block a
 * prompt from being submitted.
 */

const fs = require('fs');
const path = require('path');
const log = require('./lib/prompt-log.cjs');

/**
 * A slash command (/clear, /code-review high, /loop 5m /foo) - a command to
 * the harness rather than a prompt worth archiving. The trailing (\s|$) keeps
 * absolute paths out of this: "/usr/bin/node crashes" has a slash where the
 * separator must be, so it is treated as prose and saved.
 */
const SLASH_COMMAND_RE = /^\/([A-Za-z0-9_:-]+)(\s|$)/;

/** Slash commands worth archiving anyway, because they start a recorded interview. */
const ARCHIVED_SLASH_COMMANDS = new Set(['spec']);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Leads with a blank line and ends with a single newline (no trailing blank
 * line), so consecutive appends always separate cleanly regardless of how
 * the previous write ended - including a legacy file from an older version
 * of this script that has no trailing blank line of its own.
 */
function promptBlock({ promptNumber, time, prompt }) {
  return ['', `## Prompt ${promptNumber} - ${time}`, '', prompt.replace(/\r\n/g, '\n').trimEnd(), ''].join('\n');
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return;
  }

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const trimmed = prompt.trim();
  if (!trimmed) return;

  const slashMatch = SLASH_COMMAND_RE.exec(trimmed);
  if (slashMatch && !ARCHIVED_SLASH_COMMANDS.has(slashMatch[1].toLowerCase())) return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const promptsDir = log.promptsDirFor(projectDir);
  fs.mkdirSync(promptsDir, { recursive: true });

  const sessionId = input.session_id || 'unknown-session';
  const statePath = log.statePathFor(projectDir);
  const state = log.loadState(statePath);
  const when = new Date();

  const session = log.getSession(state, sessionId, promptsDir, when, prompt);
  const filePath = log.filePathFor(promptsDir, session);
  session.promptCount += 1;

  log.ensureFile(filePath, {
    sequence: session.sequence,
    slug: session.slug,
    sessionId,
    date: session.date,
    cwd: input.cwd || projectDir,
  });

  fs.appendFileSync(
    filePath,
    promptBlock({ promptNumber: session.promptCount, time: log.localTime(when), prompt }),
    'utf8'
  );

  log.saveState(statePath, state);
}

try {
  main();
} catch {
  // Never block a prompt because logging failed.
}
