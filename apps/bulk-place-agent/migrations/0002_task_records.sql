-- Log the place/entity ids each task created, so "what this task built" is
-- deterministic per task (not a fragile global "most recent" query). Stored as
-- a JSON array of { placeId, entityId, osmId, name, placeCreated, entityCreated }.

ALTER TABLE tasks ADD COLUMN records TEXT;
