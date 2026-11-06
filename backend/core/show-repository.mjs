import { assertMysqlTextLength } from '../db/sql.mjs';

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(field + ' is required');
  return text;
}

function parseAliases(value) {
  try {
    const aliases = JSON.parse(value || '[]');
    return Array.isArray(aliases) ? aliases : [];
  } catch {
    return [];
  }
}

function toShow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    mediaType: row.media_type,
    finished: Boolean(row.finished),
    aliases: parseAliases(row.aliases_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createShowRepository(db) {
  const getShow = (database, id) => database.get(
    'SELECT * FROM shows WHERE id = ?', [id],
  );

  async function linkIdentity(input) {
    assertMysqlTextLength(db, input.providerId, 64, 'providerId');
    assertMysqlTextLength(db, input.externalId, 255, 'externalId');
    assertMysqlTextLength(db, input.mediaType, 16, 'mediaType');
    assertMysqlTextLength(db, input.linkedBy, 64, 'linkedBy');
    return db.transaction(async (transaction) => {
      const showId = Number(input.showId);
      if (!Number.isSafeInteger(showId) || showId <= 0) {
        throw new TypeError('showId must be a positive integer');
      }
      if (!await getShow(transaction, showId)) {
        throw new Error('show ' + showId + ' does not exist');
      }

      const current = await transaction.get(
        'SELECT * FROM show_metadata_identity WHERE show_id = ? AND provider_id = ?',
        [showId, input.providerId],
      );
      if (current && current.external_id !== input.externalId) {
        throw new Error(
          'show ' + showId + ' already has a ' + input.providerId +
          ' identity; unlink it before replacing',
        );
      }

      const owner = await transaction.get(
        'SELECT show_id FROM show_metadata_identity WHERE provider_id = ? AND external_id = ?',
        [input.providerId, input.externalId],
      );
      if (owner && Number(owner.show_id) !== showId) {
        throw new Error(
          input.providerId + ' identity ' + input.externalId + ' is linked to another show',
        );
      }

      if (!current) {
        await transaction.run(
          'INSERT INTO show_metadata_identity ' +
          '(show_id, provider_id, external_id, media_type, linked_by) ' +
          'VALUES (?, ?, ?, ?, ?)',
          [showId, input.providerId, input.externalId, input.mediaType, input.linkedBy],
        );
      }

      return transaction.get(
        'SELECT id, show_id, provider_id, external_id, media_type, linked_by, linked_at ' +
        'FROM show_metadata_identity WHERE show_id = ? AND provider_id = ?',
        [showId, input.providerId],
      );
    });
  }

  return Object.freeze({
    async create({ name, mediaType = 'tv', finished = false, aliases = [] } = {}) {
      const normalizedName = requiredText(name, 'name');
      const normalizedMediaType = requiredText(mediaType, 'mediaType');
      assertMysqlTextLength(db, normalizedName, 255, 'name');
      assertMysqlTextLength(db, normalizedMediaType, 16, 'mediaType');
      if (typeof finished !== 'boolean') throw new TypeError('finished must be a boolean');
      if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== 'string')) {
        throw new TypeError('aliases must be an array of strings');
      }

      const normalizedAliases = [...new Set(
        aliases.map((alias) => alias.trim()).filter(Boolean),
      )];
      const result = await db.run(
        'INSERT INTO shows (name, media_type, finished, aliases_json) VALUES (?, ?, ?, ?)',
        [normalizedName, normalizedMediaType, finished ? 1 : 0, JSON.stringify(normalizedAliases)],
      );
      return toShow(await getShow(db, result.lastInsertId));
    },

    async getById(id) {
      const showId = Number(id);
      if (!Number.isSafeInteger(showId) || showId <= 0) return null;
      return toShow(await getShow(db, showId));
    },

    async list() {
      return (await db.all('SELECT * FROM shows ORDER BY LOWER(name), id')).map(toShow);
    },

    async linkMetadataIdentity({
      showId,
      providerId,
      externalId,
      mediaType = 'tv',
      linkedBy = 'manual',
    } = {}) {
      const identity = await linkIdentity({
        showId,
        providerId: requiredText(providerId, 'providerId'),
        externalId: requiredText(externalId, 'externalId'),
        mediaType: requiredText(mediaType, 'mediaType'),
        linkedBy: requiredText(linkedBy, 'linkedBy'),
      });

      return {
        id: Number(identity.id),
        showId: Number(identity.show_id),
        providerId: identity.provider_id,
        externalId: identity.external_id,
        mediaType: identity.media_type,
        linkedBy: identity.linked_by,
        linkedAt: identity.linked_at,
      };
    },

    async listMetadataIdentities(showId) {
      const id = Number(showId);
      if (!Number.isSafeInteger(id) || id <= 0) return [];
      return (await db.all(
        'SELECT id, show_id, provider_id, external_id, media_type, linked_by, linked_at ' +
        'FROM show_metadata_identity WHERE show_id = ? ORDER BY provider_id',
        [id],
      )).map((identity) => ({
        id: Number(identity.id),
        showId: Number(identity.show_id),
        providerId: identity.provider_id,
        externalId: identity.external_id,
        mediaType: identity.media_type,
        linkedBy: identity.linked_by,
        linkedAt: identity.linked_at,
      }));
    },
  });
}
