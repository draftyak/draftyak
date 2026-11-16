-- First native accepted metadata receipt; legacy receipt history remains unknown.
ALTER TABLE main.content_messages
ADD COLUMN received_at INTEGER
CHECK(received_at IS NULL OR
  (typeof(received_at)='integer' AND received_at BETWEEN 0 AND 9007199254740991));

ALTER TABLE main.content_messages
ADD COLUMN ingress_source_id TEXT
CHECK(
  (received_at IS NULL AND ingress_source_id IS NULL)
  OR
  (received_at IS NOT NULL AND ingress_source_id IS NOT NULL
   AND typeof(received_at)='integer' AND received_at BETWEEN 0 AND 9007199254740991
   AND typeof(ingress_source_id)='text'
   AND length(ingress_source_id)=26 AND length(CAST(ingress_source_id AS BLOB))=26
   AND ingress_source_id GLOB '[0-7]*'
   AND ingress_source_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
);

CREATE TRIGGER content_messages_ingress_immutable
BEFORE UPDATE OF received_at,ingress_source_id ON content_messages
WHEN NEW.received_at IS NOT OLD.received_at
  OR NEW.ingress_source_id IS NOT OLD.ingress_source_id
BEGIN
  SELECT RAISE(ABORT,'CONTENT_MESSAGE_INGRESS_IMMUTABLE');
END;
