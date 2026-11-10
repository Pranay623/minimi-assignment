import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Conversation, Turn } from '../shared/types.js';

type Row = Record<string, unknown>;

function readTurn(row: Row): Turn {
  return {
    id: String(row.id), conversationId: String(row.conversation_id),
    question: String(row.question), answer: String(row.answer),
    status: row.status as Turn['status'], createdAt: String(row.created_at),
    ...JSON.parse(String(row.metadata)),
  };
}

function readConversation(row: Row): Conversation {
  return {
    id: String(row.id), title: String(row.title), createdAt: String(row.created_at),
    updatedAt: String(row.updated_at), demo: Boolean(row.demo),
  };
}

/** All public read/write methods require an owner. No global memory API exists. */
export class Store {
  private db: DatabaseSync;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS conversation_owner ON conversations(owner, updated_at);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        created_at TEXT NOT NULL, metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turn_conversation ON turns(conversation_id, created_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(question, answer, content='turns', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, question, answer) VALUES (new.rowid, new.question, new.answer);
      END;
      CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, question, answer) VALUES ('delete', old.rowid, old.question, old.answer);
      END;
      CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, question, answer) VALUES ('delete', old.rowid, old.question, old.answer);
        INSERT INTO turns_fts(rowid, question, answer) VALUES (new.rowid, new.question, new.answer);
      END;
    `);
    // A process crash cannot turn an incomplete answer into durable knowledge.
    this.db.prepare("UPDATE turns SET status = 'failed' WHERE status = 'pending'").run();
  }

  close() { this.db.close(); }

  createOwner(id: string) {
    this.db.prepare('INSERT OR IGNORE INTO owners VALUES (?, ?)').run(id, new Date().toISOString());
  }

  hasOwner(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM owners WHERE id = ?').get(id);
  }

  createConversation(owner: string, demo = false, now = new Date().toISOString()): Conversation {
    const chat: Conversation = { id: randomUUID(), title: demo ? 'A week of decisions' : 'New conversation', createdAt: now, updatedAt: now, demo };
    this.db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)')
      .run(chat.id, owner, chat.title, now, now, Number(demo));
    return chat;
  }

  conversations(owner: string): Conversation[] {
    return this.db.prepare('SELECT * FROM conversations WHERE owner = ? ORDER BY updated_at DESC LIMIT 100')
      .all(owner).map(readConversation);
  }

  conversation(owner: string, id: string): Conversation | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE owner = ? AND id = ?').get(owner, id);
    return row ? readConversation(row) : undefined;
  }

  deleteConversation(owner: string, id: string): boolean {
    return this.db.prepare('DELETE FROM conversations WHERE owner = ? AND id = ?').run(owner, id).changes > 0;
  }

  turns(owner: string, conversationId: string): Turn[] {
    return this.db.prepare(`SELECT t.* FROM turns t JOIN conversations c ON c.id = t.conversation_id
      WHERE c.owner = ? AND c.id = ? ORDER BY t.created_at, t.rowid`).all(owner, conversationId).map(readTurn);
  }

  turn(owner: string, id: string): Turn | undefined {
    const row = this.db.prepare(`SELECT t.* FROM turns t JOIN conversations c ON c.id = t.conversation_id
      WHERE c.owner = ? AND t.id = ?`).get(owner, id);
    return row ? readTurn(row) : undefined;
  }

  beginTurn(owner: string, conversationId: string, id: string, question: string, now = new Date().toISOString()): Turn {
    if (!this.conversation(owner, conversationId)) throw new Error('Conversation not found');
    const turn: Turn = { id, conversationId, question, answer: '', status: 'pending', createdAt: now,
      sources: [], memory: [], searches: [], warnings: [], stats: null };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO turns (id, conversation_id, question, status, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, conversationId, question, 'pending', now, JSON.stringify(this.metadata(turn)));
      this.db.prepare(`UPDATE conversations SET updated_at = ?, title = CASE WHEN title = 'New conversation' THEN ? ELSE title END
        WHERE id = ? AND owner = ?`).run(now, question.slice(0, 70), conversationId, owner);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return turn;
  }

  /** A completed turn and its evidence are immutable. Retrying uses a new turn ID. */
  finishTurn(owner: string, turn: Turn): void {
    const changes = this.db.prepare(`UPDATE turns SET answer = ?, status = ?, metadata = ?
      WHERE id = ? AND status = 'pending' AND conversation_id IN (SELECT id FROM conversations WHERE owner = ?)`)
      .run(turn.answer, turn.status, JSON.stringify(this.metadata(turn)), turn.id, owner).changes;
    if (!changes) throw new Error('Turn is missing or already finalized');
  }

  private metadata(turn: Turn) {
    return { sources: turn.sources, memory: turn.memory, searches: turn.searches, warnings: turn.warnings, stats: turn.stats };
  }

  recall(owner: string, options: { conversationId?: string; start?: string; end?: string; query?: string; limit: number; demo: boolean }): Turn[] {
    const params: (string | number)[] = [owner, Number(options.demo)];
    let sql = `SELECT t.* FROM turns t JOIN conversations c ON c.id = t.conversation_id`;
    if (options.query) sql += ' JOIN turns_fts ON turns_fts.rowid = t.rowid';
    sql += " WHERE c.owner = ? AND c.demo = ? AND t.status = 'complete'";
    if (options.conversationId) { sql += ' AND c.id = ?'; params.push(options.conversationId); }
    if (options.start) { sql += ' AND t.created_at >= ?'; params.push(options.start); }
    if (options.end) { sql += ' AND t.created_at < ?'; params.push(options.end); }
    if (options.query) { sql += ' AND turns_fts MATCH ?'; params.push(options.query); }
    sql += options.query ? ' ORDER BY rank, t.created_at DESC' : ' ORDER BY t.created_at DESC, t.rowid DESC';
    sql += ' LIMIT ?'; params.push(options.limit);
    return this.db.prepare(sql).all(...params).map(readTurn);
  }
}
