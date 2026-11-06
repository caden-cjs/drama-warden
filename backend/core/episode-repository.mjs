import { assertMysqlTextLength, currentTimestampSql, isMySql } from '../db/sql.mjs';

function positiveInteger(value, field, { allowZero = false } = {}) {
  const number = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new TypeError(field + ' must be an integer greater than or equal to ' + minimum);
  }
  return number;
}

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(field + ' is required');
  return text;
}

function optionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function optionalNonnegativeInteger(value, field) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(field + ' must be a nonnegative integer');
  }
  return number;
}

function optionalDate(value, field) {
  if (value == null || value === '') return null;
  const date = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError(field + ' must use YYYY-MM-DD');
  }
  return date;
}

function positiveId(value, field) {
  return positiveInteger(value, field);
}

function toStorage(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    showId: Number(row.show_id),
    providerId: row.provider_id,
    rootPath: row.root_path,
    localPath: row.local_path,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createEpisodeRepository(db) {
  const now = currentTimestampSql(db);
  const mysql = isMySql(db);

  const saveSeason = (input) => db.transaction(async (tx) => {
    const showId = positiveId(input.showId, 'showId');
    const seasonNumber = positiveInteger(input.seasonNumber, 'seasonNumber', { allowZero: true });
    const providerId = optionalText(input.providerId);
    assertMysqlTextLength(db, input.name, 255, 'season.name');
    assertMysqlTextLength(db, providerId, 64, 'season.providerId');
    const upsertSeason = mysql
      ? 'ON DUPLICATE KEY UPDATE ' +
        'name = COALESCE(VALUES(name), show_season.name), ' +
        'episode_count = COALESCE(VALUES(episode_count), show_season.episode_count), ' +
        'first_air_date = COALESCE(VALUES(first_air_date), show_season.first_air_date), ' +
        'metadata_provider_id = COALESCE(VALUES(metadata_provider_id), show_season.metadata_provider_id), ' +
        'metadata_synced_at = CASE WHEN VALUES(metadata_provider_id) IS NULL ' +
        'THEN show_season.metadata_synced_at ELSE VALUES(metadata_synced_at) END, ' +
        'updated_at = ' + now
      : 'ON CONFLICT(show_id, season_number) DO UPDATE SET ' +
        'name = COALESCE(excluded.name, show_season.name), ' +
        'episode_count = COALESCE(excluded.episode_count, show_season.episode_count), ' +
        'first_air_date = COALESCE(excluded.first_air_date, show_season.first_air_date), ' +
        'metadata_provider_id = COALESCE(excluded.metadata_provider_id, show_season.metadata_provider_id), ' +
        'metadata_synced_at = CASE WHEN excluded.metadata_provider_id IS NULL ' +
        'THEN show_season.metadata_synced_at ELSE excluded.metadata_synced_at END, ' +
        'updated_at = ' + now;
    await tx.run(
      'INSERT INTO show_season ' +
      '(show_id, season_number, name, episode_count, first_air_date, metadata_provider_id, metadata_synced_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE ' + now + ' END) ' +
      upsertSeason,
      [
        showId,
        seasonNumber,
        optionalText(input.name),
        optionalNonnegativeInteger(input.episodeCount, 'episodeCount'),
        optionalDate(input.firstAirDate, 'firstAirDate'),
        providerId,
        providerId,
      ],
    );
    return tx.get(
      'SELECT id, show_id, season_number, name, episode_count, first_air_date, metadata_provider_id, metadata_synced_at ' +
      'FROM show_season WHERE show_id = ? AND season_number = ?',
      [showId, seasonNumber],
    );
  });

  const saveEpisode = (input) => db.transaction(async (tx) => {
    const showId = positiveId(input.showId, 'showId');
    const seasonNumber = positiveInteger(input.seasonNumber, 'seasonNumber', { allowZero: true });
    const episodeNumber = positiveId(input.episodeNumber, 'episodeNumber');
    const season = await tx.get(
      'SELECT id FROM show_season WHERE show_id = ? AND season_number = ?',
      [showId, seasonNumber],
    );
    if (!season) throw new Error('season ' + seasonNumber + ' does not exist for show ' + showId);

    await tx.run(
      'INSERT INTO show_episode (season_id, episode_number) VALUES (?, ?) ' +
      (mysql ? 'ON DUPLICATE KEY UPDATE id = id' : 'ON CONFLICT(season_id, episode_number) DO NOTHING'),
      [Number(season.id), episodeNumber],
    );
    return tx.get(
      'SELECT id, season_id, episode_number FROM show_episode WHERE season_id = ? AND episode_number = ?',
      [Number(season.id), episodeNumber],
    );
  });

  const saveEpisodeMetadata = (input) => db.transaction(async (tx) => {
    const episodeId = positiveId(input.episodeId, 'episodeId');
    const providerId = requiredText(input.providerId, 'providerId');
    const providerExternalId = requiredText(input.providerExternalId, 'providerExternalId');
    const providerEpisodeId = optionalText(input.providerEpisodeId);
    assertMysqlTextLength(db, providerId, 64, 'providerId');
    assertMysqlTextLength(db, providerExternalId, 255, 'providerExternalId');
    assertMysqlTextLength(db, providerEpisodeId, 255, 'providerEpisodeId');
    assertMysqlTextLength(db, input.airTime, 16, 'airTime');
    const runtime = input.runtime == null || input.runtime === ''
      ? null
      : positiveId(input.runtime, 'runtime');
    const providerPayload = input.metadata == null ? null : JSON.stringify(input.metadata);

    const upsertEpisodeMetadata = mysql
      ? 'ON DUPLICATE KEY UPDATE ' +
        'provider_external_id = VALUES(provider_external_id), ' +
        'provider_episode_id = VALUES(provider_episode_id), ' +
        'name = VALUES(name), overview = VALUES(overview), air_date = VALUES(air_date), ' +
        'air_time = VALUES(air_time), runtime = VALUES(runtime), still_path = VALUES(still_path), ' +
        'metadata_json = VALUES(metadata_json), synced_at = ' + now
      : 'ON CONFLICT(episode_id, provider_id) DO UPDATE SET ' +
        'provider_external_id = excluded.provider_external_id, ' +
        'provider_episode_id = excluded.provider_episode_id, ' +
        'name = excluded.name, overview = excluded.overview, air_date = excluded.air_date, ' +
        'air_time = excluded.air_time, runtime = excluded.runtime, still_path = excluded.still_path, ' +
        'metadata_json = excluded.metadata_json, synced_at = ' + now;
    await tx.run(
      'INSERT INTO show_episode_metadata ' +
      '(episode_id, provider_id, provider_external_id, provider_episode_id, name, overview, air_date, air_time, runtime, still_path, metadata_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      upsertEpisodeMetadata,
      [
        episodeId,
        providerId,
        providerExternalId,
        providerEpisodeId,
        optionalText(input.name),
        optionalText(input.overview),
        optionalDate(input.airDate, 'airDate'),
        optionalText(input.airTime),
        runtime,
        optionalText(input.stillPath),
        providerPayload,
      ],
    );

    return tx.get(
      'SELECT * FROM show_episode_metadata WHERE episode_id = ? AND provider_id = ?',
      [episodeId, providerId],
    );
  });

  const saveStorage = (input) => db.transaction(async (tx) => {
    const showId = positiveId(input.showId, 'showId');
    const providerId = requiredText(input.providerId, 'providerId');
    const rootPath = requiredText(input.rootPath, 'rootPath');
    const localPath = optionalText(input.localPath);
    assertMysqlTextLength(db, providerId, 64, 'providerId');
    assertMysqlTextLength(db, rootPath, 600, 'rootPath');
    assertMysqlTextLength(db, localPath, 1024, 'localPath');
    const upsertStorage = mysql
      ? 'ON DUPLICATE KEY UPDATE ' +
        'local_path = COALESCE(VALUES(local_path), show_storage.local_path), ' +
        'enabled = VALUES(enabled), updated_at = ' + now
      : 'ON CONFLICT(show_id, provider_id, root_path) DO UPDATE SET ' +
        'local_path = COALESCE(excluded.local_path, show_storage.local_path), ' +
        'enabled = excluded.enabled, updated_at = ' + now;
    await tx.run(
      'INSERT INTO show_storage (show_id, provider_id, root_path, local_path, enabled) ' +
      'VALUES (?, ?, ?, ?, ?) ' +
      upsertStorage,
      [showId, providerId, rootPath, localPath, input.enabled === false ? 0 : 1],
    );
    return tx.get(
      'SELECT * FROM show_storage WHERE show_id = ? AND provider_id = ? AND root_path = ?',
      [showId, providerId, rootPath],
    );
  });

  const saveAssets = (input) => db.transaction(async (tx) => {
    const storageId = positiveId(input.storageId, 'storageId');
    const scanId = requiredText(input.scanId, 'scanId');
    if (!Array.isArray(input.assets)) throw new TypeError('assets must be an array');
    if (typeof input.completeSnapshot !== 'boolean') {
      throw new TypeError('completeSnapshot must be an explicit boolean');
    }

    const storage = await tx.get('SELECT id, show_id FROM show_storage WHERE id = ?', [storageId]);
    if (!storage) throw new Error('storage ' + storageId + ' does not exist');

    const seenKeys = new Set();
    const upsertAsset =
      'INSERT INTO show_episode_asset ' +
      '(episode_id, show_storage_id, asset_key, relative_path, file_name, file_size, file_mtime, quality, is_present, scan_id) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ' +
      (mysql
        ? 'ON DUPLICATE KEY UPDATE ' +
          'episode_id = VALUES(episode_id), relative_path = VALUES(relative_path), ' +
          'file_name = VALUES(file_name), file_size = VALUES(file_size), file_mtime = VALUES(file_mtime), ' +
          'quality = VALUES(quality), is_present = 1, scan_id = VALUES(scan_id), last_seen_at = ' + now
        : 'ON CONFLICT(show_storage_id, asset_key) DO UPDATE SET ' +
          'episode_id = excluded.episode_id, relative_path = excluded.relative_path, ' +
          'file_name = excluded.file_name, file_size = excluded.file_size, file_mtime = excluded.file_mtime, ' +
          'quality = excluded.quality, is_present = 1, scan_id = excluded.scan_id, last_seen_at = ' + now);
    const episodeBelongsToShow =
      'SELECT 1 AS valid FROM show_episode e ' +
      'JOIN show_season s ON s.id = e.season_id ' +
      'WHERE e.id = ? AND s.show_id = ?';

    for (const asset of input.assets) {
      const episodeId = positiveId(asset.episodeId, 'asset.episodeId');
      const assetKey = requiredText(asset.assetKey, 'asset.assetKey');
      assertMysqlTextLength(db, assetKey, 700, 'asset.assetKey');
      assertMysqlTextLength(db, asset.relativePath, 2048, 'asset.relativePath');
      assertMysqlTextLength(db, asset.fileName, 1024, 'asset.fileName');
      assertMysqlTextLength(db, asset.quality, 64, 'asset.quality');
      if (seenKeys.has(assetKey)) throw new Error('duplicate asset key in snapshot: ' + assetKey);
      seenKeys.add(assetKey);
      if (!await tx.get(episodeBelongsToShow, [episodeId, Number(storage.show_id)])) {
        throw new Error('episode ' + episodeId + ' does not belong to storage show');
      }
      await tx.run(upsertAsset, [
        episodeId,
        storageId,
        assetKey,
        requiredText(asset.relativePath, 'asset.relativePath'),
        requiredText(asset.fileName, 'asset.fileName'),
        optionalNonnegativeInteger(asset.fileSize, 'asset.fileSize'),
        optionalNonnegativeInteger(asset.fileMtime, 'asset.fileMtime'),
        optionalText(asset.quality),
        scanId,
      ]);
    }

    let markedAbsent = 0;
    if (input.completeSnapshot) {
      const result = await tx.run(
        'UPDATE show_episode_asset SET is_present = 0 ' +
        'WHERE show_storage_id = ? AND is_present = 1 AND scan_id <> ?',
        [storageId, scanId],
      );
      markedAbsent = result.changes;
    }

    const syncEpisodeStorage = mysql
      ? 'ON DUPLICATE KEY UPDATE status = VALUES(status), asset_count = VALUES(asset_count), scanned_at = VALUES(scanned_at)'
      : 'ON CONFLICT(episode_id, show_storage_id) DO UPDATE SET ' +
        'status = excluded.status, asset_count = excluded.asset_count, scanned_at = excluded.scanned_at';
    await tx.run(
      'INSERT INTO show_episode_storage (episode_id, show_storage_id, status, asset_count, scanned_at) ' +
      'SELECT e.id, ?, ' +
      'CASE WHEN COUNT(a.id) = 0 THEN \'missing\' WHEN COUNT(a.id) = 1 THEN \'present\' ELSE \'conflict\' END, ' +
      'COUNT(a.id), ' + now + ' ' +
      'FROM show_episode e JOIN show_season s ON s.id = e.season_id ' +
      'LEFT JOIN show_episode_asset a ON a.episode_id = e.id AND a.show_storage_id = ? AND a.is_present = 1 ' +
      'WHERE s.show_id = ? GROUP BY e.id ' +
      syncEpisodeStorage,
      [storageId, storageId, Number(storage.show_id)],
    );

    return {
      visibleAssetCount: input.assets.length,
      markedAbsent,
      completeSnapshot: input.completeSnapshot,
    };
  });

  const reserveStorageWrites = (input) => db.transaction(async (tx) => {
    const storageId = positiveId(input.storageId, 'storageId');
    const seasonNumber = positiveInteger(input.seasonNumber, 'seasonNumber');
    const eventId = positiveId(input.eventId, 'eventId');
    if (!Array.isArray(input.episodeNumbers) || input.episodeNumbers.length === 0) {
      throw new TypeError('episodeNumbers must be a non-empty array');
    }

    const episodeNumbers = [...new Set(
      input.episodeNumbers.map((number) => positiveInteger(number, 'episodeNumber')),
    )].sort((a, b) => a - b);
    const insertClaim =
      'INSERT INTO show_episode_write_claim ' +
      '(show_storage_id, season_number, episode_number, event_id, status) ' +
      'VALUES (?, ?, ?, ?, \'reserved\') ' +
      (mysql
        ? 'ON DUPLICATE KEY UPDATE id = id'
        : 'ON CONFLICT(show_storage_id, season_number, episode_number) DO NOTHING');
    const readClaim =
      'SELECT event_id, status FROM show_episode_write_claim ' +
      'WHERE show_storage_id = ? AND season_number = ? AND episode_number = ?';
    const claimed = [];
    const blocked = [];

    for (const episodeNumber of episodeNumbers) {
      const result = await tx.run(insertClaim, [storageId, seasonNumber, episodeNumber, eventId]);
      const claim = await tx.get(readClaim, [storageId, seasonNumber, episodeNumber]);
      if (result.changes === 1) claimed.push(episodeNumber);
      else blocked.push({ episodeNumber, eventId: claim.event_id, status: claim.status });
    }
    return { claimed, blocked };
  });

  return Object.freeze({
    upsertSeason(input) {
      return saveSeason(input);
    },

    async upsertEpisode(input) {
      const episode = await saveEpisode(input);
      return {
        id: Number(episode.id),
        seasonId: Number(episode.season_id),
        episodeNumber: Number(episode.episode_number),
      };
    },

    upsertEpisodeMetadata(input) {
      return saveEpisodeMetadata(input);
    },

    createStorage(input) {
      return saveStorage(input).then(toStorage);
    },

    async getStorageById(storageId) {
      const id = positiveId(storageId, 'storageId');
      return toStorage(await db.get('SELECT * FROM show_storage WHERE id = ?', [id]));
    },

    async listShowStorages(showId, { enabledOnly = false } = {}) {
      const id = positiveId(showId, 'showId');
      const rows = enabledOnly
        ? await db.all(
          'SELECT * FROM show_storage WHERE show_id = ? AND enabled = 1 ORDER BY id',
          [id],
        )
        : await db.all('SELECT * FROM show_storage WHERE show_id = ? ORDER BY id', [id]);
      return rows.map(toStorage);
    },

    syncAssets(input) {
      return saveAssets(input);
    },

    async listStorageEpisodes(storageId) {
      const id = positiveId(storageId, 'storageId');
      return (await db.all(
        'SELECT s.season_number, e.episode_number, es.status, es.asset_count, es.scanned_at ' +
        'FROM show_episode_storage es ' +
        'JOIN show_episode e ON e.id = es.episode_id ' +
        'JOIN show_season s ON s.id = e.season_id ' +
        'WHERE es.show_storage_id = ? ORDER BY s.season_number, e.episode_number',
        [id],
      )).map((row) => ({
        seasonNumber: Number(row.season_number),
        episodeNumber: Number(row.episode_number),
        status: row.status,
        assetCount: Number(row.asset_count),
        scannedAt: row.scanned_at,
      }));
    },

    reserveWrites(input) {
      return reserveStorageWrites(input);
    },

    async findExistingWriteClaims({ storageId, seasonNumber, episodeNumbers } = {}) {
      const id = positiveId(storageId, 'storageId');
      const season = positiveInteger(seasonNumber, 'seasonNumber');
      if (!Array.isArray(episodeNumbers) || episodeNumbers.length === 0) {
        throw new TypeError('episodeNumbers must be a non-empty array');
      }
      const numbers = [...new Set(
        episodeNumbers.map((number) => positiveInteger(number, 'episodeNumber')),
      )];
      const placeholders = numbers.map(() => '?').join(', ');
      const rows = await db.all(
        'SELECT show_storage_id, season_number, episode_number, event_id, status ' +
        'FROM show_episode_write_claim WHERE show_storage_id = ? AND season_number = ? ' +
        'AND episode_number IN (' + placeholders + ') ORDER BY episode_number',
        [id, season, ...numbers],
      );
      return rows.map((row) => ({
        storageId: Number(row.show_storage_id),
        seasonNumber: Number(row.season_number),
        episodeNumber: Number(row.episode_number),
        eventId: row.event_id == null ? null : Number(row.event_id),
        status: row.status,
      }));
    },

    async markWritesUncertain(input) {
      return db.transaction(async (tx) => {
        const eventId = positiveId(input.eventId, 'eventId');
        const result = await tx.run(
          'UPDATE show_episode_write_claim SET status = \'uncertain\', updated_at = ' + now + ' ' +
          'WHERE event_id = ? AND status = \'reserved\'',
          [eventId],
        );
        return result.changes;
      });
    },

    async releaseUnwrittenClaims({ eventId, writeAttempted } = {}) {
      if (writeAttempted !== false) {
        throw new Error('claims may be released only when no storage write was attempted');
      }
      const id = positiveId(eventId, 'eventId');
      const result = await db.run(
        'DELETE FROM show_episode_write_claim WHERE event_id = ? AND status = \'reserved\'',
        [id],
      );
      return result.changes;
    },

    async listWriteClaims(eventId) {
      const id = positiveId(eventId, 'eventId');
      return (await db.all(
        'SELECT show_storage_id, season_number, episode_number, event_id, status, claimed_at, updated_at ' +
        'FROM show_episode_write_claim WHERE event_id = ? ORDER BY show_storage_id, season_number, episode_number',
        [id],
      )).map((row) => ({
        storageId: Number(row.show_storage_id),
        seasonNumber: Number(row.season_number),
        episodeNumber: Number(row.episode_number),
        eventId: Number(row.event_id),
        status: row.status,
        claimedAt: row.claimed_at,
        updatedAt: row.updated_at,
      }));
    },
  });
}
