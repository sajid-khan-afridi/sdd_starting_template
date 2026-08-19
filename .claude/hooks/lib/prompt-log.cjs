#!/usr/bin/env node
'use strict';

/**
 * Shared session/file bookkeeping for the prompt-archiving hooks
 * (save-prompt.cjs and save-question.cjs). Both hooks append to the same
 * per-session file at docs/prompts/<sequence>-<session-slug>-<date>.md,
 * tracked via .claude/prompt-log-state.json, so the session/slug/sequence
 * logic lives here once instead of drifting between the two scripts.
 */

const fs = require('fs');
const path = require('path');

const MAX_SLUG_WORDS = 5;
const MAX_SLUG_CHARS = 60;
const MAX_TRACKED_SESSIONS = 200;
const SEQUENCE_RE = /^(\d+)-.*\.md$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** First few words of some text, as a filename-safe slug. */
function slugify(text) {
  const words = String(text)
    .replace(/```[\s\S]*?```/g, ' ') // fenced code says nothing about the topic
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SLUG_WORDS);

  const slug = words
    .join('-')
    .toLowerCase()
    .slice(0, MAX_SLUG_CHARS)
    .replace(/^-+|-+$/g, '');

  return slug || 'session';
}

function promptsDirFor(projectDir) {
  return path.join(projectDir, 'docs', 'prompts');
}

function statePathFor(projectDir) {
  return path.join(projectDir, '.claude', 'prompt-log-state.json');
}

function loadState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.sessions) return parsed;
  } catch {
    // no state yet, or it is unreadable - start fresh
  }
  return { sessions: {} };
}

function saveState(statePath, state) {
  const ids = Object.keys(state.sessions);
  if (ids.length > MAX_TRACKED_SESSIONS) {
    ids
      .sort((a, b) => String(state.sessions[a].started).localeCompare(String(state.sessions[b].started)))
      .slice(0, ids.length - MAX_TRACKED_SESSIONS)
      .forEach((id) => delete state.sessions[id]);
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

/** Highest session number already used in docs/prompts, plus one. */
function nextSequence(promptsDir) {
  let highest = 0;
  for (const name of fs.readdirSync(promptsDir)) {
    const match = SEQUENCE_RE.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/** The prompts file already on disk for this slug, if a previous script version made one. */
function findExistingFile(promptsDir, slug) {
  const re = new RegExp(`^(\\d+)-${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{4}-\\d{2}-\\d{2})\\.md$`);
  for (const name of fs.readdirSync(promptsDir)) {
    const match = re.exec(name);
    if (match) return { name, sequence: Number(match[1]), date: match[2] };
  }
  return null;
}

function countExistingPrompts(filePath) {
  try {
    const headings = fs.readFileSync(filePath, 'utf8').match(/^#{1,2} Prompt \d+/gm);
    return headings ? headings.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Fills in sequence/date/promptCount on a session entry left by a prior
 * version of this script (which only stored slug + started). Reattaches to
 * that session's existing file when one is found, instead of starting a new
 * one and losing continuity.
 */
function backfillSession(session, promptsDir, when) {
  const existing = findExistingFile(promptsDir, session.slug);
  session.sequence = existing ? existing.sequence : nextSequence(promptsDir);
  session.date = existing ? existing.date : localDate(when);
  session.promptCount = existing ? countExistingPrompts(path.join(promptsDir, existing.name)) : 0;
}

/**
 * Gets this session's bookkeeping entry from state, creating or backfilling
 * it as needed. `seedText` seeds the slug the first time this session is
 * seen (e.g. the prompt text, or a question's text when a question is the
 * first thing archived for this session). Mutates and returns `state`;
 * caller is responsible for calling saveState afterwards.
 */
function getSession(state, sessionId, promptsDir, when, seedText) {
  let session = state.sessions[sessionId];
  if (!session) {
    session = {
      slug: slugify(seedText),
      sequence: nextSequence(promptsDir),
      date: localDate(when),
      promptCount: 0,
      questionCount: 0,
      started: when.toISOString(),
    };
    state.sessions[sessionId] = session;
  } else if (session.sequence === undefined || session.date === undefined || session.promptCount === undefined) {
    backfillSession(session, promptsDir, when);
  }
  if (session.questionCount === undefined) session.questionCount = 0;
  return session;
}

function filePathFor(promptsDir, session) {
  return path.join(promptsDir, `${session.sequence}-${session.slug}-${session.date}.md`);
}

function frontmatter({ sequence, slug, sessionId, date, cwd }) {
  return [
    '---',
    `sequence: ${sequence}`,
    `session: ${slug}`,
    `session_id: ${sessionId}`,
    `date: ${date}`,
    `cwd: ${JSON.stringify(cwd)}`, // quoted: Windows paths carry backslashes and a drive colon
    '---',
    '',
  ].join('\n');
}

/** Creates the session file with frontmatter the first time anything is archived for it. */
function ensureFile(filePath, meta) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, frontmatter(meta), 'utf8');
  }
}

module.exports = {
  MAX_SLUG_WORDS,
  MAX_SLUG_CHARS,
  MAX_TRACKED_SESSIONS,
  pad,
  localDate,
  localTime,
  slugify,
  promptsDirFor,
  statePathFor,
  loadState,
  saveState,
  nextSequence,
  findExistingFile,
  countExistingPrompts,
  backfillSession,
  getSession,
  filePathFor,
  frontmatter,
  ensureFile,
};
