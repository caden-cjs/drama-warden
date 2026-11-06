import { assertMysqlTextLength, currentTimestampSql, isMySql } from '../db/sql.mjs';

const TRANSITIONS = Object.freeze({
  pending: new Set(['processing', 'skipped', 'failed']),
  processing: new Set(['processed', 'skipped', 'failed']),
  processed: new Set(),
  skipped: new Set(),
  failed: new Set(),
});

const EVENT_STATUSES = new Set(Object.keys(TRANSITIONS));
const REVIEWED_NO_OUTPUT_ERROR = 'INTERRUPTED_REVIEW_CONFIRMED_NO_OUTPUT';

function isReviewedNoOutput(value) {
  return String(value || '').startsWith(REVIEWED_NO_OUTPUT_ERROR);
}

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(field + ' is required');
  return text;
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(field + ' must be a positive integer');
  }
  return id;
}

function parsePayload(value) {
  try {
    const payload = JSON.parse(value);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  } catch {
    return {};
  }
}

function toEvent(row) {
  if (!row) return null;
  const writeClaimCount = Number(row.write_claim_count) || 0;
  const nonReservedWriteClaimCount = Number(row.non_reserved_write_claim_count) || 0;
  return {
    id: Number(row.id),
    showId: row.show_id == null ? null : Number(row.show_id),
    kind: row.kind,
    status: row.status,
    source: row.source,
    payload: parsePayload(row.payload_json),
    correlationId: row.correlation_id,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error,
    retryable: row.status === 'failed'
      && (writeClaimCount === 0
        || (isReviewedNoOutput(row.last_error) && nonReservedWriteClaimCount === 0)),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createEventRepository(db) {
  const now = currentTimestampSql(db);
  const mysql = isMySql(db);
  const eventSelect =
    'SELECT update_event.*, ' +
    '(SELECT COUNT(*) FROM show_episode_write_claim c WHERE c.event_id = update_event.id) ' +
    'AS write_claim_count, ' +
    '(SELECT COUNT(*) FROM show_episode_write_claim c WHERE c.event_id = update_event.id ' +
    'AND c.status <> \'reserved\') AS non_reserved_write_claim_count ' +
    'FROM update_event';

  async function getEvent(database, id) {
    return database.get(eventSelect + ' WHERE update_event.id = ?', [id]);
  }

  async function create(input) {
    return db.transaction(async (tx) => {
      const showId = input.showId == null ? null : positiveId(input.showId, 'showId');
      const kind = requiredText(input.kind, 'kind');
      const source = requiredText(input.source || 'manual', 'source');
      assertMysqlTextLength(db, kind, 64, 'kind');
      assertMysqlTextLength(db, source, 64, 'source');
      const payload = input.payload ?? {};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TypeError('payload must be a JSON object');
      }
      const payloadJson = JSON.stringify(payload);
      if (payloadJson === undefined) throw new TypeError('payload must be JSON serializable');
      const correlationId = input.correlationId == null
        ? null
        : requiredText(input.correlationId, 'correlationId');
      assertMysqlTextLength(db, correlationId, 128, 'correlationId');

      const result = await tx.run(
        'INSERT INTO update_event (show_id, kind, source, payload_json, correlation_id) ' +
        'VALUES (?, ?, ?, ?, ?)',
        [showId, kind, source, payloadJson, correlationId],
      );
      return toEvent(await getEvent(tx, result.lastInsertId));
    });
  }

  async function transitionInTransaction(tx, input) {
    const id = positiveId(input.id, 'id');
    const nextStatus = requiredText(input.status, 'status');
    if (!EVENT_STATUSES.has(nextStatus)) throw new TypeError('unsupported event status');
    const current = await getEvent(tx, id);
    if (!current) throw new Error('event ' + id + ' does not exist');
    if (!TRANSITIONS[current.status].has(nextStatus)) {
      throw new Error('event cannot move from ' + current.status + ' to ' + nextStatus);
    }

    const lastError = nextStatus === 'failed' ? requiredText(input.error, 'error') : null;
    const update = await tx.run(
      'UPDATE update_event SET status = ?, ' +
      'attempt_count = attempt_count + CASE WHEN ? = \'processing\' THEN 1 ELSE 0 END, ' +
      'started_at = CASE WHEN ? = \'processing\' THEN ' + now + ' ELSE started_at END, ' +
      'completed_at = CASE WHEN ? IN (\'processed\', \'skipped\', \'failed\') ' +
      'THEN ' + now + ' ELSE NULL END, ' +
      'last_error = ?, updated_at = ' + now + ' ' +
      'WHERE id = ? AND status = ?',
      [nextStatus, nextStatus, nextStatus, nextStatus, lastError, id, current.status],
    );
    if (update.changes !== 1) throw new Error('event status changed concurrently');
    return toEvent(await getEvent(tx, id));
  }

  async function transition(input) {
    return db.transaction((tx) => transitionInTransaction(tx, input));
  }

  async function finalizeProcessed(input) {
    return db.transaction(async (tx) => {
      const id = positiveId(input.id, 'id');
      const storageId = positiveId(input.storageId, 'storageId');
      const seasonNumber = positiveId(input.seasonNumber, 'seasonNumber');
      if (!Array.isArray(input.episodeNumbers) || input.episodeNumbers.length === 0) {
        throw new TypeError('episodeNumbers must be a non-empty array');
      }
      const episodeNumbers = input.episodeNumbers
        .map((value) => positiveId(value, 'episodeNumber'))
        .sort((left, right) => left - right);
      if (new Set(episodeNumbers).size !== episodeNumbers.length) {
        throw new TypeError('episodeNumbers must be unique');
      }

      const claims = await tx.all(
        'SELECT show_storage_id, season_number, episode_number, status ' +
        'FROM show_episode_write_claim WHERE event_id = ? ' +
        'ORDER BY show_storage_id, season_number, episode_number' +
        (mysql ? ' FOR UPDATE' : ''),
        [id],
      );
      const claimsMatch = claims.length === episodeNumbers.length
        && claims.every((claim, index) =>
          Number(claim.show_storage_id) === storageId
          && Number(claim.season_number) === seasonNumber
          && Number(claim.episode_number) === episodeNumbers[index]
          && claim.status === 'reserved');
      if (!claimsMatch) {
        const error = new Error('event write claims changed before finalization');
        error.code = 'WRITE_CLAIMS_CHANGED';
        throw error;
      }

      const completed = await tx.run(
        'UPDATE show_episode_write_claim SET status = \'completed\', updated_at = ' + now + ' ' +
        'WHERE event_id = ? AND status = \'reserved\'',
        [id],
      );
      if (completed.changes !== episodeNumbers.length) {
        const error = new Error('event write claims changed before finalization');
        error.code = 'WRITE_CLAIMS_CHANGED';
        throw error;
      }
      return transitionInTransaction(tx, { id, status: 'processed' });
    });
  }

  async function retryFailed(idValue) {
    return db.transaction(async (tx) => {
      const id = positiveId(idValue, 'id');
      const current = await getEvent(tx, id);
      if (!current) throw new Error('event ' + id + ' does not exist');
      if (current.status !== 'failed') throw new Error('only failed events can be retried');
      const priorWriteClaims = await tx.all(
        'SELECT status FROM show_episode_write_claim WHERE event_id = ?',
        [id],
      );
      const reviewedNoOutput = isReviewedNoOutput(current.last_error)
        && priorWriteClaims.every((claim) => claim.status === 'reserved');
      if (priorWriteClaims.length > 0 && !reviewedNoOutput) {
        throw new Error(
          'event has storage write claims; inspect the destination before retrying',
        );
      }

      const update = await tx.run(
        'UPDATE update_event SET status = \'pending\', last_error = NULL, ' +
        'started_at = NULL, completed_at = NULL, updated_at = ' + now + ' ' +
        'WHERE id = ? AND status = \'failed\'',
        [id],
      );
      if (update.changes !== 1) throw new Error('event status changed concurrently');
      return toEvent(await getEvent(tx, id));
    });
  }

  async function markInterruptedRetryable(input) {
    return db.transaction(async (tx) => {
      const id = positiveId(input.id, 'id');
      const storageId = positiveId(input.storageId, 'storageId');
      const seasonNumber = positiveId(input.seasonNumber, 'seasonNumber');
      if (!Array.isArray(input.episodeNumbers) || input.episodeNumbers.length === 0) {
        throw new TypeError('episodeNumbers must be a non-empty array');
      }
      const episodeNumbers = input.episodeNumbers
        .map((value) => positiveId(value, 'episodeNumber'))
        .sort((left, right) => left - right);
      if (new Set(episodeNumbers).size !== episodeNumbers.length) {
        throw new TypeError('episodeNumbers must be unique');
      }

      const current = await getEvent(tx, id);
      if (!current) throw new Error('event ' + id + ' does not exist');
      if (current.kind !== 'new_ep' || current.status !== 'processing') {
        const error = new Error('only a processing follow-up event can be reviewed');
        error.status = 409;
        error.code = 'EVENT_NOT_INTERRUPTED';
        throw error;
      }

      const claims = await tx.all(
        'SELECT show_storage_id, season_number, episode_number, status ' +
        'FROM show_episode_write_claim WHERE event_id = ? ' +
        'ORDER BY show_storage_id, season_number, episode_number' +
        (mysql ? ' FOR UPDATE' : ''),
        [id],
      );
      const claimsMatch = claims.length === 0 || (claims.length === episodeNumbers.length
        && claims.every((claim, index) =>
          Number(claim.show_storage_id) === storageId
          && Number(claim.season_number) === seasonNumber
          && Number(claim.episode_number) === episodeNumbers[index]
          && claim.status === 'reserved'));
      if (!claimsMatch) {
        const error = new Error('event write claims require manual reconciliation');
        error.status = 409;
        error.code = 'WRITE_CLAIMS_CHANGED';
        throw error;
      }

      return transitionInTransaction(tx, {
        id,
        status: 'failed',
        error: REVIEWED_NO_OUTPUT_ERROR,
      });
    });
  }

  async function markFailedRetryableAfterReview(input) {
    return db.transaction(async (tx) => {
      const id = positiveId(input.id, 'id');
      const storageId = positiveId(input.storageId, 'storageId');
      const seasonNumber = positiveId(input.seasonNumber, 'seasonNumber');
      if (!Array.isArray(input.episodeNumbers) || input.episodeNumbers.length === 0) {
        throw new TypeError('episodeNumbers must be a non-empty array');
      }
      const episodeNumbers = input.episodeNumbers
        .map((value) => positiveId(value, 'episodeNumber'))
        .sort((left, right) => left - right);
      if (new Set(episodeNumbers).size !== episodeNumbers.length) {
        throw new TypeError('episodeNumbers must be unique');
      }

      const current = await getEvent(tx, id);
      if (!current) throw new Error('event ' + id + ' does not exist');
      if (current.kind !== 'new_ep' || current.status !== 'failed') {
        const error = new Error('only a failed follow-up event can be reviewed');
        error.status = 409;
        error.code = 'EVENT_NOT_REVIEWABLE';
        throw error;
      }
      const claims = await tx.all(
        'SELECT show_storage_id, season_number, episode_number, status ' +
        'FROM show_episode_write_claim WHERE event_id = ? ' +
        'ORDER BY show_storage_id, season_number, episode_number' +
        (mysql ? ' FOR UPDATE' : ''),
        [id],
      );
      const claimsMatch = claims.length === episodeNumbers.length
        && claims.every((claim, index) =>
          Number(claim.show_storage_id) === storageId
          && Number(claim.season_number) === seasonNumber
          && Number(claim.episode_number) === episodeNumbers[index]);
      const allUncertain = claims.length > 0 && claims.every((claim) => claim.status === 'uncertain');
      const alreadyReviewed = isReviewedNoOutput(current.last_error)
        && claims.length > 0 && claims.every((claim) => claim.status === 'reserved');
      if (!claimsMatch || (!allUncertain && !alreadyReviewed)) {
        const error = new Error('event write claims require manual reconciliation');
        error.status = 409;
        error.code = 'WRITE_CLAIMS_CHANGED';
        throw error;
      }

      if (allUncertain) {
        const reset = await tx.run(
          'UPDATE show_episode_write_claim SET status = \'reserved\', updated_at = ' + now + ' ' +
          'WHERE event_id = ? AND status = \'uncertain\'',
          [id],
        );
        if (reset.changes !== episodeNumbers.length) {
          const error = new Error('event write claims changed during reviewed retry');
          error.status = 409;
          error.code = 'WRITE_CLAIMS_CHANGED';
          throw error;
        }
      }
      const update = await tx.run(
        'UPDATE update_event SET last_error = ?, updated_at = ' + now + ' ' +
        'WHERE id = ? AND status = \'failed\'',
        [
          REVIEWED_NO_OUTPUT_ERROR + (current.last_error ? ': ' + String(current.last_error).slice(0, 512) : ''),
          id,
        ],
      );
      if (update.changes !== 1) throw new Error('event status changed concurrently');
      return toEvent(await getEvent(tx, id));
    });
  }

  async function finalizeReviewedProcessed(input) {
    return db.transaction(async (tx) => {
      const id = positiveId(input.id, 'id');
      const storageId = positiveId(input.storageId, 'storageId');
      const seasonNumber = positiveId(input.seasonNumber, 'seasonNumber');
      if (!Array.isArray(input.episodeNumbers) || input.episodeNumbers.length === 0) {
        throw new TypeError('episodeNumbers must be a non-empty array');
      }
      const episodeNumbers = input.episodeNumbers
        .map((value) => positiveId(value, 'episodeNumber'))
        .sort((left, right) => left - right);
      if (new Set(episodeNumbers).size !== episodeNumbers.length) {
        throw new TypeError('episodeNumbers must be unique');
      }

      const current = await getEvent(tx, id);
      if (!current) throw new Error('event ' + id + ' does not exist');
      if (current.kind !== 'new_ep' || current.status !== 'failed') {
        const error = new Error('only a failed follow-up event can be completed after review');
        error.status = 409;
        error.code = 'EVENT_NOT_REVIEWABLE';
        throw error;
      }
      const claims = await tx.all(
        'SELECT show_storage_id, season_number, episode_number, status ' +
        'FROM show_episode_write_claim WHERE event_id = ? ' +
        'ORDER BY show_storage_id, season_number, episode_number' +
        (mysql ? ' FOR UPDATE' : ''),
        [id],
      );
      const claimsMatch = claims.length === episodeNumbers.length
        && claims.every((claim, index) =>
          Number(claim.show_storage_id) === storageId
          && Number(claim.season_number) === seasonNumber
          && Number(claim.episode_number) === episodeNumbers[index]
          && ['reserved', 'uncertain'].includes(claim.status));
      if (!claimsMatch) {
        const error = new Error('event write claims changed before reviewed finalization');
        error.status = 409;
        error.code = 'WRITE_CLAIMS_CHANGED';
        throw error;
      }

      const completed = await tx.run(
        'UPDATE show_episode_write_claim SET status = \'completed\', updated_at = ' + now + ' ' +
        'WHERE event_id = ? AND status IN (\'reserved\', \'uncertain\')',
        [id],
      );
      if (completed.changes !== episodeNumbers.length) {
        const error = new Error('event write claims changed before reviewed finalization');
        error.status = 409;
        error.code = 'WRITE_CLAIMS_CHANGED';
        throw error;
      }
      const update = await tx.run(
        'UPDATE update_event SET status = \'processed\', last_error = NULL, ' +
        'completed_at = ' + now + ', updated_at = ' + now + ' ' +
        'WHERE id = ? AND status = \'failed\'',
        [id],
      );
      if (update.changes !== 1) throw new Error('event status changed concurrently');
      return toEvent(await getEvent(tx, id));
    });
  }

  return Object.freeze({
    create,

    async getById(id) {
      return toEvent(await getEvent(db, positiveId(id, 'id')));
    },

    async list({ status, limit = 100 } = {}) {
      const boundedLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
      if (status != null && !EVENT_STATUSES.has(status)) {
        throw new TypeError('unsupported event status');
      }
      const rows = status == null
        ? await db.all(eventSelect + ' ORDER BY update_event.id DESC LIMIT ?', [boundedLimit])
        : await db.all(
          eventSelect + ' WHERE update_event.status = ? ORDER BY update_event.id DESC LIMIT ?',
          [status, boundedLimit],
        );
      return rows.map(toEvent);
    },

    transition,
    finalizeProcessed,
    markInterruptedRetryable,
    markFailedRetryableAfterReview,
    finalizeReviewedProcessed,
    retryFailed,
  });
}
