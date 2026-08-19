#!/usr/bin/env node
'use strict';

/**
 * PostToolUse hook (matcher: AskUserQuestion): archives clarifying-question
 * interviews - such as the one /spec runs via _specs/template.md - into the
 * same per-session file save-prompt.cjs writes to
 * (docs/prompts/<sequence>-<session-slug>-<date>.md), so a spec's question
 * trail sits next to the prompt that triggered it.
 *
 * AskUserQuestion answers never pass through UserPromptSubmit (the user
 * picks them in the tool's own UI, not the chat box), so this has to be a
 * separate PostToolUse hook rather than a change to save-prompt.cjs.
 *
 * Reads the hook payload as JSON on stdin. Prints nothing and never throws -
 * a logging failure must not block the tool result from reaching Claude.
 */

const fs = require('fs');
const log = require('./lib/prompt-log.cjs');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Best-effort: the shape of tool_response for AskUserQuestion isn't guaranteed, so look in either. */
function extractMap(key, toolInput, toolResponse) {
  if (toolResponse && typeof toolResponse[key] === 'object' && toolResponse[key]) return toolResponse[key];
  if (toolInput && typeof toolInput[key] === 'object' && toolInput[key]) return toolInput[key];
  return {};
}

function formatOption(option) {
  return option && option.description ? `${option.label} - ${option.description}` : option && option.label;
}

/**
 * One entry per question: the question asked, the options it offered, and
 * the answer that was actually selected (or freeform "Other" text).
 * Falls back to dumping the raw payload if the questions array is missing
 * or an unrecognized shape, so nothing is silently lost.
 */
function formatQuestions(toolInput, toolResponse) {
  const questions = toolInput && Array.isArray(toolInput.questions) ? toolInput.questions : null;
  if (!questions || questions.length === 0) {
    return [
      '_Unrecognized AskUserQuestion payload shape - raw data below._',
      '',
      '```json',
      JSON.stringify({ tool_input: toolInput, tool_response: toolResponse }, null, 2),
      '```',
    ].join('\n');
  }

  const answers = extractMap('answers', toolInput, toolResponse);
  const annotations = extractMap('annotations', toolInput, toolResponse);

  return questions
    .map((q) => {
      const lines = [`**${q.question || '(untitled question)'}**`];
      if (Array.isArray(q.options) && q.options.length) {
        lines.push(...q.options.map((o) => `- ${formatOption(o)}`));
      }
      const answer = answers && Object.prototype.hasOwnProperty.call(answers, q.question) ? answers[q.question] : undefined;
      lines.push(`Selected: ${answer !== undefined ? answer : '(no answer captured)'}`);
      const note = annotations && annotations[q.question] && annotations[q.question].notes;
      if (note) lines.push(`Notes: ${note}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

function questionsBlock({ entryNumber, time, toolInput, toolResponse }) {
  return ['', `## Questions ${entryNumber} - ${time}`, '', formatQuestions(toolInput, toolResponse), ''].join('\n');
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return;
  }

  if (input.tool_name !== 'AskUserQuestion') return;

  const toolInput = input.tool_input || {};
  const toolResponse = input.tool_response || {};

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const promptsDir = log.promptsDirFor(projectDir);
  fs.mkdirSync(promptsDir, { recursive: true });

  const sessionId = input.session_id || 'unknown-session';
  const statePath = log.statePathFor(projectDir);
  const state = log.loadState(statePath);
  const when = new Date();

  const firstQuestionText =
    Array.isArray(toolInput.questions) && toolInput.questions[0] ? toolInput.questions[0].question : 'questions';
  const session = log.getSession(state, sessionId, promptsDir, when, firstQuestionText);
  const filePath = log.filePathFor(promptsDir, session);
  session.questionCount += 1;

  log.ensureFile(filePath, {
    sequence: session.sequence,
    slug: session.slug,
    sessionId,
    date: session.date,
    cwd: input.cwd || projectDir,
  });

  fs.appendFileSync(
    filePath,
    questionsBlock({ entryNumber: session.questionCount, time: log.localTime(when), toolInput, toolResponse }),
    'utf8'
  );

  log.saveState(statePath, state);
}

try {
  main();
} catch {
  // Never block a tool result because logging failed.
}
