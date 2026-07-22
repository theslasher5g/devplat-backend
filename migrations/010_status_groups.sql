-- Group status components under named groups (the "N components" expandable
-- rows on the status page). group_name NULL = a standalone top-level
-- component; non-null = shown under that group, whose aggregate status/uptime
-- is the worst of its members.
ALTER TABLE status_components ADD COLUMN group_name text;

-- Organize the seeded components into devplat's real two planes, and add the
-- per-host image cache as a real component under the data plane (its hit rate
-- already surfaces on the admin dashboard). These are genuine components, not
-- fabricated sub-services.
UPDATE status_components SET group_name = 'Control plane' WHERE key = 'api';
UPDATE status_components SET group_name = 'Data plane' WHERE key = 'compute';
INSERT INTO status_components (key, name, source, group_name, position)
VALUES ('image-cache', 'Image cache', 'manual', 'Data plane', 2)
ON CONFLICT (key) DO UPDATE SET group_name = EXCLUDED.group_name;
