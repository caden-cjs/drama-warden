import { randomUUID } from 'node:crypto';
import { assertMysqlTextLength, currentTimestampSql, isMySql } from '../db/sql.mjs';

const STATUSES = new Set(['pending', 'processing', 'completed', 'skipped', 'failed', 'uncertain']);

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(field + ' must be a positive integer');
  return number;
}

function parseLanguages(value) {
  try {
    const result = JSON.parse(value);
    return Array.isArray(result) ? result : ['zh-CN', 'zh-TW'];
  } catch {
    return ['zh-CN', 'zh-TW'];
  }
}

function toJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    showId: Number(row.show_id),
    storageId: Number(row.show_storage_id),
    seasonNumber: Number(row.season_number),
    episodeNumber: Number(row.episode_number),
    languages: parseLanguages(row.languages_json),
    status: row.status,
    providerId: row.provider_id,
    outputPath: row.output_path,
    attemptCount: Number(row.attempt_count),
    writeStartedAt: row.write_started_at,
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function createSubtitleRepository(db) {
  const now = currentTimestampSql(db);
  const mysql = isMySql(db);
  const leaseUntil = mysql
    ? 'DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE)'
    : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')";

  async function findRow(database, id) {
    return database.get('SELECT * FROM subtitle_job WHERE id = ?', [id]);
  }

  async function create(input) {
    const showId = positiveInteger(input.showId, 'showId');
    const storageId = positiveInteger(input.storageId, 'storageId');
    const seasonNumber = positiveInteger(input.seasonNumber, 'seasonNumber');
    const episodeNumber = positiveInteger(input.episodeNumber, 'episodeNumber');
    const languages = Array.isArray(input.languages) ? input.languages : ['zh-CN', 'zh-TW'];
    if (languages.length < 1 || languages.length > 5
        || languages.some((language) => !/^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(String(language)))) {
      throw new TypeError('languages must contain one to five language codes');
    }
    const uniqueLanguages = [...new Set(languages.map(String))];
    const languagesJson = JSON.stringify(uniqueLanguages);
    assertMysqlTextLength(db, languagesJson, 200, 'languages');
    return db.transaction(async (tx) => {
      const storage = await tx.get(
        'SELECT id FROM show_storage WHERE id = ? AND show_id = ? AND enabled = 1',
        [storageId, showId],
      );
      if (!storage) throw new Error('enabled storage does not exist for this show');
      const episode = await tx.get(
        'SELECT e.id FROM show_episode e JOIN show_season s ON s.id = e.season_id ' +
        'WHERE s.show_id = ? AND s.season_number = ? AND e.episode_number = ?',
        [showId, seasonNumber, episodeNumber],
      );
      if (!episode) throw new Error('episode does not exist in the show catalog');
      await tx.run(
        'INSERT INTO subtitle_job (show_id, show_storage_id, season_number, episode_number, languages_json) ' +
        'VALUES (?, ?, ?, ?, ?) ' +
        (mysql
          ? 'ON DUPLICATE KEY UPDATE id = id'
          : 'ON CONFLICT(show_storage_id, season_number, episode_number) DO NOTHING'),
        [showId, storageId, seasonNumber, episodeNumber, languagesJson],
      );
      const row = await tx.get(
        'SELECT * FROM subtitle_job WHERE show_storage_id = ? AND season_number = ? AND episode_number = ?',
        [storageId, seasonNumber, episodeNumber],
      );
      return toJob(row);
    });
  }

  async function claimNext() {
    return db.transaction(async (tx) => {
      await tx.run(
        'UPDATE subtitle_job SET status = CASE WHEN write_started_at IS NULL THEN \'pending\' ELSE \'uncertain\' END, ' +
        'locked_until = NULL, claim_token = NULL, error_code = CASE WHEN write_started_at IS NULL THEN error_code ELSE \'WORKER_LOST_DURING_WRITE\' END, ' +
        'completed_at = CASE WHEN write_started_at IS NULL THEN NULL ELSE ' + now + ' END, updated_at = ' + now + ' ' +
        'WHERE status = \'processing\' AND (locked_until IS NULL OR locked_until < ' + now + ')',
        [],
      );
      const row = await tx.get(
        'SELECT id FROM subtitle_job WHERE status = \'pending\' AND next_attempt_at <= ' + now + ' ORDER BY id LIMIT 1',
        [],
      );
      if (!row) return null;
      const claimToken = randomUUID();
      const updated = await tx.run(
        'UPDATE subtitle_job SET status = \'processing\', attempt_count = attempt_count + 1, ' +
        'locked_until = ' + leaseUntil + ', claim_token = ?, write_started_at = NULL, error_code = NULL, updated_at = ' + now + ' ' +
        'WHERE id = ? AND status = \'pending\'',
        [claimToken, Number(row.id)],
      );
      if (updated.changes !== 1) return null;
      return { ...toJob(await findRow(tx, Number(row.id))), claimToken };
    });
  }

  return Object.freeze({
    create,
    claimNext,

    async getById(value) {
      return toJob(await findRow(db, positiveInteger(value, 'id')));
    },

    async getByEpisode({ storageId, seasonNumber, episodeNumber } = {}) {
      const row = await db.get(
        'SELECT * FROM subtitle_job WHERE show_storage_id = ? AND season_number = ? AND episode_number = ?',
        [
          positiveInteger(storageId, 'storageId'),
          positiveInteger(seasonNumber, 'seasonNumber'),
          positiveInteger(episodeNumber, 'episodeNumber'),
        ],
      );
      return toJob(row);
    },

    async getContext(value) {
      const id = positiveInteger(value, 'id');
      const job = toJob(await findRow(db, id));
      if (!job) return null;
      const show = await db.get('SELECT id, name, aliases_json FROM shows WHERE id = ?', [job.showId]);
      const storage = await db.get(
        'SELECT id, provider_id, root_path, enabled FROM show_storage WHERE id = ? AND show_id = ?',
        [job.storageId, job.showId],
      );
      const assets = await db.all(
        'SELECT a.relative_path, a.file_name, a.file_size FROM show_episode_asset a ' +
        'JOIN show_episode e ON e.id = a.episode_id ' +
        'JOIN show_season s ON s.id = e.season_id ' +
        'WHERE a.show_storage_id = ? AND a.is_present = 1 ' +
        'AND s.show_id = ? AND s.season_number = ? AND e.episode_number = ? ' +
        'ORDER BY a.relative_path',
        [job.storageId, job.showId, job.seasonNumber, job.episodeNumber],
      );
      return {
        job,
        show: show ? { id: Number(show.id), name: show.name, aliases: JSON.parse(show.aliases_json || '[]') } : null,
        storage: storage ? {
          id: Number(storage.id),
          providerId: storage.provider_id,
          rootPath: storage.root_path,
          enabled: Boolean(storage.enabled),
        } : null,
        assets: assets.map((asset) => ({
          relativePath: asset.relative_path,
          fileName: asset.file_name,
          fileSize: asset.file_size == null ? null : Number(asset.file_size),
        })),
      };
    },

    async list({ status, showId, limit = 100 } = {}) {
      if (status != null && !STATUSES.has(status)) throw new TypeError('unsupported subtitle job status');
      const boundedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
      const normalizedShowId = showId == null ? null : positiveInteger(showId, 'showId');
      const selection = 'SELECT j.*, sh.name AS show_name, ss.provider_id AS storage_provider_id ' +
        'FROM subtitle_job j LEFT JOIN shows sh ON sh.id = j.show_id ' +
        'LEFT JOIN show_storage ss ON ss.id = j.show_storage_id ';
      let rows;
      if (status != null && normalizedShowId != null) {
        rows = await db.all(selection + 'WHERE j.status = ? AND j.show_id = ? ORDER BY j.id DESC LIMIT ?', [status, normalizedShowId, boundedLimit]);
      } else if (status != null) {
        rows = await db.all(selection + 'WHERE j.status = ? ORDER BY j.id DESC LIMIT ?', [status, boundedLimit]);
      } else if (normalizedShowId != null) {
        rows = await db.all(selection + 'WHERE j.show_id = ? ORDER BY j.id DESC LIMIT ?', [normalizedShowId, boundedLimit]);
      } else {
        rows = await db.all(selection + 'ORDER BY j.id DESC LIMIT ?', [boundedLimit]);
      }
      return rows.map((row) => ({
        ...toJob(row),
        showName: row.show_name || null,
        storageProviderId: row.storage_provider_id || null,
      }));
    },

    async markWriteStarted(idValue, providerId, claimToken) {
      const id = positiveInteger(idValue, 'id');
      assertMysqlTextLength(db, providerId, 64, 'providerId');
      if (!claimToken) throw new TypeError('claimToken is required');
      const result = await db.run(
        'UPDATE subtitle_job SET write_started_at = ' + now + ', provider_id = ?, locked_until = ' +
        leaseUntil + ', updated_at = ' + now + ' WHERE id = ? AND status = \'processing\' ' +
        'AND claim_token = ? AND write_started_at IS NULL',
        [providerId, id, claimToken],
      );
      if (result.changes !== 1) {
        const error = new Error('subtitle job lease is no longer owned by this worker');
        error.code = 'SUBTITLE_JOB_LEASE_LOST';
        error.status = 409;
        throw error;
      }
    },

    async complete(idValue, { providerId, outputPath, claimToken }) {
      const id = positiveInteger(idValue, 'id');
      assertMysqlTextLength(db, providerId, 64, 'providerId');
      assertMysqlTextLength(db, outputPath, 1024, 'outputPath');
      if (!claimToken) throw new TypeError('claimToken is required');
      const result = await db.run(
        'UPDATE subtitle_job SET status = \'completed\', provider_id = ?, output_path = ?, locked_until = NULL, ' +
        'claim_token = NULL, completed_at = ' + now + ', updated_at = ' + now + ' ' +
        'WHERE id = ? AND status = \'processing\' AND claim_token = ? AND write_started_at IS NOT NULL',
        [providerId, outputPath, id, claimToken],
      );
      if (result.changes !== 1) throw new Error('subtitle job completion state changed concurrently');
      return toJob(await findRow(db, id));
    },

    async skip(idValue, errorCode, claimToken) {
      const id = positiveInteger(idValue, 'id');
      if (!claimToken) throw new TypeError('claimToken is required');
      const result = await db.run(
        'UPDATE subtitle_job SET status = \'skipped\', error_code = ?, locked_until = NULL, claim_token = NULL, ' +
        'completed_at = ' + now + ', updated_at = ' + now + ' WHERE id = ? AND status = \'processing\' ' +
        'AND claim_token = ? AND write_started_at IS NULL',
        [String(errorCode || 'NO_MATCHING_SUBTITLE').slice(0, 64), id, claimToken],
      );
      if (result.changes !== 1) throw new Error('subtitle job cannot be skipped after a write started');
      return toJob(await findRow(db, id));
    },

    async fail(idValue, errorCode, claimToken) {
      const id = positiveInteger(idValue, 'id');
      const code = String(errorCode || 'SUBTITLE_JOB_FAILED').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
      const row = await findRow(db, id);
      const job = toJob(row);
      if (!job || job.status !== 'processing' || !claimToken || row.claim_token !== claimToken) {
        const error = new Error('subtitle job lease is no longer owned by this worker');
        error.code = 'SUBTITLE_JOB_LEASE_LOST';
        error.status = 409;
        throw error;
      }
      if (job.writeStartedAt) {
        await db.run(
          'UPDATE subtitle_job SET status = \'uncertain\', error_code = ?, locked_until = NULL, claim_token = NULL, ' +
          'completed_at = ' + now + ', updated_at = ' + now + ' WHERE id = ? AND status = \'processing\' AND claim_token = ?',
          [code, id, claimToken],
        );
        return toJob(await findRow(db, id));
      }
      const terminal = job.attemptCount >= 3;
      const backoffSeconds = Math.min(300, 30 * (2 ** Math.max(0, job.attemptCount - 1)));
      const retryAt = mysql
        ? 'DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ' + backoffSeconds + ' SECOND)'
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+" + backoffSeconds + " seconds')";
      await db.run(
        'UPDATE subtitle_job SET status = ?, error_code = ?, next_attempt_at = ' +
        (terminal ? 'next_attempt_at' : retryAt) + ', locked_until = NULL, claim_token = NULL, completed_at = ' +
        (terminal ? now : 'NULL') + ', updated_at = ' + now + ' WHERE id = ? AND status = \'processing\' ' +
        'AND claim_token = ? AND write_started_at IS NULL',
        [terminal ? 'failed' : 'pending', code, id, claimToken],
      );
      return toJob(await findRow(db, id));
    },

    async retryFailed(value) {
      const id = positiveInteger(value, 'id');
      const result = await db.run(
        'UPDATE subtitle_job SET status = \'pending\', next_attempt_at = ' + now + ', completed_at = NULL, ' +
        'write_started_at = NULL, locked_until = NULL, claim_token = NULL, error_code = NULL, updated_at = ' + now + ' ' +
        'WHERE id = ? AND status = \'failed\' AND write_started_at IS NULL',
        [id],
      );
      if (result.changes !== 1) {
        const error = new Error('only subtitle jobs failed before writing can be retried');
        error.code = 'SUBTITLE_JOB_NOT_RETRYABLE';
        error.status = 409;
        throw error;
      }
      return toJob(await findRow(db, id));
    },
  });
}
