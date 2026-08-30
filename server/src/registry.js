// Tracks which session IDs this relay considers "known" — i.e. ones it
// created itself, or ones a user explicitly opened from the "browse all
// sessions" view. Persisted to disk so the scoping survives relay restarts.
//
// Why this exists: @github/copilot-sdk's listSessions() returns *every*
// local Copilot CLI session system-wide, including ones actively open in an
// unrelated terminal — g2-channels (from the awesome-even-realities-g2
// list) solves the same underlying problem for Claude Code by requiring an
// explicit create_channel opt-in before a session becomes glasses-visible,
// rather than auto-discovering everything. This registry is our version of
// that opt-in: GET /api/sessions defaults to only the known set, with the
// full unscoped list still available (?scope=all) for the cases where you
// deliberately want to pick up an arbitrary session (e.g. one running in a
// terminal right now).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const REGISTRY_PATH = path.join(DATA_DIR, "known-sessions.json");

/** @type {Set<string>} */
let known = new Set();

function load() {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
    const ids = JSON.parse(raw);
    if (Array.isArray(ids)) known = new Set(ids);
  } catch {
    // no file yet, or corrupt — start empty rather than failing to boot
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify([...known]), "utf8");
  } catch (err) {
    console.warn("Failed to persist known-sessions registry:", err.message);
  }
}

load();

/** Mark a session as known (relay-created, or explicitly opened from the "all sessions" view). */
export function markKnown(sessionId) {
  if (!sessionId || known.has(sessionId)) return;
  known.add(sessionId);
  save();
}

export function isKnown(sessionId) {
  return known.has(sessionId);
}

export function knownIds() {
  return known;
}
